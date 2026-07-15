// =============================================================================
// qbo — QuickBooks ONLINE (Accounting API) connection + month-end cash posting.
//
// Holds the QBO client secret + tokens server-side; the browser never sees them.
// Deployed with verify_jwt:false because the OAuth callback from Intuit arrives
// with no Supabase JWT. Owner-only control actions are checked in-code.
//
//   GET  ?action=start          (owner JWT)  -> { url } to send the browser to consent
//   GET  ?code=..&state=..&realmId=..  (from Intuit) -> exchange code, store tokens, redirect back
//   GET  ?action=status         (owner JWT)  -> { connected, configured, realm_id, expires_at, updated_at }
//   GET  ?action=disconnect     (owner JWT)  -> delete the stored token
//   GET  ?action=accounts       (owner JWT)  -> { accounts:[{id,name,type,subtype}] } — active chart of accounts
//   GET  ?action=classes        (owner JWT)  -> { classes:[{id,name}] } — active classes (P&L by store)
//   POST { action:'post_je', store, month, force }  (owner JWT)
//        -> post the month-end cash journal entry (debit cash / credit revenue) for
//           (store, 'YYYY-MM') from cash_journal, stamp the row + qbo_post_log, and
//           return { ok, je_id, doc_number, amount, txn_date }. Amount is the row's
//           SERVER-COMPUTED store_revenue — a client can never choose what gets posted.
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
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

// Returns a fresh { access_token, realm_id } or null when not connected / refresh dead.
// Refreshes when within 3 minutes of expiry — and CRITICALLY persists the ROTATED
// refresh token Intuit returns (skip that and the connection dies within 100 days).
async function getToken(): Promise<{ access_token: string; realm_id: string } | null> {
  const { data: tok } = await admin.from("integration_tokens").select("*").eq("provider", PROVIDER).maybeSingle();
  if (!tok || !tok.access_token || !tok.realm_id) return null;
  const exp = tok.expires_at ? new Date(tok.expires_at).getTime() : 0;
  if (Date.now() < exp - 3 * 60 * 1000) return { access_token: tok.access_token, realm_id: String(tok.realm_id) };
  if (!tok.refresh_token) return null;

  const { ok, d } = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token", refresh_token: tok.refresh_token,
  }));
  if (!ok || !d.access_token) return null;
  const expires_at = new Date(Date.now() + (Number(d.expires_in) || 0) * 1000).toISOString();
  // Rotation — Intuit invalidates the old refresh token; if the NEW one is lost
  // the connection silently dies within 100 days. Persist with one retry and
  // scream to the logs if both writes fail.
  const rotated = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || tok.refresh_token,
    expires_at,
    updated_at: new Date().toISOString(),
  };
  let w = await admin.from("integration_tokens").update(rotated).eq("provider", PROVIDER);
  if (w.error) {
    w = await admin.from("integration_tokens").update(rotated).eq("provider", PROVIDER);
    if (w.error) console.error("qbo: FAILED to persist rotated refresh token — connection will die:", w.error.message);
  }
  return { access_token: d.access_token, realm_id: String(tok.realm_id) };
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

// =============================================================================

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
      meta: { scope: d.scope || SCOPE, token_type: d.token_type },
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

  // ---- owner-only from here down ----
  const staff = await getStaff(req);
  if (!staff || staff.role !== "owner") return json({ error: "forbidden", detail: "Owner only." }, 403);

  if (action === "start") {
    if (!CLIENT_ID) return json({ error: "not_configured", detail: "QBO_CLIENT_ID secret is not set." }, 503);
    const state = await makeState(staff.id);
    const u = `${AUTHORIZE}?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
    return json({ url: u });
  }
  if (action === "status") {
    const { data } = await admin.from("integration_tokens")
      .select("realm_id, expires_at, updated_at").eq("provider", PROVIDER).maybeSingle();
    return json({
      connected: !!data, configured: !!CLIENT_ID,
      realm_id: data?.realm_id || null, expires_at: data?.expires_at || null, updated_at: data?.updated_at || null,
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
    const q = "select Id, Name, AccountType, AccountSubType from Account where Active = true maxresults 1000";
    const r = await fetch(`${API_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=${MINORVERSION}`,
      { headers: qboHeaders(tok.access_token) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "qbo_error", detail: faultDetail(d), intuit_tid: tid(r) }, 502);
    const accounts = ((d?.QueryResponse?.Account || []) as Array<Record<string, unknown>>)
      .map((a) => ({ id: String(a.Id), name: (a.Name as string) || "", type: (a.AccountType as string) || null, subtype: (a.AccountSubType as string) || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
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
  if (action === "post_je") {
    return await postJournalEntry(body, staff);
  }
  return json({ error: "bad_action" }, 400);
});
