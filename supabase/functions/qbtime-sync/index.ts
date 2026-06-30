// QuickBooks Time data layer: keeps the OAuth token fresh and runs syncs.
// Auth: owner JWT (Authorization: Bearer <session>) OR ?secret=<QBT_SYNC_SECRET> (cron/server).
//
// Actions (GET ?action=):
//   ping     -> calls /current_user; proves the token works, returns account info
//   refresh  -> force a token refresh (keep-alive); returns the new expiry
//   users    -> pull all QB Time users, upsert qbtime_users, auto-match to staff by name/username
//
// The access token is short-lived (~10d); getValidToken() trades the refresh token for a new
// access+refresh pair when it's within 2 days of expiry, so the connection never goes stale.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("QBT_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("QBT_CLIENT_SECRET") || "";
const SYNC_SECRET = Deno.env.get("QBT_SYNC_SECRET") || "";
const PROVIDER = "qbtime";
const API = "https://rest.tsheets.com/api/v1/";
const GRANT = "https://rest.tsheets.com/api/v1/grant";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return false;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return false;
  const { data: s } = await admin.from("staff").select("role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s?.role === "owner";
}

// Returns a valid access token, refreshing (and persisting) if it's near expiry.
async function getValidToken(): Promise<string> {
  const { data: tok } = await admin.from("integration_tokens").select("*").eq("provider", PROVIDER).maybeSingle();
  if (!tok || !tok.access_token) throw new Error("not_connected");
  const exp = tok.expires_at ? new Date(tok.expires_at).getTime() : 0;
  const soon = Date.now() > exp - 2 * 24 * 3600 * 1000; // refresh within 2 days of expiry
  if (!soon) return tok.access_token;
  if (!tok.refresh_token) throw new Error("no_refresh_token");

  const form = new URLSearchParams({
    grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: tok.refresh_token,
  });
  const r = await fetch(GRANT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("refresh_failed: " + (d.error || r.status));
  const expires_at = new Date(Date.now() + (Number(d.expires_in) || 0) * 1000).toISOString();
  await admin.from("integration_tokens").update({
    access_token: d.access_token,
    refresh_token: d.refresh_token || tok.refresh_token,
    expires_at,
    meta: { scope: d.scope, token_type: d.token_type, client_url: d.client_url },
    updated_at: new Date().toISOString(),
  }).eq("provider", PROVIDER);
  return d.access_token;
}

async function qbtGet(path: string, token: string, params?: Record<string, string | number>) {
  const u = new URL(API + path);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString(), { headers: { Authorization: "Bearer " + token } });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function norm(s: unknown) { return String(s ?? "").trim().toLowerCase(); }

// common nickname groups (interchangeable forms) for fuzzy first-name matching
const NICK_GROUPS: string[][] = [
  ["michael","mike","mick","mikey"],["robert","rob","bob","bobby"],["william","will","bill","billy"],
  ["richard","rich","rick","ricky","dick"],["joshua","josh"],["benjamin","ben","benji","benny"],
  ["nicholas","nick","nico","nicky"],["james","jim","jimmy","jamie"],["john","johnny","jack"],
  ["charles","charlie","chuck"],["thomas","tom","tommy"],["christopher","chris"],["daniel","dan","danny"],
  ["matthew","matt","matty"],["anthony","tony"],["joseph","joe","joey"],["david","dave","davey"],
  ["edward","ed","eddie","ted"],["andrew","andy","drew"],["steven","stephen","steve"],
  ["kenneth","ken","kenny"],["samuel","sam","sammy"],["alexander","alex","xander"],["zachary","zach","zack"],
  ["jacob","jake"],["jonathan","jon","jonny","jonathon"],["timothy","tim","timmy"],["jeffrey","jeff"],
  ["gregory","greg"],["nathaniel","nathan","nate"],["patrick","pat"],["frederick","fred","freddy"],
  ["lawrence","larry"],["raymond","ray"],["vincent","vince","vinny","vinnie"],["maxwell","max"],
  ["gabriel","gabe"],["theodore","theo","ted"],["dominic","dom"],["jennifer","jen","jenny"],
  ["elizabeth","liz","beth","lizzy"],["katherine","katharine","kate","katie","kat"],
];
const NICK = new Map<string, Set<string>>();
for (const g of NICK_GROUPS) { const set = new Set(g); for (const n of g) NICK.set(n, set); }
function firstForms(name: string): Set<string> { const n = norm(name); return new Set([n, ...(NICK.get(n) || [])]); }
function firstsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const A = firstForms(a); for (const x of firstForms(b)) if (A.has(x)) return true; return false;
}

// Pull every QB Time user, upsert into qbtime_users, and match each to a staff row.
async function syncUsers(token: string) {
  const users: Record<string, unknown>[] = [];
  let page = 1;
  for (let i = 0; i < 50; i++) { // hard page cap
    const { status, data } = await qbtGet("users", token, { page, per_page: 50, active: "both" });
    if (status !== 200) return { ok: false, error: `users_${status}`, detail: data };
    const obj = (data?.results?.users || {}) as Record<string, Record<string, unknown>>;
    users.push(...Object.values(obj));
    if (!data?.more) break;
    page++;
  }

  // Existing mappings — preserve any staff_id already on file (manual maps win, never auto-clobbered).
  const { data: existing } = await admin.from("qbtime_users").select("qbt_id, staff_id");
  const existingMap = new Map<string, number | null>();
  for (const e of existing || []) existingMap.set(String(e.qbt_id), (e.staff_id as number) ?? null);

  // staff roster, normalized for matching.
  const { data: staff } = await admin.from("staff").select("id, first_name, last_name, username, display_name, active, start_date");
  const staffStart = new Map<number, string | null>();
  for (const s of staff || []) staffStart.set(s.id as number, (s.start_date as string) ?? null);
  // QB Time hire/term dates come as YYYY-MM-DD; "0000-00-00" means unset.
  const qbDate = (v: unknown): string | null => {
    const d = String(v ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== "0000-00-00" ? d : null;
  };
  type SRow = { id: number; fn: string; ln: string; user: string; dfn: string; dln: string };
  const list: SRow[] = [];
  const byUser = new Map<string, number>();
  for (const s of staff || []) {
    const fn = norm(s.first_name), ln = norm(s.last_name);
    if (s.username) byUser.set(norm(s.username), s.id as number);
    const dn = String(s.display_name || "").trim().split(/\s+/);
    const dfn = dn.length ? norm(dn[0]) : "", dln = dn.length >= 2 ? norm(dn.slice(1).join(" ")) : "";
    list.push({ id: s.id as number, fn, ln, user: norm(s.username), dfn, dln });
  }

  // Auto-match a QB user → staff id: exact legal → exact display → username → nickname (same last name).
  function autoMatch(u: Record<string, unknown>): number | null {
    const fn = norm(u.first_name), ln = norm(u.last_name), user = norm(u.username);
    // 1) exact legal first+last
    for (const s of list) if (s.fn && s.ln && s.fn === fn && s.ln === ln) return s.id;
    // 2) exact display first+last
    for (const s of list) if (s.dfn && s.dln && s.dfn === fn && s.dln === ln) return s.id;
    // 3) username
    if (user && byUser.has(user)) return byUser.get(user)!;
    // 4) nickname-aware: same last name, interchangeable first form (legal or display)
    for (const s of list) {
      if (s.ln && s.ln === ln && (firstsMatch(s.fn, fn) || (s.dfn && firstsMatch(s.dfn, fn)))) return s.id;
    }
    return null;
  }

  // Active-staff last names — the dupe guard for auto-create (never spawn a second row for
  // someone who's likely already here, e.g. "Michael Amador" QB ↔ "Vince Amador" MRT).
  const activeLastNames = new Set<string>();
  for (const s of staff || []) if (s.active && norm(s.last_name)) activeLastNames.add(norm(s.last_name));

  const stamp = new Date().toISOString();
  const created: { qbt_id: string; staff_id: number; name: string }[] = [];
  let backfilledStart = 0;

  const rows: Record<string, unknown>[] = [];
  for (const u of users) {
    const qbt_id = String(u.id);
    const prior = existingMap.get(qbt_id);
    const seenBefore = existingMap.has(qbt_id);
    const active = u.active === undefined ? null : !!u.active;
    // Preserve a manual/prior mapping if present; only auto-match when we have nothing yet.
    let staff_id: number | null = (prior != null) ? prior : autoMatch(u);

    // Auto-create the MRT staff row for a brand-new QB hire: first time we've seen this qbt_id,
    // it's active, no name match, and no last-name collision with existing active staff. Existing
    // roster (already in qbtime_users) never triggers this — so no dupes from the back-fill set.
    if (staff_id == null && active === true && !seenBefore && !activeLastNames.has(norm(u.last_name))) {
      const fn = (u.first_name as string) || "", ln = (u.last_name as string) || "";
      const legal = `${fn} ${ln}`.trim() || (u.username as string) || `QB ${qbt_id}`;
      const { data: ins, error } = await admin.from("staff").insert({
        display_name: legal,            // shown name = legal until the owner sets a preferred name
        first_name: fn || null, last_name: ln || null,
        role: "team_member", active: true, archived: false,
        hr_status: "active", start_date: qbDate((u as Record<string, unknown>).hire_date),  // hire date from QB
        // stub: no PIN/store/login yet — the owner finishes setup (onboarding) on the profile
        pin_hash: null, home_store: null, authorized_stores: null, auth_uid: null,
      }).select("id").single();
      if (!error && ins) { staff_id = ins.id as number; created.push({ qbt_id, staff_id, name: legal }); activeLastNames.add(norm(ln)); }
    }

    // Backfill hire date onto a linked staff row that has none — never overwrite an owner-entered date.
    if (staff_id != null && staffStart.has(staff_id) && staffStart.get(staff_id) == null) {
      const hd = qbDate((u as Record<string, unknown>).hire_date);
      if (hd) { await admin.from("staff").update({ start_date: hd }).eq("id", staff_id); staffStart.set(staff_id, hd); backfilledStart++; }
    }

    rows.push({
      qbt_id, staff_id,
      first_name: (u.first_name as string) || null,
      last_name: (u.last_name as string) || null,
      email: (u.email as string) || null,
      username: (u.username as string) || null,
      active, raw: u, last_synced: stamp,
    });
  }

  if (rows.length) {
    const { error } = await admin.from("qbtime_users").upsert(rows, { onConflict: "qbt_id" });
    if (error) return { ok: false, error: "db_" + error.message };
  }

  // One-way termination sync — PROPOSE only, never auto-apply. A *mapped* QB user that's gone
  // inactive while the MRT staff row is still active is a *candidate* for deactivation; we surface
  // it for the owner to confirm in Settings (read → propose → confirm → write), never the reverse
  // (terminating in MRT must not touch QBO). Auto-deactivating here once nuked the owner's own row.
  const activeStaff = new Map<number, string>();
  for (const s of staff || []) if (s.active) activeStaff.set(s.id as number, String(s.display_name || `${s.first_name ?? ""} ${s.last_name ?? ""}`).trim());
  const termination_candidates = rows
    .filter((r) => r.staff_id != null && r.active === false && activeStaff.has(r.staff_id))
    .map((r) => ({ qbt_id: r.qbt_id, staff_id: r.staff_id, name: activeStaff.get(r.staff_id as number),
      term_date: qbDate((r.raw as Record<string, unknown>)?.term_date) }));   // when QB recorded the termination

  return {
    ok: true,
    fetched: rows.length,
    matched: rows.filter((r) => r.staff_id != null).length,
    created: created.length ? created : undefined,                 // new hires auto-created in MRT
    start_dates_backfilled: backfilledStart || undefined,          // hire dates pulled from QB onto blank records
    termination_candidates: termination_candidates.length ? termination_candidates : undefined,
    // only surface *active* unmatched QB users — inactive strangers are just noise.
    unmatched: rows.filter((r) => r.staff_id == null && r.active !== false)
      .map((r) => ({ qbt_id: r.qbt_id, name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(), username: r.username })),
  };
}

// Manually link (or unlink) a QB Time user to a staff row. Body: { qbt_id, staff_id|null }.
async function mapUser(qbt_id: string, staff_id: number | null) {
  if (!qbt_id) return { ok: false, error: "qbt_id required" };
  const { error } = await admin.from("qbtime_users")
    .update({ staff_id, last_synced: new Date().toISOString() }).eq("qbt_id", qbt_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, qbt_id, staff_id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "ping";

  // auth: owner JWT or shared sync secret
  const secret = url.searchParams.get("secret") || req.headers.get("x-qbt-secret") || "";
  const authed = (SYNC_SECRET && secret === SYNC_SECRET) || (await isOwner(req));
  if (!authed) return json({ error: "forbidden", detail: "Owner or sync secret required." }, 403);

  let token: string;
  try { token = await getValidToken(); }
  catch (e) { return json({ error: "token", detail: String((e as Error).message) }, 409); }

  if (action === "refresh") {
    const { data } = await admin.from("integration_tokens").select("expires_at, updated_at").eq("provider", PROVIDER).maybeSingle();
    return json({ ok: true, expires_at: data?.expires_at, updated_at: data?.updated_at });
  }
  if (action === "ping") {
    const { status, data } = await qbtGet("current_user", token);
    if (status !== 200) return json({ ok: false, error: `ping_${status}`, detail: data }, 502);
    const u = Object.values((data?.results?.users || {}) as Record<string, Record<string, unknown>>)[0] || {};
    return json({ ok: true, account: data?.results?.users ? (u.client_url || data?.supplemental_data?.client_url) : null,
      user: { id: u.id, name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim(), email: u.email } });
  }
  if (action === "users") {
    return json(await syncUsers(token));
  }
  if (action === "roster") {
    // feed the Settings manual-map UI: every QB user + their current staff link, plus the staff list.
    const { data: qbu } = await admin.from("qbtime_users")
      .select("qbt_id, staff_id, first_name, last_name, username, email, active")
      .order("active", { ascending: false }).order("last_name");
    const { data: staff } = await admin.from("staff")
      .select("id, first_name, last_name, display_name, role, active").eq("active", true).order("first_name");
    return json({ ok: true, qbtime_users: qbu || [], staff: staff || [] });
  }
  if (action === "deactivate") {
    // owner-confirmed termination: flip the MRT staff row inactive. POST { staff_id } (or ?staff_id=).
    let sid: string | null = url.searchParams.get("staff_id");
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (b.staff_id != null) sid = String(b.staff_id);
    }
    if (!sid) return json({ ok: false, error: "staff_id required" }, 400);
    const { error } = await admin.from("staff").update({ active: false }).eq("id", Number(sid));
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, staff_id: Number(sid), active: false });
  }
  if (action === "map") {
    // POST { qbt_id, staff_id } — staff_id null/empty unlinks. (GET fallback via query params too.)
    let qbt_id = url.searchParams.get("qbt_id") || "";
    let sid: string | null = url.searchParams.get("staff_id");
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (b.qbt_id != null) qbt_id = String(b.qbt_id);
      if (b.staff_id !== undefined) sid = b.staff_id == null ? null : String(b.staff_id);
    }
    const staff_id = (sid == null || sid === "") ? null : Number(sid);
    return json(await mapUser(qbt_id, staff_id));
  }
  return json({ error: "bad_action" }, 400);
});
