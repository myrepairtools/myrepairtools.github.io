// =============================================================================
// qbo — QuickBooks ONLINE (Accounting API) connection + month-end cash posting.
//
// Holds the QBO client secret + tokens server-side; the browser never sees them.
// Deployed with verify_jwt:false because the OAuth callback from Intuit arrives
// with no Supabase JWT. Owner-only control actions are checked in-code.
//
//   GET  ?action=start          (owner JWT)  -> { url } to send the browser to consent
//   GET  ?code=..&state=..&realmId=..  (from Intuit) -> exchange code, store tokens, redirect back
//   GET  ?action=status         (owner JWT)  -> { connected, configured, realm_id, expires_at,
//                                                  updated_at, refresh_expires_at }
//   GET  ?action=disconnect     (owner JWT)  -> delete the stored token
//   GET  ?action=accounts       (owner JWT)  -> { accounts:[{id,name,type,subtype}] } — active chart of accounts
//   GET  ?action=classes        (owner JWT)  -> { classes:[{id,name}] } — active classes (P&L by store)
//   GET  ?action=vendors        (owner JWT)  -> { vendors:[{id,name}] } — active QBO vendors (Expenses vendor link)
//   POST { action:'extract_receipt', image_b64, media_type }  (owner JWT)
//        -> Claude vision reads the receipt photo -> { ok, vendor, date, amount, card_last4 }
//           (nulls where unreadable). Powers the Expenses page's auto-fill.
//   POST { action:'post_je', store, month, force }  (owner JWT)
//        -> post the month-end cash journal entry (debit cash / credit revenue) for
//           (store, 'YYYY-MM') from cash_journal, stamp the row + qbo_post_log, and
//           return { ok, je_id, doc_number, amount, txn_date }. Amount is the row's
//           SERVER-COMPUTED store_revenue — a client can never choose what gets posted.
//   POST { action:'create_expense', receipt_id }  (owner JWT)
//        -> post an expense receipt as a QBO Purchase (Check/CreditCard) from the
//           pre-written expense_receipts row (amount, accounts, class or per-class
//           split all come from the row — the request supplies ONLY the id), attach
//           the receipt image from the private 'receipts' bucket, stamp the row, and
//           return { ok, purchase_id, attachable_id, amount }.
//
// Intuit specifics worth knowing:
//   - The OAuth callback carries a realmId query param (the QBO company id); every
//     API call needs it, so it's persisted on integration_tokens.realm_id.
//   - Token exchange AND refresh authenticate with HTTP Basic (client_id:client_secret).
//   - Intuit ROTATES the refresh token on every refresh — the RETURNED refresh_token
//     must be persisted each time or the connection dies within 100 days.
//
// Secrets used: QBO_CLIENT_ID, QBO_CLIENT_SECRET (+ SUPABASE_URL/SERVICE_ROLE_KEY).
// Optional: QBO_BASE (sandbox override, e.g. https://sandbox-quickbooks.api.intuit.com).
// Register this exact URL as the app's Redirect URI:
//   https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/qbo
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") || "";

const REDIRECT_URI = "https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/qbo";
const RETURN_URL = "https://myrepairtools.com/settings.html";
const AUTHORIZE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";
const API_BASE = Deno.env.get("QBO_BASE") || "https://quickbooks.api.intuit.com";
const MINORVERSION = "75";
const PROVIDER = "qbo";

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const redirect = (url: string) => new Response(null, { status: 302, headers: { ...CORS, Location: url } });

async function getStaff(req: Request) {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff")
    .select("id, display_name, role, active").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s || null;
}

// HMAC-signed state so the callback can be trusted without a DB round-trip.
const enc = new TextEncoder();
function b64url(buf: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(SERVICE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function makeState(staffId: number) {
  const body = `${staffId}.${Date.now() + 10 * 60 * 1000}`;
  return `${body}.${await hmac(body)}`;
}
async function checkState(state: string | null) {
  const p = String(state || "").split(".");
  if (p.length !== 3) return null;
  const body = `${p[0]}.${p[1]}`;
  if ((await hmac(body)) !== p[2]) return null;
  if (Date.now() > Number(p[1])) return null;
  return p[0];
}

// ---- Intuit token plumbing --------------------------------------------------

// Exchange/refresh both hit the same bearer endpoint with HTTP Basic auth.
async function tokenRequest(form: URLSearchParams) {
  // 30s cap so a hung token call can never outlive the 90s refresh-claim lease.
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// System-tier alert to the owners when a refresh definitively dies — so a broken
// connection surfaces in minutes, not days. Deduped to once per 20h via meta.
async function alertRefreshDead(detail: string, meta: Record<string, unknown> | null) {
  try {
    const m = (meta || {}) as Record<string, unknown>;
    const last = new Date(String(m.last_refresh_alert_at || 0)).getTime() || 0;
    if (Date.now() - last < 20 * 3600 * 1000) return;
    // record the error for the Settings status card regardless of alert delivery
    await admin.from("integration_tokens").update({
      meta: { ...m, last_refresh_error: detail.slice(0, 300) },
    }).eq("provider", PROVIDER);
    const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
    if (!NOTIFY_SECRET) return;
    const { data: owners } = await admin.from("staff").select("id").eq("role", "owner").eq("active", true);
    const ids = (owners || []).map((o) => o.id as number);
    if (!ids.length) return;
    const r = await fetch(SB_URL + "/functions/v1/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE, apikey: SERVICE },
      body: JSON.stringify({
        action: "send", secret: NOTIFY_SECRET, kind: "system",
        title: "QuickBooks Online disconnected",
        body: "Token refresh failed (" + detail.slice(0, 140) + "). Reconnect in Settings → Integrations → QuickBooks Online.",
        link: "settings.html#integ", staff_ids: ids,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // dedupe stamp only AFTER a delivered alert — a failed send must retry next time
    if (r.ok) {
      await admin.from("integration_tokens").update({
        meta: { ...m, last_refresh_alert_at: new Date().toISOString(), last_refresh_error: detail.slice(0, 300) },
      }).eq("provider", PROVIDER);
    }
  } catch (_) { /* alerting must never break the request */ }
}

// Returns a fresh { access_token, realm_id } or null when not connected / refresh dead.
// Refreshes when within 3 minutes of expiry — and CRITICALLY persists the ROTATED
// refresh token Intuit returns (skip that and the connection dies within 100 days).
//
// SINGLE-FLIGHT: Intuit rotates refresh tokens, so two concurrent refreshes
// spending the same stored token can leave a consumed token in the DB (the race
// that killed QB Time on 2026-07-23 — expenses.html alone fires several qbo calls
// at once). Only the claim_token_refresh winner (docs/sql/token-refresh-lock.sql)
// may call the token endpoint; losers keep using the current access token or
// briefly wait for the winner's rotation to land.
/* The access token lives an hour and is refreshed on demand; the REFRESH token
   is the connection itself — ~100 days, and Intuit hands back a fresh window on
   every refresh. That deadline is what "is my QuickBooks about to expire?"
   actually means, so keep it where the status card can show it. */
function rtExpiry(d: Record<string, unknown>): string | null {
  const secs = Number(d.x_refresh_token_expires_in);
  return Number.isFinite(secs) && secs > 0 ? new Date(Date.now() + secs * 1000).toISOString() : null;
}
async function getToken(): Promise<{ access_token: string; realm_id: string } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: tok } = await admin.from("integration_tokens").select("*").eq("provider", PROVIDER).maybeSingle();
    if (!tok || !tok.access_token || !tok.realm_id) return null;
    const exp = tok.expires_at ? new Date(tok.expires_at).getTime() : 0;
    if (Date.now() < exp - 3 * 60 * 1000) return { access_token: tok.access_token, realm_id: String(tok.realm_id) };
    if (!tok.refresh_token) return null;

    // If the claim RPC itself errors (e.g. dropped by a migration), refresh WITHOUT
    // the claim — the old racy behavior beats never refreshing until the token dies.
    const { data: won, error: claimErr } = await admin.rpc("claim_token_refresh", { p_provider: PROVIDER, p_seen_rt: tok.refresh_token });
    if (!won && !claimErr) {
      // Another instance holds the refresh (or already rotated the token).
      if (Date.now() < exp) return { access_token: tok.access_token, realm_id: String(tok.realm_id) };
      await sleep(1200); continue;                    // hard-expired: wait for the winner, re-read
    }

    let ok: boolean, status: number, d: Record<string, unknown>;
    try {
      ({ ok, status, d } = await tokenRequest(new URLSearchParams({
        grant_type: "refresh_token", refresh_token: tok.refresh_token,
      })));
    } catch (_) {
      // Network-level failure talking to Intuit — release the claim and limp.
      await admin.from("integration_tokens").update({ refresh_lock_at: null }).eq("provider", PROVIDER);
      if (Date.now() < exp) return { access_token: tok.access_token, realm_id: String(tok.realm_id) };
      return null;
    }
    if (!ok || !d.access_token) {
      await admin.from("integration_tokens").update({ refresh_lock_at: null }).eq("provider", PROVIDER);
      // 5xx/network-ish = transient, stay quiet; 4xx = the token is really dead.
      if (status >= 400 && status < 500) await alertRefreshDead(JSON.stringify(d).slice(0, 200) || ("http_" + status), tok.meta);
      if (Date.now() < exp) return { access_token: tok.access_token, realm_id: String(tok.realm_id) };
      return null;
    }
    const expires_at = new Date(Date.now() + (Number(d.expires_in) || 0) * 1000).toISOString();
    // Persist the rotated pair — losing it kills the connection, so retry hard.
    const rotated = {
      access_token: d.access_token,
      refresh_token: d.refresh_token || tok.refresh_token,
      expires_at,
      meta: { ...((tok.meta || {}) as Record<string, unknown>), last_refresh_error: null, refresh_expires_at: rtExpiry(d) },
      refresh_lock_at: null,
      updated_at: new Date().toISOString(),
    };
    // exponential backoff (~7.5s max) — the old refresh token is already consumed
    // at the provider, so losing this write kills the connection; ride out an API blip.
    for (let w = 0; w < 5; w++) {
      const res = await admin.from("integration_tokens").update(rotated).eq("provider", PROVIDER);
      if (!res.error) return { access_token: d.access_token, realm_id: String(tok.realm_id) };
      await sleep(500 * Math.pow(2, w));
    }
    console.error("qbo: FAILED to persist rotated refresh token — connection dies on next refresh");
    await alertRefreshDead("rotated token could not be saved to the database", tok.meta);
    return { access_token: d.access_token, realm_id: String(tok.realm_id) };
  }
  return null;
}

// ---- QBO API helpers --------------------------------------------------------

function qboHeaders(token: string): Record<string, string> {
  return { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" };
}

// Flatten Intuit's { Fault:{ Error:[{Message,Detail,code}] } } into a readable string.
function faultDetail(d: unknown): string {
  const errs = (d as { Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }> } })?.Fault?.Error;
  if (Array.isArray(errs) && errs.length)
    return errs.map((e) => [e.Message, e.Detail].filter(Boolean).join(": ")).join(" | ");
  try { return JSON.stringify(d ?? {}); } catch { return String(d); }
}

const usd = (v: unknown) => "$" + (Number(v) || 0).toFixed(2);

// Intuit's per-request trace id — captured on every QBO response so errors can
// be handed to Intuit support with the exact transaction reference.
const tid = (r: Response | undefined) => r?.headers?.get("intuit_tid") || null;

// ---- post_je: the month-end cash journal entry ------------------------------

async function postJournalEntry(body: Record<string, unknown>, staff: { display_name: string }) {
  const store = typeof body.store === "string" ? body.store.trim() : "";
  const month = String(body.month || "");
  const force = body.force === true;
  if (!store) return json({ error: "bad_request", detail: "store is required." }, 400);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "bad_request", detail: "month must be YYYY-MM." }, 400);

  // The journal row is the single source of truth — amount is the GENERATED
  // store_revenue column, computed server-side. Never trust a client amount.
  const { data: row, error: rowErr } = await admin.from("cash_journal")
    .select("*").eq("store", store).eq("month", month).maybeSingle();
  if (rowErr) return json({ error: "db_error", detail: rowErr.message }, 500);
  if (!row) return json({ error: "not_found", detail: `No cash journal row for ${store} ${month}.` }, 404);
  if (row.starting_cash == null || row.ending_cash == null || row.cash_deposited == null)
    return json({ error: "month_incomplete", detail: "Starting cash, ending cash, and deposits must all be entered before posting." }, 400);

  const amount = Math.round(Number(row.store_revenue) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0)
    return json({ error: "zero_amount", detail: "Store revenue for this month is $0 — nothing to post." }, 400);

  // Double-post guard — force:true deliberately re-posts (e.g. after voiding in QBO).
  if (row.qbo_je_id && !force)
    return json({ error: "already_posted", je_id: row.qbo_je_id, doc_number: row.qbo_doc_number || null, posted_at: row.qbo_posted_at || null }, 409);

  // Which QBO accounts this store posts to (Settings-managed mapping).
  const { data: map } = await admin.from("qbo_store_map").select("*").eq("store", store).maybeSingle();
  if (!map || !map.cash_account_id || !map.revenue_account_id)
    return json({ error: "unmapped", detail: `No QBO account mapping for ${store} — map its cash + revenue accounts in Settings first.` }, 400);

  const tok = await getToken();
  if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);

  // Atomic claim BEFORE calling QBO — the 409 check above is read-then-act, so
  // two tabs clicking Post inside the same QBO round-trip would both pass it and
  // double-post. The claim is a conditional UPDATE only one caller can win:
  //   first post:  row must still have no je_id AND no fresh in-flight claim
  //                (a claim older than 2 min = a crashed attempt; retry may take it)
  //   force post:  row must still carry exactly the je_id we just read
  // A QBO failure rolls the claim back (best effort).
  const claimTs = new Date().toISOString();
  const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const claimQ = admin.from("cash_journal")
    .update({ qbo_posted_at: claimTs, qbo_posted_by: `${staff.display_name} (posting…)` })
    .eq("store", store).eq("month", month);
  const claim = force
    ? await claimQ.eq("qbo_je_id", row.qbo_je_id).select("month")
    : await claimQ.is("qbo_je_id", null).or(`qbo_posted_at.is.null,qbo_posted_at.lt.${stale}`).select("month");
  if (claim.error) return json({ error: "db_error", detail: claim.error.message }, 500);
  if (!claim.data || claim.data.length === 0)
    return json({ error: "already_posted", detail: "Another post for this month just ran (or is running) — refresh and check before retrying." }, 409);
  const rollbackClaim = () => admin.from("cash_journal")
    .update({ qbo_posted_at: row.qbo_posted_at || null, qbo_posted_by: row.qbo_posted_by || null })
    .eq("store", store).eq("month", month).eq("qbo_posted_at", claimTs)
    .then(() => {}, () => {});

  // TxnDate = last day of the month, built from plain integers (no Date->string
  // round-trip that could drift a day across timezones).
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const txn_date = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const monthLabel = `${MONTHS[m - 1]} ${y}`;

  // Debit cash / credit revenue for positive revenue; a negative month (refund-heavy)
  // swaps the posting types — QBO line Amounts must always be positive.
  const abs = Math.abs(amount);
  const desc = `Cash store revenue — ${monthLabel}`;
  // Class-segmented P&L: the store's mapped class rides on BOTH lines so class
  // reports (P&L by class, classed balance sheet) attribute the entry correctly.
  const classRef = map.class_id
    ? { ClassRef: { value: String(map.class_id), ...(map.class_name ? { name: String(map.class_name) } : {}) } }
    : {};
  const line = (postingType: string, accountId: unknown, accountName: unknown) => ({
    DetailType: "JournalEntryLineDetail",
    Amount: abs,
    Description: desc,
    JournalEntryLineDetail: {
      PostingType: postingType,
      AccountRef: { value: String(accountId), ...(accountName ? { name: String(accountName) } : {}) },
      ...classRef,
    },
  });
  const je = {
    TxnDate: txn_date,
    PrivateNote: `MRT Cash Journal — ${store} ${monthLabel}. Cash revenue ${usd(amount)}; deposits ${usd(row.cash_deposited)}; ` +
      `on-hand ${usd(row.starting_cash)} -> ${usd(row.ending_cash)}. Posted by ${staff.display_name} via myRepairTools.`,
    Line: [
      line(amount >= 0 ? "Debit" : "Credit", map.cash_account_id, map.cash_account_name),
      line(amount >= 0 ? "Credit" : "Debit", map.revenue_account_id, map.revenue_account_name),
    ],
  };

  let r: Response, d: any;
  try {
    r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/journalentry?minorversion=${MINORVERSION}`, {
      method: "POST", headers: qboHeaders(tok.access_token), body: JSON.stringify(je),
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    await rollbackClaim();
    return json({ error: "qbo_error", detail: String((e as Error)?.message || e) }, 502);
  }
  const posted = d?.JournalEntry;
  if (!r.ok || !posted?.Id) { await rollbackClaim(); return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502); }

  // Stamp the journal row + append the audit log (payload = exactly what QBO received).
  // The JE now EXISTS in QBO — a failed write-back must be surfaced, not swallowed,
  // or a retry would double-post.
  const warns: string[] = [];
  const now = new Date().toISOString();
  const stamp = await admin.from("cash_journal").update({
    qbo_je_id: String(posted.Id),
    qbo_doc_number: posted.DocNumber || null,
    qbo_posted_at: now,
    qbo_posted_by: staff.display_name,
    qbo_posted_amount: amount,
  }).eq("store", store).eq("month", month);
  if (stamp.error) warns.push(`JE ${posted.Id} was created in QBO but the receipt failed to save (${stamp.error.message}) — the month may still show unposted; verify in QBO before posting again.`);
  const logw = await admin.from("qbo_post_log").insert({
    store, month, je_id: String(posted.Id), doc_number: posted.DocNumber || null,
    amount, payload: { ...je, intuit_tid: tid(r) }, posted_by: staff.display_name,
  });
  if (logw.error) warns.push(`Audit log write failed (${logw.error.message}).`);

  return json({ ok: true, je_id: String(posted.Id), doc_number: posted.DocNumber || null, amount, txn_date, ...(warns.length ? { warn: warns.join(" ") } : {}) });
}

// ---- extract_receipt: Claude vision reads a receipt photo --------------------

async function extractReceipt(body: Record<string, unknown>) {
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!ANTHROPIC_KEY) return json({ error: "no_ai", detail: "ANTHROPIC_API_KEY is not set." }, 503);
  const b64 = typeof body.image_b64 === "string" ? body.image_b64 : "";
  const media = typeof body.media_type === "string" && /^image\/(jpeg|png|webp)$/.test(body.media_type)
    ? body.media_type : "image/jpeg";
  if (b64.length < 100) return json({ error: "bad_request", detail: "image_b64 required." }, 400);
  if (b64.length > 8_000_000) return json({ error: "too_large", detail: "Image too large — retake closer / smaller." }, 413);

  const payload = {
    model: "claude-haiku-4-5-20251001",   // receipts are easy reads — the fast tier keeps this ~1s
    max_tokens: 300,
    system: 'You extract fields from a photo of a purchase receipt. Reply with ONLY a JSON object, no prose: ' +
      '{"vendor": string|null, "date": "YYYY-MM-DD"|null, "amount": number|null, "card_last4": string|null}. ' +
      'vendor = the merchant name as printed, short (e.g. "Costco", "Shell", "Home Depot"). ' +
      'date = the transaction date printed on the receipt. ' +
      'amount = the final grand total actually charged, after tax and tip. ' +
      'card_last4 = the LAST FOUR DIGITS of the card used, exactly as printed — receipts write it as ' +
      '"VISA ****1234", "XXXXXXXXXXXX1234", "Card #: 1234", "ACCT 1234" or similar. Four digits only, ' +
      'no masking characters. If the receipt shows an Apple Pay / contactless device account number, ' +
      'give THAT number — it is what is printed. Null if the receipt was paid in cash or shows no card. ' +
      "Use null for any field you cannot read confidently. Never guess.",
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: media, data: b64 } },
        { type: "text", text: "Extract the fields from this receipt." },
      ],
    }],
  };
  let r: Response, d: any;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    return json({ error: "ai_error", detail: String((e as Error)?.message || e) }, 502);
  }
  if (!r.ok) return json({ error: "ai_error", detail: d?.error?.message || ("HTTP " + r.status) }, 502);

  const text = ((d?.content || []) as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text || "").join(" ");
  let vendor: string | null = null, date: string | null = null, amount: number | null = null;
  let card_last4: string | null = null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (typeof p.vendor === "string" && p.vendor.trim()) vendor = p.vendor.trim().slice(0, 120);
      if (typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) {
        const y = Number(p.date.slice(0, 4));
        if (y >= 2000 && y <= 2100) date = p.date;
      }
      const a = Number(p.amount);
      if (Number.isFinite(a) && a > 0 && a < 1_000_000) amount = Math.round(a * 100) / 100;
      const c4 = String(p.card_last4 ?? "").replace(/\D/g, "");
      if (c4.length === 4) card_last4 = c4;
    } catch { /* model returned junk — treat as unreadable */ }
  }
  return json({ ok: true, vendor, date, amount, card_last4 });
}

// ---- create_expense: post an expense receipt as a QBO Purchase ---------------

async function createExpense(body: Record<string, unknown>, staff: { display_name: string }) {
  const receipt_id = typeof body.receipt_id === "string" ? body.receipt_id.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt_id))
    return json({ error: "bad_request", detail: "receipt_id must be a UUID." }, 400);

  // The receipt row is the single source of truth — amount, accounts, and class
  // split were all written server-side by the page. Never trust anything else
  // from the request beyond the id.
  const { data: row, error: rowErr } = await admin.from("expense_receipts")
    .select("*").eq("id", receipt_id).maybeSingle();
  if (rowErr) return json({ error: "db_error", detail: rowErr.message }, 500);
  if (!row) return json({ error: "not_found", detail: "No expense receipt with that id." }, 404);
  if (row.qbo_purchase_id)
    return json({ error: "already_posted", purchase_id: String(row.qbo_purchase_id) }, 409);

  const amount = Math.round(Number(row.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || !row.txn_date || !row.payment_account_id || !row.expense_account_id)
    return json({ error: "bad_row", detail: "Receipt needs a positive amount, a date, and payment + expense accounts." }, 400);

  const tok = await getToken();
  if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);

  // Atomic claim — same double-post race as post_je: retries after a lost
  // response and double-taps must not book two Purchases. Only one caller can
  // flip the row to 'posting'; a stale claim (>2 min = crashed attempt) is
  // takeable. Rolled back on failure.
  const claimTs = new Date().toISOString();
  const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const claim = await admin.from("expense_receipts")
    .update({ status: "posting", qbo_claimed_at: claimTs })
    .eq("id", receipt_id).is("qbo_purchase_id", null)
    .or(`qbo_claimed_at.is.null,qbo_claimed_at.lt.${stale}`)
    .select("id");
  if (claim.error) return json({ error: "db_error", detail: claim.error.message }, 500);
  if (!claim.data || claim.data.length === 0) {
    const { data: again } = await admin.from("expense_receipts").select("qbo_purchase_id").eq("id", receipt_id).maybeSingle();
    if (again?.qbo_purchase_id) return json({ error: "already_posted", purchase_id: String(again.qbo_purchase_id) }, 409);
    return json({ error: "in_progress", detail: "This expense is being booked right now — give it a moment." }, 409);
  }
  const rollbackClaim = (why: string) =>
    admin.from("expense_receipts").update({ status: "failed", error: why, qbo_claimed_at: null })
      .eq("id", receipt_id).is("qbo_purchase_id", null)
      .then((w) => w.error ? ` (and the failure could not be recorded: ${w.error.message})` : "");

  // The receipt id rides in the Purchase DocNumber (queryable, 21-char limit),
  // so if a previous attempt created the Purchase but died before stamping the
  // row, we FIND it instead of booking a duplicate.
  const docNumber = `MRT-${receipt_id.slice(0, 8)}`;
  try {
    const q = `select Id from Purchase where DocNumber = '${docNumber}'`;
    const pr = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const pd = await pr.json().catch(() => ({}));
    const found = pd?.QueryResponse?.Purchase?.[0]?.Id;
    if (found) {
      const rec = await admin.from("expense_receipts").update({
        qbo_purchase_id: String(found), status: "posted", error: null, qbo_claimed_at: null,
      }).eq("id", receipt_id).is("qbo_purchase_id", null);
      return json({ ok: true, purchase_id: String(found), attachable_id: null, amount, recovered: true,
        ...(rec.error ? { warn: `Recovered Purchase ${found} but the row failed to update (${rec.error.message}).` } : {}) });
    }
  } catch (_e) { /* recovery probe is best-effort — fall through to create */ }

  // One expense line per class-split entry, or a single line with the row's class.
  const desc = [row.vendor, row.memo].filter(Boolean).join(" — ") || undefined;
  const expenseRef = { value: String(row.expense_account_id), ...(row.expense_account_name ? { name: String(row.expense_account_name) } : {}) };
  // A split entry may name its own expense account (one receipt, two categories
  // — shop tools and signage off the same Home Depot run) and/or its own class.
  // Anything it leaves out falls back to the row's single account.
  const line = (amt: number, class_id: unknown, class_name: unknown, acct_id?: unknown, acct_name?: unknown) => ({
    DetailType: "AccountBasedExpenseLineDetail",
    Amount: amt,
    Description: desc,
    AccountBasedExpenseLineDetail: {
      AccountRef: acct_id
        ? { value: String(acct_id), ...(acct_name ? { name: String(acct_name) } : {}) }
        : expenseRef,
      ...(class_id ? { ClassRef: { value: String(class_id), ...(class_name ? { name: String(class_name) } : {}) } } : {}),
    },
  });
  let lines: Array<ReturnType<typeof line>>;
  if (Array.isArray(row.split) && row.split.length) {
    lines = (row.split as Array<Record<string, unknown>>).map((e) => line(Number(e.amount), e.class_id, e.class_name, e.account_id, e.account_name));
    const sum = lines.reduce((t, l) => t + l.Amount, 0);
    if (lines.some((l) => !Number.isFinite(l.Amount) || l.Amount <= 0) || Math.abs(sum - amount) > 0.011) {
      const detail = `Split lines must all be positive and total the receipt amount (${usd(sum)} vs ${usd(amount)}).`;
      const extra = await rollbackClaim(detail);
      return json({ error: "split_mismatch", detail: detail + extra }, 400);
    }
  } else {
    lines = [line(amount, row.class_id, row.class_name)];
  }

  // Link the QBO vendor record when we can — EntityRef makes vendor reports and
  // recurring bank-feed matches smarter. The page writes qbo_vendor_id when the
  // typed name matched the vendor list; otherwise probe QBO for an exact
  // DisplayName hit. Both are best-effort — a plain text vendor still books fine.
  let entityRef: Record<string, unknown> = {};
  const vid = row.qbo_vendor_id ? String(row.qbo_vendor_id).trim() : "";
  if (/^\d+$/.test(vid)) {
    entityRef = { EntityRef: { value: vid, ...(row.qbo_vendor_name ? { name: String(row.qbo_vendor_name) } : {}), type: "Vendor" } };
  } else if (row.vendor) {
    try {
      const vq = `select Id, DisplayName from Vendor where DisplayName = '${String(row.vendor).replace(/'/g, "\\'")}'`;
      const vr = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(vq)}&minorversion=${MINORVERSION}`,
        { headers: qboHeaders(tok.access_token) });
      const vd = await vr.json().catch(() => ({}));
      const v = vd?.QueryResponse?.Vendor?.[0];
      if (v?.Id) entityRef = { EntityRef: { value: String(v.Id), name: String(v.DisplayName || row.vendor), type: "Vendor" } };
    } catch { /* probe is best-effort */ }
  }

  const purchase = {
    PaymentType: row.payment_account_type === "Credit Card" ? "CreditCard" : "Check",
    AccountRef: { value: String(row.payment_account_id), ...(row.payment_account_name ? { name: String(row.payment_account_name) } : {}) },
    ...entityRef,
    DocNumber: docNumber,   // idempotency key — recovery probe finds it by query
    TxnDate: String(row.txn_date),
    PrivateNote: [[row.vendor, row.memo].filter(Boolean).join(" — "),
      `Recorded via myRepairTools by ${row.created_by || staff.display_name}.`].filter(Boolean).join(" … "),
    Line: lines,
  };

  let r: Response, d: any;
  try {
    r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/purchase?minorversion=${MINORVERSION}`, {
      method: "POST", headers: qboHeaders(tok.access_token), body: JSON.stringify(purchase),
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    // Network-level failure: the request may or may not have reached QBO — the
    // DocNumber recovery probe on the next attempt sorts that out safely.
    const detail = String((e as Error)?.message || e);
    const extra = await rollbackClaim(detail);
    return json({ error: "qbo_error", detail: detail + extra }, 502);
  }
  const posted = d?.Purchase;
  if (!r.ok || !posted?.Id) {
    const detail = faultDetail(d);
    const extra = await rollbackClaim(detail);
    return json({ error: "qbo_error", detail: detail + extra, intuit_tid: tid(r) }, 502);
  }
  const purchase_id = String(posted.Id);

  // Attach the receipt image (best effort — the Purchase already exists in QBO,
  // so an attach failure must never fail the expense; it just warns).
  const warns: string[] = [];
  let attachable_id: string | null = null;
  if (row.receipt_path) {
    const dl = await admin.storage.from("receipts").download(String(row.receipt_path));
    if (dl.error || !dl.data) {
      warns.push(`Receipt image download failed (${dl.error?.message || "no data"}) — expense posted without the attachment.`);
    } else {
      const fileName = `receipt-${row.txn_date}-${receipt_id.slice(0, 8)}.jpg`;
      const meta = {
        AttachableRef: [{ EntityRef: { type: "Purchase", value: purchase_id } }],
        FileName: fileName,
        ContentType: "image/jpeg",
      };
      const form = new FormData();
      form.append("file_metadata_01", new Blob([JSON.stringify(meta)], { type: "application/json" }));
      form.append("file_content_01", dl.data, fileName);
      try {
        // No Content-Type header here — fetch sets the multipart boundary itself.
        const ur = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/upload?minorversion=${MINORVERSION}`, {
          method: "POST",
          headers: { Authorization: "Bearer " + tok.access_token, Accept: "application/json" },
          body: form,
        });
        const ud = await ur.json().catch(() => ({}));
        attachable_id = ud?.AttachableResponse?.[0]?.Attachable?.Id ? String(ud.AttachableResponse[0].Attachable.Id) : null;
        if (!ur.ok || !attachable_id)
          warns.push(`Receipt attach failed (${faultDetail(ud)}) — expense posted without the attachment.`);
      } catch (e) {
        warns.push(`Receipt attach failed (${String((e as Error)?.message || e)}) — expense posted without the attachment.`);
      }
    }
  }

  // Stamp the row. The Purchase now EXISTS in QBO — a failed write-back is
  // surfaced (and the DocNumber recovery probe makes a later retry safe anyway).
  const stamp = await admin.from("expense_receipts").update({
    qbo_purchase_id: purchase_id,
    qbo_attachable_id: attachable_id,
    status: "posted",
    error: null,
    qbo_claimed_at: null,
  }).eq("id", receipt_id).is("qbo_purchase_id", null).select("id");
  if (stamp.error) warns.push(`Purchase ${purchase_id} was created in QBO but the receipt row failed to update (${stamp.error.message}) — a retry will recover it safely.`);
  else if (!stamp.data || stamp.data.length === 0) warns.push(`Another run already stamped this receipt — verify Purchase ${purchase_id} in QBO.`);

  return json({ ok: true, purchase_id, attachable_id, amount, ...(warns.length ? { warn: warns.join(" ") } : {}) });
}

// =============================================================================

// ---------------------------------------------------------------------------
// A MobileSentrix order -> one properly-split QBO Purchase.
//
// The point is the bank feed: a Purchase whose total equals the card charge and
// whose lines are coded per category means the feed offers a one-tap Match
// instead of a lump landing in COGS - Parts.
//
// Everything judgemental lives in Postgres (ms_order_split / ms_category_map /
// ms_sku_category) so it is correctable without a redeploy. This function only
// resolves the QBO-side references and posts.
//
// Consignment is NEVER posted: those parts arrive unpaid, so no card charge
// exists for them; corporate drafts the bank separately when parts are used and
// that lands in COGS - Parts (Consigned) on its own. Posting a consignment
// order here would invent an expense that never happened.
async function postMsOrder(body: Record<string, unknown>, actor: string) {
  const incrementId = String(body.increment_id || "").trim();
  const dryRun = body.dry_run !== false;          // safe by default: must ask to post
  if (!incrementId) return json({ error: "bad_request", detail: "increment_id is required." }, 400);

  const { data: o, error: oe } = await admin.from("ms_orders")
    .select("*").eq("increment_id", incrementId).maybeSingle();
  if (oe) return json({ error: "db_error", detail: oe.message }, 500);
  if (!o) return json({ error: "not_found", detail: `No MobileSentrix order ${incrementId}.` }, 404);

  // ---- eligibility, stated as refusals so a bad row can never post ----
  const orderType = String((o.raw as Record<string, unknown> | null)?.order_type ?? "");
  const problems: string[] = [];
  if (String(o.payment_method || "") === "consignment" || orderType === "1")
    problems.push("Consignment order — no payment was made, so there is nothing to book.");
  if (!(Number(o.grand_total) > 0)) problems.push("Order total is not greater than zero.");
  if (!o.cc_last4) problems.push("No card on the order — only card-paid orders are booked.");
  if (!["0", "10"].includes(orderType))
    problems.push(`Order type ${orderType || "(none)"} is not a Sales or Battery order.`);
  if (o.qbo_purchase_id) return json({ error: "already_posted", purchase_id: String(o.qbo_purchase_id) }, 409);

  // ---- the split (categories + amounts), computed in Postgres ----
  const { data: split, error: se } = await admin.rpc("ms_order_split", { p_increment_id: incrementId });
  if (se) return json({ error: "db_error", detail: se.message }, 500);
  const rows = (split || []) as Array<{ category: string; amount: string }>;
  if (!rows.length) problems.push("Split came back empty.");
  const amount = Math.round(Number(o.grand_total) * 100) / 100;
  const splitSum = Math.round(rows.reduce((t, r) => t + Number(r.amount), 0) * 100) / 100;
  if (Math.abs(splitSum - amount) > 0.011)
    problems.push(`Split totals ${usd(splitSum)} but the card was charged ${usd(amount)}.`);
  for (const r of rows) {
    if (r.category === "UNCLASSIFIED")
      problems.push(`${usd(r.amount)} could not be categorised — add the SKU to ms_sku_category.`);
    if (r.category === "Discount")
      problems.push(`Order carries a ${usd(r.amount)} discount; discounts are not handled yet.`);
    if (Number(r.amount) <= 0 && r.category !== "Discount")
      problems.push(`${r.category} line is not positive (${usd(r.amount)}).`);
  }

  const tok = await getToken();
  if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);

  // ---- category -> QBO account ----
  const { data: catRows } = await admin.from("ms_category_map").select("*").eq("active", true);
  const catMap = new Map((catRows || []).map((c: Record<string, unknown>) => [String(c.category), c]));
  const lines: Array<Record<string, unknown>> = [];

  // ---- store -> class. qbo_store_map is keyed by the RAW RepairQ store name
  // ("CPR Clackamas OR") while ms_orders carries the app name, so compare on a
  // squashed prefix rather than demanding equality.
  const squash = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const { data: storeRows } = await admin.from("qbo_store_map").select("*");
  const storeRow = (storeRows || []).find((s: Record<string, unknown>) =>
    squash(s.store).startsWith(squash(o.store)) || squash(o.store).startsWith(squash(s.store)));
  if (!storeRow) problems.push(`No qbo_store_map row matches store "${o.store}".`);
  const classRef = storeRow?.class_id
    ? { ClassRef: { value: String(storeRow.class_id), ...(storeRow.class_name ? { name: String(storeRow.class_name) } : {}) } }
    : {};
  if (!storeRow?.class_id) problems.push(`Store "${o.store}" has no class mapped.`);

  // ---- card -> the QBO account it is paid from ----
  // The allowlist is the same one the Expenses page uses; the last four printed
  // on the card are matched against the ACCOUNT NAME (the house convention is
  // "Spark - Clackamas (8123)"). Exactly one hit or we refuse: paying the wrong
  // card is worse than not posting.
  const { data: cfg } = await admin.from("qbo_config").select("value").eq("key", "paywith").maybeSingle();
  const allowIds = ((cfg?.value as Record<string, unknown> | null)?.ids || []) as string[];
  let payAcct: Record<string, unknown> | null = null;
  let accountsSeen: Array<{ id: string; name: string; type: string }> = [];
  try {
    const aq = "select * from Account where Active = true maxresults 1000";
    const ar = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(aq)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const ad = await ar.json().catch(() => ({}));
    const all = (ad?.QueryResponse?.Account || []) as Array<Record<string, unknown>>;
    accountsSeen = all.map((a) => ({ id: String(a.Id), name: String(a.Name || ""), type: String(a.AccountType || "") }));

    // category accounts resolve by NAME against the live chart
    for (const r of rows) {
      const cm = catMap.get(r.category);
      if (!cm) { problems.push(`Category "${r.category}" is not in ms_category_map.`); continue; }
      let id = cm.qbo_account_id ? String(cm.qbo_account_id) : "";
      let nm = cm.qbo_account_name ? String(cm.qbo_account_name) : "";
      if (!id) {
        const hit = all.find((a) => String(a.Name || "").toLowerCase() === r.category.toLowerCase())
                 || all.find((a) => String(a.FullyQualifiedName || "").toLowerCase().endsWith(r.category.toLowerCase()));
        if (hit) { id = String(hit.Id); nm = String(hit.Name); }
      }
      if (!id) { problems.push(`No QBO account mapped or named "${r.category}".`); continue; }
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: Math.round(Number(r.amount) * 100) / 100,
        Description: `${r.category} — MobileSentrix ${incrementId}`,
        AccountBasedExpenseLineDetail: { AccountRef: { value: id, ...(nm ? { name: nm } : {}) }, ...classRef },
      });
    }

    const last4 = String(o.cc_last4 || "");
    const allowed = all.filter((a) => allowIds.map(String).includes(String(a.Id)));
    const hits = allowed.filter((a) => String(a.Name || "").includes(last4));
    if (hits.length === 1) payAcct = hits[0];
    // Name what was actually considered: "no match" is unactionable on its own,
    // and the usual cause is a card that was never added to the Settings
    // allowlist, or an account whose name omits the last four.
    else {
      const names = allowed.map((a) => String(a.Name || "")).join(" | ") || "(allowlist is empty)";
      problems.push(hits.length === 0
        ? `No allowed Paid With account names card •${last4}. Allowed accounts: ${names}`
        : `${hits.length} allowed accounts name card •${last4} — cannot tell which. Allowed accounts: ${names}`);
    }
  } catch (e) {
    problems.push(`Could not read the QBO chart of accounts: ${String((e as Error)?.message || e)}`);
  }

  // ---- vendor (best effort — a Purchase books fine without it) ----
  let entityRef: Record<string, unknown> = {};
  let vendorName: string | null = null;
  try {
    const vq = "select Id, DisplayName from Vendor where Active = true maxresults 1000";
    const vr = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(vq)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const vd = await vr.json().catch(() => ({}));
    const v = ((vd?.QueryResponse?.Vendor || []) as Array<Record<string, unknown>>)
      .find((x) => squash(x.DisplayName).includes("mobilesentrix"));
    if (v?.Id) { entityRef = { EntityRef: { value: String(v.Id), name: String(v.DisplayName), type: "Vendor" } }; vendorName = String(v.DisplayName); }
  } catch { /* best effort */ }

  const txnDate = new Date(String(o.ordered_at)).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const docNumber = `MS-${incrementId}`;
  const purchase = {
    PaymentType: "CreditCard",
    AccountRef: payAcct ? { value: String(payAcct.Id), name: String(payAcct.Name) } : undefined,
    ...entityRef,
    DocNumber: docNumber,
    TxnDate: txnDate,
    PrivateNote: `MobileSentrix order ${incrementId} (${orderType === "10" ? "Battery" : "Sales"} Order) — recorded via myRepairTools by ${actor}.`,
    Line: lines,
  };

  const preview = {
    order: {
      increment_id: incrementId, store: o.store, ordered_at: o.ordered_at, txn_date: txnDate,
      order_type: orderType === "10" ? "Battery Order" : "Sales Order",
      status: o.status, card: `${o.cc_type || "card"} •${o.cc_last4}`, charged: amount,
    },
    resolved: {
      pay_account: payAcct ? { id: String(payAcct.Id), name: String(payAcct.Name) } : null,
      class: storeRow?.class_id ? { id: String(storeRow.class_id), name: storeRow.class_name } : null,
      vendor: vendorName,
      doc_number: docNumber,
    },
    lines: lines.map((l) => ({
      account: (l.AccountBasedExpenseLineDetail as Record<string, any>).AccountRef,
      amount: l.Amount,
    })),
    line_total: Math.round(lines.reduce((t, l) => t + Number(l.Amount), 0) * 100) / 100,
    problems,
  };

  if (problems.length) return json({ ok: false, would_post: false, ...preview }, 200);
  if (dryRun) return json({ ok: true, dry_run: true, would_post: true, ...preview, payload: purchase }, 200);

  // ---- live post: claim, recover, create, stamp (same shape as createExpense) ----
  const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const claim = await admin.from("ms_orders")
    .update({ qbo_claimed_at: new Date().toISOString(), qbo_error: null })
    .eq("increment_id", incrementId).is("qbo_purchase_id", null)
    .or(`qbo_claimed_at.is.null,qbo_claimed_at.lt.${stale}`)
    .select("increment_id");
  if (claim.error) return json({ error: "db_error", detail: claim.error.message }, 500);
  if (!claim.data?.length) {
    const { data: again } = await admin.from("ms_orders").select("qbo_purchase_id").eq("increment_id", incrementId).maybeSingle();
    if (again?.qbo_purchase_id) return json({ error: "already_posted", purchase_id: String(again.qbo_purchase_id) }, 409);
    return json({ error: "in_progress", detail: "This order is being booked right now." }, 409);
  }
  const rollback = (why: string) =>
    admin.from("ms_orders").update({ qbo_error: why, qbo_claimed_at: null })
      .eq("increment_id", incrementId).is("qbo_purchase_id", null).then(() => {});

  // A previous attempt may have created the Purchase and died before stamping.
  try {
    const q = `select Id from Purchase where DocNumber = '${docNumber}'`;
    const pr = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const pd = await pr.json().catch(() => ({}));
    const found = pd?.QueryResponse?.Purchase?.[0]?.Id;
    if (found) {
      await admin.from("ms_orders").update({
        qbo_purchase_id: String(found), qbo_doc_number: docNumber, qbo_posted_at: new Date().toISOString(),
        qbo_amount: amount, qbo_error: null, qbo_claimed_at: null,
      }).eq("increment_id", incrementId).is("qbo_purchase_id", null);
      return json({ ok: true, purchase_id: String(found), amount, recovered: true, doc_number: docNumber });
    }
  } catch { /* best effort */ }

  let r: Response, d: any;
  try {
    r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/purchase?minorversion=${MINORVERSION}`, {
      method: "POST", headers: qboHeaders(tok.access_token), body: JSON.stringify(purchase),
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    const detail = String((e as Error)?.message || e);
    await rollback(detail);
    return json({ error: "qbo_error", detail }, 502);
  }
  const posted = d?.Purchase;
  if (!r.ok || !posted?.Id) {
    const detail = faultDetail(d);
    await rollback(detail);
    return json({ error: "qbo_error", detail, intuit_tid: tid(r) }, 502);
  }
  const stamp = await admin.from("ms_orders").update({
    qbo_purchase_id: String(posted.Id), qbo_doc_number: docNumber,
    qbo_posted_at: new Date().toISOString(), qbo_amount: amount, qbo_error: null, qbo_claimed_at: null,
  }).eq("increment_id", incrementId);
  return json({
    ok: true, purchase_id: String(posted.Id), doc_number: docNumber, amount,
    lines: preview.lines,
    ...(stamp.error ? { warn: `Posted Purchase ${posted.Id} but the row failed to update (${stamp.error.message}).` } : {}),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let action = url.searchParams.get("action");
  const code = url.searchParams.get("code");
  const oauthErr = url.searchParams.get("error");

  // ---- OAuth callback from Intuit (no JWT; ?code&state&realmId) ----
  if (code || oauthErr) {
    if (oauthErr) return redirect(`${RETURN_URL}?qbo=error&detail=${encodeURIComponent(url.searchParams.get("error_description") || oauthErr)}`);
    const staffId = await checkState(url.searchParams.get("state"));
    if (!staffId) return redirect(`${RETURN_URL}?qbo=error&detail=bad_state`);
    if (!CLIENT_ID || !CLIENT_SECRET) return redirect(`${RETURN_URL}?qbo=error&detail=not_configured`);
    const realmId = url.searchParams.get("realmId");   // the QBO company id — every API call needs it
    if (!realmId) return redirect(`${RETURN_URL}?qbo=error&detail=no_realm`);
    const { ok, status, d } = await tokenRequest(new URLSearchParams({
      grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT_URI,
    }));
    if (!ok || !d.access_token) return redirect(`${RETURN_URL}?qbo=error&detail=${encodeURIComponent(d.error || ("grant_" + status))}`);
    const expires_at = new Date(Date.now() + (Number(d.expires_in) || 0) * 1000).toISOString();
    await admin.from("integration_tokens").upsert({
      provider: PROVIDER, access_token: d.access_token, refresh_token: d.refresh_token, expires_at,
      realm_id: String(realmId),
      meta: { scope: d.scope || SCOPE, token_type: d.token_type, refresh_expires_at: rtExpiry(d) },
      connected_by: Number(staffId), updated_at: new Date().toISOString(),
    }, { onConflict: "provider" });
    return redirect(`${RETURN_URL}?qbo=connected`);
  }

  // post_je arrives as POST JSON; control actions as GET params.
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action) action = String(body.action);
  }

  // Edge-warm cron ping — answered before auth so it stays free of DB work.
  if (action === "ping") return json({ ok: true });

  // ---- machine caller: create an employee when a new hire finishes intake ----
  // The candidate has no JWT (their page is token-auth), so this one action
  // authenticates with the server secret instead of the owner gate below. All
  // token handling still lives here — never duplicate the refresh, it is
  // single-flight for a reason (see docs/sql/token-refresh-lock.sql).
  if (action === "create_employee") {
    const NOTIFY = Deno.env.get("NOTIFY_SECRET") || "";
    if (!NOTIFY || String(body.secret || "") !== NOTIFY) return json({ error: "forbidden" }, 403);
    const first = String(body.first_name || "").trim();
    const last = String(body.last_name || "").trim();
    if (!first || !last) return json({ error: "name_required" }, 400);
    const tok = await getToken();
    if (!tok) return json({ error: "not_connected" }, 503);

    // The create endpoint is NOT idempotent, so look before leaping: a retry
    // after a timeout must not leave two records for one person.
    // Match on GivenName + FamilyName, NOT DisplayName — QBO writes DisplayName
    // as "First M. Last" (Britt A. Bay) and prefixes some with "*", so an exact
    // "First Last" match misses almost everyone who has a middle initial.
    const esc = (x: string) => x.replace(/'/g, "''");
    const display = first + " " + last;
    const q = `select Id, DisplayName, GivenName, FamilyName from Employee where GivenName = '${esc(first)}' and FamilyName = '${esc(last)}'`;
    const fr = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const fd = await fr.json().catch(() => ({}));
    const existing = fd?.QueryResponse?.Employee?.[0];
    if (existing?.Id) return json({ ok: true, id: String(existing.Id), existing: true });

    // dry_run proves the secret, the token and the duplicate lookup without
    // writing anything into the company file
    if (body.dry_run) {
      // also list what IS in the accounting Employee list, so a DisplayName
      // that differs from "First Last" can't be mistaken for "not there"
      const lr = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent("select Id, DisplayName, GivenName, FamilyName, Active from Employee maxresults 100")}&minorversion=${MINORVERSION}`,
        { headers: qboHeaders(tok.access_token) });
      const ld = await lr.json().catch(() => ({}));
      const all = ((ld?.QueryResponse?.Employee || []) as Array<Record<string, any>>)
        .map((e) => ({ id: String(e.Id), display: e.DisplayName, given: e.GivenName, family: e.FamilyName, active: e.Active }));
      return json({ ok: true, dry_run: true, found: !!existing?.Id, would_create: !existing?.Id, display, employee_count: all.length, employees: all });
    }
    const addr = (body.address || {}) as Record<string, string>;
    const payload: Record<string, unknown> = {
      GivenName: first, FamilyName: last,
      DisplayName: first + " " + last,
      ...(body.email ? { PrimaryEmailAddr: { Address: String(body.email) } } : {}),
      ...(body.phone ? { Mobile: { FreeFormNumber: String(body.phone) } } : {}),
      ...(body.hire_date ? { HiredDate: String(body.hire_date) } : {}),
      ...(addr.street || addr.city || addr.zip
        ? { PrimaryAddr: {
            ...(addr.street ? { Line1: addr.street } : {}),
            ...(addr.city ? { City: addr.city } : {}),
            ...(addr.state ? { CountrySubDivisionCode: addr.state } : { CountrySubDivisionCode: "OR" }),
            ...(addr.zip ? { PostalCode: addr.zip } : {}),
          } }
        : {}),
    };
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/employee?minorversion=${MINORVERSION}`, {
      method: "POST", headers: { ...qboHeaders(tok.access_token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    return json({ ok: true, id: String(d?.Employee?.Id || ""), name: d?.Employee?.DisplayName || null });
  }

  if (action === "find_employee") {
    // "Is this hire in QuickBooks yet?" — asked from the Onboarding board
    // before merging a candidate onto a staff row. Includes INACTIVE records,
    // because an employee created as an accounting contact rather than through
    // payroll shows up exactly that way and the manager needs to see it.
    // Manager-level, not owner: this is asked from the Onboarding board, and
    // it reads nothing but names.
    const who = await getStaff(req);
    if (!who || !["owner", "admin", "manager"].includes(String(who.role))) {
      return json({ error: "forbidden" }, 403);
    }
    const tok = await getToken();
    if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);
    const first = String(body.first_name || "").trim().toLowerCase();
    const last = String(body.last_name || "").trim().toLowerCase();
    if (!first && !last) return json({ error: "name required" }, 400);
    const q = "select * from Employee maxresults 500";
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    const norm = (x: unknown) => String(x || "").toLowerCase().replace(/[^a-z]/g, "");
    const rows = ((d?.QueryResponse?.Employee || []) as Array<Record<string, any>>).map((e) => {
      const gn = norm(e.GivenName), fn = norm(e.FamilyName), dn = norm(e.DisplayName);
      // exact on both names, else same last name, else the display name contains it
      const score = (gn === norm(first) && fn === norm(last)) ? 3
        : (fn === norm(last) && !!last) ? 2
        : (dn.includes(norm(last)) && !!last) ? 1 : 0;
      return {
        id: String(e.Id), name: e.DisplayName || `${e.GivenName || ""} ${e.FamilyName || ""}`.trim(),
        active: e.Active !== false,
        hire_date: e.HiredDate || null,
        email: e.PrimaryEmailAddr?.Address || null,
        phone: e.Mobile?.FreeFormNumber || e.PrimaryPhone?.FreeFormNumber || null,
        // Payroll-created employees get 4000000xx ids; the Accounting API hands
        // out small sequential ones. That difference is how you tell a real
        // payroll employee from a contact record that will never be paid.
        payroll: Number(e.Id) >= 1000000,
        score,
      };
    }).filter((e) => e.score > 0).sort((a, b) => b.score - a.score || Number(b.active) - Number(a.active));
    return json({ matches: rows.slice(0, 10), total_employees: (d?.QueryResponse?.Employee || []).length });
  }
  // ---- MobileSentrix order -> QBO Purchase ----
  // Dual auth like create_employee: a cron authenticates with the server
  // secret, a person with their own JWT. Manager-level, because coding a
  // vendor purchase is bookkeeping, not an ownership decision -- and dry_run
  // (the default) posts nothing at all.
  if (action === "ms_post") {
    const NOTIFY = Deno.env.get("NOTIFY_SECRET") || "";
    let actor = "";
    if (NOTIFY && String(body.secret || "") === NOTIFY) {
      actor = "myRepairTools (scheduled)";
    } else {
      const who = await getStaff(req);
      if (!who || !["owner", "admin", "manager"].includes(String(who.role))) {
        return json({ error: "forbidden" }, 403);
      }
      actor = who.display_name;
    }
    return await postMsOrder(body, actor);
  }

  // ---- owner-only from here down ----
  const staff = await getStaff(req);
  if (!staff || staff.role !== "owner") return json({ error: "forbidden", detail: "Owner only." }, 403);

  if (action === "start") {
    if (!CLIENT_ID) return json({ error: "not_configured", detail: "QBO_CLIENT_ID secret is not set." }, 503);
    const state = await makeState(staff.id);
    // Payroll lives behind a scope our app has never asked for. Intuit only
    // validates scope after sign-in, so the only way to find out is to try it
    // in a browser. `scope` lets that be tested without a redeploy; it always
    // INCLUDES accounting, so a successful reconnect can never cost us the
    // access we already have.
    const wantScope = body.scope
      ? [...new Set((SCOPE + " " + String(body.scope)).split(/\s+/).filter(Boolean))].join(" ")
      : SCOPE;
    const u = `${AUTHORIZE}?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&scope=${encodeURIComponent(wantScope)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
    return json({ url: u });
  }
  if (action === "status") {
    const { data } = await admin.from("integration_tokens")
      .select("realm_id, expires_at, updated_at, meta").eq("provider", PROVIDER).maybeSingle();
    return json({
      connected: !!data, configured: !!CLIENT_ID,
      realm_id: data?.realm_id || null, expires_at: data?.expires_at || null, updated_at: data?.updated_at || null,
      refresh_expires_at: ((data?.meta || {}) as Record<string, unknown>).refresh_expires_at || null,
    });
  }
  if (action === "disconnect") {
    await admin.from("integration_tokens").delete().eq("provider", PROVIDER);
    return json({ ok: true });
  }
  if (action === "accounts") {
    // Active chart of accounts — feeds the Settings store→account mapping dropdowns.
    const tok = await getToken();
    if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);
    // `select *` rather than a column list: FullyQualifiedName and ParentRef are
    // what make a sub-account findable by its PARENT ("Store Buildout:Flooring"),
    // and Name alone hides the whole hierarchy — a chart with a dozen children
    // called things like "Flooring" is unusable without it.
    const q = "select * from Account where Active = true maxresults 1000";
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    const accounts = ((d?.QueryResponse?.Account || []) as Array<Record<string, unknown>>)
      .map((a) => {
        const par = (a.ParentRef || null) as { value?: string; name?: string } | null;
        return {
          id: String(a.Id),
          name: (a.Name as string) || "",
          fqn: (a.FullyQualifiedName as string) || (a.Name as string) || "",
          parent_id: par?.value ? String(par.value) : null,
          sub: !!a.SubAccount,
          type: (a.AccountType as string) || null,
          subtype: (a.AccountSubType as string) || null,
        };
      })
      .sort((a, b) => a.fqn.localeCompare(b.fqn));
    return json({ accounts });
  }
  if (action === "classes") {
    // Active class list — the owner's P&L is class-segmented per store, so the
    // Settings mapping assigns a class per store and post_je stamps it on lines.
    const tok = await getToken();
    if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);
    const q = "select Id, Name, FullyQualifiedName from Class where Active = true maxresults 1000";
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    const classes = ((d?.QueryResponse?.Class || []) as Array<Record<string, unknown>>)
      .map((c) => ({ id: String(c.Id), name: (c.FullyQualifiedName as string) || (c.Name as string) || "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ classes });
  }
  if (action === "vendors") {
    // Active vendor list — feeds the Expenses page's vendor combobox so typed
    // names link to real QBO vendor records.
    const tok = await getToken();
    if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);
    const q = "select Id, DisplayName from Vendor where Active = true maxresults 1000";
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    const vendors = ((d?.QueryResponse?.Vendor || []) as Array<Record<string, unknown>>)
      .map((v) => ({ id: String(v.Id), name: (v.DisplayName as string) || "" }))
      .filter((v) => v.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ vendors });
  }
  if (action === "employees") {
    // Active employee contact list — used to pre-fill staff_profiles phone
    // numbers (SMS alerts need a number on file). Read-only, owner-gated.
    const tok = await getToken();
    if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);
    const q = "select Id, DisplayName, GivenName, FamilyName, PrimaryPhone, Mobile from Employee where Active = true maxresults 200";
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    const employees = ((d?.QueryResponse?.Employee || []) as Array<Record<string, any>>)
      .map((e) => ({
        id: String(e.Id),
        name: (e.DisplayName as string) || `${e.GivenName || ""} ${e.FamilyName || ""}`.trim(),
        phone: e.Mobile?.FreeFormNumber || e.PrimaryPhone?.FreeFormNumber || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ employees });
  }
  if (action === "timeactivity") {
    // Read-only TimeActivity probe/reader — first brick of the QB Time → QBO
    // Workforce migration: if Intuit lands Workforce time entries here, this is
    // the stable modern read path (rest.tsheets.com is being sunset).
    const tok = await getToken();
    if (!tok) return json({ error: "not_connected", detail: "QuickBooks Online is not connected." }, 503);
    const startP = String((body.start as string) || url.searchParams.get("start") || "").slice(0, 10);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(startP) ? startP
      : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const q = `select * from TimeActivity where TxnDate >= '${start}' orderby TxnDate desc maxresults 500`;
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    const rows = ((d?.QueryResponse?.TimeActivity || []) as Array<Record<string, any>>)
      .map((t) => ({
        id: String(t.Id), date: t.TxnDate, name: t.EmployeeRef?.name || t.VendorRef?.name || t.NameOf || null,
        hours: Number(t.Hours) || 0, minutes: Number(t.Minutes) || 0,
        start: t.StartTime || null, end: t.EndTime || null, description: t.Description || null,
      }));
    return json({ start, count: rows.length, rows });
  }
  if (action === "extract_receipt") {
    return await extractReceipt(body);
  }
  if (action === "post_je") {
    return await postJournalEntry(body, staff);
  }
  if (action === "create_expense") {
    return await createExpense(body, staff);
  }
  return json({ error: "bad_action" }, 400);
});
