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
//   ping   → login (or reuse cached session), confirm it's valid. No data.
//   raw    → { method?, path, body?, headers?, form? } proxy ONE authenticated
//            request to cpr.repairq.io and return status + body. This is how we
//            replay a captured query payload: path = the "query/…" URL, body =
//            the captured payload. Session is attached + auto-refreshed on 401.
//
// Guard rails: this holds real credentials and hits an undocumented internal
// API. It is admin-gated (X-CPR-RQ-SECRET must match REPAIRQ_PROXY_SECRET) so
// only our own server-side callers (crons, admin tools) can drive it — never
// the public browser. Deploy with verify_jwt OFF; auth is the shared secret.

const RQ_BASE = "https://cpr.repairq.io";
const USERNAME = Deno.env.get("REPAIRQ_USERNAME") || "";
const PASSWORD = Deno.env.get("REPAIRQ_PASSWORD") || "";
const WORKSTATION_KEY = Deno.env.get("REPAIRQ_WORKSTATION_KEY") || "";
const LOGIN_LOCATION = Deno.env.get("REPAIRQ_LOGIN_LOCATION") || "";
const PROXY_SECRET = Deno.env.get("REPAIRQ_PROXY_SECRET") || "";

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
  if (!USERNAME || !PASSWORD || !WORKSTATION_KEY || !LOGIN_LOCATION) {
    return { ok: false, error: "RepairQ secrets not configured (need USERNAME, PASSWORD, WORKSTATION_KEY, LOGIN_LOCATION)" };
  }
  const form = new URLSearchParams();
  form.set("UserLoginForm[username]", USERNAME);
  form.set("UserLoginForm[password]", PASSWORD);
  form.set("UserLoginForm[workstation_key]", WORKSTATION_KEY);
  form.set("UserLoginForm[currentLocation]", LOGIN_LOCATION);

  const res = await fetch(`${RQ_BASE}/site/login`, {
    method: "POST",
    redirect: "manual",   // the session cookie is on the 302, not the followed page
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/x-www-form-urlencoded",
      "origin": RQ_BASE,
      "referer": `${RQ_BASE}/site/login`,
      "user-agent": UA,
    },
    body: form.toString(),
  });
  const cookie = parseSessionCookie(getSetCookies(res));
  if (!cookie) {
    return { ok: false, error: `login returned no session cookie (HTTP ${res.status}) — check credentials/workstation key` };
  }
  session = { cookie, at: Date.now() };
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
  return { status: res.status, body: text, json: parsed };
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
      return json({ ok: s.ok, session: s.ok ? "active" : null, error: s.error || null });
    }
    if (payload?.action === "raw") {
      if (!payload?.path) return json({ ok: false, error: "path required" }, 400);
      const r = await rqRequest({
        method: payload.method, path: payload.path, body: payload.body,
        form: payload.form, headers: payload.headers,
      });
      return json({ ok: r.status >= 200 && r.status < 300, status: r.status, data: r.json ?? null, body: r.json ? undefined : r.body });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
