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
  const s = await callerStaff(req);
  return s?.role === "owner";
}
// The signed-in staff member behind the request's JWT (null if none/invalid/inactive).
async function callerStaff(req: Request): Promise<Record<string, unknown> | null> {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff").select("id, role, display_name, home_store, authorized_stores")
    .eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s || null;
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
// write helper for POST/PUT/DELETE (clock in/out, PTO push/delete)
async function qbtReq(method: string, path: string, token: string, body: unknown) {
  const r = await fetch(API + path, {
    method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function norm(s: unknown) { return String(s ?? "").trim().toLowerCase(); }

// ---- Time clock helpers (write to QB Time) ----
const CLASS_CF = "819414";   // required "Class" customfield = store
function normStore(s: string) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"); }
async function qbtIdForStaff(staffId: string): Promise<string | null> {
  // A staff member may (rarely) map to more than one QB Time user; prefer one that can track time.
  const { data } = await admin.from("qbtime_users").select("qbt_id, raw, active").eq("staff_id", Number(staffId));
  if (!data || !data.length) return null;
  const pick = data.find((u) => (u.raw as Record<string, Record<string, unknown>>)?.permissions?.time_tracking === true)
    || data.find((u) => u.active) || data[0];
  return pick?.qbt_id ? String(pick.qbt_id) : null;
}
async function classForStore(token: string, store: string): Promise<{ id: string; name: string } | null> {
  const items = await qbtGet("customfielditems", token, { customfield_id: CLASS_CF });
  for (const it of Object.values((items.data?.results?.customfielditems || {}) as Record<string, Record<string, unknown>>))
    if (normStore(String(it.name)) === normStore(store)) return { id: String(it.id), name: String(it.name) };
  return null;
}
async function openTimesheet(token: string, qbtId: string): Promise<Record<string, unknown> | null> {
  // QB Time rejects very wide ranges; an open punch's date is today (window covers overnight shifts).
  const today = ymdIn(new Date(), "America/Los_Angeles");
  const r = await qbtGet("timesheets", token, { user_ids: qbtId, on_the_clock: "yes", start_date: addDays(today, -2), end_date: addDays(today, 1) });
  return Object.values((r.data?.results?.timesheets || {}) as Record<string, Record<string, unknown>>)[0] || null;
}

// ---- PTO / time-off (write to QB Time) ----
const PTO_MAP: Record<string, string> = { Vacation: "Vacation", Sick: "Sick", Personal: "Paid Time Off", PTO: "Paid Time Off", Unpaid: "Unpaid Time Off", Holiday: "Holiday" };
async function ptoJobcodeId(typeName: string): Promise<number | null> {
  const want = PTO_MAP[String(typeName)] || "Paid Time Off";
  const { data } = await admin.from("qbtime_jobcodes").select("qbt_id").ilike("name", want).limit(1);
  return data && data[0] ? Number(data[0].qbt_id) : null;
}
function daysInRange(start: string, end: string): string[] {
  const out: string[] = []; let d = start;
  for (let i = 0; i < 90 && d <= end; i++) { out.push(d); d = addDays(d, 1); }
  return out.length ? out : [start];
}
// Create ONE approved QB Time time-off request spanning [start,end]; total `hours` split per day.
async function createTimeOff(token: string, qbtId: string, jobcodeId: number, start: string, end: string, hours: number) {
  const days = daysInRange(start, end), n = days.length;
  const totalSec = Math.round(Number(hours) * 3600), per = Math.floor(totalSec / n), rem = totalSec - per * n;
  const entries = days.map((d, i) => ({ jobcode_id: Number(jobcodeId), date: d, duration: per + (i === 0 ? rem : 0), entry_method: "manual", active: true }))
    .filter((e) => e.duration > 0);
  if (!entries.length) return { ok: false, id: null as number | null, msg: "zero_duration", raw: {} };
  const r = await qbtReq("POST", "time_off_requests", token, { data: [{ user_id: Number(qbtId), status: "approved", time_off_request_entries: entries }] });
  const res = Object.values((r.data?.results?.time_off_requests || {}) as Record<string, Record<string, unknown>>)[0] || {};
  return { ok: res._status_code === 200, id: (res.id as number) ?? null, msg: res._status_message as string, raw: r.data };
}
// Cancel QB Time time-off requests (approval undone/denied). No DELETE endpoint — PUT status.
async function cancelTimeOff(token: string, ids: number[]) {
  for (const id of ids) await qbtReq("PUT", "time_off_requests", token, { data: [{ id: Number(id), status: "canceled" }] });
}

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

  // Wage type from QB (salaried = overtime-exempt) → staff.wage_type, from the ACTIVE linked user.
  let wageSet = 0;
  for (const r of rows) {
    if (r.staff_id == null || r.active !== true) continue;
    const raw = r.raw as Record<string, unknown>;
    if (raw.salaried === undefined) continue;
    const wt = raw.salaried ? "salary" : "hourly";
    const { error } = await admin.from("staff").update({ wage_type: wt }).eq("id", r.staff_id).neq("wage_type", wt);
    if (!error) wageSet++;
  }

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

// Pull QB Time jobcodes (regular + PTO) so we can label hours and PTO balances by name.
async function syncJobcodes(token: string) {
  const rows: Record<string, unknown>[] = [];
  let page = 1;
  for (let i = 0; i < 50; i++) {
    const { status, data } = await qbtGet("jobcodes", token, { page, per_page: 200, active: "both", type: "all" });
    if (status !== 200) return { ok: false, error: `jobcodes_${status}`, detail: data };
    const obj = (data?.results?.jobcodes || {}) as Record<string, Record<string, unknown>>;
    for (const j of Object.values(obj)) {
      rows.push({
        qbt_id: String(j.id), name: (j.name as string) || null, type: (j.type as string) || null,
        parent_id: j.parent_id != null ? String(j.parent_id) : null, short_code: (j.short_code as string) || null,
        active: j.active === undefined ? null : !!j.active, raw: j, updated_at: new Date().toISOString(),
      });
    }
    if (!data?.more) break;
    page++;
  }
  if (rows.length) {
    const { error } = await admin.from("qbtime_jobcodes").upsert(rows, { onConflict: "qbt_id" });
    if (error) return { ok: false, error: "db_" + error.message };
  }
  return { ok: true, jobcodes: rows.length, pto: rows.filter((r) => r.type === "pto").length };
}

// YYYY-MM-DD for a date in a timezone.
function ymdIn(d: Date, tz: string): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}
// The Sunday that begins the current week (Sun–Sat), in the given tz.
function weekStart(tz: string): string {
  const today = ymdIn(new Date(), tz);
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0=Sun … 6=Sat
  const s = new Date(Date.UTC(y, m - 1, d - dow));
  return s.toISOString().slice(0, 10);
}
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Pull QB Time timesheets for a date range and roll up into qbtime_timesheets
// (one row per QB user per day: total seconds + per-jobcode breakdown + on-the-clock flag).
async function syncTimesheets(token: string, startDate: string, endDate: string) {
  // map qbt user id -> staff id (so each daily row carries the MRT link for RLS/feature reads)
  const { data: qbu } = await admin.from("qbtime_users").select("qbt_id, staff_id");
  const staffOf = new Map<string, number | null>();
  for (const u of qbu || []) staffOf.set(String(u.qbt_id), (u.staff_id as number) ?? null);

  type Agg = { seconds: number; jobcodes: Record<string, number>; onclock: boolean };
  const byUserDay = new Map<string, Agg>();
  let page = 1, fetched = 0;
  for (let i = 0; i < 100; i++) {
    const { status, data } = await qbtGet("timesheets", token, { start_date: startDate, end_date: endDate, page, per_page: 200 });
    if (status !== 200) return { ok: false, error: `timesheets_${status}`, detail: data };
    const obj = (data?.results?.timesheets || {}) as Record<string, Record<string, unknown>>;
    const arr = Object.values(obj);
    for (const t of arr) {
      const uid = String(t.user_id), date = String(t.date || "").slice(0, 10);
      if (!uid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const secs = Number(t.duration) || 0;            // seconds; QB sends elapsed for open shifts too
      const jc = String(t.jobcode_id ?? "0");
      const k = uid + "|" + date;
      const a = byUserDay.get(k) || { seconds: 0, jobcodes: {}, onclock: false };
      a.seconds += secs;
      a.jobcodes[jc] = (a.jobcodes[jc] || 0) + secs;
      if (t.on_the_clock === true) a.onclock = true;
      byUserDay.set(k, a);
      fetched++;
    }
    if (!data?.more) break;
    page++;
  }

  const stamp = new Date().toISOString();
  const rows = Array.from(byUserDay.entries()).map(([k, a]) => {
    const [uid, biz_date] = k.split("|");
    return { qbt_user_id: uid, biz_date, staff_id: staffOf.get(uid) ?? null,
      seconds: a.seconds, jobcodes: a.jobcodes, on_the_clock: a.onclock, updated_at: stamp };
  });

  if (rows.length) {
    const { error } = await admin.from("qbtime_timesheets").upsert(rows, { onConflict: "qbt_user_id,biz_date" });
    if (error) return { ok: false, error: "db_" + error.message };
  }
  return { ok: true, range: { start: startDate, end: endDate }, timesheets: fetched, day_rows: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "ping";

  // auth: owner JWT or shared sync secret for admin actions; any signed-in staff may use
  // the clock actions (but only for THEMSELVES unless owner/secret — enforced below).
  const secret = url.searchParams.get("secret") || req.headers.get("x-qbt-secret") || "";
  const bySecret = !!SYNC_SECRET && secret === SYNC_SECRET;
  const caller = bySecret ? null : await callerStaff(req);
  const privileged = bySecret || caller?.role === "owner";
  const isClock = action.startsWith("clock_");
  const authed = privileged || (isClock && !!caller);
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
  if (action === "jobcodes") {
    return json(await syncJobcodes(token));
  }
  if (action === "timesheets") {
    // ?start=&end= (YYYY-MM-DD). Or ?days=N for a trailing N-day window (cron uses this to
    // re-sync across the week boundary and catch late edits). Default: this week (Sun) → today.
    const tz = url.searchParams.get("tz") || "America/Los_Angeles";
    const days = Number(url.searchParams.get("days") || 0);
    const today = ymdIn(new Date(), tz);
    const start = url.searchParams.get("start") || (days > 0 ? addDays(today, -days) : weekStart(tz));
    const end = url.searchParams.get("end") || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
      return json({ ok: false, error: "start/end must be YYYY-MM-DD" }, 400);
    return json(await syncTimesheets(token, start, end));
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
  if (action === "clock_status" || action === "clock_in" || action === "clock_out" || action === "clock_delete") {
    const b = req.method === "POST" ? (await req.json().catch(() => ({})) as Record<string, unknown>) : {};
    let staff_id = String(b.staff_id ?? url.searchParams.get("staff_id") ?? "");
    let qbt_id = String(b.qbt_id ?? url.searchParams.get("qbt_id") ?? "");
    let store = String(b.store ?? url.searchParams.get("store") ?? "");
    // Default to clocking the CALLER themselves. A privileged caller (owner/secret) may
    // instead target someone else by explicitly passing staff_id/qbt_id (kiosk/manager);
    // a non-privileged caller can ONLY ever clock themselves.
    if (caller && (!privileged || (!qbt_id && !staff_id))) {
      staff_id = String(caller.id); qbt_id = "";
      if (!store) store = String(caller.home_store ?? "");
    }
    if (!qbt_id && staff_id) qbt_id = (await qbtIdForStaff(staff_id)) || "";
    if (action !== "clock_delete" && !qbt_id) return json({ ok: false, error: "no_qbt_link", detail: "This staff member isn't linked to a QB Time user." }, 400);

    if (action === "clock_status") {
      const ts = await openTimesheet(token, qbt_id);
      return json({ ok: true, on_the_clock: !!ts, id: ts?.id ?? null, start: ts?.start ?? null, customfields: ts?.customfields ?? null });
    }
    if (action === "clock_in") {
      const existing = await openTimesheet(token, qbt_id);
      if (existing) return json({ ok: true, already_clocked_in: true, id: existing.id, start: existing.start });
      if (!store) return json({ ok: false, error: "store_required" }, 400);
      const cls = await classForStore(token, store);
      if (!cls) return json({ ok: false, error: "no_class_for_store", store }, 400);
      const body = { data: [{ user_id: Number(qbt_id), type: "regular", start: nowIso(), end: "", jobcode_id: 0, customfields: { [CLASS_CF]: cls.name } }] };
      const r = await qbtReq("POST", "timesheets", token, body);
      const created = Object.values((r.data?.results?.timesheets || {}) as Record<string, Record<string, unknown>>)[0];
      return json({ ok: r.status === 200 && (created?._status_code === 200), status: r.status, id: created?.id ?? null, sent_class: cls, result: r.data });
    }
    if (action === "clock_out") {
      const ts = await openTimesheet(token, qbt_id);
      if (!ts) return json({ ok: true, not_clocked_in: true });
      const body = { data: [{ id: Number(ts.id), end: nowIso() }] };
      const r = await qbtReq("PUT", "timesheets", token, body);
      const upd = Object.values((r.data?.results?.timesheets || {}) as Record<string, Record<string, unknown>>)[0];
      return json({ ok: r.status === 200 && (upd?._status_code === 200), status: r.status, id: ts.id, result: r.data });
    }
    if (action === "clock_delete") {   // test cleanup / undo — privileged only
      if (!privileged) return json({ ok: false, error: "forbidden" }, 403);
      const id = String(b.id ?? url.searchParams.get("id") ?? "");
      if (!id) return json({ ok: false, error: "id_required" }, 400);
      const r = await qbtReq("DELETE", "timesheets?ids=" + encodeURIComponent(id), token, null);
      return json({ ok: r.status === 200, status: r.status, result: r.data });
    }
  }
  if (action === "timeoff_sync") {
    // Reconcile approved time-off → QB Time; cancel entries no longer approved. One-way
    // MRT→QBO, time-off only, idempotent (create-once, tracked via qbt_ids). Paid → "Paid
    // Time Off" code; unpaid → "Unpaid Time Off" (the codes staff are actually assigned).
    if (!privileged) return json({ error: "forbidden" }, 403);
    const today = ymdIn(new Date(), "America/Los_Angeles");
    // Only sync current/upcoming approvals — never retro-write into already-run payroll.
    const { data: toCreate } = await admin.from("time_off_requests")
      .select("id,staff_id,type,start_date,end_date,hours,paid,qbt_ids")
      .eq("status", "approved").is("qbt_ids", null).gte("end_date", today);
    const { data: toCancel } = await admin.from("time_off_requests")
      .select("id,qbt_ids,status").not("qbt_ids", "is", null).neq("status", "approved");
    let created = 0, canceled = 0; const errors: unknown[] = [];
    for (const r of (toCreate || [])) {
      const qbtId = await qbtIdForStaff(String(r.staff_id));
      if (!qbtId) { errors.push({ id: r.id, e: "no_qbt_link" }); continue; }
      const jc = await ptoJobcodeId(r.paid === false ? "Unpaid" : "PTO");
      if (!jc) { errors.push({ id: r.id, e: "no_jobcode" }); continue; }
      const hrs = (r.hours && Number(r.hours) > 0) ? Number(r.hours) : daysInRange(r.start_date, r.end_date).length * 8;
      const res = await createTimeOff(token, qbtId, jc, r.start_date, r.end_date, hrs);
      if (res.ok && res.id) { await admin.from("time_off_requests").update({ qbt_ids: [res.id], qbt_synced_at: new Date().toISOString() }).eq("id", r.id); created++; }
      else errors.push({ id: r.id, e: "create_failed", msg: res.msg });
    }
    for (const r of (toCancel || [])) {
      const ids = Array.isArray(r.qbt_ids) ? (r.qbt_ids as number[]) : [];
      await cancelTimeOff(token, ids.map(Number));
      await admin.from("time_off_requests").update({ qbt_ids: null, qbt_synced_at: new Date().toISOString() }).eq("id", r.id);
      canceled++;
    }
    return json({ ok: true, created, canceled, errors });
  }
  if (action === "to_read") {
    // Read QB Time time-off requests (for verification). Defaults to all linked users.
    if (!privileged) return json({ error: "forbidden" }, 403);
    let uids = url.searchParams.get("qbt_id") || "";
    if (!uids) {
      const { data } = await admin.from("qbtime_users").select("qbt_id").not("staff_id", "is", null);
      uids = (data || []).map((u) => u.qbt_id).join(",");
    }
    const r = await qbtGet("time_off_requests", token, { user_ids: uids });
    const reqs = (r.data?.results?.time_off_requests || {}) as Record<string, Record<string, unknown>>;
    const out = Object.values(reqs).map((t) => ({ id: t.id, user_id: t.user_id, status: t.status, start: t.start_date, end: t.end_date, hours: (Number(t.total_duration) || 0) / 3600, jobcode_id: t.jobcode_id }));
    return json({ ok: true, count: out.length, requests: out });
  }
  if (action === "customfields") {
    // Discover QB Time custom fields + items (the QuickBooks "class"/location lives here).
    const cf = await qbtGet("customfields", token, { active: "yes" });
    const fields = (cf.data?.results?.customfields || {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, unknown> = {};
    for (const f of Object.values(fields)) {
      const items = await qbtGet("customfielditems", token, { customfield_id: String(f.id) });
      const its = Object.values((items.data?.results?.customfielditems || {}) as Record<string, Record<string, unknown>>)
        .map((it) => ({ id: it.id, name: it.name, active: it.active }));
      out[String(f.name)] = { id: f.id, required: f.required, item_count: its.length, items: its };
    }
    return json({ ok: true, cf_status: cf.status, fields: out });
  }
  return json({ error: "bad_action" }, 400);
});
