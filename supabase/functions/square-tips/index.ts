// Daily Square tips feed → tips_daily → commission_tips (pool + QB Time hours).
//
// Employees' tip share on My Commission = (their hours / store hours) × store pool,
// so keeping pool (Square) and hours (QB Time) fresh gives everyone a daily-updating
// tips number without anyone typing a thing.
//
// Actions (?action=):
//   pull    — pull tips per location from the Square Payments API for the last N local
//             business days (?days=3). Needs the SQUARE_ACCESS_TOKEN function secret.
//   ingest  — webhook for a parsed daily report (Zapier email parse etc.). POST JSON:
//             { date?: 'YYYY-MM-DD', source?: string,
//               tips: [{ store: 'CPR Eugene'|'Eugene'|…, amount: 123.45, date?: 'YYYY-MM-DD' }] }
//             date defaults to yesterday (America/Los_Angeles).
//   status  — location mapping + the period's rows (sanity check).
//
// Auth: header x-cpr-secret or ?secret= must equal the TIPS_SECRET function secret.
// After writing tips_daily, every touched (store, month) rolls up:
//   commission_tips.pool  = sum of that month's tips_daily rows
//   commission_tips.hours = month worked hours per person from qbtime_timesheets
//                           (PTO jobcodes excluded), keyed by display name — existing
//                           names not backed by QB Time data are left untouched.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("TIPS_SECRET") || "";
const SQ_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN") || "";
const SQ_API = "https://connect.squareup.com/v2/";
const SQ_VERSION = "2025-01-23";
const TZ = "America/Los_Angeles";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cpr-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function authed(req: Request, url: URL): boolean {
  if (!SECRET) return false;
  return req.headers.get("x-cpr-secret") === SECRET || url.searchParams.get("secret") === SECRET;
}

/* ---------- dates (local business days) ---------- */
function laDateISO(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p; // en-CA gives YYYY-MM-DD
}
function laOffset(dateISO: string): string {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .format(new Date(dateISO + "T12:00:00Z"));
  const m = s.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "-08:00";
}
function addDaysISO(dateISO: string, n: number): string {
  const p = dateISO.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
function monthEndISO(period: string): string {
  const p = period.split("-").map(Number);
  return period + "-" + ("0" + new Date(p[0], p[1], 0).getDate()).slice(-2);
}

/* ---------- store name resolution ---------- */
let STORE_CACHE: string[] | null = null;
async function storeNames(): Promise<string[]> {
  if (STORE_CACHE) return STORE_CACHE;
  const { data } = await admin.from("stores").select("store");
  STORE_CACHE = (data || []).map((r) => String(r.store)).filter(Boolean);
  return STORE_CACHE;
}
// match "Salem", "CPR Cell Phone Repair Eugene", a Square location name, … to a store
async function resolveStore(name: string): Promise<string | null> {
  const stores = await storeNames();
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  for (const s of stores) if (s.toLowerCase() === n) return s;
  for (const s of stores) {
    const keys = s.toLowerCase().split(/\s+/).filter((w) => w !== "cpr" && w.length >= 4);
    if (keys.some((k) => n.includes(k))) return s;
  }
  return null;
}

/* ---------- rollup: tips_daily + QB Time hours → commission_tips ---------- */
async function monthHoursByName(period: string, store: string): Promise<Record<string, number>> {
  const [{ data: staff }, { data: ts }] = await Promise.all([
    admin.from("staff").select("id,display_name,home_store,active").eq("active", true),
    // off_seconds = PTO + Unpaid Time Off jobcode time (computed by qbtime-sync)
    admin.from("qbtime_timesheets").select("staff_id,seconds,off_seconds")
      .gte("biz_date", period + "-01").lte("biz_date", monthEndISO(period)),
  ]);
  const mine = new Map<number, string>();
  for (const s of staff || []) if (s.home_store === store) mine.set(Number(s.id), String(s.display_name));
  const secs = new Map<number, number>();
  for (const r of ts || []) {
    const sid = Number(r.staff_id);
    if (!sid || !mine.has(sid)) continue;
    const s = Math.max(0, (Number(r.seconds) || 0) - (Number(r.off_seconds) || 0));
    secs.set(sid, (secs.get(sid) || 0) + s);
  }
  const out: Record<string, number> = {};
  for (const [sid, s] of secs) { const h = Math.round(s / 3600 * 100) / 100; if (h > 0) out[mine.get(sid)!] = h; }
  return out;
}
async function rollup(store: string, period: string) {
  const { data: days } = await admin.from("tips_daily").select("biz_date,amount")
    .eq("store", store).gte("biz_date", period + "-01").lte("biz_date", monthEndISO(period));
  // Only own a month's pool when daily coverage starts at the 1st — a partial
  // backfill (e.g. adoption mid-month) must never clobber a hand-entered pool.
  const covered = (days || []).some((r) => String(r.biz_date).slice(0, 10) === period + "-01");
  if (!covered) return { store, period, skipped: "partial_coverage" };
  const pool = Math.round((days || []).reduce((a, r) => a + (Number(r.amount) || 0), 0) * 100) / 100;
  const auto = await monthHoursByName(period, store);
  const { data: cur } = await admin.from("commission_tips").select("hours")
    .eq("store", store).eq("period", period).maybeSingle();
  const hours = Object.assign({}, (cur?.hours as Record<string, unknown>) || {});
  for (const name in auto) hours[name] = { pp1: auto[name] };
  const { error } = await admin.from("commission_tips").upsert(
    { store, period, pool, hours }, { onConflict: "store,period" });
  if (error) throw new Error("rollup_" + error.message);
  return { store, period, pool, people: Object.keys(hours).length };
}

/* ---------- write daily rows, then roll up touched months ---------- */
async function writeDays(rows: { store: string; biz_date: string; amount: number; source: string; raw?: unknown }[]) {
  if (!rows.length) return { rows: 0, rollups: [] };
  const stamp = new Date().toISOString();
  const { error } = await admin.from("tips_daily").upsert(
    rows.map((r) => ({ ...r, updated_at: stamp })), { onConflict: "store,biz_date" });
  if (error) throw new Error("tips_daily_" + error.message);
  const touched = new Set(rows.map((r) => r.store + "|" + r.biz_date.slice(0, 7)));
  const rollups = [];
  for (const t of touched) { const [store, period] = t.split("|"); rollups.push(await rollup(store, period)); }
  return { rows: rows.length, rollups };
}

/* ---------- Square API pull ---------- */
async function sqGet(path: string) {
  const r = await fetch(SQ_API + path, {
    headers: { Authorization: "Bearer " + SQ_TOKEN, "Square-Version": SQ_VERSION, "Content-Type": "application/json" },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function pull(daysBack: number) {
  if (!SQ_TOKEN) return { ok: false, error: "no_square_token", hint: "Set the SQUARE_ACCESS_TOKEN function secret (Square Dashboard → Developer → your app → Production access token)." };
  const loc = await sqGet("locations");
  if (loc.status !== 200) return { ok: false, error: "locations_" + loc.status, detail: loc.data };
  const mapped: { id: string; name: string; store: string }[] = [];
  const unmatched: string[] = [];
  for (const l of (loc.data.locations || [])) {
    if (l.status && l.status !== "ACTIVE") continue;
    const store = await resolveStore(String(l.name || ""));
    if (store) mapped.push({ id: String(l.id), name: String(l.name), store });
    else unmatched.push(String(l.name || l.id));
  }
  if (!mapped.length) return { ok: false, error: "no_locations_matched", square_locations: unmatched };
  const today = laDateISO(new Date());
  const rows: { store: string; biz_date: string; amount: number; source: string; raw: unknown }[] = [];
  for (let i = 1; i <= daysBack; i++) {
    const day = addDaysISO(today, -i);
    const off = laOffset(day);
    for (const m of mapped) {
      let cents = 0, count = 0, cursor = "";
      for (let p = 0; p < 30; p++) {
        const q = "payments?limit=100&location_id=" + encodeURIComponent(m.id)
          + "&begin_time=" + encodeURIComponent(day + "T00:00:00" + off)
          + "&end_time=" + encodeURIComponent(day + "T23:59:59" + off)
          + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
        const r = await sqGet(q);
        if (r.status !== 200) return { ok: false, error: "payments_" + r.status, detail: r.data };
        for (const pay of (r.data.payments || [])) {
          if (pay.status !== "COMPLETED") continue;
          cents += Number(pay.tip_money?.amount) || 0;
          count++;
        }
        cursor = r.data.cursor || "";
        if (!cursor) break;
      }
      rows.push({ store: m.store, biz_date: day, amount: Math.round(cents) / 100, source: "square",
        raw: { location_id: m.id, location: m.name, payments: count } });
    }
  }
  const w = await writeDays(rows);
  return { ok: true, days: daysBack, locations: mapped, unmatched, ...w };
}

/* ---------- ingest webhook (Zapier / parsed email) ---------- */
async function ingest(body: Record<string, unknown>) {
  const defDate = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? body.date : addDaysISO(laDateISO(new Date()), -1);
  const source = typeof body.source === "string" && body.source ? body.source : "square-email";
  const items = Array.isArray(body.tips) ? body.tips : [];
  const rows: { store: string; biz_date: string; amount: number; source: string; raw: unknown }[] = [];
  const unmatched: unknown[] = [];
  for (const it of items as Record<string, unknown>[]) {
    const store = await resolveStore(String(it.store || ""));
    const amount = Math.round((Number(it.amount) || 0) * 100) / 100;
    const date = typeof it.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : defDate;
    if (!store || !(amount >= 0)) { unmatched.push(it); continue; }
    rows.push({ store, biz_date: date, amount, source, raw: it });
  }
  const w = await writeDays(rows);
  return { ok: true, ...w, unmatched };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (!authed(req, url)) return json({ ok: false, error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") || "pull";
  try {
    if (action === "pull") {
      const days = Math.min(62, Math.max(1, Number(url.searchParams.get("days")) || 3));
      return json(await pull(days));
    }
    if (action === "ingest") {
      const body = await req.json().catch(() => ({}));
      return json(await ingest(body as Record<string, unknown>));
    }
    if (action === "status") {
      const period = url.searchParams.get("period") || laDateISO(new Date()).slice(0, 7);
      const { data } = await admin.from("tips_daily").select("store,biz_date,amount,source")
        .gte("biz_date", period + "-01").lte("biz_date", monthEndISO(period)).order("biz_date");
      return json({ ok: true, period, square_token: !!SQ_TOKEN, rows: data || [] });
    }
    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
