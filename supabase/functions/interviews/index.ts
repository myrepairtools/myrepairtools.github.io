// interviews — our own interview booking service (Microsoft Bookings replacement).
//
// The whole point: the HOST declares weekly windows and nothing else gets a
// vote. There is no calendar sync, so nothing can mysteriously block a slot —
// only an existing interview, a blackout the host set, or the lead/max-per-day
// rules can take a slot off the board.
//
// Public (no auth — the candidate never signs in):
//   GET  ?action=hosts&store=…        -> who's taking interviews (name, store, blurb)
//   GET  ?action=slots&host=…&store=… -> open slots, computed live
//   POST {action:'book', …}           -> create the booking, confirm by SMS + email
//   GET  ?action=view&t=<token>       -> the candidate's own booking
//   POST {action:'cancel', t}         -> candidate cancels (frees the slot)
//   POST {action:'reschedule', t, starts_at}
// Staff (Supabase JWT):
//   POST {action:'my_bookings'}       -> upcoming for the signed-in host
//
// Slots are COMPUTED, never generated: availability − bookings − blackouts.
// Nothing to backfill, nothing to drift.
//
// Times: everything is stored UTC; windows are store-local (America/Los_Angeles)
// minutes-from-midnight, so DST is handled by converting per calendar date.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM") || "onboarding@resend.dev";
const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") || "";
const SITE = "https://myrepairtools.com";
const TZ = "America/Los_Angeles";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------------- time helpers (store-local ⇄ UTC) ---------------- */
// Offset (minutes) between UTC and store time at a given instant — handles DST.
function tzOffsetMin(at: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, timeZoneName: "shortOffset", hour: "2-digit", hour12: false,
  }).format(at);
  const m = s.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!m) return -480;
  return Number(m[1]) * 60 + (m[1].startsWith("-") ? -1 : 1) * Number(m[2] || 0);
}
// 'YYYY-MM-DD' + local minutes -> UTC Date
function localToUtc(dateStr: string, minutes: number): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  // guess with a nominal offset, then correct with the real one for that instant
  let guess = new Date(Date.UTC(y, mo - 1, d, 0, minutes));
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMin(guess);
    guess = new Date(Date.UTC(y, mo - 1, d, 0, minutes - off));
  }
  return guess;
}
function localDateStr(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
function localWeekday(dateStr: string): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
}
function addDays(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n, 12));
  return dt.toISOString().slice(0, 10);
}
function prettyWhen(at: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(at);
}

const token = () => crypto.randomUUID().replace(/-/g, "").slice(0, 22);
const e164 = (v: string) => {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? (String(v).trim().startsWith("+") ? String(v).trim() : "") : "";
};

/* ---------------- slot computation ---------------- */
type Slot = { staff_id: number; name: string; store: string | null; starts_at: string; ends_at: string };

async function openSlots(hostId: number | null, store: string | null): Promise<Slot[]> {
  const [{ data: hosts }, { data: avail }, { data: settings }] = await Promise.all([
    admin.from("staff").select("id, display_name, role, active").eq("active", true),
    admin.from("interview_availability").select("*").eq("active", true),
    admin.from("interview_settings").select("*"),
  ]);
  const setBy = new Map<number, any>((settings || []).map((s: any) => [Number(s.staff_id), s]));
  const nameBy = new Map<number, string>((hosts || []).map((h: any) => [Number(h.id), h.display_name]));

  let rows = (avail || []).filter((a: any) => {
    const s = setBy.get(Number(a.staff_id));
    if (!s || s.active === false) return false;             // host not accepting
    if (!nameBy.has(Number(a.staff_id))) return false;      // inactive staff
    if (hostId && Number(a.staff_id) !== hostId) return false;
    if (store && a.store && a.store !== store) return false;
    return true;
  });
  if (!rows.length) return [];

  const horizon = Math.max(...rows.map((r: any) => setBy.get(Number(r.staff_id))?.horizon_days ?? 21));
  const now = new Date();
  const today = localDateStr(now);
  const lastDay = addDays(today, Math.min(horizon, 60));

  // existing bookings + blackouts across the window
  const [{ data: booked }, { data: blackouts }] = await Promise.all([
    admin.from("interview_bookings").select("staff_id, starts_at, ends_at")
      .eq("status", "booked").gte("starts_at", now.toISOString()),
    admin.from("interview_blackouts").select("*").gte("block_date", today).lte("block_date", lastDay),
  ]);
  const busy = (booked || []).map((b: any) => ({
    staff_id: Number(b.staff_id), s: new Date(b.starts_at).getTime(), e: new Date(b.ends_at).getTime(),
  }));
  const perDay = new Map<string, number>();
  for (const b of (booked || [])) {
    const k = Number(b.staff_id) + "|" + localDateStr(new Date(b.starts_at));
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }

  const out: Slot[] = [];
  for (let i = 0; i <= Math.min(horizon, 60); i++) {
    const day = addDays(today, i);
    const wd = localWeekday(day);
    for (const a of rows) {
      const cfg = setBy.get(Number(a.staff_id))!;
      if (i > (cfg.horizon_days ?? 21)) continue;
      if (Number(a.weekday) !== wd) continue;
      const dayKey = Number(a.staff_id) + "|" + day;
      if ((perDay.get(dayKey) || 0) >= (cfg.max_per_day ?? 4)) continue;

      // blackouts for this host (or everyone) on this date
      const blocks = (blackouts || []).filter((b: any) =>
        b.block_date === day && (b.staff_id == null || Number(b.staff_id) === Number(a.staff_id)));
      const step = (cfg.slot_minutes ?? 30) + (cfg.buffer_minutes ?? 0);
      const leadMs = (cfg.lead_hours ?? 12) * 3600000;
      let count = perDay.get(dayKey) || 0;

      for (let m = Number(a.start_min); m + Number(cfg.slot_minutes ?? 30) <= Number(a.end_min); m += step) {
        if (count >= (cfg.max_per_day ?? 4)) break;
        const s = localToUtc(day, m);
        const e = new Date(s.getTime() + (cfg.slot_minutes ?? 30) * 60000);
        if (s.getTime() - now.getTime() < leadMs) continue;                 // too soon
        const wholeDay = blocks.some((b: any) => b.start_min == null);
        if (wholeDay) break;
        const hitsBlock = blocks.some((b: any) =>
          b.start_min != null && m < Number(b.end_min) && (m + Number(cfg.slot_minutes ?? 30)) > Number(b.start_min));
        if (hitsBlock) continue;
        const taken = busy.some((b) =>
          b.staff_id === Number(a.staff_id) && s.getTime() < b.e && e.getTime() > b.s);
        if (taken) continue;
        out.push({
          staff_id: Number(a.staff_id), name: nameBy.get(Number(a.staff_id)) || "",
          store: a.store || null, starts_at: s.toISOString(), ends_at: e.toISOString(),
        });
      }
    }
  }
  out.sort((x, y) => x.starts_at.localeCompare(y.starts_at) || x.name.localeCompare(y.name));
  return out;
}

/* ---------------- notifications ---------------- */
// Resend when it's configured, Gmail SMTP otherwise — same two transports the
// contracts/notify functions use, so interview email works with whatever is set.
async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!to) return false;
  const html = '<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.55;white-space:pre-wrap">'
    + text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(https:\/\/[^\s]+)/g, '<a href="$1">$1</a>') + "</div>";
  if (RESEND_API_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, text, html }),
      });
      if (r.ok) return true;
    } catch { /* fall through to Gmail */ }
  }
  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
      const client = new SMTPClient({
        connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
      });
      await client.send({ from: `CPR Cell Phone Repair <${GMAIL_USER}>`, to, subject, content: text, html });
      await client.close();
      return true;
    } catch { return false; }
  }
  return false;
}
async function sendSms(to: string, body: string, store: string | null): Promise<boolean> {
  const num = e164(to);
  if (!num) return false;
  try {
    const r = await fetch(SB_URL + "/functions/v1/messaging", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ANON, "apikey": ANON },
      body: JSON.stringify({ action: "send", to: num, body, store, template_key: "interview" }),
    });
    const d = await r.json().catch(() => ({}));
    return r.ok && d?.ok !== false;
  } catch { return false; }
}
// Tell the HOST personally — the manager whose slot this is needs it in their
// own feed/phone, not just a team channel they might not watch. Kind
// 'interview' is a Notification (push on by default, text opt-in per person),
// deliberately not the urgent tier.
async function notifyHost(staffId: number, title: string, body: string) {
  if (!NOTIFY_SECRET) return;
  try {
    await fetch(SB_URL + "/functions/v1/alerts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send", secret: NOTIFY_SECRET, kind: "interview",
        staff_ids: [staffId], title, body, link: "interviews.html", icon: "🗓️",
      }),
    });
  } catch { /* best effort */ }
}
// tell the team a booking landed (routed rule, Settings › Notifications)
async function notifyTeam(eventKey: string, subject: string, text: string) {
  if (!NOTIFY_SECRET) return;
  try {
    await fetch(SB_URL + "/functions/v1/notify?secret=" + encodeURIComponent(NOTIFY_SECRET), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", event_key: eventKey, subject, text }),
    });
  } catch { /* best effort */ }
}
async function storeAddress(store: string | null): Promise<string> {
  if (!store) return "";
  try {
    const { data } = await admin.from("stores").select("store, address").eq("store", store).maybeSingle();
    return (data as any)?.address || "";
  } catch { return ""; }
}
function candidateText(b: any, hostName: string, addr: string, link: string, lead: string): string {
  return lead + "\n\n"
    + "When: " + prettyWhen(new Date(b.starts_at)) + "\n"
    + "Who: " + hostName + "\n"
    + (b.store ? "Where: " + b.store + (addr ? "\n" + addr : "") + "\n" : "")
    + "\nNeed to change it? " + link
    + "\n\n— CPR Cell Phone Repair";
}

/* ---------------- entry ---------------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  const action = String(body.action || url.searchParams.get("action") || "");

  try {
    if (action === "ping") return json({ ok: true });

    if (action === "hosts") {
      const store = url.searchParams.get("store");
      const { data: settings } = await admin.from("interview_settings").select("*").eq("active", true);
      const ids = (settings || []).map((s: any) => Number(s.staff_id));
      if (!ids.length) return json({ hosts: [] });
      const [{ data: staff }, { data: avail }] = await Promise.all([
        admin.from("staff").select("id, display_name, role, home_store, active").in("id", ids).eq("active", true),
        admin.from("interview_availability").select("staff_id, store").eq("active", true).in("staff_id", ids),
      ]);
      const stores = new Map<number, Set<string>>();
      for (const a of (avail || [])) {
        if (!a.store) continue;
        if (!stores.has(Number(a.staff_id))) stores.set(Number(a.staff_id), new Set());
        stores.get(Number(a.staff_id))!.add(a.store);
      }
      const blurb = new Map((settings || []).map((s: any) => [Number(s.staff_id), s.blurb]));
      const hosts = (staff || [])
        .map((s: any) => ({
          id: Number(s.id), name: s.display_name, role: s.role,
          stores: [...(stores.get(Number(s.id)) || [])],
          blurb: blurb.get(Number(s.id)) || null,
        }))
        .filter((h) => !store || h.stores.includes(store));
      return json({ hosts });
    }

    if (action === "slots") {
      const host = url.searchParams.get("host");
      const store = url.searchParams.get("store");
      const slots = await openSlots(host ? Number(host) : null, store || null);
      return json({ slots, tz: TZ });
    }

    if (action === "book") {
      const staffId = Number(body.staff_id || 0);
      const startsAt = String(body.starts_at || "");
      const name = String(body.candidate_name || "").trim();
      const phone = String(body.candidate_phone || "").trim();
      const email = String(body.candidate_email || "").trim();
      if (!staffId || !startsAt || !name) return json({ ok: false, error: "missing_fields" }, 400);
      if (!phone && !email) return json({ ok: false, error: "need_contact" }, 400);

      // Re-derive the slot server-side — never trust a posted time. If it isn't
      // in the open list right now, someone just took it (or it was never real).
      const open = await openSlots(staffId, null);
      const slot = open.find((s) => s.starts_at === startsAt && s.staff_id === staffId);
      if (!slot) return json({ ok: false, error: "slot_taken" }, 409);

      const row = {
        token: token(), staff_id: staffId, store: slot.store,
        starts_at: slot.starts_at, ends_at: slot.ends_at,
        candidate_name: name, candidate_phone: phone || null, candidate_email: email || null,
        position: String(body.position || "").trim() || null,
        notes: String(body.notes || "").trim() || null,
      };
      const ins = await admin.from("interview_bookings").insert(row).select().single();
      if (ins.error) return json({ ok: false, error: ins.error.message }, 500);
      const b = ins.data as any;

      const hostName = slot.name;
      const addr = await storeAddress(slot.store);
      const link = SITE + "/interview.html?t=" + b.token;
      const when = prettyWhen(new Date(b.starts_at));
      const text = candidateText(b, hostName, addr, link,
        "You're booked, " + name.split(/\s+/)[0] + " — here are your interview details.");
      const smsOk = phone ? await sendSms(phone,
        "CPR interview confirmed: " + when + (slot.store ? " at " + slot.store : "") + " with " + hostName
        + ". Change or cancel: " + link, slot.store) : false;
      const mailOk = email ? await sendEmail(email, "Your CPR interview — " + when, text) : false;
      await admin.from("interview_bookings")
        .update({ confirm_sms: smsOk, confirm_email: mailOk }).eq("id", b.id);

      await notifyHost(staffId, "Interview booked — " + when,
        name + (row.position ? " · " + row.position : "") + (slot.store ? " · " + slot.store : "")
        + (phone ? " · " + phone : ""));
      await notifyTeam("interviews.booked", "Interview booked — " + name + " · " + when,
        name + " booked an interview.\nWhen: " + when + "\nWith: " + hostName
        + (slot.store ? "\nWhere: " + slot.store : "")
        + (phone ? "\nPhone: " + phone : "") + (email ? "\nEmail: " + email : "")
        + (row.position ? "\nPosition: " + row.position : "")
        + "\n\nOpen: " + SITE + "/interviews.html");

      return json({ ok: true, token: b.token, starts_at: b.starts_at, ends_at: b.ends_at,
        host: hostName, store: slot.store, address: addr, confirm: { sms: smsOk, email: mailOk } });
    }

    if (action === "view") {
      const t = String(url.searchParams.get("t") || body.t || "");
      if (!t) return json({ ok: false, error: "no_token" }, 400);
      const { data } = await admin.from("interview_bookings").select("*").eq("token", t).maybeSingle();
      if (!data) return json({ ok: false, error: "not_found" }, 404);
      const b = data as any;
      const { data: host } = await admin.from("staff").select("display_name").eq("id", b.staff_id).maybeSingle();
      return json({
        ok: true, booking: {
          token: b.token, starts_at: b.starts_at, ends_at: b.ends_at, status: b.status,
          candidate_name: b.candidate_name, store: b.store, position: b.position,
          host: (host as any)?.display_name || "", address: await storeAddress(b.store),
        },
      });
    }

    if (action === "cancel") {
      const t = String(body.t || "");
      const { data } = await admin.from("interview_bookings").select("*").eq("token", t).maybeSingle();
      if (!data) return json({ ok: false, error: "not_found" }, 404);
      const b = data as any;
      if (b.status !== "booked") return json({ ok: true, already: b.status });
      await admin.from("interview_bookings").update({
        status: "canceled", canceled_at: new Date().toISOString(),
        canceled_by: String(body.by || "candidate"), updated_at: new Date().toISOString(),
      }).eq("id", b.id);
      const { data: host } = await admin.from("staff").select("display_name").eq("id", b.staff_id).maybeSingle();
      const when = prettyWhen(new Date(b.starts_at));
      await notifyHost(Number(b.staff_id), "Interview canceled — " + when,
        b.candidate_name + " canceled" + (b.store ? " · " + b.store : "") + ". That slot is open again.");
      await notifyTeam("interviews.canceled", "Interview canceled — " + b.candidate_name + " · " + when,
        b.candidate_name + " canceled their " + when + " interview with " + ((host as any)?.display_name || "") + ".");
      return json({ ok: true });
    }

    if (action === "reschedule") {
      const t = String(body.t || "");
      const startsAt = String(body.starts_at || "");
      const { data } = await admin.from("interview_bookings").select("*").eq("token", t).maybeSingle();
      if (!data) return json({ ok: false, error: "not_found" }, 404);
      const b = data as any;
      if (b.status !== "booked") return json({ ok: false, error: "not_active" }, 409);
      const open = await openSlots(Number(b.staff_id), null);
      const slot = open.find((s) => s.starts_at === startsAt);
      if (!slot) return json({ ok: false, error: "slot_taken" }, 409);
      await admin.from("interview_bookings").update({
        starts_at: slot.starts_at, ends_at: slot.ends_at, store: slot.store,
        reminded_24h: false, updated_at: new Date().toISOString(),
      }).eq("id", b.id);
      const link = SITE + "/interview.html?t=" + b.token;
      const when = prettyWhen(new Date(slot.starts_at));
      if (b.candidate_phone) await sendSms(b.candidate_phone,
        "CPR interview moved to " + when + (slot.store ? " at " + slot.store : "") + ". Details: " + link, slot.store);
      if (b.candidate_email) await sendEmail(b.candidate_email, "Your CPR interview moved — " + when,
        candidateText({ ...b, starts_at: slot.starts_at, store: slot.store }, slot.name,
          await storeAddress(slot.store), link, "Your interview has been moved."));
      await notifyHost(Number(b.staff_id), "Interview moved — " + when,
        b.candidate_name + " rescheduled" + (slot.store ? " · " + slot.store : "") + ".");
      await notifyTeam("interviews.booked", "Interview rescheduled — " + b.candidate_name + " · " + when,
        b.candidate_name + " moved their interview to " + when + ".");
      return json({ ok: true, starts_at: slot.starts_at });
    }

    // ---- reminders (cron): text tomorrow's candidates once ----
    if (action === "remind") {
      if (!NOTIFY_SECRET || (body.secret || url.searchParams.get("secret")) !== NOTIFY_SECRET) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
      const now = Date.now();
      const { data } = await admin.from("interview_bookings").select("*")
        .eq("status", "booked").eq("reminded_24h", false)
        .gte("starts_at", new Date(now).toISOString())
        .lte("starts_at", new Date(now + 26 * 3600000).toISOString());
      let sent = 0;
      for (const b of (data || []) as any[]) {
        const { data: host } = await admin.from("staff").select("display_name").eq("id", b.staff_id).maybeSingle();
        const when = prettyWhen(new Date(b.starts_at));
        const link = SITE + "/interview.html?t=" + b.token;
        if (b.candidate_phone) {
          await sendSms(b.candidate_phone,
            "Reminder: your CPR interview is " + when + (b.store ? " at " + b.store : "")
            + " with " + ((host as any)?.display_name || "us") + ". Can't make it? " + link, b.store);
        }
        if (b.candidate_email) {
          await sendEmail(b.candidate_email, "Reminder: your CPR interview " + when,
            candidateText(b, (host as any)?.display_name || "", await storeAddress(b.store), link,
              "A quick reminder about your interview tomorrow."));
        }
        await admin.from("interview_bookings").update({ reminded_24h: true }).eq("id", b.id);
        sent++;
      }
      return json({ ok: true, reminded: sent });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
