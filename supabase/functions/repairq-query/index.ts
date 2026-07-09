// repairq-query — on-demand pulls from RepairQ (myRepairTools)
//
// RepairQ normally PUSHES us data (dashboard exports dropped on pages). This
// function lets us PULL: it authenticates to RepairQ with our own creds,
// caches the PHPSESSID session, and replays captured Looker "query/…"
// payloads to get live data back as JSON. Credentials never touch the
// browser (Supabase secrets, same trust model as messaging/twilio-call).
//
// Method courtesy of Brett K.:
//   1. POST /site/login (username, password, workstation_key, currentLocation)
//      → RepairQ returns a PHPSESSID cookie. Reuse it until it expires;
//      never re-send credentials per request.
//   2. RepairQ reports are Looker-backed internal "query/<something>-<loc>-<user>"
//      calls. Capture one payload from the browser Network panel (Fetch/XHR)
//      once, store it as a named query template, and replay it on demand.
//      The location id in the payload can be swapped to pull any store.
//
// Secrets:
//   REPAIRQ_USERNAME, REPAIRQ_PASSWORD            — the RQ login
//   REPAIRQ_WORKSTATION_KEY                        — from the login form (e.g. FEsJJETN5fUHn9qt)
//   REPAIRQ_LOGIN_LOCATION                         — a location id to auth under (e.g. 1089)
//
// Actions (POST JSON):
//   ping         → login (or reuse cached session), confirm it's valid. No data.
//   raw          → { method?, path, body?, headers?, form? } proxy ONE
//                  authenticated request to cpr.repairq.io and return status +
//                  body. This is how we FIRST replay a captured query payload:
//                  path = the "query/…" URL, body = the captured payload.
//                  Session is attached + auto-refreshed on 401.
//   save_query   → { name, path, description?, method?, body_template? } store a
//                  captured payload as a reusable template in repairq_queries.
//   list_queries → the saved templates.
//   query        → { name, location?, params?, cache?:true } run a saved
//                  template (substituting {loc}/{param} tokens), optionally
//                  cache the result into repairq_cache, return the data. This is
//                  the demand pull crons + tools call — capture once, replay
//                  forever.
//
// Guard rails: this holds real credentials and hits an undocumented internal
// API. It is admin-gated (X-CPR-RQ-SECRET must match REPAIRQ_PROXY_SECRET) so
// only our own server-side callers (crons, admin tools) can drive it — never
// the public browser. Deploy with verify_jwt OFF; auth is the shared secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RQ_BASE = "https://cpr.repairq.io";
const USERNAME = Deno.env.get("REPAIRQ_USERNAME") || "";
const PASSWORD = Deno.env.get("REPAIRQ_PASSWORD") || "";
const WORKSTATION_KEY = Deno.env.get("REPAIRQ_WORKSTATION_KEY") || "";
const LOGIN_LOCATION = Deno.env.get("REPAIRQ_LOGIN_LOCATION") || "";
const PROXY_SECRET = Deno.env.get("REPAIRQ_PROXY_SECRET") || "";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cpr-rq-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* ---------------- session cache ---------------- */
// Module-level (per warm instance). Good enough: the login is cheap and each
// instance just re-auths once when cold. A cross-instance cache in Postgres
// can come later if login rate becomes a concern.
let session: { cookie: string; at: number } | null = null;
const SESSION_TTL = 20 * 60 * 1000;   // re-login defensively after 20 min

function parseSessionCookie(setCookies: string[]): string | null {
  // grab PHPSESSID (and any other cookies RepairQ sets) into a Cookie header
  const jar: Record<string, string> = {};
  for (const sc of setCookies) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  if (!jar["PHPSESSID"]) return null;
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// Deno's fetch collapses multiple Set-Cookie headers; getSetCookie() splits them.
function getSetCookies(res: Response): string[] {
  const h: any = res.headers;
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

async function login(): Promise<{ ok: boolean; error?: string; cookie?: string }> {
  if (!USERNAME || !PASSWORD || !LOGIN_LOCATION) {
    return { ok: false, error: "RepairQ secrets not configured (need USERNAME, PASSWORD, LOGIN_LOCATION)" };
  }
  // 1. GET the login page first: it primes the session + CSRF cookies and
  //    carries TWO values the POST must echo back — the Yii CSRF token and a
  //    server-issued workstation key (fresh per visit; the secret is only a
  //    fallback). Skipping this is why naive logins silently fail.
  const jar: Record<string, string> = {};
  const pre = await fetch(`${RQ_BASE}/site/login`, {
    redirect: "manual",
    headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml,*/*", "accept-language": "en-US,en;q=0.9" },
  });
  jarMerge(jar, pre);
  const html = await pre.text();
  const pick = (name: string) => {
    const re1 = new RegExp(`name="${name.replace(/[[\]]/g, "\\$&")}"[^>]*value="([^"]*)"`);
    const re2 = new RegExp(`value="([^"]*)"[^>]*name="${name.replace(/[[\]]/g, "\\$&")}"`);
    return (html.match(re1) || html.match(re2) || [])[1] || "";
  };
  const csrf = pick("YII_CSRF_TOKEN");
  const wsk = pick("UserLoginForm[workstation_key]") || WORKSTATION_KEY;

  const form = new URLSearchParams();
  if (csrf) form.set("YII_CSRF_TOKEN", csrf);
  form.set("UserLoginForm[username]", USERNAME);
  form.set("UserLoginForm[password]", PASSWORD);
  form.set("UserLoginForm[workstation_key]", wsk);
  form.set("UserLoginForm[currentLocation]", LOGIN_LOCATION);

  const res = await fetch(`${RQ_BASE}/site/login`, {
    method: "POST",
    redirect: "manual",   // the session cookie is on the 302, not the followed page
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/x-www-form-urlencoded",
      "origin": RQ_BASE,
      "referer": `${RQ_BASE}/site/login`,
      "user-agent": UA,
      "cookie": jarStr(jar),
    },
    body: form.toString(),
  });
  jarMerge(jar, res);
  const loc = res.headers.get("location") || "";
  // success = a redirect AWAY from the login page
  if (!(res.status >= 300 && res.status < 400) || /site\/login/i.test(loc)) {
    const body = await res.text().catch(() => "");
    // Yii renders validation errors in .errorSummary / .errorMessage / .help-inline
    const errs = [...body.matchAll(/class="(?:errorSummary|errorMessage|help-inline|alert[^"]*)"[^>]*>([\s\S]{0,240}?)<\/(?:div|span|p|li)>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3);
    return { ok: false, error: `login not accepted (HTTP ${res.status}${loc ? " → " + loc : ""})${errs.length ? " — " + errs.join(" | ") : ""}`, debug: { csrf_found: !!csrf, wsk_used: wsk ? wsk.slice(0, 4) + "…" : null, loc_used: LOGIN_LOCATION, body_snippet: body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300) } } as any;
  }
  if (!jar["PHPSESSID"]) return { ok: false, error: "login redirected but no PHPSESSID cookie present" };
  session = { cookie: jarStr(jar), at: Date.now() };
  return { ok: true, cookie: session.cookie };
}

async function ensureSession(force = false): Promise<{ ok: boolean; error?: string; cookie?: string }> {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return { ok: true, cookie: session.cookie };
  return await login();
}

/* ---------------- authenticated proxy ---------------- */

async function rqRequest(opts: { method?: string; path: string; body?: string; form?: Record<string, string>; headers?: Record<string, string> }, retry = true): Promise<{ status: number; body: string; json?: any }> {
  const s = await ensureSession();
  if (!s.ok) throw new Error(s.error || "no session");

  let bodyStr = opts.body;
  const headers: Record<string, string> = {
    "user-agent": UA,
    "accept": "application/json, text/plain, */*",
    "origin": RQ_BASE,
    "referer": `${RQ_BASE}/`,
    "x-requested-with": "XMLHttpRequest",
    "cookie": session!.cookie,
    ...(opts.headers || {}),
  };
  if (opts.form) {
    bodyStr = new URLSearchParams(opts.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (bodyStr && !headers["content-type"]) {
    // captured Looker payloads are JSON
    headers["content-type"] = "application/json";
  }

  const path = opts.path.startsWith("http") ? opts.path : `${RQ_BASE}${opts.path.startsWith("/") ? "" : "/"}${opts.path}`;
  const res = await fetch(path, { method: opts.method || (bodyStr ? "POST" : "GET"), headers, body: bodyStr, redirect: "manual" });

  // A bounced session redirects to /site/login or 401s — re-auth once and retry.
  const looksLoggedOut = res.status === 401 || res.status === 403 ||
    (res.status >= 300 && res.status < 400 && /\/site\/login/i.test(res.headers.get("location") || ""));
  if (looksLoggedOut && retry) {
    await ensureSession(true);
    return await rqRequest(opts, false);
  }

  const text = await res.text();
  let parsed: any = undefined;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: text, json: parsed, location: res.headers.get("location") };
}

/* ---------------- Looker embed (RepairQ Analytics reports) ---------------- */
// RepairQ's Analytics reports are Looker embeds on repairq.looker.com. Auth
// chain: RepairQ session → the Analytics page carries a SIGNED embed SSO URL
// → following it (redirects) mints Looker session cookies + a CSRF token →
// then the internal query API works: POST querymanager/queries (async) →
// poll dataflux/query_tasks/<id> for results.

const LK_BASE = "https://repairq.looker.com";
let lookerSess: { cookie: string; csrf: string; at: number } | null = null;
const LOOKER_TTL = 15 * 60 * 1000;

function jarMerge(jar: Record<string, string>, res: Response) {
  for (const sc of getSetCookies(res)) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
}
const jarStr = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

// Find the signed embed SSO URL on RepairQ's analytics surface. Candidates
// 302 around inside cpr.repairq.io, so follow same-host redirects a few hops
// and scan every body along the way. Also harvest analytics-ish links from
// the app shell ("/") as extra candidates.
async function findEmbedUrl(): Promise<{ url?: string; tried: any[] }> {
  const tried: any[] = [];
  const scanBody = (body: string) =>
    (body.match(/https:(?:\\\/\\\/|\/\/)repairq\.looker\.com[^"'\s\\]{0,600}/g) || [])
      .map((u) => u.replace(/\\\//g, "/").replace(/&amp;/g, "&"));

  const candidates = ["/analytics", "/report/analytics", "/bi", "/looker", "/report"];
  try {
    const home = await rqRequest({ path: "/", method: "GET", headers: { "accept": "text/html,*/*", "x-requested-with": "" } });
    const navLinks = [...new Set((home.body.match(/href="(?:https:\/\/cpr\.repairq\.io)?(\/[a-zA-Z\/]*(?:analytic|looker|insight|bi)[a-zA-Z\/]*)"/gi) || [])
      .map((h) => h.replace(/^href="/, "").replace(/"$/, "").replace("https://cpr.repairq.io", "")))];
    tried.push({ path: "/", status: home.status, nav_candidates: navLinks });
    candidates.unshift(...navLinks);
    const fromHome = scanBody(home.body).find((u) => /\/login\/embed\//.test(u));
    if (fromHome) return { url: fromHome, tried };
  } catch { /* home scan optional */ }

  for (const p of [...new Set(candidates)]) {
    try {
      let path = p;
      for (let hop = 0; hop < 4; hop++) {
        const r = await rqRequest({ path, method: "GET", headers: { "accept": "text/html,application/xhtml+xml,*/*", "x-requested-with": "" } });
        const hits = scanBody(r.body);
        tried.push({ path, status: r.status, location: r.location || undefined, looker_urls: hits.slice(0, 2).map((u) => u.slice(0, 140)) });
        const sso = hits.find((u) => /\/login\/embed\//.test(u));
        if (sso) return { url: sso, tried };
        if (r.status >= 300 && r.status < 400 && r.location) {
          if (/repairq\.looker\.com\/login\/embed\//.test(r.location)) return { url: r.location.replace(/&amp;/g, "&"), tried };
          if (/^https?:\/\//.test(r.location) && !r.location.includes("cpr.repairq.io")) break;
          path = r.location.replace(/^https?:\/\/cpr\.repairq\.io/, "");
          if (/\/site\/login/.test(path)) break;
          continue;
        }
        break;
      }
    } catch (e) { tried.push({ path: p, error: String((e as Error).message || e) }); }
  }
  return { tried };
}

let lookerTrail: any[] = [];
async function lookerSession(force = false): Promise<{ cookie: string; csrf: string }> {
  if (!force && lookerSess && Date.now() - lookerSess.at < LOOKER_TTL) return lookerSess;
  const f = await findEmbedUrl();
  if (!f.url) throw new Error("no Looker embed URL found — probes: " + JSON.stringify(f.tried).slice(0, 600));
  const jar: Record<string, string> = {};
  lookerTrail = [];
  let url: string | null = f.url;
  for (let i = 0; i < 12 && url; i++) {
    const res: any = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml,*/*", "accept-language": "en-US,en;q=0.9", ...(Object.keys(jar).length ? { "cookie": jarStr(jar) } : {}) },
    });
    const setc = getSetCookies(res).map((c: string) => c.split("=")[0]);
    jarMerge(jar, res);
    const loc = res.headers.get("location");
    lookerTrail.push({ hop: i, host: new URL(url).host, path: new URL(url).pathname.slice(0, 60), status: res.status, set: setc, to: loc ? loc.slice(0, 80) : null });
    if (res.status >= 300 && res.status < 400 && loc) {
      url = loc.startsWith("http") ? loc : (loc.startsWith("/") ? new URL(url).origin + loc : LK_BASE + "/" + loc);
      continue;
    }
    // landed on a 200: if it's the embed HTML, Looker may set its session via a
    // follow-up init call. Try hitting the embed session-check to finalize.
    if (res.status === 200 && !jar["looker.session_renewable"]) {
      try {
        const init = await fetch(`${LK_BASE}/api/internal/session`, { headers: { "user-agent": UA, "accept": "application/json", "cookie": jarStr(jar), ...(jar["CSRF-TOKEN"] ? { "x-csrf-token": decodeURIComponent(jar["CSRF-TOKEN"]) } : {}) } });
        jarMerge(jar, init);
        lookerTrail.push({ hop: "init", path: "/api/internal/session", status: init.status, set: getSetCookies(init).map((c: string) => c.split("=")[0]) });
      } catch { /* best effort */ }
    }
    url = null;
  }
  const csrf = decodeURIComponent(jar["CSRF-TOKEN"] || "");
  if (!jar["rack.session"] || !csrf) {
    throw new Error("Looker session incomplete — cookies: " + Object.keys(jar).join(", ") + " | trail: " + JSON.stringify(lookerTrail).slice(0, 500));
  }
  lookerSess = { cookie: jarStr(jar), csrf, at: Date.now() };
  return lookerSess;
}

// Run one captured Analytics query payload end-to-end: create (async) → poll.
async function lookerRun(body: any, retry = true): Promise<{ created: any; results: any[] }> {
  const s = await lookerSession();
  const hdr = {
    "content-type": "application/json",
    "accept": "*/*",
    "cookie": s.cookie,
    "x-csrf-token": s.csrf,
    "origin": LK_BASE,
    "referer": `${LK_BASE}/embed/looks/1`,
    "user-agent": UA,
  };
  const post = await fetch(`${LK_BASE}/api/internal/querymanager/queries`, { method: "POST", headers: hdr, body: JSON.stringify(body) });
  const created = await post.json().catch(() => ({}));
  if (post.status === 401 || post.status === 403) {
    if (retry) { await lookerSession(true); return await lookerRun(body, false); }
    throw new Error(`Looker auth rejected (HTTP ${post.status})`);
  }
  if (!post.ok) throw new Error(`queries HTTP ${post.status}: ${JSON.stringify(created).slice(0, 400)}`);

  // Collect query-task ids from the response (32-hex strings), then poll each.
  const ids = new Set<string>();
  const scan = (o: any) => {
    if (o == null) return;
    if (typeof o === "string") { if (/^[0-9a-f]{32}$/.test(o)) ids.add(o); return; }
    if (Array.isArray(o)) { o.forEach(scan); return; }
    if (typeof o === "object") Object.values(o).forEach(scan);
  };
  scan(created);

  const results: any[] = [];
  for (const id of [...ids].slice(0, 4)) {
    let last: any = null;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${LK_BASE}/api/internal/dataflux/query_tasks/${id}`, { headers: { ...hdr, "content-type": undefined as any } });
      last = await r.json().catch(() => ({}));
      const status = last?.status || last?.query_task?.status || "";
      const done = /complete|error|failure/i.test(String(status)) || last?.data != null || last?.results != null;
      if (done) break;
      await new Promise((res) => setTimeout(res, 1200));
    }
    results.push({ task_id: id, result: last });
  }
  return { created, results };
}

/* ---------------- saved templates + demand pull ---------------- */

// Replace {loc}, {user}, and any {param} tokens in a string. `loc` maps to
// {loc}; everything in `params` maps to its own {key}.
function subst(s: string, loc: string | null, params: Record<string, unknown>): string {
  let out = s;
  if (loc != null) out = out.split("{loc}").join(String(loc));
  for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
  return out;
}

// A location "location" param can be a store name (resolve to its RQ loc id via
// store_lines.rq_location_id if present) or a raw id. Falls back to the raw
// value. Returns null when nothing was passed (use the template as-is).
async function resolveLoc(location: string | null | undefined): Promise<string | null> {
  if (location == null || location === "") return null;
  const raw = String(location).trim();
  if (/^\d+$/.test(raw)) return raw;   // already a numeric RQ location id
  // try to map a store name → rq_location_id
  try {
    const { data } = await admin.from("store_lines").select("store, aliases, rq_location_id").eq("active", true);
    const q = raw.toLowerCase();
    for (const l of (data || [])) {
      const hit = l.store?.toLowerCase() === q ||
        (Array.isArray(l.aliases) ? l.aliases : []).some((a: string) => String(a).toLowerCase() === q);
      if (hit && l.rq_location_id) return String(l.rq_location_id);
    }
  } catch { /* column may not exist yet — fall through */ }
  return raw;
}

async function actionSaveQuery(p: any) {
  if (!p?.name || !p?.path) return json({ ok: false, error: "name and path required" }, 400);
  const row = {
    name: String(p.name),
    description: p.description ? String(p.description) : null,
    method: p.method ? String(p.method).toUpperCase() : "POST",
    path: String(p.path),
    body_template: p.body_template ?? null,
    active: p.active !== false,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin.from("repairq_queries")
    .upsert(row, { onConflict: "name" }).select().maybeSingle();
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, query: data });
}

async function actionListQueries() {
  const { data, error } = await admin.from("repairq_queries")
    .select("id, name, description, method, path, active, updated_at").order("name");
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, queries: data || [] });
}

async function actionQuery(p: any) {
  if (!p?.name) return json({ ok: false, error: "name required" }, 400);
  const { data: tpl, error } = await admin.from("repairq_queries")
    .select("*").eq("name", String(p.name)).eq("active", true).maybeSingle();
  if (error) return json({ ok: false, error: error.message }, 500);
  if (!tpl) return json({ ok: false, error: `no active saved query named "${p.name}"` }, 404);

  const loc = await resolveLoc(p.location);
  const params = (p.params && typeof p.params === "object") ? p.params : {};
  const path = subst(String(tpl.path), loc, params);
  let body: string | undefined;
  if (tpl.body_template != null) {
    body = subst(JSON.stringify(tpl.body_template), loc, params);
  }

  const r = await rqRequest({ method: tpl.method || "POST", path, body });
  const okStatus = r.status >= 200 && r.status < 300;
  const rowCount = Array.isArray(r.json) ? r.json.length
    : (r.json && Array.isArray(r.json.data) ? r.json.data.length : null);

  // cache unless explicitly disabled or the pull failed
  if (p.cache !== false && okStatus && r.json !== undefined) {
    await admin.from("repairq_cache").insert({
      query_name: String(p.name), location: p.location ?? null, params,
      status: r.status, data: r.json, row_count: rowCount,
    });
  }
  return json({
    ok: okStatus, status: r.status, query: p.name, location: p.location ?? null,
    row_count: rowCount, cached: p.cache !== false && okStatus,
    data: r.json ?? null, body: r.json ? undefined : r.body?.slice(0, 2000),
  });
}

/* ---------------- entry ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // admin gate — server-side callers only
  if (!PROXY_SECRET || req.headers.get("x-cpr-rq-secret") !== PROXY_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: any = {};
  try { payload = await req.json(); } catch { /* empty */ }

  try {
    if (payload?.action === "ping") {
      const s = await ensureSession(payload?.force === true);
      if (!s.ok) return json({ ok: false, session: null, error: s.error || null, debug: (s as any).debug || null });
      // trust nothing: a protected page must NOT bounce to the login screen
      const check = await rqRequest({ path: "/ticket", method: "GET", headers: { "accept": "text/html,*/*", "x-requested-with": "" } }, false);
      const authed = check.status === 200 && !/site\/login/i.test(check.location || "");
      return json({
        ok: authed, session: authed ? "active" : null,
        error: authed ? null : `logged in but session not honored (GET /ticket → ${check.status}${check.location ? " → " + check.location : ""})`,
      });
    }
    if (payload?.action === "raw") {
      if (!payload?.path) return json({ ok: false, error: "path required" }, 400);
      const r = await rqRequest({
        method: payload.method, path: payload.path, body: payload.body,
        form: payload.form, headers: payload.headers,
      });
      return json({ ok: r.status >= 200 && r.status < 300, status: r.status, data: r.json ?? null, body: r.json ? undefined : r.body });
    }
    if (payload?.action === "save_query") return await actionSaveQuery(payload);
    if (payload?.action === "list_queries") return await actionListQueries();
    if (payload?.action === "query") return await actionQuery(payload);
    if (payload?.action === "looker_probe") {
      // diagnose the embed handoff: where's the SSO URL, does the session mint?
      const f = await findEmbedUrl();
      let sess: any = null;
      if (f.url) {
        try { const s = await lookerSession(true); sess = { ok: true, csrf_len: s.csrf.length, cookies: s.cookie.split("; ").map((c) => c.split("=")[0]), trail: lookerTrail }; }
        catch (e) { sess = { ok: false, error: String((e as Error).message || e), trail: lookerTrail }; }
      }
      return json({ ok: !!f.url, embed_url: f.url ? f.url.slice(0, 140) + "…" : null, probes: f.tried, session: sess });
    }
    if (payload?.action === "looker_query") {
      if (!payload?.body) return json({ ok: false, error: "body required (the captured querymanager payload)" }, 400);
      const r = await lookerRun(payload.body);
      return json({ ok: true, created: r.created, results: r.results });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
