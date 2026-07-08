// twilio-call — automated customer voice calls (myRepairTools)
//
// The voice sibling of the `messaging` (RingCentral SMS) function. Places an
// automated "your repair is ready" call via Twilio, FROM the store's own
// RingCentral number once that number is added as a Verified Caller ID in
// the Twilio console (voice calls may present any verified number — that's
// the whole trick: Twilio does the calling, the store's line does the
// talking). Falls back to a Twilio-owned number when the store's line isn't
// verified yet. Every attempt logs to `call_log`.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.
// Actions:
//   status — account type (trial/full), verified caller IDs, owned numbers,
//            per-store from-number readiness (for Settings → Integrations)
//   call   — {to, store, ticket_no, template_key, agent_name,
//             customer_name, device} → place the ready-for-pickup call
//
// Deploy with verify_jwt OFF — the extension calls through bg.js with the
// public anon key (same trust model as `messaging`; the Twilio creds never
// leave this function).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TW_BASE = `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}`;

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function e164(raw: string): string | null {
  let s = String(raw || "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (!s.startsWith("+")) {
    if (s.length === 10) s = "+1" + s;
    else if (s.length === 11 && s.startsWith("1")) s = "+" + s;
    else return null;
  }
  if (/^\+\d{10,15}$/.test(s)) return s;
  return null;
}

function xmlEsc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function tw(path: string, init?: RequestInit) {
  const r = await fetch(`${TW_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": "Basic " + btoa(`${TW_SID}:${TW_TOKEN}`),
      ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

async function verifiedCallerIds(): Promise<Set<string>> {
  const r = await tw("/OutgoingCallerIds.json?PageSize=100");
  const set = new Set<string>();
  for (const c of (r.data?.outgoing_caller_ids || [])) set.add(c.phone_number);
  return set;
}

async function ownedNumbers(): Promise<string[]> {
  const r = await tw("/IncomingPhoneNumbers.json?PageSize=50");
  return (r.data?.incoming_phone_numbers || []).map((n: any) => n.phone_number);
}

// store → its line, alias-tolerant (mirror of messaging's lineForStore)
async function lineFor(raw: string | null | undefined): Promise<{ store: string; sms_number: string } | null> {
  if (!raw) return null;
  const q = String(raw).trim().toLowerCase();
  const { data } = await admin.from("store_lines").select("store, sms_number, aliases").eq("active", true);
  for (const l of (data || [])) {
    if (l.store.toLowerCase() === q) return l;
    if ((Array.isArray(l.aliases) ? l.aliases : []).some((a: string) => String(a).toLowerCase() === q)) return l;
  }
  return null;
}

/* ---------------- actions ---------------- */

async function actionStatus() {
  if (!TW_SID || !TW_TOKEN) return json({ ok: false, error: "Twilio secrets not configured" }, 500);
  const acct = await tw(".json");
  const verified = await verifiedCallerIds();
  const owned = await ownedNumbers();
  const { data: lines } = await admin.from("store_lines").select("store, sms_number").eq("active", true);
  return json({
    ok: acct.ok,
    account: { name: acct.data?.friendly_name || null, type: acct.data?.type || null, status: acct.data?.status || null },
    trial: String(acct.data?.type || "").toLowerCase() === "trial",
    owned_numbers: owned,
    verified_caller_ids: [...verified],
    stores: (lines || []).map((l: any) => ({
      store: l.store,
      number: l.sms_number,
      // verified = calls can present the store's own RingCentral number
      verified: verified.has(l.sms_number),
    })),
  });
}

async function actionCall(payload: any, sentBy: { id?: string; name?: string }) {
  if (!TW_SID || !TW_TOKEN) return json({ ok: false, error: "Twilio secrets not configured" }, 500);
  const to = e164(payload?.to || "");
  if (!to) return json({ ok: false, error: "Invalid destination number" }, 400);

  // FROM: the store's own line when it's a verified caller ID, else a
  // Twilio-owned number so the call still goes out.
  const line = await lineFor(payload?.store);
  const store = line ? line.store : (payload?.store || null);
  const verified = await verifiedCallerIds();
  let from: string | null = null;
  if (line && verified.has(line.sms_number)) from = line.sms_number;
  if (!from) from = (await ownedNumbers())[0] || null;
  if (!from) return json({ ok: false, error: "No usable caller ID — verify the store number or buy a Twilio number" }, 400);

  // spoken message — plain, slow, said twice (voicemail-friendly)
  const name = String(payload?.customer_name || "").trim().split(/\s+/)[0] || "";
  const device = String(payload?.device || "").trim();
  const storeSpoken = String(store || "CPR Cell Phone Repair").replace(/\s+OR$/i, "").replace(/^CPR\s*/i, "");
  const msg = `Hi${name ? " " + name : ""}! This is C P R Cell Phone Repair${storeSpoken ? ", " + storeSpoken : ""}, with good news: your ${device || "repair"} is ready for pickup. Come by during business hours — see you soon!`;
  const twiml =
    `<Response><Pause length="1"/>` +
    `<Say voice="Polly.Joanna">${xmlEsc(msg)}</Say>` +
    `<Pause length="1"/><Say voice="Polly.Joanna">Once more: ${xmlEsc(msg)}</Say>` +
    `<Say voice="Polly.Joanna">Goodbye!</Say></Response>`;

  const body = new URLSearchParams({ To: to, From: from, Twiml: twiml });
  let ok = false, sid: string | null = null, err: string | null = null;
  try {
    const r = await tw("/Calls.json", { method: "POST", body: body.toString() });
    ok = r.ok;
    sid = r.data?.sid || null;
    if (!ok) err = r.data?.message || `HTTP ${r.status}`;
  } catch (e) {
    err = String((e as Error).message || e);
  }

  await admin.from("call_log").insert({
    to_number: to, from_number: from, store,
    ticket_no: payload?.ticket_no || null, template_key: payload?.template_key || null,
    status: ok ? "placed" : "failed", twilio_sid: sid, error: err,
    sent_by: sentBy.id || null, sent_by_name: sentBy.name || payload?.agent_name || null,
  });

  return ok ? json({ ok: true, sid, to, from, store }) : json({ ok: false, error: err }, 502);
}

/* ---------------- entry ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let payload: any = {};
  try { payload = await req.json(); } catch { /* empty */ }

  // resolve the signed-in staff member for the audit trail (optional)
  let sentBy: { id?: string; name?: string } = {};
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const { data } = await admin.auth.getUser(authHeader.slice(7));
      if (data?.user) {
        sentBy.id = data.user.id;
        const { data: staff } = await admin.from("staff").select("name").eq("auth_uid", data.user.id).maybeSingle();
        sentBy.name = staff?.name || data.user.email || undefined;
      }
    } catch { /* anonymous */ }
  }

  try {
    if (payload?.action === "status") return await actionStatus();
    if (payload?.action === "call") return await actionCall(payload, sentBy);
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
