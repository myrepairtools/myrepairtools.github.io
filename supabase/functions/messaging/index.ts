/*
    messaging — CPR Oregon SMS via RingCentral (myRepairTools)

    Server-side texting proxy. Holds the RingCentral credentials (JWT auth
    flow) as function secrets; the browser never sees them. Every send is
    logged to sms_log and screened against sms_opt_outs (STOP handling).

    MULTI-STORE: each store texts from its own line. `store_lines` (Supabase)
    maps the canonical RepairQ store name → { sms_number, jwt_secret_key,
    aliases }. One RingCentral app (client id/secret); one Personal JWT per
    store user, stored as the function secret named in jwt_secret_key
    (Salem = the original RINGCENTRAL_JWT). A store whose JWT secret isn't
    set yet falls back to the default line so sends never fail on setup lag.

    Actions (POST JSON { action, ... }):
      - test            → auth + identity per store line (no send)
      - send            → { to, body, store?, ticket_no?, template_key? }
      - poll            → sweep every store's inbox (message-store) for
                          inbound SMS + STOP/START; used by the pg_cron
      - contact_set/get/delete → per-ticket follow-up preference
      - inbound         → RingCentral webhook receiver (kept for the day the
                          app gets webhook permission)

    Auth: browser calls carry the user's Supabase JWT (verify_jwt on); we
    resolve the staff row for the audit trail. The RingCentral webhook path
    authenticates with a shared secret instead.

    Secrets: RINGCENTRAL_CLIENT_ID / _CLIENT_SECRET / _SERVER, per-store JWTs
    (RINGCENTRAL_JWT = Salem/default, RINGCENTRAL_JWT_EUGENE,
    RINGCENTRAL_JWT_CLACKAMAS, …named in store_lines.jwt_secret_key),
    RINGCENTRAL_FROM_NUMBER (default line), plus SUPABASE_URL /
    SUPABASE_SERVICE_ROLE_KEY.
*/

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RC_SERVER = Deno.env.get("RINGCENTRAL_SERVER") || "https://platform.ringcentral.com";
const RC_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID") || "";
const RC_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET") || "";
const RC_JWT_DEFAULT = Deno.env.get("RINGCENTRAL_JWT") || "";
const RC_FROM_DEFAULT = Deno.env.get("RINGCENTRAL_FROM_NUMBER") || "";
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

/* ---------------- store lines (store → number + JWT) ---------------- */

type StoreLine = {
  store: string;
  sms_number: string;
  jwt_secret_key: string | null;
  aliases: string[];
  active: boolean;
  jwt: string;          // resolved secret value ('' when not set yet)
  is_default: boolean;  // this line's JWT === the default JWT
};

let linesCache: { lines: StoreLine[]; exp: number } | null = null;

async function storeLines(): Promise<StoreLine[]> {
  if (linesCache && Date.now() < linesCache.exp) return linesCache.lines;
  const { data } = await admin.from("store_lines").select("*").eq("active", true);
  const lines: StoreLine[] = (data || []).map((r: any) => {
    const jwt = r.jwt_secret_key ? (Deno.env.get(r.jwt_secret_key) || "") : "";
    return {
      store: r.store,
      sms_number: r.sms_number,
      jwt_secret_key: r.jwt_secret_key,
      aliases: Array.isArray(r.aliases) ? r.aliases : [],
      active: r.active,
      jwt,
      is_default: !!jwt && jwt === RC_JWT_DEFAULT,
    };
  });
  linesCache = { lines, exp: Date.now() + 60_000 };   // 1-min cache per instance
  return lines;
}

// Resolve any raw store string (canonical name, alias, RC label) to its line.
async function lineForStore(raw: string | null | undefined): Promise<StoreLine | null> {
  if (!raw) return null;
  const q = String(raw).trim().toLowerCase();
  if (!q) return null;
  for (const l of await storeLines()) {
    if (l.store.toLowerCase() === q) return l;
    if (l.aliases.some((a) => String(a).toLowerCase() === q)) return l;
  }
  return null;
}

/* ---------------- RingCentral auth (JWT → access token, cached per JWT) ---------------- */

const tokenCache = new Map<string, { token: string; exp: number }>();

async function rcToken(jwt?: string): Promise<string> {
  const assertion = jwt || RC_JWT_DEFAULT;
  if (!assertion) throw new Error("No RingCentral JWT configured");
  const key = assertion.slice(-24);   // cache key: JWT tail, never logged
  const hit = tokenCache.get(key);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);
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
  tokenCache.set(key, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

async function rcGet(path: string, jwt?: string) {
  const t = await rcToken(jwt);
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
  // Per-store line status: which stores have a JWT in place, and whether it
  // authenticates. No sends. Used by Settings → Integrations → RingCentral.
  const lines = await storeLines();
  const stores: any[] = [];
  for (const l of lines) {
    const entry: any = {
      store: l.store,
      number: l.sms_number,
      jwt_secret_key: l.jwt_secret_key,
      jwt_set: !!l.jwt,
      fallback: !l.jwt,          // sends fall back to the default line
      authenticated: false as boolean | null,
      extension: null as string | null,
      error: null as string | null,
    };
    if (l.jwt) {
      try {
        const info = await rcGet("/restapi/v1.0/account/~/extension/~", l.jwt);
        entry.authenticated = info.ok;
        entry.extension = info.data?.name || info.data?.extensionNumber || null;
        if (!info.ok) entry.error = info.data?.message || `HTTP ${info.status}`;
      } catch (e) {
        entry.error = String((e as Error).message || e);
      }
    }
    stores.push(entry);
  }
  // default-line identity (what fallback sends go out as)
  let defaultExt: string | null = null, defaultOk = false, defaultErr: string | null = null;
  try {
    const info = await rcGet("/restapi/v1.0/account/~/extension/~");
    defaultOk = info.ok;
    defaultExt = info.data?.name || info.data?.extensionNumber || null;
    if (!info.ok) defaultErr = info.data?.message || `HTTP ${info.status}`;
  } catch (e) {
    defaultErr = String((e as Error).message || e);
  }
  return json({
    ok: true,
    default_line: { number: RC_FROM_DEFAULT || null, authenticated: defaultOk, extension: defaultExt, error: defaultErr },
    stores,
  });
}

async function actionSend(payload: any, sentBy: { id?: string; name?: string }) {
  const to = e164(payload?.to || "");
  const body = (payload?.body || "").toString().trim();
  if (!to) return json({ ok: false, error: "Invalid destination number" }, 400);
  if (!body) return json({ ok: false, error: "Empty message" }, 400);

  // Resolve the sending line from the store (extension passes the RepairQ
  // header name, which IS the canonical store name). Unknown store or a
  // store whose JWT isn't minted yet → default line, so sends never bounce.
  const line = await lineForStore(payload?.store);
  const from = (line && line.jwt) ? line.sms_number : RC_FROM_DEFAULT;
  const jwt = (line && line.jwt) ? line.jwt : RC_JWT_DEFAULT;
  const store = line ? line.store : (payload?.store || null);
  if (!from) return json({ ok: false, error: "No sending line configured (RINGCENTRAL_FROM_NUMBER)" }, 400);

  if (await isOptedOut(to)) {
    await admin.from("sms_log").insert({
      to_number: to, from_number: from, store, body, ticket_no: payload?.ticket_no || null,
      template_key: payload?.template_key || null, status: "failed",
      error: "recipient opted out", sent_by: sentBy.id || null, sent_by_name: sentBy.name || null,
    });
    return json({ ok: false, error: "This number has opted out of texts (replied STOP)." }, 409);
  }

  // append a one-time opt-out hint on non-conversational (templated) sends
  const finalBody = payload?.template_key ? body + "\n\nReply STOP to opt out." : body;

  let rc: any, ok = false, rcId: string | null = null, err: string | null = null;
  try {
    const t = await rcToken(jwt);
    const r = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/sms`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text: finalBody }),
    });
    rc = await r.json();
    ok = r.ok;
    rcId = rc?.id ? String(rc.id) : null;
    if (!ok) err = rc?.message || rc?.errorCode || `HTTP ${r.status}`;
  } catch (e) {
    err = String((e as Error).message || e);
  }

  await admin.from("sms_log").insert({
    to_number: to, from_number: from, store, body: finalBody, ticket_no: payload?.ticket_no || null,
    template_key: payload?.template_key || null, status: ok ? "sent" : "failed",
    rc_message_id: rcId, error: err, sent_by: sentBy.id || null,
    // extension sends (no Supabase session) pass the RepairQ tech name for the audit trail
    sent_by_name: sentBy.name || payload?.agent_name || null,
  });

  return ok ? json({ ok: true, id: rcId, to, from, store }) : json({ ok: false, error: err }, 502);
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

/* ---------------- per-ticket follow-up contact ---------------- */

async function actionContactSet(payload: any, sentBy: { id?: string; name?: string }) {
  const ticket = String(payload?.ticket_no || "").replace(/\D/g, "");
  if (!ticket) return json({ ok: false, error: "ticket_no required" }, 400);
  const method = ["text", "call", "email", "return", "skip"].includes(payload?.method) ? payload.method : "text";
  // normalize the store to its canonical name when we recognize it
  const line = await lineForStore(payload?.store);
  const row = {
    ticket_no: ticket,
    store: line ? line.store : (payload?.store || null),
    method,
    contact_name: payload?.name || null,
    contact_number: method === "email" ? null : (e164(payload?.number || "") || payload?.number || null),
    contact_email: payload?.email || null,
    note: payload?.note || null,
    set_by_name: sentBy.name || payload?.agent_name || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from("ticket_contacts").upsert(row, { onConflict: "ticket_no" });
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true });
}

async function actionContactGet(payload: any) {
  const ticket = String(payload?.ticket_no || "").replace(/\D/g, "");
  if (!ticket) return json({ ok: false, error: "ticket_no required" }, 400);
  const { data } = await admin.from("ticket_contacts").select("*").eq("ticket_no", ticket).maybeSingle();
  return json({ ok: true, contact: data || null });
}

async function actionContactDelete(payload: any) {
  const ticket = String(payload?.ticket_no || "").replace(/\D/g, "");
  if (!ticket) return json({ ok: false, error: "ticket_no required" }, 400);
  await admin.from("ticket_contacts").delete().eq("ticket_no", ticket);
  return json({ ok: true });
}

/* ---------------- inbound ---------------- */

async function pollInbox(jwt: string, store: string | null, toNumber: string | null, back: number) {
  // One extension's inbox: record unseen inbound SMS, honor STOP/START.
  const r = await rcGet(
    "/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&direction=Inbound&perPage=100&dateFrom=" +
    new Date(Date.now() - back).toISOString(),
    jwt,
  );
  if (!r.ok) return { store, ok: false, error: r.data?.message || `HTTP ${r.status}`, scanned: 0, recorded: 0, opt_outs: 0 };
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
      direction: "in", to_number: toNumber, from_number: from, store, body: text,
      status: "received", rc_message_id: rcId,
    });
    recorded++;
  }
  return { store, ok: true, scanned: recs.length, recorded, opt_outs: optOuts };
}

async function actionPoll(hours?: number) {
  // No-webhook path: sweep EVERY configured store's inbox. Stores without a
  // minted JWT are skipped (their line's texts land in the default inbox only
  // if the numbers share an extension — they don't — so those stores simply
  // have no inbound until their JWT goes in). The default JWT's inbox is
  // always swept, deduped against any store line using the same JWT.
  const back = Math.max(1, Math.min(720, hours || 24)) * 3600e3;
  const lines = await storeLines();
  const results: any[] = [];
  const sweptJwtTails = new Set<string>();
  for (const l of lines) {
    if (!l.jwt) { results.push({ store: l.store, ok: false, skipped: true, error: "JWT not set" }); continue; }
    const tail = l.jwt.slice(-24);
    if (sweptJwtTails.has(tail)) continue;    // two stores on one JWT — sweep once
    sweptJwtTails.add(tail);
    results.push(await pollInbox(l.jwt, l.store, l.sms_number, back));
  }
  // the default JWT, if no store line claimed it (pre-migration safety)
  if (RC_JWT_DEFAULT && !sweptJwtTails.has(RC_JWT_DEFAULT.slice(-24))) {
    results.push(await pollInbox(RC_JWT_DEFAULT, null, RC_FROM_DEFAULT || null, back));
  }
  const totals = results.reduce((t, r) => ({
    scanned: t.scanned + (r.scanned || 0), recorded: t.recorded + (r.recorded || 0), opt_outs: t.opt_outs + (r.opt_outs || 0),
  }), { scanned: 0, recorded: 0, opt_outs: 0 });
  return json({ ok: true, ...totals, stores: results });
}

async function actionInbound(req: Request, raw: any) {
  // RingCentral webhook — validation handshake + inbound message store
  const vt = req.headers.get("validation-token");
  if (vt) return new Response("", { status: 200, headers: { ...cors, "Validation-Token": vt } });

  for (const ev of raw?.body?.length ? raw.body : [raw?.body].filter(Boolean)) {
    const from = e164(ev?.from?.phoneNumber || "");
    const text = (ev?.subject || "").toString();
    const to = e164(ev?.to?.[0]?.phoneNumber || "") || RC_FROM_DEFAULT;
    if (!from) continue;
    if (STOP_RE.test(text)) await admin.from("sms_opt_outs").upsert({ phone: from, source: "sms:STOP" });
    if (START_RE.test(text)) await admin.from("sms_opt_outs").delete().eq("phone", from);
    const lines = await storeLines();
    const line = lines.find((l) => l.sms_number === to) || null;
    await admin.from("sms_log").insert({
      direction: "in", to_number: to, from_number: from, store: line?.store || null, body: text, status: "received",
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
    if (payload?.action === "contact_set") return await actionContactSet(payload, sentBy);
    if (payload?.action === "contact_get") return await actionContactGet(payload);
    if (payload?.action === "contact_delete") return await actionContactDelete(payload);
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
