// Notification delivery backend for the CPR tools.
// Sends a subject/message to notification_channels — either via email (Resend) or a
// Teams/Power Automate webhook. Two entry points:
//   { action:'test',  channel_id }          -> send a canned test to one channel
//   { action:'send',  event_key, subject, text }  -> send to every enabled channel routed to
//                                                      the (enabled) rule with that event_key
//   { action:'send',  channel_ids:[..], subject, text }  -> send to explicit channels
//
// Auth: manager/admin/owner JWT (Authorization: Bearer <session>) OR ?secret=<NOTIFY_SECRET>.
// Email needs RESEND_API_KEY (+ optional NOTIFY_FROM, default onboarding@resend.dev). Webhook
// channels need no extra config. If email isn't configured, email channels return a clear error
// while webhook channels still deliver.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM") || "CPR Tools <onboarding@resend.dev>";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function callerStaff(req: Request): Promise<Record<string, unknown> | null> {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff").select("id, role, display_name")
    .eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s || null;
}

type Channel = { id: number; name: string; type: string; target: string | null; webhook_format: string | null; enabled: boolean };

// Build the webhook payload for a Teams incoming webhook / Power Automate HTTP trigger.
function webhookBody(fmt: string | null, subject: string, text: string, keyword: string): string {
  if (fmt === "messagecard") {
    return JSON.stringify({
      "@type": "MessageCard", "@context": "http://schema.org/extensions",
      summary: subject, themeColor: "DC282E",
      title: subject, text: text.replace(/\n/g, "\n\n"),
      keyword,   // structured field Power Automate can switch on
    });
  }
  if (fmt === "adaptive") {
    return JSON.stringify({
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard", version: "1.4",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          body: [
            { type: "TextBlock", size: "Medium", weight: "Bolder", text: subject, wrap: true },
            { type: "TextBlock", text: text, wrap: true },
          ],
          msteams: { keyword },
        },
      }],
    });
  }
  // default: plain JSON — friendliest for a Power Automate "When an HTTP request is received" trigger
  return JSON.stringify({ keyword, subject, text, title: subject, message: text });
}

async function sendEmail(to: string, subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { ok: false, error: "email_not_configured" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: NOTIFY_FROM, to: [to], subject,
      text,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2D2D3B;line-height:1.5">${
        text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")
      }</div>`,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (d && (d.message || d.name)) || `resend_${r.status}` };
  return { ok: true };
}

async function deliver(ch: Channel, subject: string, text: string, keyword: string): Promise<{ channel: string; ok: boolean; via: string; error?: string }> {
  const target = (ch.target || "").trim();
  if (!target) return { channel: ch.name, ok: false, via: ch.type, error: "no_target" };
  try {
    if (ch.type === "webhook") {
      const r = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body: webhookBody(ch.webhook_format, subject, text, keyword) });
      if (!r.ok) return { channel: ch.name, ok: false, via: "webhook", error: `http_${r.status}` };
      return { channel: ch.name, ok: true, via: "webhook" };
    }
    // email (incl. a Teams channel email address)
    const e = await sendEmail(target, subject, text);
    return { channel: ch.name, ok: e.ok, via: "email", error: e.error };
  } catch (err) {
    return { channel: ch.name, ok: false, via: ch.type, error: String((err as Error)?.message || err) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const bySecret = !!NOTIFY_SECRET && url.searchParams.get("secret") === NOTIFY_SECRET;
  const caller = bySecret ? null : await callerStaff(req);
  const role = String(caller?.role || "");
  const authed = bySecret || ["owner", "admin", "manager"].includes(role);
  if (!authed) return json({ ok: false, error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const action = String(body.action || "send");

  // Resolve the channel list for this call.
  let channels: Channel[] = [];
  let ruleKeyword = "";
  if (action === "test") {
    // Test an unsaved draft ({channel:{type,target,...}}) or an existing channel by id.
    const draft = body.channel as Partial<Channel> | undefined;
    if (draft && draft.target) {
      channels = [{ id: 0, name: draft.name || "Draft channel", type: draft.type || "email", target: draft.target, webhook_format: draft.webhook_format || "adaptive", enabled: true }];
    } else {
      const id = Number(body.channel_id);
      if (!id) return json({ ok: false, error: "channel_id or channel draft required" }, 400);
      const { data } = await admin.from("notification_channels").select("id,name,type,target,webhook_format,enabled").eq("id", id).maybeSingle();
      if (!data) return json({ ok: false, error: "channel not found" }, 404);
      channels = [data as Channel];
    }
  } else {
    if (Array.isArray(body.channel_ids) && body.channel_ids.length) {
      const { data } = await admin.from("notification_channels").select("id,name,type,target,webhook_format,enabled").in("id", body.channel_ids as number[]);
      channels = (data || []) as Channel[];
    } else if (body.event_key) {
      const { data: rule } = await admin.from("notification_rules").select("id,enabled,keyword").eq("event_key", String(body.event_key)).maybeSingle();
      if (!rule) return json({ ok: false, error: "rule not found" }, 404);
      if (!rule.enabled) return json({ ok: true, skipped: "rule_disabled", results: [] });
      ruleKeyword = String(rule.keyword || "").trim();
      const { data: links } = await admin.from("notification_rule_channels").select("channel_id").eq("rule_id", rule.id);
      const ids = (links || []).map((l: { channel_id: number }) => l.channel_id);
      if (!ids.length) return json({ ok: true, skipped: "no_channels", results: [] });
      const { data } = await admin.from("notification_channels").select("id,name,type,target,webhook_format,enabled").in("id", ids).eq("enabled", true);
      channels = (data || []) as Channel[];
    } else {
      return json({ ok: false, error: "event_key or channel_ids required" }, 400);
    }
  }

  const keyword = String(body.keyword || ruleKeyword || "").trim();
  const descSubject = String(body.subject || (action === "test" ? "CPR Tools · test notification" : "CPR Tools notification"));
  const descText = String(body.text || (action === "test"
    ? "This is a test from the CPR Tools notifications panel. If you got this, the channel works."
    : "You have a new notification from the CPR Tools."));
  // When a keyword is set, the keyword IS the signal — send it as the message so a Power Automate
  // "when keywords are mentioned" trigger matches. No keyword → send the human-readable message.
  const sendSubject = keyword || descSubject;
  const sendText = keyword || descText;

  if (!channels.length) return json({ ok: true, skipped: "no_channels", results: [] });
  const results = await Promise.all(channels.map((c) => deliver(c, sendSubject, sendText, keyword)));
  const okAll = results.every((r) => r.ok);
  return json({ ok: okAll, results, keyword: keyword || undefined });
});
