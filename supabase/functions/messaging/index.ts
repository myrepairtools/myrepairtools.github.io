/*
    messaging — CPR Oregon SMS via RingCentral (myRepairTools)

    Server-side texting proxy. Holds the RingCentral credentials (JWT auth
    flow) as function secrets; the browser never sees them. Every send is
    logged to sms_log and screened against sms_opt_outs (STOP handling).

    Actions (POST JSON { action, ... }):
      - test            → { ok, from, extension }   auth + identity check, no send
      - send            → { to, body, ticket_no?, template_key? }  send one SMS
      - inbound         → RingCentral webhook receiver (records replies, STOP)

    Auth: browser calls carry the user's Supabase JWT (verify_jwt on); we
    resolve the staff row for the audit trail. The RingCentral webhook path
    authenticates with a shared header secret instead.

    Secrets: RINGCENTRAL_CLIENT_ID / _CLIENT_SECRET / _JWT / _SERVER /
    _FROM_NUMBER, plus SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
*/

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RC_SERVER = Deno.env.get("RINGCENTRAL_SERVER") || "https://platform.ringcentral.com";
const RC_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID") || "";
const RC_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET") || "";
const RC_JWT = Deno.env.get("RINGCENTRAL_JWT") || "";
const RC_FROM = Deno.env.get("RINGCENTRAL_FROM_NUMBER") || "";
const WEBHOOK_SECRET = Deno.env.get("RINGCENTRAL_WEBHOOK_SECRET") || "";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cpr-webhook",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

/* ---------------- RingCentral auth (JWT → access token, cached) ---------------- */

let tokenCache: { token: string; exp: number } | null = null;

async function rcToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", RC_JWT);
  const r = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${RC_ID}:${RC_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error("RingCentral auth failed: " + (data.error_description || data.message || JSON.stringify(data)));
  }
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function rcGet(path: string) {
  const t = await rcToken();
  const r = await fetch(`${RC_SERVER}${path}`, { headers: { "Authorization": `Bearer ${t}` } });
  return { ok: r.ok, status: r.status, data: await r.json() };
}

/* ---------------- helpers ---------------- */

function e164(raw: string): string | null {
  const s = (raw || "").replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(s)) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;          // US default
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  return null;
}

async function isOptedOut(phone: string): Promise<boolean> {
  const { data } = await admin.from("sms_opt_outs").select("phone").eq("phone", phone).maybeSingle();
  return !!data;
}

const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt-out)\s*$/i;
const START_RE = /^\s*(start|unstop|subscribe|yes)\s*$/i;

/* ---------------- actions ---------------- */

async function actionTest() {
  // exercises auth + identity without sending
  const info = await rcGet("/restapi/v1.0/account/~/extension/~");
  // account-wide numbers (tells us if every store's number is reachable
  // from this one login, which decides one-setup vs per-store creds)
  const acct = await rcGet("/restapi/v1.0/account/~/phone-number?perPage=1000");
  const smsNumbers = (acct.data?.records || [])
    .filter((r: any) => (r.features || []).includes("SmsSender"))
    .map((r: any) => ({
      number: r.phoneNumber,
      label: r.label || null,
      extension: r.extension?.name || null,
      extensionNumber: r.extension?.extensionNumber || null,
      usageType: r.usageType,
    }));
  return json({
    ok: true,
    authenticated: true,
    this_extension: info.data?.name || info.data?.extensionNumber || null,
    from_configured: RC_FROM || null,
    account_sms_numbers: smsNumbers,
    note: smsNumbers.length > 1
      ? "Multiple SMS numbers visible on one login — per-store sending from one setup is possible."
      : "One SMS number visible from this login.",
  });
}

async function actionSend(payload: any, sentBy: { id?: string; name?: string }) {
  const to = e164(payload?.to || "");
  const body = (payload?.body || "").toString().trim();
  if (!to) return json({ ok: false, error: "Invalid destination number" }, 400);
  if (!body) return json({ ok: false, error: "Empty message" }, 400);
  if (!RC_FROM) return json({ ok: false, error: "RINGCENTRAL_FROM_NUMBER not set" }, 400);

  if (await isOptedOut(to)) {
    await admin.from("sms_log").insert({
      to_number: to, from_number: RC_FROM, body, ticket_no: payload?.ticket_no || null,
      template_key: payload?.template_key || null, status: "failed",
      error: "recipient opted out", sent_by: sentBy.id || null, sent_by_name: sentBy.name || null,
    });
    return json({ ok: false, error: "This number has opted out of texts (replied STOP)." }, 409);
  }

  // append a one-time opt-out hint on non-conversational (templated) sends
  const finalBody = payload?.template_key ? body + "\n\nReply STOP to opt out." : body;

  let rc: any, ok = false, rcId: string | null = null, err: string | null = null;
  try {
    const t = await rcToken();
    const r = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/sms`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: RC_FROM }, to: [{ phoneNumber: to }], text: finalBody }),
    });
    rc = await r.json();
    ok = r.ok;
    rcId = rc?.id ? String(rc.id) : null;
    if (!ok) err = rc?.message || rc?.errorCode || `HTTP ${r.status}`;
  } catch (e) {
    err = String((e as Error).message || e);
  }

  await admin.from("sms_log").insert({
    to_number: to, from_number: RC_FROM, body: finalBody, ticket_no: payload?.ticket_no || null,
    template_key: payload?.template_key || null, status: ok ? "sent" : "failed",
    rc_message_id: rcId, error: err, sent_by: sentBy.id || null,
    // extension sends (no Supabase session) pass the RepairQ tech name for the audit trail
    sent_by_name: sentBy.name || payload?.agent_name || null,
  });

  return ok ? json({ ok: true, id: rcId, to }) : json({ ok: false, error: err }, 502);
}

const SELF_URL = `${SB_URL.replace(".supabase.co", ".functions.supabase.co")}/messaging`;

async function actionSubscriptions() {
  const r = await rcGet("/restapi/v1.0/subscription");
  const subs = (r.data?.records || []).map((s: any) => ({
    id: s.id, status: s.status, address: s.deliveryMode?.address, filters: s.eventFilters, expires: s.expirationTime,
  }));
  return json({ ok: true, subscriptions: subs });
}

async function actionSubscribe() {
  // (re)create the inbound-SMS webhook pointing back at this function
  const t = await rcToken();
  // clear stale subscriptions to our endpoint first
  const existing = await rcGet("/restapi/v1.0/subscription");
  for (const s of (existing.data?.records || [])) {
    if (s.deliveryMode?.address?.includes("/messaging")) {
      await fetch(`${RC_SERVER}/restapi/v1.0/subscription/${s.id}`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${t}` },
      });
    }
  }
  const r = await fetch(`${RC_SERVER}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      eventFilters: ["/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"],
      deliveryMode: {
        transportType: "WebHook",
        address: `${SELF_URL}?webhook=${encodeURIComponent(WEBHOOK_SECRET)}`,
      },
      expiresIn: 630720000, // ~20y; RC caps it, renew action can refresh
    }),
  });
  const data = await r.json();
  if (!r.ok) return json({ ok: false, error: data.message || JSON.stringify(data), detail: data }, 502);
  return json({ ok: true, subscription_id: data.id, status: data.status, expires: data.expirationTime });
}

async function actionPoll(hours?: number) {
  // No-webhook path: read recent inbound SMS from the message store and
  // record any we haven't seen (dedup on rc_message_id). Honors STOP/START.
  // Default 24h window (plenty for the frequent cron); pass hours for a
  // wider one-time catch-up.
  const back = Math.max(1, Math.min(720, hours || 24)) * 3600e3;
  const r = await rcGet(
    "/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&direction=Inbound&perPage=100&dateFrom=" +
    new Date(Date.now() - back).toISOString(),
  );
  if (!r.ok) return json({ ok: false, error: r.data?.message || `HTTP ${r.status}`, detail: r.data }, 502);
  // Apply in CHRONOLOGICAL order so the customer's most recent STOP/START wins
  // (RingCentral returns newest-first).
  const recs = (r.data?.records || []).slice().sort((a: any, b: any) =>
    String(a.creationTime || a.id).localeCompare(String(b.creationTime || b.id)));
  let recorded = 0, optOuts = 0;
  for (const m of recs) {
    const rcId = String(m.id);
    const { data: seen } = await admin.from("sms_log").select("id").eq("rc_message_id", rcId).maybeSingle();
    if (seen) continue;
    const from = e164(m.from?.phoneNumber || "");
    const text = (m.subject || "").toString();
    if (!from) continue;
    if (STOP_RE.test(text)) { await admin.from("sms_opt_outs").upsert({ phone: from, source: "sms:STOP" }); optOuts++; }
    if (START_RE.test(text)) await admin.from("sms_opt_outs").delete().eq("phone", from);
    await admin.from("sms_log").insert({
      direction: "in", to_number: RC_FROM, from_number: from, body: text,
      status: "received", rc_message_id: rcId,
    });
    recorded++;
  }
  return json({ ok: true, scanned: recs.length, recorded, opt_outs: optOuts });
}

async function actionInbound(req: Request, raw: any) {
  // RingCentral webhook — validation handshake + inbound message store
  const vt = req.headers.get("validation-token");
  if (vt) return new Response("", { status: 200, headers: { ...cors, "Validation-Token": vt } });

  for (const ev of raw?.body?.length ? raw.body : [raw?.body].filter(Boolean)) {
    const from = e164(ev?.from?.phoneNumber || "");
    const text = (ev?.subject || "").toString();
    if (!from) continue;
    if (STOP_RE.test(text)) await admin.from("sms_opt_outs").upsert({ phone: from, source: "sms:STOP" });
    if (START_RE.test(text)) await admin.from("sms_opt_outs").delete().eq("phone", from);
    await admin.from("sms_log").insert({
      direction: "in", to_number: RC_FROM, from_number: from, body: text, status: "received",
    });
  }
  return json({ ok: true });
}

/* ---------------- entry ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let payload: any = {};
  try { payload = await req.json(); } catch { /* webhook may send empty */ }

  // webhook path: RingCentral posts here (no user JWT). It authenticates via
  // the ?webhook=<secret> query param (RC can't set custom headers), or the
  // Validation-Token handshake header on subscription creation.
  const url = new URL(req.url);
  const qSecret = url.searchParams.get("webhook");
  const hookSecret = req.headers.get("x-cpr-webhook") || qSecret;
  const isValidation = !!req.headers.get("validation-token");
  if (payload?.action === "inbound" || hookSecret || isValidation) {
    if (!isValidation && WEBHOOK_SECRET && hookSecret !== WEBHOOK_SECRET) {
      return json({ ok: false, error: "bad webhook secret" }, 401);
    }
    return actionInbound(req, payload);
  }

  // resolve the signed-in staff member for the audit trail
  let sentBy: { id?: string; name?: string } = {};
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const { data } = await admin.auth.getUser(authHeader.slice(7));
      if (data?.user) {
        sentBy.id = data.user.id;
        const { data: staff } = await admin.from("staff").select("name").eq("auth_uid", data.user.id).maybeSingle();
        sentBy.name = staff?.name || data.user.email || null;
      }
    } catch { /* leave anonymous */ }
  }

  try {
    if (payload?.action === "test") return await actionTest();
    if (payload?.action === "send") return await actionSend(payload, sentBy);
    if (payload?.action === "subscribe") return await actionSubscribe();
    if (payload?.action === "subscriptions") return await actionSubscriptions();
    if (payload?.action === "poll") return await actionPoll(payload?.hours);
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
