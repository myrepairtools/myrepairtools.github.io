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
// Phase 2 ("Reply") — the review engine (see docs/sql/2026-07-22-gbp-phase2.sql):
//   engine   — the */15 cron: incremental review pull, 1–3★ + SLA alerts (via the
//              alerts function + direct SMS per gbp_notify_prefs), auto-reply
//              enqueue (4–5★ only, 3h hold) and posting (9a–7p store time),
//              Monday digest to Communications. Secret-authed.
//   draft    — POST {review_id}: LLM reply draft for the drawer (manager JWT).
//   reply    — POST {review_id, text}: post a reply to Google + audit (manager JWT).
//   queue    — GET: the hold queue. queue_op — POST {id, op:cancel|post_now|edit, text}.
//   config   — GET auto-reply toggles. config_set — POST {master, stores} (manager JWT).
//
// Auth: cron/server actions need header x-cpr-secret or ?secret= equal to the
// GBP_SYNC_SECRET function secret; browser actions accept a Supabase JWT for an
// active staff row with role manager/admin/owner. Google auth: GBP_CLIENT_ID /
// GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN (offline OAuth for the GBP owner account).
// Replies are written with the same business.manage scope. LLM drafts use the
// project-wide ANTHROPIC_API_KEY secret; alerts ride NOTIFY_SECRET.
// Guardrails (design response §3, verbatim): 1–3★ never auto-posts — a person
// approves every one; every post (human or auto) writes to Google AND a
// gbp_audit row; 1–2★ drafts always include the store phone / take-it-offline.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("GBP_SYNC_SECRET") || "";
const G_ID = Deno.env.get("GBP_CLIENT_ID") || "";
const G_SECRET = Deno.env.get("GBP_CLIENT_SECRET") || "";
const G_REFRESH = Deno.env.get("GBP_REFRESH_TOKEN") || "";
const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY") || "";
const NOTIFY = Deno.env.get("NOTIFY_SECRET") || "";
const TZ = "America/Los_Angeles";
const SITE = "https://myrepairtools.github.io/";

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
function laParts(): { hour: number; hm: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const hour = Number(get("hour")) % 24;
  return { hour, hm: `${String(hour).padStart(2, "0")}:${get("minute")}`, weekday: get("weekday") };
}
function isoWeek(): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t.getTime() - y1.getTime()) / 86400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-${String(w).padStart(2, "0")}`;
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
async function gPut(url: string, body: unknown): Promise<Record<string, unknown>> {
  const t = await gToken();
  const r = await fetch(url, {
    method: "PUT",
    headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

/* ---------- profile phone + photo freshness (nightly, cheap) ---------- */
async function pullContactAndPhotos(loc: Loc): Promise<{ phone: string | null; last_photo_at: string | null }> {
  let phone: string | null = null, lastPhoto: string | null = null;
  try {
    const d = await gGet(`${INFO}${loc.google_location_id}?readMask=phoneNumbers`);
    phone = (d.phoneNumbers as Record<string, string> | undefined)?.primaryPhone || null;
  } catch (_) { /* phone is a nice-to-have */ }
  try {
    const d = await gGet(`${V4}${loc.google_account}/${loc.google_location_id}/media?pageSize=100`);
    for (const m of (d.mediaItems || []) as Record<string, any>[]) {
      const t = m.createTime ? String(m.createTime) : null;
      if (t && (!lastPhoto || t > lastPhoto)) lastPhoto = t;
    }
  } catch (_) { /* media list can 404 on listings with no media */ }
  await admin.from("gbp_locations").update({ phone, last_photo_at: lastPhoto }).eq("store", loc.store);
  return { phone, last_photo_at: lastPhoto };
}

/* ---------- browser auth: active manager/admin/owner via Supabase JWT ---------- */
type Me = { id: number; name: string; role: string };
async function staffFromReq(req: Request): Promise<Me | null> {
  const m = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/i);
  if (!m) return null;
  const { data } = await admin.auth.getUser(m[1]).catch(() => ({ data: { user: null } }));
  const uid = data?.user?.id;
  if (!uid) return null;
  const { data: st } = await admin.from("staff").select("id,display_name,role,active")
    .eq("auth_uid", uid).maybeSingle();
  if (!st || st.active === false) return null;
  if (!["manager", "admin", "owner"].includes(String(st.role))) return null;
  return { id: Number(st.id), name: String(st.display_name || ""), role: String(st.role) };
}

/* ---------- config (gbp_config key/value) ---------- */
type AutoCfg = { master: boolean; stores: Record<string, boolean> };
async function getCfg<T>(key: string, fallback: T): Promise<T> {
  const { data } = await admin.from("gbp_config").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}
async function setCfg(key: string, value: unknown, by: string) {
  const { error } = await admin.from("gbp_config").upsert(
    { key, value, updated_by: by, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error("gbp_config_" + error.message);
}
function storeAutoOn(cfg: AutoCfg, store: string): boolean {
  return !!cfg.master && cfg.stores?.[store] !== false;  // missing store key = ON
}

/* ---------- reply drafting ---------- */
// Rating-only thank-yous rotate per store, never the same twice in a row.
const THANKS = [
  "Thanks so much for the five stars — we appreciate you trusting us with your device!",
  "Thank you for the great rating! We're glad we could help — see you next time.",
  "We appreciate the kind rating — thanks for choosing us for your repair!",
  "Thanks for the stars! It was a pleasure helping you out.",
  "Thank you! Reviews like yours mean a lot to our repair team.",
  "Much appreciated — thanks for taking a moment to rate us!",
];
async function thankYouFor(store: string): Promise<string> {
  const rot = await getCfg<Record<string, number>>("thanks_rot", {});
  const last = Number(rot[store] ?? -1);
  let i = Math.floor(Math.random() * THANKS.length);
  if (i === last) i = (i + 1) % THANKS.length;
  rot[store] = i;
  await setCfg("thanks_rot", rot, "auto");
  return THANKS[i];
}
type Rev = { id: string; store: string; stars: number | null; comment: string | null; reviewer_name: string | null; created_at: string | null };
async function llmDraft(rev: Rev, phone: string | null): Promise<string> {
  if (!ANTHROPIC) throw new Error("missing_anthropic_key");
  const stars = Number(rev.stars) || 0;
  const low = stars <= 3;
  const city = rev.store.replace(/^CPR\s*/i, "");
  const sys = [
    `You write public replies to Google reviews for CPR Cell Phone Repair ${city}, a local phone/tablet/computer repair shop.`,
    "Voice: warm, human, specific — like the store owner wrote it. Reference a concrete detail from the review when there is one.",
    "Rules: under 70 words; no emojis, no hashtags; never offer discounts or incentives (Google policy); never argue, blame, or admit legal fault; no personal data beyond the reviewer's first name; don't start every reply the same way.",
    low
      ? `This review is negative (${stars} star${stars === 1 ? "" : "s"}). Apologize once, sincerely. Take the concern seriously without being defensive. Invite them to take it offline: ask them to call the store${phone ? ` at ${phone}` : ""} so a manager can make it right.`
      : "This review is positive. Thank them by first name if given, and keep it fresh and brief.",
    "Return ONLY the reply text — no quotes, no preamble.",
  ].join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5", max_tokens: 300, system: sys,
      messages: [{
        role: "user",
        content: `${stars}★ review from ${rev.reviewer_name || "a customer"}:\n"${(rev.comment || "").slice(0, 2000)}"`,
      }],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status !== 200) throw new Error("anthropic_" + r.status + "_" + JSON.stringify(d?.error?.message || "").slice(0, 200));
  const text = (d.content || []).filter((c: Record<string, unknown>) => c.type === "text")
    .map((c: Record<string, string>) => c.text).join("").trim();
  if (!text) throw new Error("anthropic_empty");
  return text.slice(0, 3800);
}

/* ---------- posting a reply (the ONLY write path to Google) ---------- */
async function postReply(reviewId: string, text: string, actor: string, source: "manual" | "auto") {
  const { data: rev } = await admin.from("gbp_reviews").select("id,store").eq("id", reviewId).maybeSingle();
  if (!rev) throw new Error("review_not_found");
  await gPut(`${V4}${reviewId}/reply`, { comment: text });
  const now = new Date().toISOString();
  await admin.from("gbp_reviews").update({ reply_text: text, replied_at: now }).eq("id", reviewId);
  await admin.from("gbp_audit").insert({
    actor, action: "reply_" + source, store: rev.store,
    payload: { review_id: reviewId, text },
  });
  // a manual post supersedes any pending auto-reply for the same review
  if (source === "manual") {
    await admin.from("gbp_reply_queue").update({ status: "cancelled", decided_by: actor })
      .eq("review_id", reviewId).eq("status", "hold");
  }
}

/* ---------- notifications (alerts function + direct SMS per gbp prefs) ---------- */
// Feed/push ride the alerts function (kind 'system' — per-kind push granularity
// stays with alert_prefs); SMS is sent directly so the gear's SMS choice always
// wins regardless of alert_prefs.
async function fanoutAlert(staffIds: number[], title: string, body: string, link: string) {
  if (!staffIds.length || !NOTIFY) return;
  await fetch(`${SB_URL}/functions/v1/alerts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", secret: NOTIFY, kind: "system", icon: "⭐", title, body, link, staff_ids: staffIds }),
  }).catch(() => {});
}
async function fanoutSms(phones: string[], text: string) {
  if (!NOTIFY) return;
  for (const to of phones) {
    await fetch(`${SB_URL}/functions/v1/messaging`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "system_send", secret: NOTIFY, to, body: text }),
    }).catch(() => {});
  }
}
type Pref = { staff_id: number; methods: Record<string, boolean>; stores: string[]; triggers: Record<string, boolean>; quiet: { start?: string; end?: string } | null; phone: string | null };
async function loadPrefs(): Promise<Pref[]> {
  const { data: rows } = await admin.from("gbp_notify_prefs").select("*");
  if (!rows?.length) return [];
  const ids = rows.map((r) => r.staff_id);
  const [{ data: staff }, { data: profs }] = await Promise.all([
    admin.from("staff").select("id,active").in("id", ids),
    admin.from("staff_profiles").select("staff_id,phone").in("staff_id", ids),
  ]);
  const activeSet = new Set((staff || []).filter((s) => s.active !== false).map((s) => Number(s.id)));
  const phones: Record<number, string> = {};
  for (const p of profs || []) if (p.phone) phones[Number(p.staff_id)] = String(p.phone);
  return (rows || []).filter((r) => activeSet.has(Number(r.staff_id))).map((r) => ({
    staff_id: Number(r.staff_id),
    methods: r.methods || {}, stores: Array.isArray(r.stores) ? r.stores : [],
    triggers: r.triggers || {}, quiet: r.quiet || null,
    phone: phones[Number(r.staff_id)] || null,
  }));
}
function inQuiet(q: Pref["quiet"], hm: string): boolean {
  if (!q?.start || !q?.end) return false;
  return q.start > q.end ? (hm >= q.start || hm < q.end) : (hm >= q.start && hm < q.end);
}
// trigger defaults: low_star ON, sla ON, auto_digest OFF
function subscribers(prefs: Pref[], store: string, trigger: string, ignoreQuiet: boolean, hm: string): Pref[] {
  return prefs.filter((p) =>
    (p.triggers[trigger] ?? (trigger !== "auto_digest")) &&
    (!p.stores.length || p.stores.includes(store)) &&
    (ignoreQuiet || !inQuiet(p.quiet, hm)));
}
async function logged(key: string): Promise<boolean> {
  const { data } = await admin.from("gbp_notify_log").select("key").eq("key", key).maybeSingle();
  return !!data;
}
async function logKey(key: string) {
  await admin.from("gbp_notify_log").upsert({ key }, { onConflict: "key", ignoreDuplicates: true });
}
function excerpt(s: string | null, n: number): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/* ---------- the review engine (every-15-min cron): pull → alert → auto-reply → digest ---------- */
async function engine() {
  const locs = await mappedLocations();
  if (!locs.length) return { ok: false, error: "no_locations_mapped" };
  const out: Record<string, unknown> = {};

  // 1 · incremental review pull (watermark, same as nightly)
  let pulled = 0;
  for (const l of locs) {
    try {
      const { data: mx } = await admin.from("gbp_reviews").select("updated_at")
        .eq("store", l.store).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      pulled += (await pullReviews(l, !mx?.updated_at, mx?.updated_at || null)).n;
    } catch (e) { out["pull_error_" + l.store] = String((e as Error)?.message || e).slice(0, 150); }
  }
  out.pulled = pulled;

  const { hour, hm, weekday } = laParts();
  const prefs = await loadPrefs();
  const cfg = await getCfg<AutoCfg>("auto_reply", { master: false, stores: {} });
  const nowMs = Date.now();
  const shortName = (s: string) => s.replace(/^CPR\s*/i, "");
  const reviewLink = (id: string) => SITE + "google-reviews.html#r=" + encodeURIComponent(id);

  // 2 · 1–3★ alerts (recent only — the backfill is history, not news)
  const { data: lows } = await admin.from("gbp_reviews")
    .select("id,store,stars,comment,reviewer_name,created_at")
    .lte("stars", 3).is("deleted_at", null)
    .gte("created_at", new Date(nowMs - 72 * 3600_000).toISOString());
  let lowSent = 0;
  for (const r of lows || []) {
    const key = "lowstar:" + r.id;
    if (await logged(key)) continue;
    await logKey(key);
    const ignoreQuiet = Number(r.stars) <= 2;  // 1–2★ ignores quiet hours by default
    const subs = subscribers(prefs, r.store, "low_star", ignoreQuiet, hm);
    if (subs.length) {
      const title = `⚠ ${r.stars}★ from ${r.reviewer_name || "a customer"} at ${shortName(r.store)}`;
      const body = excerpt(r.comment, 120) || "(rating only — no text)";
      await fanoutAlert(subs.filter((p) => p.methods.push !== false || p.methods.inapp !== false).map((p) => p.staff_id),
        title, body, "google-reviews.html#r=" + encodeURIComponent(r.id));
      const sms = subs.filter((p) => p.methods.sms && p.phone);
      if (sms.length) {
        await fanoutSms(sms.map((p) => p.phone!),
          `⚠ ${r.stars}★ from ${r.reviewer_name || "a customer"} at ${shortName(r.store)}: '${excerpt(r.comment, 80) || "no text"}' — reply: ${reviewLink(r.id)}`);
      }
      lowSent++;
    }
  }
  out.low_star_alerts = lowSent;

  // 3 · SLA breaches: amber nudge at 12h unanswered, red at 24h (recent reviews only;
  // legacy_unanswered = the retired pre-engine backlog — never actionable)
  const { data: open } = await admin.from("gbp_reviews")
    .select("id,store,stars,comment,reviewer_name,created_at")
    .is("reply_text", null).is("deleted_at", null).eq("legacy_unanswered", false)
    .gte("created_at", new Date(nowMs - 7 * 86400_000).toISOString());
  let slaSent = 0;
  for (const r of open || []) {
    const ageH = (nowMs - new Date(r.created_at || 0).getTime()) / 3600_000;
    for (const [th, keyP] of [[24, "sla24:"], [12, "sla12:"]] as [number, string][]) {
      if (ageH < th) continue;
      const key = keyP + r.id;
      if (await logged(key)) break;  // 24h implies 12h was due; log both paths once each
      await logKey(key);
      const subs = subscribers(prefs, r.store, "sla", false, hm);
      if (subs.length) {
        const title = `${th >= 24 ? "🔴" : "🟡"} Review unanswered ${Math.floor(ageH)}h at ${shortName(r.store)}`;
        const body = `${r.stars}★ from ${r.reviewer_name || "a customer"} — ${excerpt(r.comment, 100) || "rating only"}`;
        await fanoutAlert(subs.map((p) => p.staff_id), title, body, "google-reviews.html#r=" + encodeURIComponent(r.id));
        const sms = subs.filter((p) => p.methods.sms && p.phone);
        if (sms.length) await fanoutSms(sms.map((p) => p.phone!), `${title} — reply: ${reviewLink(r.id)}`);
        slaSent++;
      }
      break;
    }
  }
  out.sla_alerts = slaSent;

  // 4 · auto-reply enqueue: 4–5★ only, recent, one queue row per review, 3h hold
  let queued = 0;
  if (cfg.master) {
    const { data: cands } = await admin.from("gbp_reviews")
      .select("id,store,stars,comment,reviewer_name,created_at")
      .gte("stars", 4).is("reply_text", null).is("deleted_at", null)
      .gte("created_at", new Date(nowMs - 7 * 86400_000).toISOString())
      .order("created_at", { ascending: true }).limit(30);
    const ids = (cands || []).map((c) => c.id);
    const { data: qRows } = ids.length
      ? await admin.from("gbp_reply_queue").select("review_id").in("review_id", ids)
      : { data: [] };
    const queuedSet = new Set((qRows || []).map((q) => String(q.review_id)));
    const phones: Record<string, string | null> = {};
    for (const l of locs) phones[l.store] = (l as unknown as { phone?: string }).phone || null;
    for (const c of (cands || []).slice(0, 8)) {   // cap LLM calls per run
      if (queuedSet.has(c.id) || !storeAutoOn(cfg, c.store)) continue;
      try {
        const draft = c.comment ? await llmDraft(c as Rev, phones[c.store] ?? null) : await thankYouFor(c.store);
        const { error } = await admin.from("gbp_reply_queue").insert({
          review_id: c.id, store: c.store, source: "auto", draft,
          status: "hold", post_after: new Date(nowMs + 3 * 3600_000).toISOString(),
        });
        if (!error) queued++;
      } catch (e) { out["draft_error"] = String((e as Error)?.message || e).slice(0, 150); }
    }
  }
  out.auto_queued = queued;

  // 5 · post due holds — only 9 AM–7 PM store time, and only while the toggles stay on
  let posted = 0;
  if (hour >= 9 && hour < 19) {
    const { data: due } = await admin.from("gbp_reply_queue").select("*")
      .eq("status", "hold").lte("post_after", new Date().toISOString()).limit(20);
    for (const q of due || []) {
      if (q.source === "auto" && !storeAutoOn(cfg, q.store)) continue;  // toggled off → stays on hold
      try {
        await postReply(String(q.review_id), String(q.draft), "auto", "auto");
        await admin.from("gbp_reply_queue").update({ status: "posted", posted_at: new Date().toISOString(), error: null }).eq("id", q.id);
        posted++;
      } catch (e) {
        const msg = String((e as Error)?.message || e).slice(0, 300);
        const stale = nowMs - new Date(q.post_after).getTime() > 24 * 3600_000;
        await admin.from("gbp_reply_queue").update({ error: msg, ...(stale ? { status: "error" } : {}) }).eq("id", q.id);
      }
    }
  }
  out.auto_posted = posted;

  // 6 · Monday digest of last week's auto-posts → Communications (+ opted-in alerts)
  if (weekday === "Mon" && hour >= 9) {
    const wk = "digest:" + isoWeek();
    if (!(await logged(wk))) {
      await logKey(wk);
      const { data: autos } = await admin.from("gbp_reply_queue").select("store,posted_at")
        .eq("status", "posted").eq("source", "auto")
        .gte("posted_at", new Date(nowMs - 7 * 86400_000).toISOString());
      if (autos?.length) {
        const perStore: Record<string, number> = {};
        for (const a of autos) perStore[a.store] = (perStore[a.store] || 0) + 1;
        const lines = Object.keys(perStore).sort().map((s) => `${shortName(s)}: ${perStore[s]}`).join(" · ");
        await admin.from("communications").upsert([{
          source_key: wk, kind: "gbp",
          title: `🤖 ${autos.length} review repl${autos.length === 1 ? "y" : "ies"} auto-posted last week`,
          body: `${lines}. Every reply is in the Google Reviews feed with an AUTO label.`,
        }], { onConflict: "source_key", ignoreDuplicates: true });
        const subs = prefs.filter((p) => p.triggers.auto_digest === true);
        await fanoutAlert(subs.map((p) => p.staff_id),
          `🤖 Auto-replies last week: ${autos.length}`, lines, "google-reviews.html");
        out.digest = autos.length;
      }
    }
  }
  return { ok: true, ...out };
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

const MGR_ACTIONS = ["draft", "reply", "queue", "queue_op", "config", "config_set"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "pull";
  let me: Me | null = null;
  if (MGR_ACTIONS.includes(action)) {
    me = await staffFromReq(req);
    if (!me && !authed(req, url)) return json({ ok: false, error: "unauthorized" }, 401);
  } else if (!authed(req, url)) return json({ ok: false, error: "unauthorized" }, 401);
  const actor = me ? me.name || ("staff:" + me.id) : "server";
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
        ["contact", () => pullContactAndPhotos(l)],
      ]);
      return json({ ok: true, days, results });
    }

    if (action === "engine") return json(await engine());

    if (action === "draft") {
      const b = await req.json().catch(() => ({}));
      const id = String(b.review_id || "");
      const { data: rev } = await admin.from("gbp_reviews")
        .select("id,store,stars,comment,reviewer_name,created_at").eq("id", id).maybeSingle();
      if (!rev) return json({ ok: false, error: "review_not_found" }, 404);
      const { data: loc } = await admin.from("gbp_locations").select("phone").eq("store", rev.store).maybeSingle();
      const draft = rev.comment ? await llmDraft(rev as Rev, loc?.phone || null) : await thankYouFor(rev.store);
      return json({ ok: true, draft });
    }

    if (action === "reply") {
      const b = await req.json().catch(() => ({}));
      const id = String(b.review_id || ""), text = String(b.text || "").trim();
      if (!id || !text) return json({ ok: false, error: "review_id and text required" }, 400);
      if (text.length > 4000) return json({ ok: false, error: "reply_too_long" }, 400);
      await postReply(id, text, actor, "manual");
      return json({ ok: true });
    }

    if (action === "queue") {
      const { data: rows } = await admin.from("gbp_reply_queue").select("*")
        .eq("status", "hold").order("post_after", { ascending: true });
      const ids = (rows || []).map((r) => r.review_id);
      const { data: revs } = ids.length
        ? await admin.from("gbp_reviews").select("id,store,stars,comment,reviewer_name,created_at").in("id", ids)
        : { data: [] };
      const byId: Record<string, unknown> = {};
      for (const r of revs || []) byId[String(r.id)] = r;
      return json({ ok: true, queue: (rows || []).map((r) => ({ ...r, review: byId[String(r.review_id)] || null })) });
    }

    if (action === "queue_op") {
      const b = await req.json().catch(() => ({}));
      const qid = Number(b.id), op = String(b.op || "");
      const { data: q } = await admin.from("gbp_reply_queue").select("*").eq("id", qid).maybeSingle();
      if (!q || q.status !== "hold") return json({ ok: false, error: "queue_row_not_open" }, 404);
      if (op === "cancel") {
        await admin.from("gbp_reply_queue").update({ status: "cancelled", decided_by: actor }).eq("id", qid);
      } else if (op === "edit") {
        const text = String(b.text || "").trim();
        if (!text) return json({ ok: false, error: "text required" }, 400);
        await admin.from("gbp_reply_queue").update({ draft: text.slice(0, 4000), decided_by: actor }).eq("id", qid);
      } else if (op === "post_now") {
        await postReply(String(q.review_id), String(b.text || q.draft), actor, "auto");
        await admin.from("gbp_reply_queue").update({
          status: "posted", posted_at: new Date().toISOString(), decided_by: actor, error: null,
        }).eq("id", qid);
      } else return json({ ok: false, error: "bad_op" }, 400);
      return json({ ok: true });
    }

    if (action === "config") {
      return json({ ok: true, auto_reply: await getCfg<AutoCfg>("auto_reply", { master: false, stores: {} }) });
    }

    if (action === "config_set") {
      const b = await req.json().catch(() => ({}));
      const cfg: AutoCfg = { master: !!b.master, stores: {} };
      if (b.stores && typeof b.stores === "object") {
        for (const k of Object.keys(b.stores)) cfg.stores[k] = !!b.stores[k];
      }
      await setCfg("auto_reply", cfg, actor);
      await admin.from("gbp_audit").insert({ actor, action: "auto_reply_config", store: null, payload: cfg });
      return json({ ok: true, auto_reply: cfg });
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
