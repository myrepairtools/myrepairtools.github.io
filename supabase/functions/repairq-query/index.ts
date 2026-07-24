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
    // querymanager wants dynamic_fields as a STRING (pivot Looks like Category
    // Sales 5817 reject null) — "" when none, JSON string otherwise.
    dynamic_fields: q.dynamic_fields == null ? "" : (typeof q.dynamic_fields === "string" ? q.dynamic_fields : JSON.stringify(q.dynamic_fields)),
    query_timezone: q.query_timezone ?? "",
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

// ---- Live pull → ingest bridge -------------------------------------------
// Pull an Eugene Look as the global (799) session, rename its API field names
// to the human LABEL headers the `ingest` function expects (ingest is the one
// battle-tested writer for the money tables — reuse it, never reimplement its
// aggregation), then POST the rows to ingest with the right feed. One code
// path feeds both the scheduled-delivery and the live-pull worlds identically.
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") || "";
// Looker store name → app store name (drop the state suffix ingest's storeMap
// doesn't carry, e.g. "CPR Clackamas OR" → "CPR Clackamas").
const CANON_STORES = "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR";

// field maps: ingest label ← Looker API field, per feed
const INGEST_FIELD_MAP: Record<string, Record<string, string>> = {
  claim_repairs: {
    "RQ Ticket #": "ticket.id", "Claim Invoice #": "ticket.invoice_id",
    "Location": "location.short_name", "Provider": "ticket.warranty_provider",
    "Service Program Name": "service_program.name",
    "Device Catalog Item Name": "device_catalog_item.name",
    "Device Description": "device.description",
    "Ticket Picked Up Date": "ticket.picked_up_date",
    "Ticket Item All Net Repair Sale Total": "ticket_item.all_net_repair_sale_total",
    "Ticket Item All Net COGS Total": "ticket_item.all_net_cogs_total",
    "Royalty Due": "royalty_due", "Gross Profit": "gross_profit",
    "Tkt Status": "ticket.status",
  },
  claim_parts: {
    "RQ Ticket #": "ticket.id", "Claim Invoice #": "ticket.invoice_id",
    "Location": "location.short_name", "Provider": "ticket.warranty_provider",
    "Service Program Name": "service_program.name",
    "Device Catalog Item Name": "device_catalog_item.name",
    "Part Name": "child_catalog_item.name",
    "Ticket Picked Up Date": "ticket.picked_up_date",
    "Is Consigned": "child_inventory_item.is_consigned",
    "All Net COGS Total": "child_ticket_item.all_net_cogs_total",
  },
  // Accessory Sales by Employee (4591). Validated: net/gp/units/tickets match
  // commission_sales for stable employees (deltas are live-freshness only).
  commission_accessory: {
    "Location": "location.short_name", "Employee": "sold_by.full_name",
    "Accounted on Date": "ticket_item.accounted_on_date",
    "Accy Tkt #": "ticket.count_final",
    "Accy Count": "ticket_item.all_sale_accessory_count",
    "Accy Total": "ticket_item.all_net_accessory_sales_total",
    "Accy GP": "ticket_item.all_net_accessory_sales_after_cogs_total",
  },
  // Device Sales merge (dashboard 2827 / element 12289). Per device-row; ingest
  // sums per employee/day. q1_* is the merged per-ticket accessory count.
  commission_device: {
    "Location": "location.short_name", "Employee": "sold_by.full_name",
    "Accounted on Date": "ticket_item.accounted_on_date", "Ticket Number": "ticket.id",
    "Device Sale Count": "ticket_item.all_sale_count",
    "Device Net Sale Price": "ticket_item.all_net_sale_total",
    "Device Gross Profit": "ticket_item.all_net_sale_after_cogs_total",
    "Accessory Count": "q1_ticket_item.all_sale_count",
  },
  // Device Returns merge (dashboard 2830 / element 12293). Mirror of device;
  // ingest keeps only rows where net < 0 (real refunds).
  commission_device_return: {
    "Location": "location.short_name", "Employee": "sold_by.full_name",
    "Accounted on Date": "ticket_item.accounted_on_date", "Ticket Number": "ticket.id",
    "Device Return Count": "ticket_item.all_return_count",
    "Device Net Sale Price": "ticket_item.all_net_sale_total",
    "Device Gross Profit": "ticket_item.all_net_sale_after_cogs_total",
    "Accessories Returned": "q1_ticket_item.all_return_count",
  },
};

function apiRowsToLabels(rows: any[], feed: string): any[] {
  const map = INGEST_FIELD_MAP[feed];
  if (!map) return rows;
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [label, api] of Object.entries(map)) {
      let v = r[api];
      if (label === "Location" && v != null) v = appStoreName(String(v)); // drop " OR" etc.
      out[label] = v ?? "";
    }
    return out;
  });
}

// A Looker pivot cell is { "<pivot value>": { value, ... }, ... }. Pull the
// numeric value for a pivot key (null → 0).
function pivotVal(cell: any, key: string): number {
  const c = cell && typeof cell === "object" ? cell[key] : null;
  if (c == null) return 0;
  if (typeof c === "object") return Number(c.value ?? 0) || 0;
  return Number(c) || 0;
}
function pivotKeys(cell: any): string[] {
  return cell && typeof cell === "object" ? Object.keys(cell) : [];
}

// Service (5399) is pivoted on the service name with two measures (all_sale_count
// + all_net_sale_total). Flatten to the "<Service> - All Sale Count" /
// "<Service> - All Net Sale Total" columns ingest's service parser strips + sums.
function servicePivotRows(rows: any[]): any[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {
      "Location": appStoreName(String(r["location.short_name"] ?? "")),
      "Employee": r["sold_by.full_name"] ?? "",
      "Accounted on Date": r["ticket_item.accounted_on_date"] ?? "",
    };
    const cnt = r["ticket_item.all_sale_count"], net = r["ticket_item.all_net_sale_total"];
    for (const svc of new Set([...pivotKeys(cnt), ...pivotKeys(net)])) {
      out[`${svc} - All Sale Count`] = pivotVal(cnt, svc);
      out[`${svc} - All Net Sale Total`] = pivotVal(net, svc);
    }
    return out;
  });
}

// Category (5817) is pivoted on item_type.name (accessory category) with a
// unit-count measure, but has NO date dimension in the saved Look. We inject
// accounted_on_date into the query fields (below) so it breaks down per day,
// then flatten the pivot to the flat "Accessory - Case" … columns ingest's
// commission_category maps via CAT_MAP.
function categoryPivotRows(rows: any[], dateField: string): any[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {
      "Location": appStoreName(String(r["location.short_name"] ?? "")),
      "Employee": r["user.full_name"] ?? r["sold_by.full_name"] ?? "",
      "Accounted on Date": r[dateField] ?? "",
    };
    const cnt = r["ticket_item.all_sale_count"];
    for (const cat of pivotKeys(cnt)) out[cat] = pivotVal(cnt, cat);
    return out;
  });
}

// ---- Device feeds (device-orders page) -------------------------------------
// Pull the two Eugene device dashboards as the global (799) session and hand
// the rows to ingest's device_inventory / device_sales handlers. NOTE: device
// tables key on the RAW RepairQ location name ("CPR Clackamas OR" — no suffix
// strip), unlike the claims/commission maps.
const DEVICE_ITEM_TYPES = "Device - Computer,Device - Drone,Device - Game,Device - Other / Misc,Device - Phone,Device - Tablet";

function deviceRowsToLabels(rows: any[], kind: "inventory" | "sales"): any[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {
      "ID": r["inventory_item.id"] ?? "",
      "Location": r["location.short_name"] ?? "",          // RAW name on purpose
      "Manufacturer": r["manufacturer.name"] ?? "",
      "Device": r["catalog_item.name"] ?? "",
      "Serial/IMEI": r["inventory_item.serial_number"] ?? "",
      "Supplier": r["supplier.name"] ?? r["supplier.active_name"] ?? "",
      "Note": r["inventory_item.note"] ?? "",
      "Days In Stock": r["inventory_item.days_in_stock"] ?? "",
      "Cost": r["inventory_item.cost"] ?? "",
      "Price": r["inventory_item.price"] ?? "",
    };
    if (kind === "sales") out["Sold Date"] = r["inventory_item.status_updated_date"] ?? "";
    else {
      out["Status"] = r["inventory_status.name"] ?? "";
      out["Added Date"] = r["inventory_item.added_date"] ?? "";
    }
    return out;
  });
}

// run one dashboard saved-query tile via the global (799) session
async function runTile(dashId: string, elId: string, rmId: string, filters: Record<string, string>): Promise<any[]> {
  const body = {
    plain_queries: [],
    saved_queries: [{ element_id: elId, filters: [filters], generate_links: false, path_prefix: "/explore", server_table_calcs: false, source: "dashboard", sorts: [], result_maker_id: rmId }],
    context: { id: dashId, type: "dashboard", session_id: "mrtDev" + elId },
    options: { force_run: false, streaming: false, eager_poll: false, enable_phases: false },
  };
  const run = await lookerRun(body);
  const rows: any[] = [];
  for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
  return rows;
}

async function actionSyncDevices(p: any) {
  if (!INGEST_SECRET) return json({ ok: false, error: "INGEST_SECRET not configured" }, 500);
  const stores = p?.location != null ? String(p.location) : "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR";
  const soldWindow = String(p?.sold_window || "1 month");   // device_sales upserts, so history accumulates
  const dry = !!p?.dry_run;
  const out: Record<string, any> = {};

  // 1. inventory snapshot — dashboard 1317, tile 6744 (Instock/Ordered/Pending Refurb/Pulled)
  const invRows = await runTile("1317", "6744", "30287", {
    "catalog_item.is_serialized": "Yes",
    "location.short_name": stores,
    "inventory_status.name": "Instock,Ordered,Pending Refurb,Pulled",
    "item_type.name": DEVICE_ITEM_TYPES,
    "inventory_item.status_updated_date": "",
  });
  const invLabeled = deviceRowsToLabels(invRows, "inventory");
  // 2. sold devices — dashboard 2330, tile 10113 (Sold, status-updated window)
  const soldRows = await runTile("2330", "10113", "27819", {
    "catalog_item.is_serialized": "Yes",
    "location.short_name": stores,
    "inventory_status.name": "Sold",
    "item_type.name": DEVICE_ITEM_TYPES,
    "inventory_item.status_updated_date": soldWindow,
  });
  const soldLabeled = deviceRowsToLabels(soldRows, "sales");

  if (dry) {
    return json({ ok: true, dry_run: true,
      inventory: { pulled: invRows.length, sample: invLabeled[0] ?? null },
      sales: { pulled: soldRows.length, sample: soldLabeled[0] ?? null } });
  }
  for (const [feed, labeled, pulled] of [["device_inventory", invLabeled, invRows.length], ["device_sales", soldLabeled, soldRows.length]] as [string, any[], number][]) {
    const res = await fetch(`${SB_URL}/functions/v1/ingest?token=${encodeURIComponent(INGEST_SECRET)}&feed=${feed}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(labeled),
    });
    out[feed] = { pulled, ingest: await res.json().catch(() => ({})) };
  }
  return json({ ok: Object.values(out).every((v: any) => v.ingest?.ok !== false), ...out });
}

// Pull one Look and hand its (relabeled) rows to ingest. login-location stays
// the global 799 session; location filter forced to all three stores.
async function actionSyncIngest(p: any) {
  const feed = String(p?.feed || "");
  const lookId = String(p?.look_id || "");
  const dashId = String(p?.dashboard_id || "");
  const elId = String(p?.element_id || "");
  const rmId = String(p?.result_maker_id || "");
  if (!feed || (!lookId && !(dashId && elId && rmId))) return json({ ok: false, error: "feed + (look_id OR dashboard_id+element_id+result_maker_id) required" }, 400);
  if (!INGEST_SECRET) return json({ ok: false, error: "INGEST_SECRET not configured" }, 500);
  const stores = p?.location != null ? String(p.location) : CANON_STORES;
  const raw: any[] = [];
  const catDate = "ticket_item.accounted_on_date";
  if (lookId) {
    // plain Look → global (799) session, location forced to all three stores
    const look = await lookerGet(`/api/internal/looks/${lookId}`);
    if (!look.ok || !look.data?.query) return json({ ok: false, error: `look ${lookId} fetch HTTP ${look.status}` }, 502);
    const q = look.data.query;
    // Category Look has no date dimension — inject one so it breaks down per day.
    if (feed === "commission_category" && Array.isArray(q.fields) && !q.fields.includes(catDate)) {
      q.fields = [...q.fields, catDate];
    }
    // Optional date-window override (e.g. "this month") so a daily cron keeps the
    // whole current month fresh instead of only today.
    if (p?.date && q.filters && catDate in q.filters) q.filters = { ...q.filters, [catDate]: String(p.date) };
    const pq = plainFromQuery(q, "sync" + feed, stores, "look", "/embed/looks", true);
    const run = await lookerRun({ options: { async: true, eager_poll: false, force_run: false, generate_links: false, streaming: false }, plain_queries: [pq] });
    for (const r of run.results) if (Array.isArray(r.rows)) raw.push(...flattenLookerRows(r.rows));
  } else {
    // MERGE tile → build the saved_query body; both source filters carry the
    // date window + the 3-store location (never empty — that leaks franchises).
    const dateField = String(p?.date_field || "ticket_item.accounted_on_date");
    const dateVal = String(p?.date || "this month");
    const nSources = Number(p?.source_count || 2);
    const filters = Array.from({ length: Math.max(1, nSources) }, () => ({ [dateField]: dateVal, "location.short_name": stores }));
    const body = {
      plain_queries: [], saved_queries: [{ element_id: elId, filters, generate_links: false, path_prefix: "/explore", server_table_calcs: false, source: "dashboard", sorts: [], result_maker_id: rmId }],
      context: { id: dashId, type: "dashboard", session_id: "mrtSync" + elId },
      options: { force_run: false, streaming: false, eager_poll: false, enable_phases: false },
    };
    const run = await lookerRun(body);
    for (const r of run.results) if (Array.isArray(r.rows)) raw.push(...flattenLookerRows(r.rows));
  }
  const labeled = feed === "commission_service" ? servicePivotRows(raw)
    : feed === "commission_category" ? categoryPivotRows(raw, catDate)
    : apiRowsToLabels(raw, feed);
  const srcLabel = lookId ? { look_id: lookId } : { dashboard_id: dashId, element_id: elId };
  if (p?.dry_run) {
    return json({ ok: true, feed, ...srcLabel, pulled: raw.length, dry_run: true, sample_api: raw[0] ?? null, sample_labeled: labeled[0] ?? null });
  }
  // POST to ingest (reuses its exact write + aggregation logic)
  const res = await fetch(`${SB_URL}/functions/v1/ingest?token=${encodeURIComponent(INGEST_SECRET)}&feed=${encodeURIComponent(feed)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(labeled),
  });
  const body = await res.json().catch(() => ({}));
  return json({ ok: res.ok && body?.ok !== false, feed, ...srcLabel, pulled: raw.length, ingest: body });
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

// Parse a RepairQ /inventory/edit page into a flat form-field map: every
// InventoryItemForm[*] + InventoryItemUpdateReason[*] field + the catalog id +
// the session's CSRF token, taking each <select>'s SELECTED option and the note
// <textarea>. Repost this (with only status_id changed) to move ONE unit — it
// carries the unit's own condition/carrier/supplier, so no bucket guessing.
function parseEditForm(b: string): Record<string, string> {
  const f: Record<string, string> = {};
  const wanted = (n: string) =>
    n.startsWith("InventoryItemForm[") || n.startsWith("InventoryItemUpdateReason[") || n === "original_catalog_item_id";
  for (const m of b.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/\bname="([^"]+)"/) || [])[1];
    if (!name || !wanted(name)) continue;
    const type = (tag.match(/\btype="([^"]*)"/) || [])[1] || "text";
    const val = (tag.match(/\bvalue="([^"]*)"/) || [])[1] || "";
    if (type === "checkbox") { if (/\bchecked\b/i.test(tag)) f[name] = val || "1"; }
    else if (type === "submit" || type === "button") { /* skip */ }
    else if (!(name in f)) f[name] = val;
  }
  for (const m of b.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = m[1];
    if (!wanted(name)) continue;
    const body = m[2];
    const sel = body.match(/<option\b[^>]*\bselected\b[^>]*\bvalue="([^"]*)"/i) ||
      body.match(/<option\b[^>]*\bvalue="([^"]*)"[^>]*\bselected\b/i);
    f[name] = sel ? sel[1] : "";
  }
  for (const m of b.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    if (m[1].startsWith("InventoryItemForm[")) f[m[1]] = m[2].trim();
  }
  const csrf = (b.match(/name="YII_CSRF_TOKEN"[^>]*value="([^"]*)"/) ||
    b.match(/value="([^"]*)"[^>]*name="YII_CSRF_TOKEN"/) || [])[1];
  if (csrf) f["YII_CSRF_TOKEN"] = csrf;
  return f;
}

// Flip ONE inventory unit fromStatus → toStatus via its own edit form. Reads the
// current form, refuses if the unit isn't in fromStatus (so re-runs are safe),
// changes only the status, appends the note, verifies from the reloaded form.
async function flipUnit(itemId: string | number, fromStatus: number, toStatus: number, note: string):
  Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }> {
  const g = await rqRequest({ method: "GET", path: `/inventory/edit/${itemId}` });
  const b = g.body || "";
  if (!b || /site\/login/i.test((g as any).location || "")) return { ok: false, error: "could not load edit form" };
  const f = parseEditForm(b);
  const cur = f["InventoryItemForm[status_id]"];
  if (cur == null || cur === "") return { ok: false, error: "form parse failed" };
  if (Number(cur) !== fromStatus) return { ok: false, skipped: true, reason: `unit is status ${cur}, not ${fromStatus}` };
  f["InventoryItemForm[status_id]"] = String(toStatus);
  f["InventoryItemUpdateReason[value]"] = String(toStatus);
  f["InventoryItemUpdateReason[previous_value]"] = String(fromStatus);
  const prev = f["InventoryItemForm[note]"] || "";
  f["InventoryItemForm[note]"] = (prev ? prev + "\n" : "") + note;
  const w = await rqRequest({ method: "POST", path: `/inventory/edit/${itemId}`, form: f });
  const v = await rqRequest({ method: "GET", path: `/inventory/edit/${itemId}` });
  const vf = parseEditForm(v.body || "");
  if (Number(vf["InventoryItemForm[status_id]"]) === toStatus) return { ok: true };
  return { ok: false, error: `post ${w.status}, status still ${vf["InventoryItemForm[status_id]"] ?? "?"}` };
}

/* ---------------- entry ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let payload: any = {};
  try { payload = await req.json(); } catch { /* empty */ }

  // Staff-triggered "↻ Refresh from RepairQ" (consumption report). Gated by a
  // valid signed-in Supabase user (the PIN session's JWT) rather than the
  // server-side proxy secret — so the browser never needs the RepairQ secret.
  // Re-pulls part stock + consumption on demand (same as the :07/:37 crons).
  if (payload?.action === "refresh") {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error: uerr } = await admin.auth.getUser(tok);
    if (uerr || !u?.user) return json({ ok: false, error: "sign in required" }, 401);
    try {
      const stores = Array.isArray(payload?.stores) && payload.stores.length ? payload.stores : undefined;
      const stockR = await actionLookerSyncStock(stores ? { stores } : {});
      const consR = await actionLookerSyncConsumption(stores ? { stores } : {});
      const stock = await (stockR as Response).json().catch(() => ({ ok: false }));
      const consumption = await (consR as Response).json().catch(() => ({ ok: false }));
      return json({ ok: stock.ok !== false && consumption.ok !== false, stock, consumption });
    } catch (e) {
      return json({ ok: false, error: String((e as Error).message || e) }, 500);
    }
  }

  // Bulk inventory status change (the "Inventory Editor" tool). Browser-driven,
  // gated by a signed-in admin/owner (not the server secret) so the RepairQ
  // credentials never touch the page. Move units from one status to another at a
  // store: non-serialized SKUs move by qty via removeStock (verified + one
  // retry); a serial flips via its own edit form. Re-runnable — every write
  // rechecks live counts first, so only what's actually in the "from" status
  // moves, and an interrupted run is safe to re-upload.
  if (payload?.action === "inventory_status") {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error: uerr } = await admin.auth.getUser(tok);
    if (uerr || !u?.user) return json({ ok: false, error: "sign in required" }, 401);
    const { data: st } = await admin.from("staff")
      .select("role, active").eq("auth_uid", u.user.id).eq("active", true).maybeSingle();
    const role = st?.role || "";
    if (role !== "admin" && role !== "owner") return json({ ok: false, error: "admin access required" }, 403);

    const mode = String(payload.mode || "");
    const locName = String(payload.location || "").trim();
    if (!locName) return json({ ok: false, error: "location required" }, 400);
    const locId = await resolveLoc(locName);

    // ad-hoc Looker query over inventory_item (default session sees all stores)
    const lk = async (fields: string[], filters: Record<string, string>, sorts: string[] = []) => {
      const pq = {
        model: "repairq_cpr", view: "inventory_item", fields, pivots: [], fill_fields: [],
        filters, filter_expression: "", sorts, limit: "5000", column_limit: "50", total: false,
        row_total: "", subtotals: [], dynamic_fields: "", query_timezone: "", element_id: "mrtinv",
        client_id: "mrtinv", generate_links: false, path_prefix: "/embed/looks", server_table_calcs: false, source: "look",
      };
      const run = await lookerRun({ options: { async: true, eager_poll: false, force_run: true, generate_links: false, streaming: false }, plain_queries: [pq] });
      const rows: any[] = [];
      for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
      return rows;
    };
    // live per-status counts for a catalog at this store (aggregate across buckets)
    const counts = async (catalogId: string | number): Promise<Record<number, number> | null> => {
      const r = await rqRequest({
        method: "POST", path: "/ajax/inventoryItem/getStatusCounts",
        form: { catalogItemId: String(catalogId), locationId: String(locId), conditionId: "", carrierId: "", supplierId: "" },
      });
      const d: any = r.json;
      if (!d || d.success !== true) return null;
      const m: Record<number, number> = {};
      for (const x of [...(d.onHand || []), ...(d.historical || [])]) m[Number(x.status_id)] = Number(x.count) || 0;
      return m;
    };

    if (mode === "resolve") {
      const fromStatus = Number(payload.from_status);
      const inRows: Array<{ value: string; qty: number }> = Array.isArray(payload.rows) ? payload.rows : [];
      const vals = inRows.map((r) => ({ value: String(r.value || "").trim(), qty: Math.max(1, Number(r.qty) || 1) })).filter((r) => r.value);
      const skuList = [...new Set(vals.map((v) => v.value))];
      const skuMap = new Map<string, { cid: any; name: string }>();
      for (let i = 0; i < skuList.length; i += 40) {
        const batch = skuList.slice(i, i + 40);
        const rows = await lk(["catalog_item.id", "catalog_item.sku", "catalog_item.name"],
          { "catalog_item.sku": batch.join(","), "location.short_name": locName });
        for (const r of rows) { const s = String(r["catalog_item.sku"]); if (!skuMap.has(s)) skuMap.set(s, { cid: r["catalog_item.id"], name: r["catalog_item.name"] }); }
      }
      const unmatched = skuList.filter((s) => !skuMap.has(s));
      const serMap = new Map<string, { iid: any; cid: any; sku: string; name: string }>();
      for (let i = 0; i < unmatched.length; i += 40) {
        const batch = unmatched.slice(i, i + 40);
        const rows = await lk(["inventory_item.id", "inventory_item.serial_number", "catalog_item.id", "catalog_item.sku", "catalog_item.name"],
          { "inventory_item.serial_number": batch.join(","), "location.short_name": locName });
        for (const r of rows) { const sn = String(r["inventory_item.serial_number"]); if (sn && !serMap.has(sn)) serMap.set(sn, { iid: r["inventory_item.id"], cid: r["catalog_item.id"], sku: String(r["catalog_item.sku"]), name: r["catalog_item.name"] }); }
      }
      const countCache = new Map<string, Record<number, number> | null>();
      const liveFor = async (cid: any) => { const k = String(cid); if (!countCache.has(k)) countCache.set(k, await counts(cid)); return countCache.get(k)!; };
      const out: any[] = [];
      for (const v of vals) {
        if (skuMap.has(v.value)) {
          const m = skuMap.get(v.value)!;
          const c = await liveFor(m.cid);
          out.push({ value: v.value, kind: "sku", catalog_id: m.cid, name: m.name, qty: v.qty, live_in_from: c ? (c[fromStatus] || 0) : null });
        } else if (serMap.has(v.value)) {
          const m = serMap.get(v.value)!;
          out.push({ value: v.value, kind: "serial", item_id: m.iid, catalog_id: m.cid, sku: m.sku, name: m.name, qty: 1, live_in_from: null });
        } else {
          out.push({ value: v.value, kind: "notfound", qty: v.qty });
        }
      }
      return json({ ok: true, mode: "resolve", location: locName, from_status: fromStatus, rows: out });
    }

    if (mode === "apply") {
      const fromStatus = Number(payload.from_status);
      const toStatus = Number(payload.to_status);
      if (!fromStatus || !toStatus || fromStatus === toStatus) return json({ ok: false, error: "valid distinct from/to status required" }, 400);
      const note = String(payload.note || "Updated via myRepairTools").replace(/[\u{10000}-\u{10FFFF}]/gu, "").slice(0, 180);
      const overStock = payload.over_stock === true;
      const rows: any[] = Array.isArray(payload.rows) ? payload.rows : [];
      const receipt: any[] = [];
      for (const row of rows) {
        const rec: any = { value: row.value, kind: row.kind, name: row.name || null };
        try {
          if (row.kind === "sku") {
            const pre = await counts(row.catalog_id);
            if (!pre) { rec.status = "error"; rec.error = "precheck failed"; rec.moved = 0; receipt.push(rec); continue; }
            const live = pre[fromStatus] || 0; const preTo = pre[toStatus] || 0;
            rec.live_before = live;
            const reqQty = Math.max(1, Number(row.qty) || 1);
            const want = overStock ? live : Math.min(reqQty, live);
            if (want <= 0) { rec.status = "skipped"; rec.reason = "none in from-status"; rec.moved = 0; receipt.push(rec); continue; }
            let ok = false;
            for (let attempt = 0; attempt < 2 && !ok; attempt++) {
              const w = await rqRequest({
                method: "POST", path: "/ajax/inventoryItem/removeStock", form: {
                  catalogItemId: String(row.catalog_id), statusId: String(fromStatus), locationId: String(locId),
                  conditionId: "1", carrierId: "0", supplierId: "0", qtyToRemove: String(want),
                  newStatus: String(toStatus), updateReason: "", serials: "", note,
                },
              });
              const post = await counts(row.catalog_id);
              if (post && post[fromStatus] === live - want && (post[toStatus] || 0) === preTo + want) {
                ok = true; rec.post_from = post[fromStatus]; rec.post_to = post[toStatus] || 0;
              } else if (attempt === 1) {
                rec.error = (w.json && (w.json as any).message) ? String((w.json as any).message).replace(/<[^>]+>/g, "").trim().slice(0, 160) : "write not verified";
              }
            }
            rec.status = ok ? "done" : "failed"; rec.moved = ok ? want : 0;
            if (reqQty > want && !overStock) rec.short = reqQty - want;
          } else if (row.kind === "serial") {
            const r = await flipUnit(row.item_id, fromStatus, toStatus, note);
            rec.status = r.ok ? "done" : (r.skipped ? "skipped" : "failed");
            rec.moved = r.ok ? 1 : 0;
            if (r.error) rec.error = r.error;
            if (r.reason) rec.reason = r.reason;
          } else {
            rec.status = "skipped"; rec.reason = "not found in RepairQ"; rec.moved = 0;
          }
        } catch (e) { rec.status = "error"; rec.error = String((e as Error).message || e).slice(0, 160); rec.moved = rec.moved || 0; }
        receipt.push(rec);
      }
      return json({ ok: true, mode: "apply", location: locName, from_status: fromStatus, to_status: toStatus, receipt });
    }

    return json({ ok: false, error: "mode must be 'resolve' or 'apply'" }, 400);
  }

  // admin gate — server-side callers only
  if (!PROXY_SECRET || req.headers.get("x-cpr-rq-secret") !== PROXY_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

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
      return json({ ok: r.status >= 200 && r.status < 300, status: r.status, location: (r as any).location || null, data: r.json ?? null, body: r.json ? undefined : r.body });
    }
    if (payload?.action === "sync_digest") {
      // Capture the owner's daily digest (Looker dashboard 2273) into digest_raw.
      // The 11 tiles (baked from the browser's querymanager batch) carry relative
      // date filters ("today"/"1 months"/"7 days") that auto-roll each run. Runs
      // each tile individually so results map 1:1 to a tile_key. Cron: daily.
      const DASH = "2273";
      const TILES: Array<{ key: string; q: any }> = [
        { key: "daily_digest", q: { element_id: "9862", result_maker_id: "26851", sorts: ["ticket_item.all_sale_after_discount_total desc"], filters: [{ "catalog_item.sku": "-NULL", "ticket_item.is_child": "", "location.short_name": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR", "ticket.is_closed": "Yes", "ticket.status": "closed", "ticket.claim_status": "", "ticket.status_updated_date": "today" }] } },
        { key: "monthly_digest", q: { element_id: "9863", result_maker_id: "26850", sorts: ["ticket_item.all_sale_after_discount_total desc"], filters: [{ "catalog_item.sku": "-NULL", "ticket_item.is_child": "", "location.short_name": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR", "ticket.is_closed": "Yes", "ticket.status": "closed", "ticket.claim_status": "", "ticket.status_updated_date": "1 months" }] } },
        { key: "employee_breakdown", q: { element_id: "9864", result_maker_id: "26953", sorts: ["sold_by.full_name desc"], filters: [{ "catalog_item.sku": "-%zaggwarr%", "ticket_item.is_accessory_sale": "", "ticket_item.is_child": "No", "location.short_name": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR", "ticket.status": "closed", "ticket.status_updated_date": "today", "sold_by.full_name": "-API Assurant,-Jeffrey Klotz,-Brandon Billings" }] } },
        { key: "claims_completed_eugene", q: { element_id: "9865", result_maker_id: "28093", sorts: ["location.short_name"], filters: [{ "location.short_name": "CPR Eugene", "ticket.warranty_provider": "", "ticket.status": "\"in_repair\",\"pending_approval\",\"pending_notification\",\"ready_for_pickup\",\"in_diagnosis\",\"on_hold\",\"waiting_for_payment\",invoiced,approved", "service_program.name": "-Apple IRP,-Samsung ISP", "ticket.claim_status": "fulfilled", "ticket.claim_number": "", "ticket.updated_date": "", "ticket_device.claim_mfr": "", "ticket.repair_completed_date": "today", "ticket.status_updated_date": "today" }] } },
        { key: "claims_completed_salem", q: { element_id: "10434", result_maker_id: "28094", sorts: ["location.short_name"], filters: [{ "location.short_name": "CPR Salem Northeast", "ticket.warranty_provider": "", "ticket.status": "\"in_repair\",\"pending_approval\",\"pending_notification\",\"ready_for_pickup\",\"in_diagnosis\",\"on_hold\",\"waiting_for_payment\",invoiced,approved", "service_program.name": "-Apple IRP,-Samsung ISP", "ticket.claim_status": "fulfilled", "ticket.claim_number": "", "ticket.updated_date": "", "ticket_device.claim_mfr": "", "ticket.repair_completed_date": "today", "ticket.status_updated_date": "today" }] } },
        { key: "claims_completed_clackamas", q: { element_id: "12145", result_maker_id: "30884", sorts: ["location.short_name"], filters: [{ "location.short_name": "CPR Clackamas OR", "ticket.warranty_provider": "", "ticket.status": "\"in_repair\",\"pending_approval\",\"pending_notification\",\"ready_for_pickup\",\"in_diagnosis\",\"on_hold\",\"waiting_for_payment\",invoiced,approved", "service_program.name": "-Apple IRP,-Samsung ISP", "ticket.claim_status": "fulfilled", "ticket.claim_number": "", "ticket.updated_date": "", "ticket_device.claim_mfr": "", "ticket.repair_completed_date": "today", "ticket.status_updated_date": "today" }] } },
        { key: "claim_payout_weekly", q: { element_id: "11173", result_maker_id: "30883", query_timezone: "America/Chicago", sorts: ["transaction.payment_amount_total desc 0"], filters: [{ "payment_method.name": "", "ticket.warranty_provider": "-EMPTY", "ticket.warranty_device_serial": "", "ticket.created_date": "", "ticket.claim_number": "", "transaction.deposit_posted_date": "7 days", "location.short_name": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR" }] } },
        { key: "express_repairs", q: { element_id: "11205", result_maker_id: "30880", sorts: ["ticket_item.all_sale_count desc"], filters: [{ "catalog_item.sku": "EXPRESS-0001", "location.short_name": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR", "ticket_item.accounted_on_date": "1 months" }] } },
        { key: "device_cleanings", q: { element_id: "11206", result_maker_id: "30882", sorts: ["ticket_item.all_sale_count desc"], filters: [{ "catalog_item.sku": "DEVICECLEAN", "location.short_name": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR", "ticket_item.accounted_on_date": "1 months" }] } },
        { key: "akko_plan_sales", q: { element_id: "11207", result_maker_id: "30881", sorts: ["ticket_item.all_sale_count desc"], filters: [{ "catalog_item.sku": "AKKOPLAN,AKKOPLAN5,AKKOPLAN8,AKKOPLAN11", "location.short_name": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR", "ticket_item.accounted_on_date": "1 months" }] } },
        { key: "device_sales_today", q: { element_id: "12352", result_maker_id: "31223", sorts: [], filters: [{}, {}] } },
      ];
      // capture_date = "today" in America/Los_Angeles (the stores' timezone)
      const laDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const out: any[] = [];
      for (const t of TILES) {
        try {
          const body = {
            plain_queries: [],
            saved_queries: [{ ...t.q, generate_links: false, path_prefix: "/explore", server_table_calcs: false, source: "dashboard" }],
            context: { id: DASH, type: "dashboard", session_id: "mrt" + t.q.element_id },
            options: { force_run: false, streaming: false, eager_poll: false, enable_phases: false },
          };
          const run = await lookerRun(body);
          const rows: any[] = [];
          for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
          await admin.from("digest_raw").upsert({
            capture_date: laDate, tile_key: t.key, element_id: t.q.element_id,
            rows, row_count: rows.length, captured_at: new Date().toISOString(),
          }, { onConflict: "capture_date,tile_key" });
          out.push({ tile: t.key, rows: rows.length });
        } catch (e) {
          out.push({ tile: t.key, error: String((e as Error).message || e) });
        }
      }
      const okCount = out.filter((o) => o.error == null).length;
      return json({ ok: okCount > 0, capture_date: laDate, tiles_ok: okCount, tiles_total: TILES.length, detail: out });
    }
    if (payload?.action === "looker_batch") {
      // Replay a dashboard's saved-query tiles (captured from the browser's
      // querymanager batch) with a FRESH server-minted Looker session. Each
      // tile runs individually so results map 1:1 to its element_id (lookerRun
      // only polls the first few task-ids in a multi-query batch). Relative
      // date filters ("today"/"1 months") in the payload auto-roll each run.
      const dashId = String(payload?.dashboard_id || "");
      const queries = Array.isArray(payload?.saved_queries) ? payload.saved_queries : [];
      if (!dashId || !queries.length) return json({ ok: false, error: "dashboard_id and saved_queries required" }, 400);
      const tiles: any[] = [];
      for (const q of queries) {
        const elId = String(q?.element_id || "");
        try {
          const body = {
            plain_queries: [],
            saved_queries: [{ ...q, generate_links: false }],
            context: { id: dashId, type: "dashboard", session_id: "mrt" + elId },
            options: { force_run: false, streaming: false, eager_poll: false, enable_phases: false },
          };
          const run = await lookerRun(body);
          const rows: any[] = [];
          for (const r of run.results) if (Array.isArray(r.rows)) rows.push(...flattenLookerRows(r.rows));
          tiles.push({ element_id: elId, result_maker_id: q?.result_maker_id ?? null, row_count: rows.length, rows: payload?.include_data ? rows : undefined });
        } catch (e) {
          tiles.push({ element_id: elId, error: String((e as Error).message || e) });
        }
      }
      return json({ ok: true, dashboard_id: dashId, tiles });
    }
    if (payload?.action === "note_add") {
      // Write a ticket note SERVER-SIDE with our own authenticated session.
      // The browser/extension path fought a losing battle with the page-reload
      // that follows a status change (cookies dropped, requests killed mid-flight).
      // Here there is no browser: fetch the ticket to mint a CSRF that matches
      // OUR session, then POST the note. Rock-solid — same path used to clean
      // notes all along. { ticket_no, note }.
      const ticket = String(payload?.ticket_no || "").replace(/\D/g, "");
      // RepairQ MySQL is 3-byte utf8 — a 4-byte char truncates the note (a
      // leading emoji stores blank and bricks the ticket save). Strip them.
      const noteText = String(payload?.note ?? "").replace(/[\u{10000}-\u{10FFFF}]/gu, "").trim();
      if (!ticket) return json({ ok: false, error: "ticket_no required" }, 400);
      if (!noteText) return json({ ok: false, error: "note empty (blank notes are rejected)" }, 400);
      const pg = await rqRequest({ path: `/ticket/${ticket}`, method: "GET", headers: { accept: "text/html,*/*", "x-requested-with": "" } });
      if (pg.status !== 200) return json({ ok: false, error: `ticket fetch ${pg.status}` }, 502);
      const csrf = (pg.body.match(/value="([^"]+)" name="YII_CSRF_TOKEN"/) || pg.body.match(/name="YII_CSRF_TOKEN"[^>]*value="([^"]+)"/) || [])[1];
      if (!csrf) return json({ ok: false, error: "no CSRF on ticket page" }, 502);
      const save = await rqRequest({
        method: "POST", path: "/ajax/ticketNote/save",
        form: { YII_CSRF_TOKEN: csrf, ticketId: ticket, note: noteText, print: "0", important: "0" },
      });
      const saved = !!(save.json && save.json.success === true && save.json.note && save.json.note.id);
      return json({ ok: saved, status: save.status, note_id: saved ? save.json.note.id : null, error: saved ? undefined : "save not confirmed" }, saved ? 200 : 502);
    }
    if (payload?.action === "sweep_blank_notes") {
      // Blank-note janitor. RepairQ's 3-byte MySQL utf8 truncates notes at the
      // first 4-byte char, so emoji-prefixed extension notes stored as EMPTY —
      // and a blank note blocks the whole ticket from saving. Extension
      // v2.5.81 stopped writing them; this sweeps stragglers from machines
      // still on an older build. Scans the active ticket list and deletes any
      // empty-bodied note it finds.
      const ids: string[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= 4; page++) {
        const r = await rqRequest({ method: "GET", path: page === 1 ? "/ticket" : `/ticket?Ticket_page=${page}`, headers: { accept: "text/html,*/*", "x-requested-with": "" } });
        if (r.status !== 200) break;
        const found = [...(r.body || "").matchAll(/<tr[^>]*data-id="(\d+)"/g)].map((m) => m[1]);
        const fresh = found.filter((t) => !seen.has(t));
        if (!fresh.length) break;
        fresh.forEach((t) => { seen.add(t); ids.push(t); });
      }
      const noteRe = /\{"id":(\d+),"ticket_id":\d+,"user_id":\d+,"note":"((?:[^"\\]|\\.)*)"/g;
      const deleted: Array<{ ticket: string; note_id: string }> = [];
      const failed: Array<{ ticket: string; note_id?: string; error: string }> = [];
      for (const t of ids) {
        const r = await rqRequest({ method: "GET", path: `/ticket/${t}`, headers: { accept: "text/html,*/*", "x-requested-with": "" } });
        if (r.status !== 200) { failed.push({ ticket: t, error: `HTTP ${r.status}` }); continue; }
        const body = r.body || "";
        const csrf = body.match(/value="([^"]+)" name="YII_CSRF_TOKEN"/)?.[1];
        for (const m of body.matchAll(noteRe)) {
          let text = "";
          try { text = JSON.parse(`"${m[2]}"`); } catch { text = m[2]; }
          if (String(text).trim()) continue;   // real note — leave it
          if (!csrf) { failed.push({ ticket: t, note_id: m[1], error: "no csrf" }); continue; }
          const del = await rqRequest({ method: "POST", path: "/ajax/ticketNote/delete", form: { YII_CSRF_TOKEN: csrf, id: m[1], noteId: m[1], ticketId: t } });
          if (del.status === 200) deleted.push({ ticket: t, note_id: m[1] });
          else failed.push({ ticket: t, note_id: m[1], error: `delete HTTP ${del.status}` });
        }
      }
      if (deleted.length) console.log(`sweep_blank_notes: deleted ${deleted.length}`, JSON.stringify(deleted));
      return json({ ok: true, scanned: ids.length, deleted, failed });
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
    if (payload?.action === "sync_ingest") return await actionSyncIngest(payload);
    if (payload?.action === "sync_devices") return await actionSyncDevices(payload);
    if (payload?.action === "sync_claims") {
      // pull both claim Looks (payouts 5759 + parts 5760) → ingest. Repairs
      // first so the invoice→payout_date map is seeded before parts.
      const dry = !!payload?.dry_run;
      const r1 = await actionSyncIngest({ feed: "claim_repairs", look_id: payload?.repairs_look || "5759", dry_run: dry });
      const r2 = await actionSyncIngest({ feed: "claim_parts", look_id: payload?.parts_look || "5760", dry_run: dry });
      return json({ ok: true, repairs: await r1.json().catch(() => null), parts: await r2.json().catch(() => null) });
    }
    if (payload?.action === "sync_commission") {
      // all five commission feeds → commission_sales via ingest. Accessory /
      // service / category refresh the whole current month; device sales the
      // month; device returns the year (returns attribute to the sale date).
      const dry = !!payload?.dry_run;
      const month = "this month";
      const steps: [string, any][] = [
        ["accessory", { feed: "commission_accessory", look_id: "4591", date: month }],
        ["service", { feed: "commission_service", look_id: "5399", date: month }],
        ["category", { feed: "commission_category", look_id: "5817", date: month }],
        ["device", { feed: "commission_device", dashboard_id: "2827", element_id: "12289", result_maker_id: "31223", date: month }],
        ["device_return", { feed: "commission_device_return", dashboard_id: "2830", element_id: "12293", result_maker_id: "31236", date: "this year" }],
      ];
      const out: Record<string, any> = {};
      for (const [name, args] of steps) {
        const r = await actionSyncIngest({ ...args, dry_run: dry });
        out[name] = await r.json().catch(() => null);
      }
      return json({ ok: Object.values(out).every((v: any) => v?.ok !== false), feeds: out });
    }
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
