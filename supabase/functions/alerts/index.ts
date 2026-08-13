// =============================================================================
// alerts — the notification fanout for the personal Alerts feed.
//
// One entry point for every notification source (crons, other edge functions,
// admin surfaces like Schedule Admin's Notify / KB publish):
//
//   POST { action:'send', kind, title, body?, link?, icon?,
//          staff_ids?: number[] | all_active?: true, secret? }
//
//   1. ALWAYS writes an alerts row per recipient (the feed is complete no
//      matter what channels are on).
//   2. Fans out per the person's alert_prefs (missing = push on, sms off):
//        push  -> Web Push to every device in push_subscriptions (dead
//                 endpoints — 404/410 — are pruned)
//        sms   -> messaging function's system_send, from the official line
//      kind 'comms' push is LOCKED ON by policy.
//
// Auth: body.secret === NOTIFY_SECRET (crons / server-to-server), OR a staff
// JWT with role admin/manager/owner (browser surfaces).
// Secrets: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT, NOTIFY_SECRET.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const VAPID_PUB = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIV = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:owner@myrepairtools.com";
const MESSAGING_URL = SB_URL + "/functions/v1/messaging";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
if (VAPID_PUB && VAPID_PRIV) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUB, VAPID_PRIV);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const KINDS = ["comms", "task", "schedule", "schedule_preview", "kb", "goal", "birthday", "anniversary", "system", "interview", "hiring"];

async function callerAllowed(req: Request, body: Record<string, unknown>): Promise<boolean> {
  if (SECRET && body.secret === SECRET) return true;
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return false;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return false;
  const { data: s } = await admin.from("staff").select("role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return !!s && ["admin", "manager", "owner"].includes(String(s.role));
}

async function doSend(body: Record<string, unknown>) {
  const kind = String(body.kind || "system");
  if (!KINDS.includes(kind)) return json({ error: "bad_kind", detail: `kind must be one of ${KINDS.join("/")}` }, 400);
  const title = String(body.title || "").trim().slice(0, 140);
  if (!title) return json({ error: "bad_request", detail: "title required" }, 400);
  const text = body.body ? String(body.body).trim().slice(0, 500) : null;
  const link = body.link ? String(body.link).slice(0, 300) : null;
  const icon = body.icon ? String(body.icon).slice(0, 8) : null;
  // Caller opt-out of web-push for THIS send (still writes the feed + sends SMS).
  // The Schedule Admin "Notify Employees" broadcast uses it — the owner wants
  // that to be a text only, not push + text.
  const pushOff = body.push === false;

  // recipients
  let ids: number[] = [];
  if (Array.isArray(body.staff_ids)) ids = body.staff_ids.map(Number).filter((n) => Number.isFinite(n));
  else if (body.all_active === true) {
    const { data } = await admin.from("staff").select("id").eq("active", true);
    ids = (data ?? []).map((s: { id: number }) => s.id);
  }
  if (!ids.length) return json({ error: "bad_request", detail: "staff_ids or all_active required" }, 400);

  // 1. the feed rows — always
  const rows = ids.map((staff_id) => ({ staff_id, kind, title, body: text, link, icon }));
  const ins = await admin.from("alerts").insert(rows);
  if (ins.error) return json({ error: "db_error", detail: ins.error.message }, 500);

  // 2. per-person channel fanout
  const [prefsQ, profQ, subsQ] = await Promise.all([
    admin.from("alert_prefs").select("staff_id, prefs").in("staff_id", ids),
    admin.from("staff_profiles").select("staff_id, phone").in("staff_id", ids),
    admin.from("push_subscriptions").select("id, staff_id, endpoint, p256dh, auth").in("staff_id", ids),
  ]);
  const prefs: Record<number, Record<string, { push?: boolean; sms?: boolean }>> = {};
  (prefsQ.data ?? []).forEach((r: { staff_id: number; prefs: Record<string, { push?: boolean; sms?: boolean }> }) => { prefs[r.staff_id] = r.prefs || {}; });
  const phones: Record<number, string> = {};
  (profQ.data ?? []).forEach((r: { staff_id: number; phone: string | null }) => { if (r.phone) phones[r.staff_id] = r.phone; });
  const subsBy: Record<number, Array<{ id: string; endpoint: string; p256dh: string; auth: string }>> = {};
  (subsQ.data ?? []).forEach((s: { id: string; staff_id: number; endpoint: string; p256dh: string; auth: string }) => {
    (subsBy[s.staff_id] = subsBy[s.staff_id] || []).push(s);
  });

  let pushed = 0, pruned = 0, smsSent = 0, smsSkippedNoPhone = 0;
  const errors: string[] = [];
  const payload = JSON.stringify({ title, body: text || "", link: link || "alerts.html", icon: icon || "" });

  // Push (distinct endpoints) fans out concurrently. SMS does NOT: every text
  // goes through the one messaging function / one RingCentral line, and firing
  // the whole group at once overran the runtime's outbound-connection cap — the
  // tail of the burst was dropped before it reached messaging (so it never even
  // logged), which is why a full-staff schedule broadcast silently skipped
  // Jose & Dylan. Texts are now sent SEQUENTIALLY with a retry so everyone in
  // the group actually gets one.
  const pushJobs: Promise<void>[] = [];
  const smsList: number[] = [];
  for (const id of ids) {
    const p = (prefs[id] || {})[kind] || {};
    // Two tiers. Notifications (task/kb/goal/comms…): push default ON, SMS opt-in.
    // ALERTS (urgent — schedule/system): must reach people NOW, so push AND SMS
    // are auto-enrolled for everyone (prefs can't turn them off).
    const urgent = kind === "schedule" || kind === "system";
    const wantPush = pushOff ? false : ((kind === "comms" || urgent) ? true : p.push !== false);
    const wantSms = urgent ? true : p.sms === true;

    if (wantPush && VAPID_PUB) {
      for (const sub of (subsBy[id] || [])) {
        pushJobs.push((async () => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload, { TTL: 3600 },
            );
            pushed++;
          } catch (e) {
            const code = (e as { statusCode?: number })?.statusCode;
            if (code === 404 || code === 410) {
              await admin.from("push_subscriptions").delete().eq("id", sub.id);
              pruned++;
            } else errors.push(`push ${code || (e as Error)?.message}`);
          }
        })());
      }
    }
    if (wantSms && SECRET) {
      if (phones[id]) smsList.push(id);
      else smsSkippedNoPhone++;   // urgent alert but no number on file — surfaced below
    }
  }

  // texts one at a time, each retried once on a transient failure (network drop
  // or a RingCentral rate-limit), so no recipient is silently skipped
  const smsBody = `CPR: ${title}${text ? " — " + text : ""}${link ? " myrepairtools.com/" + link : ""}`;
  for (const id of smsList) {
    let ok = false, lastErr = "";
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await fetch(MESSAGING_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "system_send", secret: SECRET, to: phones[id], body: smsBody }),
        });
        if (r.ok) { ok = true; smsSent++; break; }
        lastErr = `sms ${r.status} id${id}`;
        // 409 (opted out) / 400 (bad number) won't fix on retry — stop early
        if (r.status === 409 || r.status === 400) break;
      } catch (e) { lastErr = `sms ${(e as Error)?.message} id${id}`; }
    }
    if (!ok && lastErr) errors.push(lastErr);
  }
  await Promise.allSettled(pushJobs);

  return json({ ok: true, recipients: ids.length, pushed, pruned, sms_sent: smsSent, sms_skipped_no_phone: smsSkippedNoPhone, ...(errors.length ? { errors: errors.slice(0, 10) } : {}) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body.action === "ping") return json({ ok: true });
  if (!(await callerAllowed(req, body))) return json({ error: "forbidden" }, 403);
  if (body.action === "send") return await doSend(body);
  return json({ error: "bad_action" }, 400);
});
