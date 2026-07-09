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

// overrideLoc + isolated let a diagnostic authenticate under a DIFFERENT store
// location without clobbering the module-global `session` the live crons use:
// pass isolated=true and the returned cookie is yours alone (globals untouched).
async function login(overrideLoc?: string, isolated = false): Promise<{ ok: boolean; error?: string; cookie?: string }> {
  const loginLoc = overrideLoc || LOGIN_LOCATION;
  if (!USERNAME || !PASSWORD || !loginLoc) {
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
  form.set("UserLoginForm[currentLocation]", loginLoc);

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
    return { ok: false, error: `login not accepted (HTTP ${res.status}${loc ? " → " + loc : ""})${errs.length ? " — " + errs.join(" | ") : ""}`, debug: { csrf_found: !!csrf, wsk_used: wsk ? wsk.slice(0, 4) + "…" : null, loc_used: loginLoc, body_snippet: body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300) } } as any;
  }
  if (!jar["PHPSESSID"]) return { ok: false, error: "login redirected but no PHPSESSID cookie present" };
  const cookie = jarStr(jar);
  if (!isolated) session = { cookie, at: Date.now() };   // isolated probes never touch the shared session
  return { ok: true, cookie };
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
function htmlUnescape(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function findEmbedUrl(): Promise<{ url?: string; tried: any[] }> {
  const tried: any[] = [];
  // The signed SSO URL is the FULL iframe src on the analytics page — up to
  // ~1300 chars ending in &signature=… . Grab the whole quoted attribute
  // (never truncate: a clipped signature makes Looker bounce to /login).
  const scanBody = (body: string): string[] => {
    const out: string[] = [];
    for (const m of body.matchAll(/(?:src|href)\s*=\s*"(https:(?:\\\/\\\/|\/\/)repairq\.looker\.com\/login\/embed\/[^"]+)"/g)) {
      out.push(htmlUnescape(m[1].replace(/\\\//g, "/")));
    }
    // fallback: unquoted/escaped occurrences (still take the full run to the next quote)
    for (const m of body.matchAll(/https:(?:\\\/\\\/|\/\/)repairq\.looker\.com\/login\/embed\/[^"'\s\\<]+/g)) {
      out.push(htmlUnescape(m[0].replace(/\\\//g, "/")));
    }
    return out;
  };

  const candidates = ["/analytics", "/report/analytics", "/bi", "/looker", "/report"];
  try {
    const home = await rqRequest({ path: "/", method: "GET", headers: { "accept": "text/html,*/*", "x-requested-with": "" } });
    const navLinks = [...new Set((home.body.match(/href="(?:https:\/\/cpr\.repairq\.io)?(\/[a-zA-Z\/]*(?:analytic|looker|insight|bi)[a-zA-Z\/]*)"/gi) || [])
      .map((h) => h.replace(/^href="/, "").replace(/"$/, "").replace("https://cpr.repairq.io", "")))];
    tried.push({ path: "/", status: home.status, nav_candidates: navLinks });
    candidates.unshift("/analytics/dashboard?dashboard=cpr_dashboard&location=" + (LOGIN_LOCATION || ""), ...navLinks);
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
// Pass `sess` to run as an isolated embed user (a specific store location);
// omit it to use the module-global session (the live 917 crons).
async function lookerRun(body: any, retry = true, sess?: { cookie: string; csrf: string }): Promise<{ created: any; results: any[] }> {
  const s = sess || await lookerSession();
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
  const rawText = await post.text();
  let created: any = {};
  try { created = JSON.parse(rawText); } catch { /* keep text */ }
  if (post.status === 401 || post.status === 403) {
    // only the global session can self-heal; an isolated session just fails.
    if (retry && !sess) { await lookerSession(true); return await lookerRun(body, false); }
    throw new Error(`Looker auth rejected (HTTP ${post.status})`);
  }
  if (!post.ok) throw new Error(`queries HTTP ${post.status}: ${(rawText || "(empty)").slice(0, 500)}`);

  // Collect query-task ids from the response (32-hex strings), then poll each.
  const ids = new Set<string>();
  const scan = (o: any) => {
    if (o == null) return;
    if (typeof o === "string") { if (/^[0-9a-f]{32}$/.test(o)) ids.add(o); return; }
    if (Array.isArray(o)) { o.forEach(scan); return; }
    if (typeof o === "object") Object.values(o).forEach(scan);
  };
  scan(created);

  const getHdr = { "cookie": s.cookie, "x-csrf-token": s.csrf, "accept": "application/json, text/plain, */*", "user-agent": UA, "referer": `${LK_BASE}/embed/explore` };
  const results: any[] = [];
  for (const id of [...ids].slice(0, 4)) {
    // 1. poll status to completion
    let status = "";
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`${LK_BASE}/api/internal/dataflux/query_tasks/${id}`, { headers: getHdr });
      const j = await r.json().catch(() => ({}));
      status = j?.status || "";
      if (/complete|error|failure/i.test(status)) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    // 2. fetch the row data from the results endpoint (JSON array of row objects)
    let rows: any = null, via: string | null = null;
    for (const ep of [
      `/api/internal/dataflux/query_tasks/${id}/results`,
      `/api/internal/query_tasks/${id}/results`,
      `/api/internal/dataflux/query_tasks/${id}/results?apply_formatting=true`,
    ]) {
      try {
        const r = await fetch(`${LK_BASE}${ep}`, { headers: getHdr });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : (Array.isArray(j?.rows) ? j.rows : null));
        if (arr) { rows = arr; via = ep; break; }
        if (j && rows == null) { rows = j; via = ep + " (non-array)"; }
      } catch { /* try next */ }
    }
    results.push({ task_id: id, status, via, row_count: Array.isArray(rows) ? rows.length : null, rows });
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

// Looker rows come as { field: {value, rendered, ...} }. Flatten to {field: value}.
function flattenLookerRows(rows: any[]): any[] {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, cell] of Object.entries(row || {})) {
      out[k] = (cell && typeof cell === "object" && "value" in (cell as any)) ? (cell as any).value : cell;
    }
    return out;
  });
}

// Run a saved LOOKER template by name, substituting {loc} (the store's Looker
// location name — its canonical store name) and any {param}, then cache the
// flattened rows into repairq_cache. This is the demand pull crons call.
async function actionLookerPull(p: any) {
  if (!p?.name) return json({ ok: false, error: "name required" }, 400);
  const { data: tpl, error } = await admin.from("repairq_queries")
    .select("*").eq("name", String(p.name)).eq("active", true).maybeSingle();
  if (error) return json({ ok: false, error: error.message }, 500);
  if (!tpl) return json({ ok: false, error: `no active query "${p.name}"` }, 404);
  // Catalog entry may point at a saved Look ('look:<id>'), a plain dashboard
  // ('dashboard:<id>'), or a merged-results tile
  // ('merge:<dashId>:<elId>[:<resultMakerId>]') instead of an inline body.
  const path = String(tpl.path || "");
  const mm = /^merge:(\d+):(\d+)(?::(\d+))?$/.exec(path);
  if (mm) return await actionLookerMerge({ ...p, dashboard_id: mm[1], element_id: mm[2], result_maker_id: mm[3] });
  const m = /^(look|dashboard):(\d+)$/.exec(path);
  if (m) {
    return m[1] === "look"
      ? await actionLookerLook({ ...p, look_id: m[2] })
      : await actionLookerDashboard({ ...p, dashboard_id: m[2] });
  }
  if (!tpl.body_template) return json({ ok: false, error: `template "${p.name}" has no body or look/dashboard path` }, 404);

  // Looker filters on the store NAME, not the numeric id — {loc} = store name.
  const loc = p.location != null ? String(p.location) : null;
  const params = (p.params && typeof p.params === "object") ? p.params : {};
  let bodyStr = JSON.stringify(tpl.body_template);
  if (loc != null) bodyStr = bodyStr.split("{loc}").join(loc);
  for (const [k, v] of Object.entries(params)) bodyStr = bodyStr.split(`{${k}}`).join(String(v));
  const body = JSON.parse(bodyStr);

  const run = await lookerRun(body);
  const all: any[] = [];
  for (const r of run.results) if (Array.isArray(r.rows)) all.push(...flattenLookerRows(r.rows));

  if (p.cache !== false && all.length >= 0) {
    await admin.from("repairq_cache").insert({
      query_name: String(p.name), location: p.location ?? null, params,
      status: 200, data: all, row_count: all.length,
    });
  }
  return json({ ok: true, query: p.name, location: p.location ?? null, row_count: all.length, cached: p.cache !== false, data: all });
}

// Fetch a Looker dashboard's element query definitions with our session.
async function lookerGet(path: string, sess?: { cookie: string; csrf: string }): Promise<{ ok: boolean; status: number; data: any }> {
  const s = sess || await lookerSession();
  const r = await fetch(`${LK_BASE}${path}`, { headers: { "cookie": s.cookie, "x-csrf-token": s.csrf, "accept": "application/json, */*", "user-agent": UA, "referer": `${LK_BASE}/embed/dashboards/1` } });
  const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch { /* text */ }
  return { ok: r.ok, status: r.status, data: j ?? t };
}

// Build a querymanager plain_query from a Looker query object (dashboard tile
// or Look), overriding the location filter for the target store.
function plainFromQuery(q: any, elementId: string, store: string | null, source: string, pathPrefix: string, forceLoc = false): any {
  const filters = { ...(q.filters || {}) };
  if (store != null && ("location.short_name" in filters || forceLoc)) filters["location.short_name"] = store;
  return {
    model: q.model, view: q.view, fields: q.fields || [], pivots: q.pivots || [],
    fill_fields: q.fill_fields || [], filters, filter_expression: q.filter_expression ?? "",
    filter_config: q.filter_config ?? undefined, sorts: q.sorts || [],
    limit: String(q.limit || "5000"), column_limit: String(q.column_limit || "50"),
    total: !!q.total, row_total: q.row_total ?? "", subtotals: q.subtotals || [],
    dynamic_fields: q.dynamic_fields ?? null, query_timezone: q.query_timezone ?? "",
    element_id: elementId, client_id: "mrt" + elementId,
    generate_links: false, path_prefix: pathPrefix, server_table_calcs: false, source,
  };
}

// Run a MERGED dashboard tile (Looker "merged results" — e.g. device-attach:
// devices sold + accessories on those same tickets). The merge is defined on
// the dashboard element; we run it by referencing the element + its
// result_maker_id, with a client-invented session_id (Looker only uses it as
// a correlation string). date/param filters pass through per source query.
async function actionLookerMerge(p: any) {
  const dashId = String(p?.dashboard_id || "");
  const elId = String(p?.element_id || "");
  let rmId = p?.result_maker_id != null ? String(p.result_maker_id) : "";
  const nSources = Number(p?.source_count || 2);
  const dateFilter = p?.date != null ? String(p.date) : "today";
  const dateField = String(p?.date_field || "ticket_item.accounted_on_date");
  if (!dashId || !elId) return json({ ok: false, error: "dashboard_id and element_id required" }, 400);

  // resolve result_maker_id from the dashboard element if not supplied
  if (!rmId) {
    const dash = await lookerGet(`/api/internal/dashboards/${dashId}`, p._sess);
    const el = (dash.data?.dashboard_elements || []).find((e: any) => String(e.id) === elId);
    rmId = el?.result_maker_id != null ? String(el.result_maker_id) : "";
    if (!rmId) return json({ ok: false, error: `element ${elId} has no result_maker_id` }, 404);
  }

  const filters = Array.from({ length: Math.max(1, nSources) }, () => ({ [dateField]: dateFilter }));
  const sid = "mrt" + elId + String(Math.abs(dashId.length * 2654435761 % 1e9)).padStart(9, "0");
  const body = {
    plain_queries: [],
    saved_queries: [{
      element_id: elId, filters, generate_links: false,
      path_prefix: "/explore", server_table_calcs: false, source: "dashboard",
      sorts: [], result_maker_id: rmId,
    }],
    context: { id: dashId, type: "dashboard", session_id: sid },
    options: { force_run: false, streaming: false, eager_poll: false, enable_phases: false },
  };
  const run = await lookerRun(body, true, p._sess);
  const rows: any[] = [];
  for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
  if (p.cache !== false) {
    await admin.from("repairq_cache").insert({
      query_name: p.name || `merge:${dashId}:${elId}`, location: p.location ?? null,
      params: { dashboard_id: dashId, element_id: elId, result_maker_id: rmId },
      status: 200, data: rows, row_count: rows.length,
    });
  }
  return json({ ok: true, dashboard_id: dashId, element_id: elId, row_count: rows.length, cached: p.cache !== false, data: p.include_data ? rows : undefined });
}

// Pull a saved LOOK by id (a single stored query), location-swapped + cached.
async function actionLookerLook(p: any) {
  const id = String(p?.look_id || "");
  if (!id) return json({ ok: false, error: "look_id required" }, 400);
  const look = await lookerGet(`/api/internal/looks/${id}`, p._sess);
  if (!look.ok || !look.data?.query) return json({ ok: false, error: `look fetch HTTP ${look.status}`, body: String(look.data).slice(0, 300) }, 502);
  const store = p.location != null ? String(p.location) : null;
  const pq = plainFromQuery(look.data.query, "look" + id, store, "look", "/embed/looks", p.force_location);
  const run = await lookerRun({ options: { async: true, eager_poll: false, force_run: false, generate_links: false, streaming: false }, plain_queries: [pq] }, true, p._sess);
  const rows: any[] = [];
  for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
  if (p.cache !== false) {
    await admin.from("repairq_cache").insert({
      query_name: p.name || `look:${id}`, location: p.location ?? null,
      params: { look_id: id, title: look.data.title }, status: 200, data: rows, row_count: rows.length,
    });
  }
  return json({ ok: true, look_id: id, title: look.data.title || null, location: p.location ?? null, row_count: rows.length, cached: p.cache !== false, data: p.include_data ? rows : undefined });
}

// The elegant path (Brett's insight): reference a Looker DASHBOARD by id, read
// its tiles' query definitions from the API, run each for the target store,
// and cache. No payload capture — the query lives in Looker, maintained there.
async function actionLookerDashboard(p: any) {
  const id = String(p?.dashboard_id || "");
  if (!id) return json({ ok: false, error: "dashboard_id required" }, 400);
  const dash = await lookerGet(`/api/internal/dashboards/${id}`, p._sess);
  if (!dash.ok) return json({ ok: false, error: `dashboard fetch HTTP ${dash.status}`, body: String(dash.data).slice(0, 300) }, 502);

  const els = (dash.data?.dashboard_elements || []).filter((e: any) => e?.query && e.query.model);
  const store = p.location != null ? String(p.location) : null;
  const out: any[] = [];
  for (const el of els) {
    const q = el.query;
    // point the location filter at the target store (keep all other filters)
    const filters = { ...(q.filters || {}) };
    if (store != null && ("location.short_name" in filters || p.force_location)) filters["location.short_name"] = store;
    const pq: any = {
      model: q.model, view: q.view, fields: q.fields || [], pivots: q.pivots || [],
      fill_fields: q.fill_fields || [], filters,
      filter_expression: q.filter_expression ?? "", sorts: q.sorts || [],
      limit: String(q.limit || "500"), column_limit: String(q.column_limit || "50"),
      total: !!q.total, row_total: q.row_total ?? "", subtotals: q.subtotals || [],
      dynamic_fields: q.dynamic_fields ?? null, query_timezone: q.query_timezone ?? "",
      filter_config: q.filter_config ?? undefined,
      // required by querymanager create:
      element_id: String(el.id), client_id: "mrtDash" + el.id,
      generate_links: false, path_prefix: "/embed/dashboards", server_table_calcs: false, source: "dashboard",
    };
    try {
      const run = await lookerRun({ options: { async: true, eager_poll: false, force_run: false, generate_links: false, streaming: false }, plain_queries: [pq] }, true, p._sess);
      const rows: any[] = [];
      for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
      out.push({ element_id: String(el.id), title: el.title || null, row_count: rows.length, rows });
    } catch (e) {
      out.push({ element_id: String(el.id), title: el.title || null, error: String((e as Error).message || e) });
    }
  }

  if (p.cache !== false) {
    for (const el of out) {
      if (el.error) continue;
      await admin.from("repairq_cache").insert({
        query_name: p.name || `dashboard:${id}:${el.element_id}`, location: p.location ?? null,
        params: { dashboard_id: id, element_id: el.element_id, title: el.title },
        status: 200, data: el.rows, row_count: el.row_count,
      });
    }
  }
  return json({ ok: true, dashboard_id: id, title: dash.data?.title || null, location: p.location ?? null, elements: out.map((e: any) => ({ element_id: e.element_id, title: e.title, row_count: e.row_count, error: e.error })), data: p.include_data ? out : undefined });
}

// Map a Looker location name to the name the app's tables use (stock /
// consumption_log store spelling). Looker says "CPR Clackamas OR"; the tables
// say "CPR Clackamas". Strip a trailing state suffix.
function appStoreName(lookerName: string): string {
  return String(lookerName || "").replace(/\s+(OR|WA|NH)$/i, "").trim();
}

// Resolve the Looker session a sync cron should run under. Defaults to an
// isolated Eugene (799) session so it reads the canonical Eugene-folder Looks;
// pass login_location:"" (or "global") to fall back to the module-global
// session. Returns undefined for the global path, {cookie,csrf} for isolated,
// or {error,...} on failure.
async function syncSession(p: any): Promise<{ cookie: string; csrf: string } | undefined | any> {
  const loc = p?.login_location != null ? String(p.login_location) : "799";
  if (!loc || loc === "global" || loc === "917") return undefined;
  const s = await isolatedLookerSession(loc);
  if (!s.ok) return { stage: s.stage, error: s.error || "isolated session failed", login_location: loc };
  return { cookie: s.cookie!, csrf: s.csrf! };
}

// Sync live PART STOCK from the Eugene All-Part-Inventory Look into the `stock`
// table the consumption report reads — so on-hand / on-order go live with no
// page changes. Upserts on (store, sku); PRESERVES each row's manually-tuned
// max_baseline + note. Authenticates as Eugene (799) so it reads the canonical
// Eugene-folder Look (5775); pass login_location:"" to use the global session.
async function actionLookerSyncStock(p: any) {
  const stores = Array.isArray(p?.stores) && p.stores.length ? p.stores
    : ["CPR Eugene", "CPR Salem Northeast", "CPR Clackamas OR"];
  const lookId = String(p?.look_id || "5775");
  const sess = await syncSession(p);
  if ((sess as any)?.error) return json({ ok: false, ...(sess as any) }, 502);
  const out: any[] = [];
  for (const store of stores) {
    try {
      const look = await lookerGet(`/api/internal/looks/${lookId}`, sess as any);
      if (!look.ok || !look.data?.query) throw new Error(`look fetch HTTP ${look.status}`);
      const pq = plainFromQuery(look.data.query, "syncStock", store, "look", "/embed/looks", true);
      const run = await lookerRun({ options: { async: true, eager_poll: false, force_run: false, generate_links: false, streaming: false }, plain_queries: [pq] }, true, sess as any);
      const rows: any[] = [];
      for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));

      const appStore = appStoreName(store);
      // preserve existing max_baseline + note per sku
      const { data: existing } = await admin.from("stock").select("sku, max_baseline, note").eq("store", appStore);
      const keep = new Map((existing || []).map((r: any) => [r.sku, { max_baseline: r.max_baseline, note: r.note }]));

      const now = new Date().toISOString();
      const upserts = rows.filter((r) => r["catalog_item.sku"]).map((r) => {
        const sku = String(r["catalog_item.sku"]);
        const k = keep.get(sku) || {};
        return {
          store: appStore, sku,
          name: r["catalog_item.name"] ?? null,
          in_stock: Number(r["inventory_item.count_in_stock"] || 0),
          on_order: Number(r["ordered_items.ordered_qty"] || 0),
          max_baseline: (k as any).max_baseline ?? (r["catalog_location_override.reorder_qty_total"] != null ? Number(r["catalog_location_override.reorder_qty_total"]) : null),
          note: (k as any).note ?? (r["catalog_location_override.note"] ?? null),
          updated_at: now,
        };
      });
      // upsert in chunks
      let wrote = 0;
      for (let i = 0; i < upserts.length; i += 500) {
        const chunk = upserts.slice(i, i + 500);
        const { error } = await admin.from("stock").upsert(chunk, { onConflict: "store,sku" });
        if (error) throw new Error(error.message);
        wrote += chunk.length;
      }
      out.push({ store: appStore, pulled: rows.length, upserted: wrote });
    } catch (e) {
      out.push({ store: appStoreName(store), error: String((e as Error).message || e) });
    }
  }
  return json({ ok: out.every((o) => !o.error), stores: out });
}

// Sync live PART CONSUMPTION from the Eugene Part-Consumption Look into
// consumption_log. The report SUMS units per sku/day, so we REPLACE each
// (store, biz_date) the Look returns — delete that day's existing rows, insert
// RepairQ's — never add alongside (which would double-count). Only touches days
// the Look covers (today), leaving historical days intact. Idempotent.
// Authenticates as Eugene (799) for the canonical Eugene-folder Look (5774).
async function actionLookerSyncConsumption(p: any) {
  const stores = Array.isArray(p?.stores) && p.stores.length ? p.stores
    : ["CPR Eugene", "CPR Salem Northeast", "CPR Clackamas OR"];
  const lookId = String(p?.look_id || "5774");
  const sess = await syncSession(p);
  if ((sess as any)?.error) return json({ ok: false, ...(sess as any) }, 502);
  const out: any[] = [];
  for (const store of stores) {
    try {
      const look = await lookerGet(`/api/internal/looks/${lookId}`, sess as any);
      if (!look.ok || !look.data?.query) throw new Error(`look fetch HTTP ${look.status}`);
      const pq = plainFromQuery(look.data.query, "syncCons", store, "look", "/embed/looks", true);
      const run = await lookerRun({ options: { async: true, eager_poll: false, force_run: false, generate_links: false, streaming: false }, plain_queries: [pq] }, true, sess as any);
      const rows: any[] = [];
      for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));

      const appStore = appStoreName(store);
      // group by biz_date
      const byDate = new Map<string, any[]>();
      for (const r of rows) {
        const d = r["inventory_item.status_updated_date"];
        const sku = r["catalog_item.sku"];
        if (!d || !sku) continue;
        (byDate.get(d) || byDate.set(d, []).get(d))!.push({
          biz_date: d, store: appStore, sku: String(sku),
          name: r["catalog_item.name"] ?? null,
          units: Number(r["inventory_item.count"] || 0),
          supplier: "RepairQ", updated_at: new Date().toISOString(),
        });
      }
      let replaced = 0;
      const days: string[] = [];
      for (const [d, recs] of byDate) {
        // replace this day for this store
        const del = await admin.from("consumption_log").delete().eq("store", appStore).eq("biz_date", d);
        if (del.error) throw new Error(del.error.message);
        const ins = await admin.from("consumption_log").insert(recs);
        if (ins.error) throw new Error(ins.error.message);
        replaced += recs.length; days.push(d);
      }
      out.push({ store: appStore, pulled: rows.length, replaced, days });
    } catch (e) {
      out.push({ store: appStoreName(store), error: String((e as Error).message || e) });
    }
  }
  return json({ ok: out.every((o) => !o.error), stores: out });
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

/* ---------------- isolated content-access probe ----------------
   Diagnostic only. Authenticates RepairQ under a chosen store location
   (so Looker mints that store's embed user, cpr_user_<loc>), then checks
   whether specific Looks / dashboards are inside that embed user's Looker
   content-access scope. Runs entirely on LOCAL cookie jars — never writes
   the module-global `session`/`lookerSess`, so the live 917 crons are
   completely undisturbed. Answers "can user 799 see 5817/1317/2330?". */
// Mint a Looker embed session for a GIVEN store location on local cookie jars,
// never touching the module globals. Shared by every isolated diagnostic.
async function isolatedLookerSession(loc: string): Promise<{ ok: boolean; stage?: string; error?: string; cookie?: string; csrf?: string; trail?: any[] }> {
  // 1. isolated RepairQ login under `loc`
  const lg = await login(loc, true);
  if (!lg.ok || !lg.cookie) return { ok: false, stage: "login", error: lg.error || "login failed" };
  const rqCookie = lg.cookie;

  // 2. find the signed Looker embed SSO URL on this location's analytics page
  const embedRe = /https:(?:\\\/\\\/|\/\/)repairq\.looker\.com\/login\/embed\/[^"'\s\\<]+/g;
  let ssoUrl: string | null = null;
  let path = "/analytics/dashboard?dashboard=cpr_dashboard&location=" + encodeURIComponent(loc);
  const trail: any[] = [];
  for (let hop = 0; hop < 5 && !ssoUrl; hop++) {
    const r = await fetch(path.startsWith("http") ? path : RQ_BASE + path, {
      redirect: "manual",
      headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml,*/*", "cookie": rqCookie, "x-requested-with": "" },
    });
    const locH = r.headers.get("location");
    const body = (r.status >= 300 && r.status < 400) ? "" : await r.text().catch(() => "");
    trail.push({ hop, path: path.slice(0, 70), status: r.status, to: locH ? locH.slice(0, 70) : null });
    const m = body.match(embedRe);
    if (m && m.length) { ssoUrl = htmlUnescape(m[0].replace(/\\\//g, "/")); break; }
    if (r.status >= 300 && r.status < 400 && locH) {
      if (/repairq\.looker\.com\/login\/embed\//.test(locH)) { ssoUrl = htmlUnescape(locH.replace(/&amp;/g, "&")); break; }
      path = locH.replace(/^https?:\/\/cpr\.repairq\.io/, "");
      if (/site\/login/.test(path)) break;
      continue;
    }
    break;
  }
  if (!ssoUrl) return { ok: false, stage: "embed_url", error: "no Looker SSO URL for location " + loc, trail };

  // 3. mint an ISOLATED Looker embed session from the SSO URL
  const jar: Record<string, string> = {};
  let url: string | null = ssoUrl;
  for (let i = 0; i < 12 && url; i++) {
    const res: any = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml,*/*", ...(Object.keys(jar).length ? { "cookie": jarStr(jar) } : {}) },
    });
    jarMerge(jar, res);
    const l = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && l) {
      url = l.startsWith("http") ? l : (l.startsWith("/") ? new URL(url).origin + l : LK_BASE + "/" + l);
      continue;
    }
    if (res.status === 200 && !jar["looker.session_renewable"]) {
      try {
        const init = await fetch(`${LK_BASE}/api/internal/session`, { headers: { "user-agent": UA, "accept": "application/json", "cookie": jarStr(jar), ...(jar["CSRF-TOKEN"] ? { "x-csrf-token": decodeURIComponent(jar["CSRF-TOKEN"]) } : {}) } });
        jarMerge(jar, init);
      } catch { /* best effort */ }
    }
    url = null;
  }
  const csrf = decodeURIComponent(jar["CSRF-TOKEN"] || "");
  if (!jar["rack.session"] || !csrf) return { ok: false, stage: "looker_session", error: "incomplete Looker session — cookies: " + Object.keys(jar).join(", "), trail };
  return { ok: true, cookie: jarStr(jar), csrf, trail };
}

async function probeContentAccess(loc: string, looks: number[], dashboards: number[]): Promise<any> {
  const sess = await isolatedLookerSession(loc);
  if (!sess.ok) return { ok: false, loc, stage: sess.stage, error: sess.error, trail: sess.trail };
  const cookie = sess.cookie!, csrf = sess.csrf!, trail = sess.trail;

  // identify which embed user we actually became, then probe each target.
  //    Out-of-scope content returns 404 (Looker hides what the embed user
  //    can't access); 200 = in scope.
  const lget = async (p: string) => {
    const r = await fetch(`${LK_BASE}${p}`, { headers: { "cookie": cookie, "x-csrf-token": csrf, "accept": "application/json, */*", "user-agent": UA, "referer": `${LK_BASE}/embed/dashboards/1` } });
    let j: any; const t = await r.text(); try { j = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, ok: r.ok, title: (j && (j.title || j.dashboard?.title)) || null };
  };
  let whoami: any = null;
  try { const u = await lget("/api/internal/user"); whoami = u.status === 200 ? (u.title || "ok") : `HTTP ${u.status}`; } catch { /* ignore */ }

  const lookOut: Record<string, any> = {};
  for (const id of looks) { const r = await lget(`/api/internal/looks/${id}`); lookOut[id] = { status: r.status, access: r.ok, title: r.title }; }
  const dashOut: Record<string, any> = {};
  for (const id of dashboards) { const r = await lget(`/api/internal/dashboards/${id}`); dashOut[id] = { status: r.status, access: r.ok, title: r.title }; }
  return { ok: true, loc, whoami, looks: lookOut, dashboards: dashOut, trail };
}

// Run a query body against an already-minted isolated session (create → poll →
// results). Returns flattened rows. Shared by the isolated dashboard runner.
async function runPlainWithSession(cookie: string, csrf: string, pq: any): Promise<{ rows: any[]; status: string; error?: string }> {
  const hdr = { "content-type": "application/json", "accept": "*/*", "cookie": cookie, "x-csrf-token": csrf, "origin": LK_BASE, "referer": `${LK_BASE}/embed/dashboards/1`, "user-agent": UA };
  const post = await fetch(`${LK_BASE}/api/internal/querymanager/queries`, {
    method: "POST", headers: hdr,
    body: JSON.stringify({ options: { async: true, eager_poll: false, force_run: false, generate_links: false, streaming: false }, plain_queries: [pq] }),
  });
  const rawText = await post.text();
  if (!post.ok) return { rows: [], status: "http_" + post.status, error: rawText.slice(0, 200) };
  let created: any = {}; try { created = JSON.parse(rawText); } catch { /* keep */ }
  const ids = new Set<string>();
  const scan = (o: any): void => {
    if (o == null) return;
    if (typeof o === "string") { if (/^[0-9a-f]{32}$/.test(o)) ids.add(o); return; }
    if (Array.isArray(o)) { o.forEach(scan); return; }
    if (typeof o === "object") Object.values(o).forEach(scan);
  };
  scan(created);
  const getHdr = { "cookie": cookie, "x-csrf-token": csrf, "accept": "application/json, text/plain, */*", "user-agent": UA, "referer": `${LK_BASE}/embed/explore` };
  for (const id of [...ids].slice(0, 2)) {
    let status = "";
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`${LK_BASE}/api/internal/dataflux/query_tasks/${id}`, { headers: getHdr });
      const j = await r.json().catch(() => ({}));
      status = j?.status || "";
      if (/complete|error|failure/i.test(status)) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    for (const ep of [`/api/internal/dataflux/query_tasks/${id}/results`, `/api/internal/dataflux/query_tasks/${id}/results?apply_formatting=true`]) {
      const r = await fetch(`${LK_BASE}${ep}`, { headers: getHdr });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
      if (arr) return { rows: flattenLookerRows(arr), status };
    }
  }
  return { rows: [], status: "no_rows" };
}

// Pull a whole dashboard AS a given store location (isolated session). Resolves
// each tile's query from the dashboard definition, optionally overrides the
// location filter, and reports per-tile row counts + distinct stores seen — the
// definitive row-lock test AND the reusable puller for a 799 cutover.
async function runDashboardAs(loc: string, dashId: string, storeOverride: string | null): Promise<any> {
  const sess = await isolatedLookerSession(loc);
  if (!sess.ok) return { ok: false, loc, stage: sess.stage, error: sess.error, trail: sess.trail };
  const cookie = sess.cookie!, csrf = sess.csrf!;
  const dashR = await fetch(`${LK_BASE}/api/internal/dashboards/${dashId}`, { headers: { "cookie": cookie, "x-csrf-token": csrf, "accept": "application/json, */*", "user-agent": UA, "referer": `${LK_BASE}/embed/dashboards/${dashId}` } });
  if (!dashR.ok) return { ok: false, loc, stage: "dashboard", status: dashR.status, error: (await dashR.text()).slice(0, 200) };
  const dash = await dashR.json().catch(() => ({}));
  const els = (dash?.dashboard_elements || []).filter((e: any) => e?.query && e.query.model);
  const tiles: any[] = [];
  for (const el of els.slice(0, 6)) {
    const q = el.query;
    const filters = { ...(q.filters || {}) };
    if (storeOverride != null && ("location.short_name" in filters)) filters["location.short_name"] = storeOverride;
    const pq: any = {
      model: q.model, view: q.view, fields: q.fields || [], pivots: q.pivots || [],
      fill_fields: q.fill_fields || [], filters, filter_expression: q.filter_expression ?? "",
      sorts: q.sorts || [], limit: String(q.limit || "500"), column_limit: String(q.column_limit || "50"),
      total: !!q.total, row_total: q.row_total ?? "", subtotals: q.subtotals || [],
      dynamic_fields: q.dynamic_fields ?? null, query_timezone: q.query_timezone ?? "",
      element_id: String(el.id), client_id: "mrtIso" + el.id, generate_links: false,
      path_prefix: "/embed/dashboards", server_table_calcs: false, source: "dashboard",
    };
    const run = await runPlainWithSession(cookie, csrf, pq);
    const storeKey = run.rows.length ? (Object.keys(run.rows[0]).find((k) => /location|store/i.test(k)) || null) : null;
    const stores = storeKey ? [...new Set(run.rows.map((r) => r[storeKey]).filter((v) => v != null))] : [];
    tiles.push({ element_id: String(el.id), title: el.title || null, row_count: run.rows.length, status: run.status, error: run.error, store_key: storeKey, distinct_stores: stores });
  }
  return { ok: true, loc, dashboard_id: dashId, title: dash?.title || null, store_override: storeOverride, tiles };
}

// Run a LITERAL querymanager body (exactly as captured from a browser cURL) AS a
// given store location. Optionally rewrite every location.short_name filter to
// `locationOverride` so an Eugene-authored dashboard pulls ALL stores. Forces
// non-streaming so results arrive via query_tasks. Reuses the session-aware
// lookerRun. This is the canonical consumer for the Eugene report catalog.
async function runQueryBodyAs(loc: string, body: any, locationOverride: string | null): Promise<any> {
  const sess = await isolatedLookerSession(loc);
  if (!sess.ok) return { ok: false, loc, stage: sess.stage, error: sess.error, trail: sess.trail };
  const b = JSON.parse(JSON.stringify(body || {}));
  b.options = { ...(b.options || {}), streaming: false, force_run: false, eager_poll: false, enable_phases: false };
  if (locationOverride != null) {
    for (const grp of ["saved_queries", "plain_queries"]) {
      for (const sq of (b[grp] || [])) {
        for (const f of (Array.isArray(sq.filters) ? sq.filters : [sq.filters].filter(Boolean))) {
          if (f && typeof f === "object" && "location.short_name" in f) f["location.short_name"] = locationOverride;
        }
      }
    }
  }
  // Looker needs a context.session_id; invent a stable one if absent.
  if (b.context && !b.context.session_id) b.context.session_id = "mrt" + String(b.context.id || "");
  let run: any;
  try { run = await lookerRun(b, true, { cookie: sess.cookie!, csrf: sess.csrf! }); }
  catch (e) { return { ok: false, loc, stage: "run", error: String((e as Error).message || e) }; }
  const perTask = (run.results || []).map((r: any) => ({ task_id: r.task_id, status: r.status, row_count: Array.isArray(r.rows) ? r.rows.length : null }));
  const rows: any[] = [];
  for (const r of (run.results || [])) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
  const storeKey = rows.length ? (Object.keys(rows[0]).find((k) => /location|store/i.test(k)) || null) : null;
  const stores = storeKey ? [...new Set(rows.map((r) => r[storeKey]).filter((v) => v != null))] : [];
  return { ok: true, loc, location_override: locationOverride, row_count: rows.length, per_task: perTask, store_key: storeKey, distinct_stores: stores, columns: rows.length ? Object.keys(rows[0]) : [], sample: rows.slice(0, 5) };
}

// Run one dashboard saved-query as a given store's embed user (isolated session)
// and return the flattened rows — used to answer "is this embed user row-locked
// to its own store, or can it see all stores' data?". No global state touched.
async function runSavedQueryAs(loc: string, dashId: string, elementId: string, resultMakerId: string, filters: any[]): Promise<any> {
  const sess = await isolatedLookerSession(loc);
  if (!sess.ok) return { ok: false, loc, stage: sess.stage, error: sess.error, trail: sess.trail };
  const cookie = sess.cookie!, csrf = sess.csrf!;
  const body = {
    plain_queries: [],
    saved_queries: [{
      element_id: elementId,
      filters: Array.isArray(filters) ? filters : [],
      generate_links: false,
      path_prefix: "/explore",
      server_table_calcs: false,
      source: "dashboard",
      sorts: [],
      result_maker_id: resultMakerId,
    }],
    context: { id: dashId, type: "dashboard", session_id: "mrt" + dashId + elementId },
    options: { force_run: false, streaming: true, eager_poll: false, enable_phases: false },
  };
  const hdr = {
    "content-type": "application/json", "accept": "*/*", "cookie": cookie, "x-csrf-token": csrf,
    "origin": LK_BASE, "referer": `${LK_BASE}/embed/dashboards/${dashId}`, "user-agent": UA,
  };
  const post = await fetch(`${LK_BASE}/api/internal/querymanager/queries`, { method: "POST", headers: hdr, body: JSON.stringify(body) });
  const rawText = await post.text();
  if (!post.ok) return { ok: false, loc, stage: "queries", status: post.status, error: rawText.slice(0, 400) };
  let created: any = {}; try { created = JSON.parse(rawText); } catch { /* keep text */ }
  const ids = new Set<string>();
  const scan = (o: any): void => {
    if (o == null) return;
    if (typeof o === "string") { if (/^[0-9a-f]{32}$/.test(o)) ids.add(o); return; }
    if (Array.isArray(o)) { o.forEach(scan); return; }
    if (typeof o === "object") Object.values(o).forEach(scan);
  };
  scan(created);
  const getHdr = { "cookie": cookie, "x-csrf-token": csrf, "accept": "application/json, text/plain, */*", "user-agent": UA, "referer": `${LK_BASE}/embed/explore` };
  let rows: any[] | null = null;
  for (const id of [...ids].slice(0, 1)) {
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`${LK_BASE}/api/internal/dataflux/query_tasks/${id}`, { headers: getHdr });
      const j = await r.json().catch(() => ({}));
      if (/complete|error|failure/i.test(j?.status || "")) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    for (const ep of [`/api/internal/dataflux/query_tasks/${id}/results`, `/api/internal/dataflux/query_tasks/${id}/results?apply_formatting=true`]) {
      const r = await fetch(`${LK_BASE}${ep}`, { headers: getHdr });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
      if (arr) { rows = flattenLookerRows(arr); break; }
    }
  }
  if (rows == null) return { ok: false, loc, stage: "results", error: "no rows returned", task_ids: [...ids] };
  // Which store column is present? Summarize distinct store-ish values so we can
  // tell if the embed user saw multiple stores or just its own.
  const storeKey = Object.keys(rows[0] || {}).find((k) => /location|store/i.test(k)) || null;
  const stores = storeKey ? [...new Set(rows.map((r) => r[storeKey]).filter((v) => v != null))] : [];
  return { ok: true, loc, dashboard_id: dashId, element_id: elementId, row_count: rows.length, store_key: storeKey, distinct_stores: stores, columns: Object.keys(rows[0] || {}), sample: rows.slice(0, 5) };
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
    if (payload?.action === "looker_access_probe") {
      // isolated diagnostic: which Looks/dashboards can the embed user for a
      // given store location see? Defaults probe the known-good controls plus
      // the out-of-scope targets. login_location required.
      const loc = String(payload?.login_location || "").trim();
      if (!loc) return json({ ok: false, error: "login_location required (e.g. 799 for Eugene, 917 for Clackamas)" }, 400);
      const looks = Array.isArray(payload?.looks) ? payload.looks.map(Number) : [5792, 5817];
      const dashboards = Array.isArray(payload?.dashboards) ? payload.dashboards.map(Number) : [2852, 1317, 2330];
      return json(await probeContentAccess(loc, looks, dashboards));
    }
    if (payload?.action === "looker_run_as") {
      // isolated: run a dashboard saved-query AS a given store location and see
      // which stores' rows come back (row-lock test). Requires login_location,
      // dashboard_id, element_id, result_maker_id; optional filters[].
      const loc = String(payload?.login_location || "").trim();
      const dashId = String(payload?.dashboard_id || "").trim();
      const elId = String(payload?.element_id || "").trim();
      const rmId = String(payload?.result_maker_id || "").trim();
      if (!loc || !dashId || !elId || !rmId) return json({ ok: false, error: "login_location, dashboard_id, element_id, result_maker_id required" }, 400);
      return json(await runSavedQueryAs(loc, dashId, elId, rmId, payload?.filters || []));
    }
    if (payload?.action === "looker_pull_as") {
      // Run a Look / dashboard / merge tile AS a store location (isolated
      // session), delegating to the normal catalog actions with p._sess set so
      // location override + caching all work. This is the 799-cutover puller.
      const loc = String(payload?.login_location || "").trim();
      if (!loc) return json({ ok: false, error: "login_location required" }, 400);
      const sess = await isolatedLookerSession(loc);
      if (!sess.ok) return json({ ok: false, loc, stage: sess.stage, error: sess.error, trail: sess.trail }, 502);
      const p = { ...payload, _sess: { cookie: sess.cookie!, csrf: sess.csrf! } };
      if (payload?.look_id) return await actionLookerLook(p);
      if (payload?.merge_element_id || payload?.result_maker_id) return await actionLookerMerge({ ...p, element_id: payload.merge_element_id || payload.element_id });
      if (payload?.dashboard_id) return await actionLookerDashboard(p);
      return json({ ok: false, error: "provide look_id, dashboard_id, or dashboard_id+result_maker_id" }, 400);
    }
    if (payload?.action === "looker_body_as") {
      // isolated: run a literal querymanager body (captured cURL) as a store
      // location, optionally rewriting location.short_name to pull all stores.
      const loc = String(payload?.login_location || "").trim();
      if (!loc || !payload?.body) return json({ ok: false, error: "login_location and body required" }, 400);
      const override = payload?.location_override != null ? String(payload.location_override) : null;
      return json(await runQueryBodyAs(loc, payload.body, override));
    }
    if (payload?.action === "looker_dashboard_as") {
      // isolated: pull a whole dashboard AS a store location; reports per-tile
      // row counts + distinct stores (row-lock test). Optional store override.
      const loc = String(payload?.login_location || "").trim();
      const dashId = String(payload?.dashboard_id || "").trim();
      if (!loc || !dashId) return json({ ok: false, error: "login_location and dashboard_id required" }, 400);
      const store = payload?.store != null ? String(payload.store) : null;
      return json(await runDashboardAs(loc, dashId, store));
    }
    if (payload?.action === "looker_query") {
      if (!payload?.body) return json({ ok: false, error: "body required (the captured querymanager payload)" }, 400);
      const r = await lookerRun(payload.body);
      return json({ ok: true, created: r.created, results: r.results });
    }
    if (payload?.action === "looker_pull") return await actionLookerPull(payload);
    if (payload?.action === "looker_dashboard") return await actionLookerDashboard(payload);
    if (payload?.action === "looker_look") return await actionLookerLook(payload);
    if (payload?.action === "looker_merge") return await actionLookerMerge(payload);
    if (payload?.action === "sync_stock") return await actionLookerSyncStock(payload);
    if (payload?.action === "sync_consumption") return await actionLookerSyncConsumption(payload);
    if (payload?.action === "looker_get") {
      // authenticated GET against Looker with our embed session (exploration)
      const s = await lookerSession();
      const p = String(payload?.path || "");
      if (!p.startsWith("/")) return json({ ok: false, error: "path required (e.g. /api/internal/dashboards/2852)" }, 400);
      const r = await fetch(`${LK_BASE}${p}`, { headers: { "cookie": s.cookie, "x-csrf-token": s.csrf, "accept": "application/json, */*", "user-agent": UA, "referer": `${LK_BASE}/embed/dashboards/1` } });
      const t = await r.text();
      let j: any; try { j = JSON.parse(t); } catch { /* text */ }
      return json({ ok: r.ok, status: r.status, data: j ?? undefined, body: j ? undefined : t.slice(0, 1500) });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
