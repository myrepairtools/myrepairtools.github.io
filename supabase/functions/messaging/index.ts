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
  // Optional per-store APP credentials: some store users' developer-portal
  // orgs can't authorize the main app, so their JWTs are bound to an app
  // THEY own. RINGCENTRAL_APP_KEY_<suffix> / RINGCENTRAL_APP_SECRET_<suffix>
  // (suffix from jwt_secret_key, e.g. _EUGENE) switch the token exchange to
  // that app; unset → the main app's credentials.
  app_key: string;
  app_secret: string;
};

let linesCache: { lines: StoreLine[]; exp: number } | null = null;

async function storeLines(): Promise<StoreLine[]> {
  if (linesCache && Date.now() < linesCache.exp) return linesCache.lines;
  const { data } = await admin.from("store_lines").select("*").eq("active", true);
  const lines: StoreLine[] = (data || []).map((r: any) => {
    const jwt = r.jwt_secret_key ? (Deno.env.get(r.jwt_secret_key) || "") : "";
    const suffix = r.jwt_secret_key ? String(r.jwt_secret_key).replace(/^RINGCENTRAL_JWT_?/, "") : "";
    return {
      store: r.store,
      sms_number: r.sms_number,
      jwt_secret_key: r.jwt_secret_key,
      aliases: Array.isArray(r.aliases) ? r.aliases : [],
      active: r.active,
      jwt,
      is_default: !!jwt && jwt === RC_JWT_DEFAULT,
      app_key: suffix ? (Deno.env.get(`RINGCENTRAL_APP_KEY_${suffix}`) || "") : "",
      app_secret: suffix ? (Deno.env.get(`RINGCENTRAL_APP_SECRET_${suffix}`) || "") : "",
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

// Read the cross-instance token cache (rc_tokens, service-role only).
async function dbToken(key: string): Promise<{ token: string; exp: number } | null> {
  try {
    const { data } = await admin.from("rc_tokens").select("token, exp").eq("cache_key", key).maybeSingle();
    if (data && new Date(data.exp).getTime() - 60_000 > Date.now()) {
      return { token: data.token, exp: new Date(data.exp).getTime() };
    }
  } catch { /* cache optional */ }
  return null;
}

async function rcToken(jwt?: string, appKey?: string, appSecret?: string): Promise<string> {
  const assertion = jwt || RC_JWT_DEFAULT;
  const cid = appKey || RC_ID;
  const csec = appSecret || RC_SECRET;
  if (!assertion) throw new Error("No RingCentral JWT configured");
  const key = cid.slice(-8) + ":" + assertion.slice(-24);   // cache key: app + JWT tails, never logged
  const hit = tokenCache.get(key);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;

  // Cross-instance cache: every cold edge instance starts with an empty
  // memory cache, and RingCentral rate-limits the token endpoint hard — a
  // redeploy (or scale-up) used to stampede it with one exchange per store
  // per instance. Share tokens through Postgres so the whole fleet re-uses
  // one token per line.
  const shared = await dbToken(key);
  if (shared) { tokenCache.set(key, shared); return shared.token; }

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);
  const r = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${cid}:${csec}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    const msg = data.error_description || data.message || JSON.stringify(data);
    // Rate-limited? Another instance is likely mid-exchange for this same
    // line — give it a beat and trust ITS token instead of failing the user.
    if (/rate/i.test(String(msg))) {
      await new Promise((res) => setTimeout(res, 2000));
      const again = await dbToken(key);
      if (again) { tokenCache.set(key, again); return again.token; }
    }
    throw new Error("RingCentral auth failed: " + msg);
  }
  const exp = Date.now() + (data.expires_in || 3600) * 1000;
  tokenCache.set(key, { token: data.access_token, exp });
  try {
    await admin.from("rc_tokens").upsert({
      cache_key: key, token: data.access_token,
      exp: new Date(exp).toISOString(), updated_at: new Date().toISOString(),
    });
  } catch { /* cache optional */ }
  return data.access_token;
}

async function rcGet(path: string, jwt?: string, appKey?: string, appSecret?: string) {
  const t = await rcToken(jwt, appKey, appSecret);
  const r = await fetch(`${RC_SERVER}${path}`, { headers: { "Authorization": `Bearer ${t}` } });
  return { ok: r.ok, status: r.status, data: await r.json() };
}

async function rcPut(path: string, body: unknown, jwt?: string, appKey?: string, appSecret?: string) {
  const t = await rcToken(jwt, appKey, appSecret);
  const r = await fetch(`${RC_SERVER}${path}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
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
        const info = await rcGet("/restapi/v1.0/account/~/extension/~", l.jwt, l.app_key, l.app_secret);
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
  let sentFrom = from;
  try {
    // A store JWT that's set but broken (revoked, minted against the wrong
    // app) must not bounce customer texts — fall back to the default line,
    // same as a store with no JWT at all.
    let t: string;
    try {
      t = await rcToken(jwt, line?.app_key, line?.app_secret);
    } catch (e) {
      if (jwt !== RC_JWT_DEFAULT && RC_JWT_DEFAULT && RC_FROM_DEFAULT) {
        t = await rcToken(RC_JWT_DEFAULT);
        sentFrom = RC_FROM_DEFAULT;
      } else throw e;
    }
    const r = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/sms`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: sentFrom }, to: [{ phoneNumber: to }], text: finalBody }),
    });
    rc = await r.json();
    ok = r.ok;
    rcId = rc?.id ? String(rc.id) : null;
    if (!ok) err = rc?.message || rc?.errorCode || `HTTP ${r.status}`;
  } catch (e) {
    err = String((e as Error).message || e);
  }

  await admin.from("sms_log").insert({
    to_number: to, from_number: sentFrom, store, body: finalBody, ticket_no: payload?.ticket_no || null,
    template_key: payload?.template_key || null, status: ok ? "sent" : "failed",
    rc_message_id: rcId, error: err, sent_by: sentBy.id || null,
    // extension sends (no Supabase session) pass the RepairQ tech name for the audit trail
    sent_by_name: sentBy.name || payload?.agent_name || null,
  });

  return ok ? json({ ok: true, id: rcId, to, from: sentFrom, store }) : json({ ok: false, error: err }, 502);
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

// Resolve an editable customer-message template for a store: the store's own
// override wins, else the shared default (store is null). The body carries
// {short codes} the caller fills in per send. Returns body:null if unset so the
// extension can fall back to its built-in wording.
async function actionTemplateGet(payload: any) {
  const key = String(payload?.key || payload?.template_key || "").trim();
  if (!key) return json({ ok: false, error: "key required" }, 400);
  const line = await lineForStore(payload?.store);
  const store = line ? line.store : (payload?.store ? String(payload.store) : null);
  if (store) {
    const { data } = await admin.from("message_templates").select("body").eq("template_key", key).eq("store", store).maybeSingle();
    if (data?.body) return json({ ok: true, body: data.body, source: "store" });
  }
  const { data } = await admin.from("message_templates").select("body").eq("template_key", key).is("store", null).maybeSingle();
  if (data?.body) return json({ ok: true, body: data.body, source: "default" });
  return json({ ok: true, body: null, source: "none" });
}

async function actionContactDelete(payload: any) {
  const ticket = String(payload?.ticket_no || "").replace(/\D/g, "");
  if (!ticket) return json({ ok: false, error: "ticket_no required" }, 400);
  await admin.from("ticket_contacts").delete().eq("ticket_no", ticket);
  return json({ ok: true });
}

/* ---------------- read views (RC panel: inbox / calls / voicemail) ---------------- */

// Resolve the store to a usable (jwt, app creds) tuple; fall back to the
// default line so a store without its own JWT still shows *something*.
function lineAuth(line: StoreLine | null) {
  if (line && line.jwt) return { jwt: line.jwt, appKey: line.app_key, appSecret: line.app_secret, from: line.sms_number, store: line.store };
  return { jwt: RC_JWT_DEFAULT, appKey: undefined as string | undefined, appSecret: undefined as string | undefined, from: RC_FROM_DEFAULT, store: null as string | null };
}

function prettyName(rec: any, party: any): string {
  const n = (party?.name || "").toString().trim();
  return n;
}
function prettyNum(n: string): string {
  const d = String(n || "").replace(/\D/g, "");
  const x = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  return x.length === 10 ? `${x.slice(0, 3)}-${x.slice(3, 6)}-${x.slice(6)}` : (n || "");
}

// SMS conversations — newest message per counterparty, with unread counts.
async function actionConversations(payload: any) {
  const line = await lineForStore(payload?.store);
  const a = lineAuth(line);
  if (!a.jwt) return json({ ok: false, error: "No line configured for this store" }, 400);
  const days = Math.max(1, Math.min(90, Number(payload?.days) || 30));
  const dateFrom = new Date(Date.now() - days * 864e5).toISOString();
  const r = await rcGet(`/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&perPage=250&dateFrom=${dateFrom}`, a.jwt, a.appKey, a.appSecret);
  if (!r.ok) return json({ ok: false, error: r.data?.message || `HTTP ${r.status}`, status: r.status });

  const threads: Record<string, any> = {};
  for (const m of (r.data?.records || [])) {
    const inbound = m.direction === "Inbound";
    const party = inbound ? m.from : (Array.isArray(m.to) ? m.to[0] : m.to);
    const num = e164(party?.phoneNumber || "");
    if (!num) continue;
    const key = num;
    const t = threads[key] || (threads[key] = { number: num, name: prettyName(m, party), last_text: "", last_time: "", last_dir: "", unread: 0 });
    if (!t.name) t.name = prettyName(m, party);
    if (inbound && /unread/i.test(m.readStatus || "")) t.unread++;
    if (!t.last_time || String(m.creationTime) > t.last_time) {
      t.last_time = m.creationTime; t.last_text = (m.subject || "").toString(); t.last_dir = inbound ? "in" : "out";
    }
  }
  // hide internal manager-alert numbers (SLA recipients) from the customer inbox
  const internal = await internalNumbers();
  const list = Object.values(threads)
    .filter((t: any) => !internal.has(t.number))
    .sort((x: any, y: any) => String(y.last_time).localeCompare(String(x.last_time)));
  return json({ ok: true, store: line?.store || a.store, conversations: list });
}

let internalCache: { nums: Set<string>; exp: number } | null = null;
async function internalNumbers(): Promise<Set<string>> {
  if (internalCache && Date.now() < internalCache.exp) return internalCache.nums;
  const { data } = await admin.from("sms_sla_recipients").select("phone").eq("active", true);
  const nums = new Set<string>((data || []).map((r: any) => e164(r.phone) || "").filter(Boolean));
  internalCache = { nums, exp: Date.now() + 60_000 };
  return nums;
}

// A short closing pleasantry ("thanks!", "sounds good", "👍") rarely needs a
// reply — don't nag managers about those.
function needsReply(text: string): boolean {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (t.length <= 42 && /^(thank|thanks|thx|ty\b|ok\b|okay|k\b|great|awesome|perfect|sounds good|will do|got it|see you|see ya|no problem|np\b|cool|👍|🙏|❤|😊|👌)/.test(t)) return false;
  return true;
}

// Response-time watchdog: alert managers when a customer's inbound text has
// gone unanswered past the threshold. Reads RingCentral directly, so a reply
// made in the RC app (not just our panel) counts. Cron-driven.
async function actionSlaCheck() {
  const { data: cfg } = await admin.from("sms_sla_config").select("*").eq("id", 1).maybeSingle();
  if (cfg && cfg.enabled === false) return json({ ok: true, alerts: 0, disabled: true, detail: [] });
  const THRESH = Math.max(1, Number(cfg?.threshold_min ?? 5)) * 60e3;   // unanswered longer than this → alert
  const COOLDOWN = Math.max(1, Number(cfg?.cooldown_min ?? 30)) * 60e3;  // at most one alert per conversation per window
  const MAXAGE = 12 * 3600e3;     // ignore anything older (no overnight backfill spam)
  const qStart = Number(cfg?.quiet_start ?? 8), qEnd = Number(cfg?.quiet_end ?? 20);
  let hour = 12;
  try { hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date())); } catch { /* default midday */ }
  const quiet = hour < qStart || hour >= qEnd;   // only text alerts inside these Pacific hours

  const { data: recips } = await admin.from("sms_sla_recipients").select("*").eq("active", true);
  const internal = new Set((recips || []).map((x: any) => e164(x.phone) || "").filter(Boolean));
  const lines = await storeLines();
  const now = Date.now();
  let alerts = 0; const detail: any[] = [];

  for (const l of lines) {
    if (!l.jwt) continue;
    const dateFrom = new Date(now - 2 * 864e5).toISOString();
    const r = await rcGet(`/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&perPage=250&dateFrom=${dateFrom}`, l.jwt, l.app_key, l.app_secret);
    if (!r.ok) continue;
    const threads: Record<string, any> = {};
    for (const m of (r.data?.records || [])) {
      const inbound = m.direction === "Inbound";
      const party = inbound ? m.from : (Array.isArray(m.to) ? m.to[0] : m.to);
      const num = e164(party?.phoneNumber || ""); if (!num) continue;
      const t = threads[num] || (threads[num] = { number: num, name: (party?.name || "").toString(), last_time: "", last_dir: "", last_text: "" });
      if (!t.name && party?.name) t.name = String(party.name);
      if (!t.last_time || String(m.creationTime) > t.last_time) { t.last_time = m.creationTime; t.last_dir = inbound ? "in" : "out"; t.last_text = (m.subject || "").toString(); }
    }
    for (const num of Object.keys(threads)) {
      const t = threads[num];
      if (t.last_dir !== "in" || internal.has(num)) continue;   // answered, or an internal number
      if (!needsReply(t.last_text)) continue;                   // short "thanks!"-type closers don't need a nudge
      const age = now - new Date(t.last_time).getTime();
      if (age < THRESH || age > MAXAGE) continue;
      const { data: st } = await admin.from("sms_sla_state").select("*").eq("store", l.store).eq("number", num).maybeSingle();
      if (st && (now - new Date(st.last_alerted_at).getTime()) < COOLDOWN) continue;
      const to = (recips || []).filter((x: any) => !x.store || String(x.store).toLowerCase() === l.store.toLowerCase());
      const mins = Math.round(age / 60000);
      const sending = to.length > 0 && !quiet;
      detail.push({ store: l.store, number: num, mins, recipients: to.length, sending });
      if (sending) {
        const who = t.name || prettyNum(num);
        const body = `⏰ Unanswered text — ${l.store}\n${who} (${prettyNum(num)}) texted ${mins} min ago:\n"${(t.last_text || "").slice(0, 120)}"\nOpen RepairQ to reply.`;
        for (const rcp of to) {
          const dest = e164(rcp.phone); if (!dest) continue;
          await actionSend({ to: dest, body, store: l.store }, { name: "SLA watchdog" });
        }
        alerts++;
        // only stamp the cooldown when we actually alerted, so adding a
        // recipient later doesn't get suppressed by a dry-run stamp
        await admin.from("sms_sla_state").upsert({ store: l.store, number: num, last_inbound: t.last_time, last_alerted_at: new Date(now).toISOString() });
      }
    }
  }
  return json({ ok: true, alerts, quiet, detail });
}

// One conversation's messages (filtered by counterparty number).
async function actionThread(payload: any) {
  const line = await lineForStore(payload?.store);
  const a = lineAuth(line);
  const want = e164(payload?.number || "");
  if (!want) return json({ ok: false, error: "number required" }, 400);
  const days = Math.max(1, Math.min(180, Number(payload?.days) || 60));
  const dateFrom = new Date(Date.now() - days * 864e5).toISOString();
  const r = await rcGet(`/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&perPage=250&dateFrom=${dateFrom}`, a.jwt, a.appKey, a.appSecret);
  if (!r.ok) return json({ ok: false, error: r.data?.message || `HTTP ${r.status}`, status: r.status });
  const msgs = (r.data?.records || []).filter((m: any) => {
    const party = m.direction === "Inbound" ? m.from : (Array.isArray(m.to) ? m.to[0] : m.to);
    return e164(party?.phoneNumber || "") === want;
  }).map((m: any) => ({
    id: String(m.id), dir: m.direction === "Inbound" ? "in" : "out",
    text: (m.subject || "").toString(), time: m.creationTime,
    status: m.messageStatus || m.readStatus || null,
  })).sort((x: any, y: any) => String(x.time).localeCompare(String(y.time)));
  return json({ ok: true, number: want, messages: msgs });
}

// Call log — missed-call focus. Needs the "ReadCallLog" scope on the app.
async function actionCalls(payload: any) {
  const line = await lineForStore(payload?.store);
  const a = lineAuth(line);
  const days = Math.max(1, Math.min(90, Number(payload?.days) || 14));
  const dateFrom = new Date(Date.now() - days * 864e5).toISOString();
  const r = await rcGet(`/restapi/v1.0/account/~/extension/~/call-log?perPage=100&view=Simple&dateFrom=${dateFrom}`, a.jwt, a.appKey, a.appSecret);
  if (!r.ok) return json({ ok: false, error: r.data?.message || `HTTP ${r.status}`, status: r.status, scope_hint: r.status === 403 ? "add ReadCallLog scope to the store's RC app" : undefined });
  const calls = (r.data?.records || []).map((c: any) => {
    const inbound = c.direction === "Inbound";
    const party = inbound ? c.from : c.to;
    return {
      id: String(c.id), dir: inbound ? "in" : "out",
      number: e164(party?.phoneNumber || "") || (party?.phoneNumber || ""),
      name: (party?.name || "").toString(),
      result: c.result || "",              // Missed, Accepted, Voicemail, ...
      missed: /missed|no answer|voicemail|busy|rejected/i.test(c.result || ""),
      time: c.startTime, duration: c.duration || 0,
    };
  });
  return json({ ok: true, store: line?.store || a.store, calls });
}

// Voicemails + transcripts (RingCentral voicemail transcription, if the plan has it).
async function actionVoicemails(payload: any) {
  const line = await lineForStore(payload?.store);
  const a = lineAuth(line);
  const days = Math.max(1, Math.min(90, Number(payload?.days) || 30));
  const dateFrom = new Date(Date.now() - days * 864e5).toISOString();
  const r = await rcGet(`/restapi/v1.0/account/~/extension/~/message-store?messageType=VoiceMail&perPage=50&dateFrom=${dateFrom}`, a.jwt, a.appKey, a.appSecret);
  if (!r.ok) return json({ ok: false, error: r.data?.message || `HTTP ${r.status}`, status: r.status });

  const token = await rcToken(a.jwt, a.appKey, a.appSecret);
  const out: any[] = [];
  for (const m of (r.data?.records || [])) {
    const from = e164(m.from?.phoneNumber || "") || (m.from?.phoneNumber || "");
    let transcript: string | null = null;
    let audioId: string | null = null;
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    for (const at of atts) {
      if (/transcription/i.test(at.type || "")) {
        try {
          const tr = await fetch(`${RC_SERVER}${at.uri.replace(RC_SERVER, "")}`.startsWith("http") ? at.uri : `${RC_SERVER}${at.uri}`, { headers: { Authorization: `Bearer ${token}` } });
          if (tr.ok) transcript = (await tr.text()).trim();
        } catch { /* transcript optional */ }
      } else if (/audio/i.test(at.contentType || "") || at.type === "AudioRecording") {
        audioId = String(at.id);
      }
    }
    out.push({
      id: String(m.id), from, name: (m.from?.name || "").toString(),
      time: m.creationTime, duration: m.vmDuration || 0,
      read: !/unread/i.test(m.readStatus || ""),
      transcript, transcription_status: m.vmTranscriptionStatus || null,
      audio_uri: audioId ? `/restapi/v1.0/account/~/extension/~/message-store/${m.id}/content/${audioId}` : null,
    });
  }
  return json({ ok: true, store: line?.store || a.store, voicemails: out });
}

// Mark a conversation READ in RingCentral (needs the Edit Messages scope):
// flips every unread inbound SMS from this number to Read, which clears the
// unread state everywhere — our panel badge AND the RingCentral apps.
async function actionThreadRead(payload: any) {
  const line = await lineForStore(payload?.store);
  const a = lineAuth(line);
  const want = e164(payload?.number || "");
  if (!want) return json({ ok: false, error: "number required" }, 400);
  const dateFrom = new Date(Date.now() - 90 * 864e5).toISOString();
  const r = await rcGet(
    `/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&direction=Inbound&readStatus=Unread&perPage=100&dateFrom=${dateFrom}`,
    a.jwt, a.appKey, a.appSecret,
  );
  if (!r.ok) return json({ ok: false, error: r.data?.message || `HTTP ${r.status}`, status: r.status });
  let marked = 0, failed = 0;
  for (const m of (r.data?.records || [])) {
    const from = e164(m.from?.phoneNumber || "");
    if (from !== want) continue;
    const u = await rcPut(`/restapi/v1.0/account/~/extension/~/message-store/${m.id}`, { readStatus: "Read" }, a.jwt, a.appKey, a.appSecret);
    if (u.ok) marked++;
    else failed++;
  }
  return json({
    ok: failed === 0, marked, failed,
    scope_hint: failed ? "add the Edit Messages scope to the store's RC app" : undefined,
  });
}

// Read-only routing diagnosis: where does each store line ACTUALLY route?
// Pulls every store user's answering rules (work-hours / after-hours /
// custom / forward-all) plus the account-wide number→extension map, so a
// hidden IVR forward can be SEEN instead of hunted through the admin UI.
// Needs only the ReadAccounts scope the store apps already have.
async function actionDiagRouting() {
  // extension directory (id → name/type) via the default/admin JWT, so
  // transfer targets resolve to names ("IVR Menu", "Location Call Queue"…)
  const dir = new Map<string, any>();
  try {
    const d = await rcGet("/restapi/v1.0/account/~/extension?perPage=500");
    for (const x of (d.data?.records || [])) {
      const e = { ext: x.extensionNumber || null, name: x.name || null, type: x.type || null };
      dir.set(String(x.id), e);
      if (x.extensionNumber) dir.set(`#${x.extensionNumber}`, e);
    }
  } catch { /* directory optional */ }
  const lines = await storeLines();
  const stores: any[] = [];
  for (const l of lines) {
    const entry: any = { store: l.store, number: l.sms_number, ok: false, extension: null, error: null };
    if (!l.jwt) { entry.error = "no JWT configured"; stores.push(entry); continue; }
    try {
      const info = await rcGet("/restapi/v1.0/account/~/extension/~", l.jwt, l.app_key, l.app_secret);
      if (!info.ok) throw new Error(info.data?.message || `extension HTTP ${info.status}`);
      entry.extension = { id: info.data.id, ext: info.data.extensionNumber, name: info.data.name, type: info.data.type };
      // This account runs RingCentral's NEW call handling engine
      // (NewCallHandlingAndForwarding) — the v1.0 answering-rule API is
      // disabled; routing lives in v2 comm-handling state rules (work-hours /
      // after-hours / forward-all-calls / dnd / agent) + custom interaction
      // rules. Strip greeting blobs, keep everything else raw for diagnosis.
      const prune = (o: any): any => {
        if (Array.isArray(o)) return o.map(prune);
        if (o && typeof o === "object") {
          const out: any = {};
          for (const [k, v] of Object.entries(o)) {
            if (/greeting|audio|prompt/i.test(k)) continue;
            out[k] = prune(v);
          }
          return out;
        }
        return o;
      };
      const extId = info.data.id;
      const states = await rcGet(`/restapi/v2/accounts/~/extensions/${extId}/comm-handling/voice/state-rules`, l.jwt, l.app_key, l.app_secret);
      entry.state_rules = states.ok ? prune(states.data) : { error: states.data?.message || states.data?.errors?.[0]?.message || `HTTP ${states.status}` };
      const custom = await rcGet(`/restapi/v2/accounts/~/extensions/${extId}/comm-handling/voice/interaction-rules`, l.jwt, l.app_key, l.app_secret);
      entry.interaction_rules = custom.ok ? prune(custom.data) : { error: custom.data?.message || custom.data?.errors?.[0]?.message || `HTTP ${custom.status}` };
      entry.ok = states.ok || custom.ok;
    } catch (e) { entry.error = String((e as Error).message || e); }
    stores.push(entry);
  }

  // account number map — which extension each number rings (voice routing truth)
  let numbers: any = null;
  try {
    const n = await rcGet("/restapi/v1.0/account/~/phone-number?perPage=200");
    numbers = n.ok
      ? (n.data?.records || []).map((x: any) => ({
          number: x.phoneNumber, usageType: x.usageType || null,
          extension: x.extension ? { ext: x.extension.extensionNumber || null, name: x.extension.name || null, type: x.extension.type || null } : null,
        }))
      : { error: n.data?.message || `HTTP ${n.status}` };
  } catch (e) { numbers = { error: String((e as Error).message || e) }; }

  // directory dump so target extension ids in the rules resolve to names
  const directory = [...dir.entries()].filter(([k]) => !k.startsWith("#")).map(([id, e]) => ({ id, ...e }));
  return json({ ok: true, stores, numbers, directory });
}

/* ---------------- inbound ---------------- */

async function pollInbox(jwt: string, store: string | null, toNumber: string | null, back: number, appKey?: string, appSecret?: string) {
  // One extension's inbox: record unseen inbound SMS, honor STOP/START.
  const r = await rcGet(
    "/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&direction=Inbound&perPage=100&dateFrom=" +
    new Date(Date.now() - back).toISOString(),
    jwt, appKey, appSecret,
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
    results.push(await pollInbox(l.jwt, l.store, l.sms_number, back, l.app_key, l.app_secret));
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

  // Warmer: a pg_cron pings this every few minutes so the isolate stays hot and
  // the panel's first fetch after idle doesn't eat a cold start. Returns instantly.
  if (payload?.action === "ping") return json({ ok: true, warm: true });

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
    if (payload?.action === "conversations") return await actionConversations(payload);
    if (payload?.action === "thread") return await actionThread(payload);
    if (payload?.action === "calls") return await actionCalls(payload);
    if (payload?.action === "voicemails") return await actionVoicemails(payload);
    if (payload?.action === "thread_read") return await actionThreadRead(payload);
    if (payload?.action === "diag_routing") return await actionDiagRouting();
    if (payload?.action === "sla_check") return await actionSlaCheck();
    if (payload?.action === "template_get") return await actionTemplateGet(payload);
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
