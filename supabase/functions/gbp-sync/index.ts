// Google Business Profile sync → gbp_* tables (Phase 1: Measure).
//
// Pulls performance metrics, monthly search keywords, reviews, and a profile
// snapshot for every store's Google listing, so google-traffic.html (and the
// AI assistant) can compare stores and explain what Eugene is doing right.
// Read-only against Google in Phase 1 — nothing here writes to the profiles.
//
// Actions (?action=):
//   discover — map Google locations → stores (by listing title, like square-tips
//              matches Square locations). Writes gbp_locations. Run first; check
//              the response for `unmatched` before backfilling.
//   backfill — one-time history load: metrics (?months=18, chunked), all reviews
//              (with deletion sweep), keywords per month, profile snapshot.
//              Can be scoped with ?store=Eugene and ?months=6 if a run gets long.
//   pull     — the nightly cron: metrics for a trailing window (?days=10 — Google
//              revises ~3–5 days back), new/updated reviews, snapshot-if-changed.
//   keywords — re-pull the last ?months=3 finished months (Google finalizes a
//              month's keywords mid-following-month; re-pulling absorbs revisions).
//   status   — mapping + row counts + which secrets are present (sanity check).
//
// Auth: header x-cpr-secret or ?secret= must equal the GBP_SYNC_SECRET function
// secret. Google auth: GBP_CLIENT_ID / GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN
// (offline OAuth for the Google account that manages the store profiles).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("GBP_SYNC_SECRET") || "";
const G_ID = Deno.env.get("GBP_CLIENT_ID") || "";
const G_SECRET = Deno.env.get("GBP_CLIENT_SECRET") || "";
const G_REFRESH = Deno.env.get("GBP_REFRESH_TOKEN") || "";
const TZ = "America/Los_Angeles";

const PERF = "https://businessprofileperformance.googleapis.com/v1/";
const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1/";
const ACCT = "https://mybusinessaccountmanagement.googleapis.com/v1/";
const V4 = "https://mybusiness.googleapis.com/v4/";

const DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
];
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

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

/* ---------- dates ---------- */
function laTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDaysISO(dateISO: string, n: number): string {
  const p = dateISO.split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}
function monthKey(dateISO: string): string { return dateISO.slice(0, 7); }
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function dateParams(prefix: string, iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${prefix}.year=${y}&${prefix}.month=${m}&${prefix}.day=${d}`;
}

/* ---------- Google auth + fetch ---------- */
let TOKEN: { v: string; exp: number } | null = null;
async function gToken(): Promise<string> {
  if (TOKEN && Date.now() < TOKEN.exp - 60_000) return TOKEN.v;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: G_ID, client_secret: G_SECRET,
      refresh_token: G_REFRESH, grant_type: "refresh_token",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status !== 200 || !d.access_token) {
    throw new Error("google_token_" + r.status + "_" + (d.error_description || d.error || "unknown"));
  }
  TOKEN = { v: String(d.access_token), exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return TOKEN.v;
}
async function gGet(url: string, retry = 1): Promise<Record<string, unknown>> {
  const t = await gToken();
  const r = await fetch(url, { headers: { Authorization: "Bearer " + t } });
  if ((r.status === 429 || r.status >= 500) && retry > 0) {
    await new Promise((res) => setTimeout(res, 2500));
    return gGet(url, retry - 1);
  }
  const d = await r.json().catch(() => ({}));
  if (r.status !== 200) {
    throw new Error("google_" + r.status + "_" + JSON.stringify((d as { error?: { message?: string } }).error?.message || d).slice(0, 300));
  }
  return d as Record<string, unknown>;
}

/* ---------- store name resolution (same approach as square-tips) ---------- */
let STORE_CACHE: string[] | null = null;
async function storeNames(): Promise<string[]> {
  if (STORE_CACHE) return STORE_CACHE;
  const { data } = await admin.from("stores").select("store");
  STORE_CACHE = (data || []).map((r) => String(r.store)).filter(Boolean);
  return STORE_CACHE;
}
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

type Loc = {
  store: string; google_account: string; google_location_id: string;
  place_id: string | null; new_review_uri: string | null; maps_uri: string | null; title: string;
};
async function mappedLocations(): Promise<Loc[]> {
  const { data } = await admin.from("gbp_locations").select("*");
  return (data || []).filter((l) => l.google_location_id) as Loc[];
}

/* ---------- discover: Google accounts/locations → gbp_locations ---------- */
async function discover() {
  const acc = await gGet(ACCT + "accounts");
  const accounts = (acc.accounts || []) as { name: string; accountName?: string }[];
  if (!accounts.length) return { ok: false, error: "no_google_accounts" };
  const mapped: Loc[] = [];
  const unmatched: string[] = [];
  for (const a of accounts) {
    let pageToken = "";
    do {
      const q = `${INFO}${a.name}/locations?readMask=name,title,metadata,storefrontAddress&pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const d = await gGet(q);
      for (const l of (d.locations || []) as Record<string, any>[]) {
        // Titles can be identical across listings ("CPR Cell Phone Repair"), so the
        // storefront address (city etc.) is part of the match text.
        const addr = (l.storefrontAddress || {}) as Record<string, any>;
        const addrText = [...(addr.addressLines || []), addr.locality, addr.administrativeArea]
          .filter(Boolean).join(" ");
        const store = await resolveStore(`${l.title || ""} ${addrText}`);
        const meta = (l.metadata || {}) as Record<string, string>;
        if (store) {
          mapped.push({
            store, google_account: a.name, google_location_id: String(l.name),
            place_id: meta.placeId || null, new_review_uri: meta.newReviewUri || null,
            maps_uri: meta.mapsUri || null, title: String(l.title || ""),
          });
        } else unmatched.push(`${l.title || l.name}${addrText ? ` (${addrText})` : ""}`);
      }
      pageToken = String(d.nextPageToken || "");
    } while (pageToken);
  }
  if (mapped.length) {
    const stamp = new Date().toISOString();
    const { error } = await admin.from("gbp_locations").upsert(
      mapped.map((m) => ({ ...m, connected_at: stamp })), { onConflict: "store" });
    if (error) throw new Error("gbp_locations_" + error.message);
  }
  return { ok: true, mapped, unmatched };
}

/* ---------- performance metrics ---------- */
async function pullMetrics(loc: Loc, startISO: string, endISO: string): Promise<number> {
  const metricsQ = DAILY_METRICS.map((m) => "dailyMetrics=" + m).join("&");
  const url = `${PERF}${loc.google_location_id}:fetchMultiDailyMetricsTimeSeries?${metricsQ}` +
    `&${dateParams("dailyRange.startDate", startISO)}&${dateParams("dailyRange.endDate", endISO)}`;
  const d = await gGet(url);
  const rows: { store: string; date: string; metric: string; value: number }[] = [];
  for (const multi of (d.multiDailyMetricTimeSeries || []) as Record<string, any>[]) {
    for (const s of (multi.dailyMetricTimeSeries || []) as Record<string, any>[]) {
      const metric = String(s.dailyMetric || "");
      for (const dv of (s.timeSeries?.datedValues || []) as Record<string, any>[]) {
        const dt = dv.date || {};
        if (!dt.year || !dt.month || !dt.day) continue;
        const iso = `${dt.year}-${String(dt.month).padStart(2, "0")}-${String(dt.day).padStart(2, "0")}`;
        rows.push({ store: loc.store, date: iso, metric, value: Number(dv.value) || 0 });
      }
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("gbp_metrics_daily").upsert(
      rows.slice(i, i + 500), { onConflict: "store,date,metric" });
    if (error) throw new Error("gbp_metrics_" + error.message);
  }
  return rows.length;
}

/* ---------- monthly search keywords ---------- */
const isBranded = (k: string) => /\bcpr\b/i.test(k);
async function pullKeywordsMonth(loc: Loc, ym: string): Promise<number> {
  const [y, m] = ym.split("-").map(Number);
  const range = `monthlyRange.startMonth.year=${y}&monthlyRange.startMonth.month=${m}` +
    `&monthlyRange.endMonth.year=${y}&monthlyRange.endMonth.month=${m}`;
  let pageToken = "", n = 0;
  do {
    const url = `${PERF}${loc.google_location_id}/searchkeywords/impressions/monthly?${range}&pageSize=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const d = await gGet(url);
    const rows = ((d.searchKeywordsCounts || []) as Record<string, any>[]).map((k) => {
      const iv = k.insightsValue || {};
      const thresholded = iv.value == null;
      return {
        store: loc.store, month: ym, keyword: String(k.searchKeyword || "").toLowerCase(),
        impressions: Number(iv.value ?? iv.threshold) || 0,
        is_threshold: thresholded, is_branded: isBranded(String(k.searchKeyword || "")),
      };
    }).filter((r) => r.keyword);
    if (rows.length) {
      const { error } = await admin.from("gbp_keywords_monthly").upsert(rows, { onConflict: "store,month,keyword" });
      if (error) throw new Error("gbp_keywords_" + error.message);
      n += rows.length;
    }
    pageToken = String(d.nextPageToken || "");
  } while (pageToken);
  return n;
}

/* ---------- reviews (v4 API, ordered by updateTime desc) ---------- */
function reviewRow(loc: Loc, r: Record<string, any>) {
  return {
    id: String(r.name || (loc.google_account + "/" + loc.google_location_id + "/reviews/" + r.reviewId)),
    store: loc.store,
    stars: STARS[String(r.starRating)] || null,
    comment: r.comment ? String(r.comment) : null,
    reviewer_name: r.reviewer?.displayName ? String(r.reviewer.displayName) : null,
    reviewer_photo: r.reviewer?.profilePhotoUrl ? String(r.reviewer.profilePhotoUrl) : null,
    created_at: r.createTime || null,
    updated_at: r.updateTime || null,
    reply_text: r.reviewReply?.comment ? String(r.reviewReply.comment) : null,
    replied_at: r.reviewReply?.updateTime || null,
    deleted_at: null,
    synced_at: new Date().toISOString(),
    raw: r,
  };
}
async function pullReviews(loc: Loc, full: boolean, since: string | null): Promise<{ n: number; total: number | null; rating: number | null }> {
  const base = `${V4}${loc.google_account}/${loc.google_location_id}/reviews?pageSize=50`;
  let pageToken = "", n = 0, total: number | null = null, rating: number | null = null;
  const seen: string[] = [];
  // incremental: stop once a whole page predates the watermark (minus 3-day overlap)
  const watermark = !full && since ? new Date(new Date(since).getTime() - 3 * 86400_000).toISOString() : null;
  paging: do {
    const d = await gGet(base + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""));
    if (d.totalReviewCount != null) total = Number(d.totalReviewCount);
    if (d.averageRating != null) rating = Math.round(Number(d.averageRating) * 100) / 100;
    const reviews = (d.reviews || []) as Record<string, any>[];
    if (!reviews.length) break;
    const rows = reviews.map((r) => reviewRow(loc, r));
    const { error } = await admin.from("gbp_reviews").upsert(rows, { onConflict: "id" });
    if (error) throw new Error("gbp_reviews_" + error.message);
    n += rows.length;
    for (const r of rows) seen.push(r.id);
    if (watermark && rows.every((r) => (r.updated_at || r.created_at || "9999") < watermark)) break paging;
    pageToken = String(d.nextPageToken || "");
  } while (pageToken);
  if (full) {
    // deletion sweep: anything in the DB for this store that Google no longer returns
    const { data: dbIds } = await admin.from("gbp_reviews").select("id").eq("store", loc.store).is("deleted_at", null);
    const seenSet = new Set(seen);
    const gone = (dbIds || []).map((r) => String(r.id)).filter((id) => !seenSet.has(id));
    for (let i = 0; i < gone.length; i += 200) {
      await admin.from("gbp_reviews").update({ deleted_at: new Date().toISOString() }).in("id", gone.slice(i, i + 200));
    }
  }
  await admin.from("gbp_locations").update({ rating, review_count: total }).eq("store", loc.store);
  return { n, total, rating };
}

/* ---------- profile snapshot (insert only when changed) ---------- */
async function snapshot(loc: Loc): Promise<boolean> {
  const d = await gGet(`${INFO}${loc.google_location_id}?readMask=title,categories,regularHours,specialHours,serviceItems`);
  const profile = {
    title: d.title || null, categories: d.categories || null, regularHours: d.regularHours || null,
    specialHours: d.specialHours || null, serviceItems: d.serviceItems || null,
  };
  const { data: last } = await admin.from("gbp_profile_snapshots").select("profile")
    .eq("store", loc.store).order("taken_at", { ascending: false }).limit(1).maybeSingle();
  if (last && JSON.stringify(last.profile) === JSON.stringify(profile)) return false;
  const { error } = await admin.from("gbp_profile_snapshots").insert({ store: loc.store, profile });
  if (error) throw new Error("gbp_snapshot_" + error.message);
  return true;
}

/* ---------- per-store orchestration ----------
   Stages run independently per store: a reviews failure (e.g. the v4 API not
   yet allowlisted for the project) must not block metrics/keywords/snapshot.
   last_error collects every failed stage; ok = no stage failed. */
type StageDef = [string, () => Promise<unknown>];
async function runStages(defs: StageDef[]) {
  const res: Record<string, unknown> = {};
  const errs: string[] = [];
  for (const [name, fn] of defs) {
    try { res[name] = await fn(); }
    catch (e) { res[name] = "error"; errs.push(name + ": " + String((e as Error)?.message || e).slice(0, 200)); }
  }
  return { res, errs };
}
async function forEachLoc(locs: Loc[], mk: (l: Loc) => StageDef[]) {
  const out: Record<string, unknown>[] = [];
  for (const l of locs) {
    const { res, errs } = await runStages(mk(l));
    await admin.from("gbp_locations").update({
      last_sync_at: new Date().toISOString(),
      last_error: errs.length ? errs.join(" | ").slice(0, 500) : null,
    }).eq("store", l.store);
    out.push({ store: l.store, ok: !errs.length, ...res, ...(errs.length ? { errors: errs } : {}) });
  }
  return out;
}

async function scopedLocations(url: URL): Promise<Loc[]> {
  let locs = await mappedLocations();
  if (!locs.length) { await discover(); locs = await mappedLocations(); }
  const only = url.searchParams.get("store");
  if (only) {
    const s = await resolveStore(only);
    locs = locs.filter((l) => l.store === s);
  }
  return locs;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (!authed(req, url)) return json({ ok: false, error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") || "pull";
  try {
    if (!G_ID || !G_SECRET || !G_REFRESH) {
      if (action !== "status") return json({ ok: false, error: "missing_google_secrets", need: ["GBP_CLIENT_ID", "GBP_CLIENT_SECRET", "GBP_REFRESH_TOKEN"] }, 500);
    }

    if (action === "discover") return json(await discover());

    if (action === "pull") {
      const days = Math.min(90, Math.max(3, Number(url.searchParams.get("days")) || 10));
      const locs = await scopedLocations(url);
      if (!locs.length) return json({ ok: false, error: "no_locations_mapped" });
      const today = laTodayISO();
      const results = await forEachLoc(locs, (l) => [
        ["metrics", () => pullMetrics(l, addDaysISO(today, -days), addDaysISO(today, -1))],
        ["reviews", async () => {
          // watermark = newest review we already hold (self-heals after failed runs);
          // empty table → full pull incl. deletion sweep
          const { data: mx } = await admin.from("gbp_reviews").select("updated_at")
            .eq("store", l.store).order("updated_at", { ascending: false }).limit(1).maybeSingle();
          return (await pullReviews(l, !mx?.updated_at, mx?.updated_at || null)).n;
        }],
        ["snapshot_changed", () => snapshot(l)],
      ]);
      return json({ ok: true, days, results });
    }

    if (action === "backfill") {
      const months = Math.min(18, Math.max(1, Number(url.searchParams.get("months")) || 18));
      const locs = await scopedLocations(url);
      if (!locs.length) return json({ ok: false, error: "no_locations_mapped" });
      const today = laTodayISO();
      const start = addMonths(monthKey(today), -(months - 1)) + "-01";
      const results = await forEachLoc(locs, (l) => [
        ["metrics", async () => {
          // ≤180-day chunks
          let n = 0, from = start;
          while (from < today) {
            const to = addDaysISO(from, 179) < addDaysISO(today, -1) ? addDaysISO(from, 179) : addDaysISO(today, -1);
            n += await pullMetrics(l, from, to);
            from = addDaysISO(to, 1);
          }
          return n;
        }],
        ["reviews", async () => (await pullReviews(l, true, null)).n],
        ["keywords", async () => {
          // every finished month in the window (current month has no data yet)
          let n = 0;
          for (let ym = monthKey(start); ym < monthKey(today); ym = addMonths(ym, 1)) {
            n += await pullKeywordsMonth(l, ym);
          }
          return n;
        }],
        ["snapshot_changed", () => snapshot(l)],
      ]);
      return json({ ok: true, months, results });
    }

    if (action === "keywords") {
      const months = Math.min(18, Math.max(1, Number(url.searchParams.get("months")) || 3));
      const locs = await scopedLocations(url);
      if (!locs.length) return json({ ok: false, error: "no_locations_mapped" });
      const lastFinished = addMonths(monthKey(laTodayISO()), -1);
      const results = await forEachLoc(locs, (l) => [
        ["keywords", async () => {
          let n = 0;
          for (let i = 0; i < months; i++) n += await pullKeywordsMonth(l, addMonths(lastFinished, -i));
          return n;
        }],
      ]);
      return json({ ok: true, months, results });
    }

    if (action === "status") {
      const { data: locs } = await admin.from("gbp_locations").select("store,title,google_location_id,place_id,rating,review_count,connected_at,last_sync_at,last_error");
      const counts: Record<string, number | null> = {};
      for (const t of ["gbp_metrics_daily", "gbp_keywords_monthly", "gbp_reviews"]) {
        const { count } = await admin.from(t).select("*", { count: "exact", head: true });
        counts[t] = count ?? null;
      }
      return json({
        ok: true, locations: locs || [], counts,
        secrets: { client_id: !!G_ID, client_secret: !!G_SECRET, refresh_token: !!G_REFRESH, sync_secret: !!SECRET },
      });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
