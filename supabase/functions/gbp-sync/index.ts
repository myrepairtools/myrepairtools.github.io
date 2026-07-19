// Google Business Profile sync — Phase 1 "Measure" (pattern: square-tips).
//
// Pulls per-store GBP data into clean tables (schema: docs/sql/2026-07-10-gbp-schema.sql):
//   gbp_metrics_daily (Performance API), gbp_keywords_monthly (Performance API,
//   monthly), gbp_reviews (legacy v4 — the newer APIs have no reviews),
//   gbp_profile_snapshots (Business Information API + v4 media count).
//
// Actions (?action=):
//   discover — map Google listings → stores (title keyword match against the
//              stores table, same idea as square-tips) and upsert gbp_locations.
//   backfill — 18 months of metrics + keywords, ALL reviews, snapshot. Idempotent;
//              re-run per store (&store=Eugene) if the full run times out.
//   pull     — nightly: last N days of metrics (?days=10 default — Google lags
//              3–5 days so we re-pull a window), full review sync, snapshot.
//   keywords — monthly keywords for the last ?months=2 (Google publishes after
//              month end; current month is legitimately empty).
//   status   — per-store sync state + row counts (sanity check).
//
// Auth: ?secret= or x-cpr-secret header must equal GBP_SYNC_SECRET. Deploy with
// JWT verification OFF — cron and curl call this, not browsers.
//
// Fault tolerance: every stage (metrics/reviews/keywords/snapshot) runs per store
// in its own try/catch — one failure stamps gbp_locations.last_error but never
// blocks the other stages or stores.
//
// Secrets: GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REFRESH_TOKEN (Google OAuth,
// scope business.manage, minted for the GBP owner account), GBP_SYNC_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("GBP_SYNC_SECRET") || "";
const CLIENT_ID = Deno.env.get("GBP_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("GBP_CLIENT_SECRET") || "";
const REFRESH_TOKEN = Deno.env.get("GBP_REFRESH_TOKEN") || "";

const API_PERF = "https://businessprofileperformance.googleapis.com/v1/";
const API_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1/";
const API_ACCT = "https://mybusinessaccountmanagement.googleapis.com/v1/";
const API_V4 = "https://mybusiness.googleapis.com/v4/";

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

/* ---------- Google OAuth (refresh token → short-lived access token) ---------- */
let TOKEN: { value: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (TOKEN && Date.now() < TOKEN.exp - 60_000) return TOKEN.value;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("oauth_" + r.status + "_" + (d.error || "no_token"));
  TOKEN = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return TOKEN.value;
}
async function gGet(base: string, path: string) {
  const t = await accessToken();
  const r = await fetch(base + path, { headers: { Authorization: "Bearer " + t } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("google_" + r.status + "_" + path.split("?")[0] + "_" + JSON.stringify(data.error?.message || data).slice(0, 200));
  return data;
}

/* ---------- dates ---------- */
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string {
  const p = iso.split("-").map(Number);
  return isoDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)));
}
function ymd(iso: string) { const p = iso.split("-").map(Number); return { year: p[0], month: p[1], day: p[2] }; }
function monthShift(ym: { y: number; m: number }, n: number) {
  const d = new Date(Date.UTC(ym.y, ym.m - 1 + n, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
function monthStr(ym: { y: number; m: number }) { return ym.y + "-" + ("0" + ym.m).slice(-2); }

/* ---------- store mapping ---------- */
type Loc = { store: string; location_id: string; account_id: string | null; place_id: string | null };
async function mappedLocations(onlyStore?: string | null): Promise<Loc[]> {
  const { data, error } = await admin.from("gbp_locations")
    .select("store,google_location_id,google_account_id,place_id");
  if (error) throw new Error("gbp_locations_" + error.message);
  let rows = (data || []).map((r) => ({
    store: String(r.store), location_id: String(r.google_location_id),
    account_id: r.google_account_id ? String(r.google_account_id) : null,
    place_id: r.place_id ? String(r.place_id) : null,
  }));
  if (onlyStore) {
    const q = onlyStore.toLowerCase();
    rows = rows.filter((r) => r.store.toLowerCase().includes(q));
  }
  if (!rows.length) throw new Error(onlyStore ? "store_not_mapped_" + onlyStore : "no_locations_mapped_run_discover_first");
  return rows;
}
async function stampSync(store: string, errs: string[]) {
  await admin.from("gbp_locations").update({
    last_sync_at: new Date().toISOString(),
    last_error: errs.length ? errs.join(" | ").slice(0, 900) : null,
  }).eq("store", store);
}

/* ---------- discover: Google listings → stores ---------- */
async function discover() {
  const { data: storeRows } = await admin.from("stores").select("store");
  const stores = (storeRows || []).map((r) => String(r.store)).filter(Boolean);
  const accts = await gGet(API_ACCT, "accounts");
  const mapped: Record<string, unknown>[] = [];
  const unmatched: string[] = [];
  for (const a of (accts.accounts || [])) {
    let pageToken = "";
    do {
      const q = String(a.name) + "/locations?readMask=name,title,metadata&pageSize=100"
        + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
      const d = await gGet(API_INFO, q);
      for (const l of (d.locations || [])) {
        const title = String(l.title || "");
        const t = title.toLowerCase();
        // match by store-name keywords (drop "CPR"/"OR"; need a word ≥4 chars in the title)
        const store = stores.find((s) =>
          s.toLowerCase().split(/\s+/).filter((w) => w !== "cpr" && w.length >= 4).some((k) => t.includes(k)));
        if (!store) { unmatched.push(title || String(l.name)); continue; }
        const row = {
          store,
          google_location_id: String(l.name),          // "locations/123…"
          google_account_id: String(a.name),           // "accounts/123…"
          place_id: l.metadata?.placeId ? String(l.metadata.placeId) : null,
          title,
        };
        const { error } = await admin.from("gbp_locations").upsert(row, { onConflict: "store" });
        if (error) throw new Error("upsert_" + error.message);
        mapped.push(row);
      }
      pageToken = d.nextPageToken || "";
    } while (pageToken);
  }
  return { ok: true, mapped, unmatched };
}

/* ---------- metrics (Performance API) ---------- */
const DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS",
];
async function pullMetrics(loc: Loc, startISO: string, endISO: string): Promise<number> {
  const s = ymd(startISO), e = ymd(endISO);
  const q = loc.location_id + ":fetchMultiDailyMetricsTimeSeries?"
    + DAILY_METRICS.map((m) => "dailyMetrics=" + m).join("&")
    + `&dailyRange.startDate.year=${s.year}&dailyRange.startDate.month=${s.month}&dailyRange.startDate.day=${s.day}`
    + `&dailyRange.endDate.year=${e.year}&dailyRange.endDate.month=${e.month}&dailyRange.endDate.day=${e.day}`;
  const d = await gGet(API_PERF, q);
  const rows: { store: string; date: string; metric: string; value: number }[] = [];
  for (const series of (d.multiDailyMetricTimeSeries || [])) {
    for (const one of (series.dailyMetricTimeSeries || [])) {
      const metric = String(one.dailyMetric || "");
      for (const dv of (one.timeSeries?.datedValues || [])) {
        const dt = dv.date; if (!dt?.year) continue;
        rows.push({
          store: loc.store,
          date: dt.year + "-" + ("0" + dt.month).slice(-2) + "-" + ("0" + dt.day).slice(-2),
          metric, value: Number(dv.value) || 0,
        });
      }
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("gbp_metrics_daily")
      .upsert(rows.slice(i, i + 500), { onConflict: "store,date,metric" });
    if (error) throw new Error("metrics_upsert_" + error.message);
  }
  return rows.length;
}

/* ---------- keywords (Performance API, monthly) ---------- */
function classifyBranded(keyword: string, store: string): boolean | null {
  const k = keyword.toLowerCase();
  if (/\bcpr\b|cell phone repair/.test(k)) return true;   // our brand → branded
  // a bare location search ("eugene", "salem oregon") is ambiguous → unclassified
  const cityWords = store.toLowerCase().split(/\s+/).filter((w) => w !== "cpr" && w.length >= 4);
  const leftover = k.split(/\s+/).filter((w) =>
    w && w !== "or" && w !== "oregon" && !cityWords.some((c) => c.includes(w) || w.includes(c)));
  if (!leftover.length) return null;
  return false;                                            // generic service search → discovery
}
async function pullKeywords(loc: Loc, startYM: { y: number; m: number }, endYM: { y: number; m: number }): Promise<number> {
  let total = 0, pageToken = "";
  do {
    const q = loc.location_id + "/searchkeywords/impressions/monthly?"
      + `monthlyRange.startMonth.year=${startYM.y}&monthlyRange.startMonth.month=${startYM.m}`
      + `&monthlyRange.endMonth.year=${endYM.y}&monthlyRange.endMonth.month=${endYM.m}`
      + "&pageSize=100" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const d = await gGet(API_PERF, q);
    const rows: Record<string, unknown>[] = [];
    for (const k of (d.searchKeywordsCounts || [])) {
      const keyword = String(k.searchKeyword || "").trim();
      if (!keyword) continue;
      const iv = k.insightsValue || {};
      const isThreshold = iv.threshold != null;
      // The monthly endpoint aggregates the requested range; we call it one month
      // at a time from the callers so each row lands on its own month.
      rows.push({
        store: loc.store, month: monthStr(startYM), keyword,
        impressions: Number(isThreshold ? iv.threshold : iv.value) || 0,
        is_threshold: isThreshold,
        is_branded: classifyBranded(keyword, loc.store),
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from("gbp_keywords_monthly")
        .upsert(rows.slice(i, i + 500), { onConflict: "store,month,keyword" });
      if (error) throw new Error("keywords_upsert_" + error.message);
    }
    total += rows.length;
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return total;
}
async function keywordsForMonths(loc: Loc, monthsBack: number): Promise<number> {
  // one call per calendar month so rows land on the right month
  const now = new Date();
  let total = 0;
  for (let i = 1; i <= monthsBack; i++) {
    const ym = monthShift({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 }, -i);
    total += await pullKeywords(loc, ym, ym);
  }
  return total;
}

/* ---------- reviews (legacy v4 — the only API that has them) ---------- */
const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
async function pullReviews(loc: Loc): Promise<{ upserts: number; deleted: number }> {
  if (!loc.account_id) throw new Error("reviews_no_account_id_run_discover");
  const base = loc.account_id + "/" + loc.location_id;   // accounts/…/locations/…
  const seen = new Set<string>();
  let upserts = 0, pageToken = "";
  do {
    const d = await gGet(API_V4, base + "/reviews?pageSize=50"
      + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""));
    const rows: Record<string, unknown>[] = [];
    for (const rv of (d.reviews || [])) {
      const id = String(rv.name || "");
      if (!id) continue;
      seen.add(id);
      rows.push({
        id, store: loc.store,
        stars: STAR[String(rv.starRating)] || 0,
        comment: rv.comment ? String(rv.comment) : null,
        reviewer_name: rv.reviewer?.displayName ? String(rv.reviewer.displayName) : null,
        created_at: rv.createTime, updated_at: rv.updateTime || null,
        reply_text: rv.reviewReply?.comment ? String(rv.reviewReply.comment) : null,
        replied_at: rv.reviewReply?.updateTime || null,
        deleted_at: null,                    // present on Google again = un-delete
        raw: rv, synced_at: new Date().toISOString(),
      });
    }
    const valid = rows.filter((r) => Number(r.stars) >= 1);
    if (valid.length) {
      const { error } = await admin.from("gbp_reviews").upsert(valid, { onConflict: "id" });
      if (error) throw new Error("reviews_upsert_" + error.message);
      upserts += valid.length;
    }
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  // full-list pull every time (a few hundred rows, trivial vs quota) → we can
  // soft-delete anything Google no longer serves
  const { data: stored } = await admin.from("gbp_reviews").select("id")
    .eq("store", loc.store).is("deleted_at", null);
  const gone = (stored || []).map((r) => String(r.id)).filter((id) => !seen.has(id));
  if (gone.length) {
    const { error } = await admin.from("gbp_reviews")
      .update({ deleted_at: new Date().toISOString() }).in("id", gone);
    if (error) throw new Error("reviews_delete_" + error.message);
  }
  return { upserts, deleted: gone.length };
}

/* ---------- profile snapshot (drift detection + photo freshness) ---------- */
async function snapshot(loc: Loc): Promise<void> {
  const info = await gGet(API_INFO, loc.location_id
    + "?readMask=title,categories,regularHours,specialHours,serviceItems,phoneNumbers,websiteUri");
  let attributes: unknown = null;
  try {
    const a = await gGet(API_INFO, loc.location_id + "/attributes");
    attributes = a.attributes || null;
  } catch (_) { /* attributes are nice-to-have */ }
  let mediaCount: number | null = null, latestMedia: string | null = null;
  if (loc.account_id) {
    try {
      const m = await gGet(API_V4, loc.account_id + "/" + loc.location_id + "/media?pageSize=50");
      mediaCount = Number(m.totalMediaItemCount) || (m.mediaItems || []).length || 0;
      for (const it of (m.mediaItems || [])) {
        const t = String(it.createTime || "");
        if (t && (!latestMedia || t > latestMedia)) latestMedia = t;
      }
    } catch (_) { /* media is nice-to-have */ }
  }
  const { error } = await admin.from("gbp_profile_snapshots").insert({
    store: loc.store,
    categories: info.categories || null,
    services: info.serviceItems || null,
    hours: { regular: info.regularHours || null, special: info.specialHours || null },
    attributes,
    media_count: mediaCount, latest_media_at: latestMedia,
  });
  if (error) throw new Error("snapshot_" + error.message);
}

/* ---------- orchestration: run stages per store, fault-tolerant ---------- */
type StageName = "metrics" | "reviews" | "keywords" | "snapshot";
async function runStores(locs: Loc[], stages: StageName[], opts: { days?: number; months?: number }) {
  const today = isoDate(new Date());
  const out: Record<string, unknown>[] = [];
  for (const loc of locs) {
    const errs: string[] = [];
    const r: Record<string, unknown> = { store: loc.store };
    for (const stage of stages) {
      try {
        if (stage === "metrics") {
          r.metrics = await pullMetrics(loc, addDays(today, -(opts.days || 10)), today);
        } else if (stage === "reviews") {
          r.reviews = await pullReviews(loc);
        } else if (stage === "keywords") {
          r.keywords = await keywordsForMonths(loc, opts.months || 2);
        } else if (stage === "snapshot") {
          await snapshot(loc); r.snapshot = true;
        }
      } catch (e) {
        errs.push(stage + ": " + String((e as Error)?.message || e));
      }
    }
    if (errs.length) r.errors = errs;
    await stampSync(loc.store, errs);
    out.push(r);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (!authed(req, url)) return json({ ok: false, error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") || "status";
  const store = url.searchParams.get("store");
  try {
    if (action === "discover") return json(await discover());

    if (action === "pull") {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 10));
      const locs = await mappedLocations(store);
      return json({ ok: true, action, stores: await runStores(locs, ["metrics", "reviews", "snapshot"], { days }) });
    }

    if (action === "backfill") {
      const locs = await mappedLocations(store);
      // 18 months ≈ 550 days of metrics + 18 monthly keyword calls + all reviews
      const stores = await runStores(locs, ["metrics", "reviews", "keywords", "snapshot"], { days: 550, months: 18 });
      return json({ ok: true, action, stores });
    }

    if (action === "keywords") {
      const months = Math.min(18, Math.max(1, Number(url.searchParams.get("months")) || 2));
      const locs = await mappedLocations(store);
      return json({ ok: true, action, stores: await runStores(locs, ["keywords"], { months }) });
    }

    if (action === "status") {
      const [{ data: locs }, m, k, rv] = await Promise.all([
        admin.from("gbp_locations").select("*").order("store"),
        admin.from("gbp_metrics_daily").select("id", { count: "exact", head: true }),
        admin.from("gbp_keywords_monthly").select("id", { count: "exact", head: true }),
        admin.from("gbp_reviews").select("id", { count: "exact", head: true }),
      ]);
      const { data: latest } = await admin.from("gbp_metrics_daily")
        .select("date").order("date", { ascending: false }).limit(1);
      return json({
        ok: true, locations: locs || [],
        counts: { metrics: m.count ?? 0, keywords: k.count ?? 0, reviews: rv.count ?? 0 },
        data_through: latest?.[0]?.date || null,
      });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
