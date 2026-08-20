/*
    square-pay — MRT virtual terminal (backup register)

    The Square-logo pop-down in the site's top rail drives this. Three modes:
      terminal  — push a checkout to the store's Square Terminal (the wedge):
                  card-present rates; the customer taps at the counter.
      link      — create a quick-pay payment link (the panel texts it to the
                  customer from the store's RingCentral line via `messaging`).
      keyed     — charge a manually entered card (Web Payments SDK token from
                  the browser). Needs SQUARE_APP_ID set before the panel
                  enables the tab; the server side is live either way.

    Every attempt is written to square_payments (audit trail; the panel's
    Recent list reads it). Square credentials stay server-side.

    Actions (POST JSON { action, ... }, user JWT for the audit trail):
      config           → { keyed_ready, app_id? }         panel bootstrap
      devices          → { store } → paired terminals at that store
      terminal_create  → { store, amount_cents, device_id, ticket_no?, note? }
      terminal_status  → { id } (square_payments id) → live checkout status
      terminal_cancel  → { id }
      link_create      → { store, amount_cents, name?, ticket_no?, note?, email? }
      keyed_charge     → { store, amount_cents, source_id, ticket_no?, note?, ... }
      recent           → { store? } → last 20 payments

    Secrets: SQUARE_ACCESS_TOKEN (shared with square-tips/contracts),
    SQUARE_APP_ID (only for keyed mode), SUPABASE_URL / SERVICE_ROLE_KEY.
*/

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SQ_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN") || "";
const SQ_APP_ID = Deno.env.get("SQUARE_APP_ID") || "";
const SQ_API = "https://connect.squareup.com/v2/";
const SQ_VERSION = "2024-06-04";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sq(method: string, path: string, body?: unknown) {
  const r = await fetch(SQ_API + path, {
    method,
    headers: { Authorization: "Bearer " + SQ_TOKEN, "Square-Version": SQ_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// store -> Square location, same fuzzy name-match the other functions use
async function locationFor(store: string): Promise<string | null> {
  const r = await sq("GET", "locations");
  if (r.status !== 200) return null;
  const keys = store.toLowerCase().split(/\s+/).filter((w) => w !== "cpr" && w.length >= 4);
  for (const l of (r.data.locations || [])) {
    if (l.status && l.status !== "ACTIVE") continue;
    const n = String(l.name || "").toLowerCase();
    if (keys.some((k) => n.includes(k))) return String(l.id);
  }
  return null;
}

const cents = (v: unknown) => { const n = Math.round(Number(v)); return (isFinite(n) && n >= 100 && n <= 2_000_000) ? n : 0; };

/* ---------------- actions ---------------- */

async function actionDevices(payload: any) {
  const store = String(payload?.store || "");
  const locId = await locationFor(store);
  if (!locId) return json({ ok: false, error: "No Square location matched '" + store + "'" }, 400);
  // paired device codes are the canonical source of terminal device_ids
  const r = await sq("GET", "devices/codes?status=PAIRED&product_type=TERMINAL_API&location_id=" + encodeURIComponent(locId));
  let devices = (r.status === 200 ? (r.data.device_codes || []) : [])
    .filter((d: any) => d.device_id)
    .map((d: any) => ({ device_id: d.device_id, name: d.name || "Square Terminal" }));
  if (!devices.length) {
    // fall back to the Devices API (terminals paired through other flows)
    const r2 = await sq("GET", "devices?location_id=" + encodeURIComponent(locId));
    devices = (r2.status === 200 ? (r2.data.devices || []) : [])
      .filter((d: any) => /terminal/i.test(String(d?.attributes?.model || "")) || /terminal/i.test(String(d?.attributes?.type || "")))
      .map((d: any) => ({ device_id: String(d.id).replace(/^device:/, ""), name: d?.attributes?.name || d?.attributes?.model || "Square Terminal" }));
  }
  return json({ ok: true, store, location_id: locId, devices });
}

// NOTE: the old logRow() lived here. It discarded the insert error and returned
// `data?.id ?? null`, which is what let a failed insert fall through to Square
// with a null row id -- and, with no client op id, an idempotency key of
// "mrt-vt-null-<amount>" that could collide across unrelated customers paying
// the same amount. Replaced by reserveRow() below, which inspects the error and
// refuses to call Square unless it owns a row. Do not reintroduce it.
async function updRow(id: number, patch: Record<string, unknown>) {
  await admin.from("square_payments").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

/* ---------------- caller identity and authorization ----------------
   This function runs under the service role, so RLS does NOT apply to
   anything it does. Every scope check therefore has to be made here,
   explicitly. Before this, authorization was `if (!takenBy) return 401` --
   any signed-in person at all, including `candidate`, a role scoped to
   schedule.view and nothing else, could push a charge to any store's
   terminal or key a card in directly.                                  */

// Roles are bilingual during the cutover, exactly as is_admin() has it.
function roleKey(role: string) {
  return role === "manager" ? "admin" : role === "employee" ? "team_member" : role;
}

async function resolveCaller(req: Request) {
  const h = req.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  let uid = "";
  try { const { data } = await admin.auth.getUser(h.slice(7)); uid = data?.user?.id || ""; }
  catch { return null; }
  if (!uid) return null;
  const { data: staff } = await admin.from("staff")
    .select("id, display_name, role, home_store, authorized_stores, active")
    .eq("auth_uid", uid).maybeSingle();
  if (!staff || !staff.active) return null;   // fail CLOSED: no row, or deactivated
  return staff as any;
}

// Reads the same catalog Settings > Roles & Permissions edits, so the answer
// tracks the permission model instead of a second one hard-coded here.
// The error is inspected deliberately: if the embedded-resource filter ever
// stops constraining (a renamed FK, an ambiguous relationship), we must fail
// CLOSED rather than treat a non-empty result as a grant.
async function roleHasPerm(role: string, key: string) {
  if (roleKey(role) === "owner") return true;             // owner short-circuits, like has_perm()
  const { data, error } = await admin.from("role_permissions")
    .select("permission_id, permissions!inner(key), roles!inner(key)")
    .eq("permissions.key", key).eq("roles.key", roleKey(role)).limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length === 1;
}

// Charging is scoped to the caller's own stores -- the same scope the UI
// already applies when it builds the store picker (assets/square-pay.js:65-68).
// Compared case-insensitively rather than through norm_store(): both sides hold
// canonical names ('CPR Eugene'), and a SQL round trip per request is not worth
// it. If a RepairQ spelling ever reaches this payload, extend this to an rpc.
const normStore = (s: unknown) => String(s || "").trim().toLowerCase();

function callerAtStore(staff: any, store: string) {
  if (roleKey(staff.role) === "owner") return true;
  if (normStore(staff.home_store) === normStore(store)) return true;
  const list = Array.isArray(staff.authorized_stores) ? staff.authorized_stores : [];
  return list.some((s: unknown) => normStore(s) === normStore(store));
}
function storesFor(staff: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: unknown) => {
    const v = String(s || "").trim();
    if (v && !seen.has(normStore(v))) { seen.add(normStore(v)); out.push(v); }
  };
  add(staff.home_store);
  (Array.isArray(staff.authorized_stores) ? staff.authorized_stores : []).forEach(add);
  return out;
}

/* ---------------- one intent, one charge ----------------
   client_op_id is generated by the browser ONCE per user intent and reused
   across retries of that intent, so a double tap collides instead of charging
   twice. Three rules make that safe, and all three matter:

   1. RESERVE, don't just insert. The insert result's ERROR is inspected. A
      23505 means someone else already owns this intent -- we re-read their row
      and return it. Any other insert error aborts BEFORE Square is called: this
      code must never charge a card it cannot record.
   2. Never build an idempotency key from a failed insert. The previous shape
      ("mrt-vt-" + rowId) silently became "mrt-vt-null-<amount>" when the insert
      failed, which would COLLIDE at Square across unrelated customers paying
      the same amount. Worse than the bug it replaced.
   3. A duplicate must match the intent. client_op_id is globally unique, so
      matching on it alone would let a caller pass the store gate with their own
      store and then hand back a DIFFERENT store's payment link or checkout id.
      Store, mode and amount are compared before anything is returned as a
      duplicate; a mismatch is a conflict, never a success.                   */

function sameIntent(row: any, store: string, mode: string, amount: number) {
  return normStore(row?.store) === normStore(store)
      && String(row?.mode || "") === mode
      && Number(row?.amount_cents) === Number(amount);
}

type Reservation =
  | { kind: "owned"; rowId: number }
  | { kind: "duplicate"; row: any }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

async function reserveRow(row: Record<string, unknown>, opId: string | null,
                          store: string, mode: string, amount: number): Promise<Reservation> {
  if (opId) {                                   // fast path: already recorded?
    const { data: prior } = await admin.from("square_payments")
      .select("*").eq("client_op_id", opId).maybeSingle();
    if (prior) {
      return sameIntent(prior, store, mode, amount)
        ? { kind: "duplicate", row: prior }
        : { kind: "conflict" };
    }
  }
  const { data, error } = await admin.from("square_payments")
    .insert({ ...row, client_op_id: opId }).select("id").single();
  if (!error && data?.id) return { kind: "owned", rowId: Number(data.id) };

  if (error && (error as any).code === "23505" && opId) {
    // Lost the race. The winner owns the Square call; return what they got.
    const { data: winner } = await admin.from("square_payments")
      .select("*").eq("client_op_id", opId).maybeSingle();
    if (winner) {
      return sameIntent(winner, store, mode, amount)
        ? { kind: "duplicate", row: winner }
        : { kind: "conflict" };
    }
  }
  // Anything else: refuse. Do NOT fall through to Square with a null row id.
  return { kind: "error", message: (error as any)?.message || "could not record the payment attempt" };
}

async function actionTerminalCreate(payload: any, takenBy: string) {
  const store = String(payload?.store || "");
  const amount = cents(payload?.amount_cents);
  const deviceId = String(payload?.device_id || "");
  if (!store || !amount) return json({ ok: false, error: "store and amount (min $1) required" }, 400);
  if (!deviceId) return json({ ok: false, error: "device_id required" }, 400);
  const ticket = String(payload?.ticket_no || "").trim() || null;
  const note = String(payload?.note || "").trim() || null;

  // The store gate at the entry point checks `payload.store` -- but the DEVICE
  // is what actually receives the charge, and it arrives from the client too.
  // Without this, a tech at store A passes the gate with their own store and
  // then pushes the charge to store B's terminal. Bind the device to the
  // authorized store's Square location before charging anything.
  const locId = await locationFor(store);
  if (!locId) return json({ ok: false, error: "No Square location matched '" + store + "'" }, 400);
  const dev = await sq("GET", "devices/codes?status=PAIRED&product_type=TERMINAL_API&location_id=" + encodeURIComponent(locId));
  const paired = (dev.status === 200 ? (dev.data?.device_codes || []) : [])
    .map((d: any) => String(d.device_id || "")).filter(Boolean);
  if (paired.indexOf(deviceId) < 0) {
    return json({ ok: false, error: "That terminal is not paired with " + store + "." }, 403);
  }

  // One intent, one charge. See the block comment on reserveRow().
  const opId = String(payload?.client_op_id || "").trim() || null;
  const res = await reserveRow({
    store, mode: "terminal", amount_cents: amount, ticket_no: ticket, note,
    taken_by: takenBy || null, device_id: deviceId, device_name: payload?.device_name || null, status: "pending",
  }, opId, store, "terminal", amount);
  if (res.kind === "conflict") return json({ ok: false, error: "That payment reference is already in use for a different charge." }, 409);
  if (res.kind === "error")    return json({ ok: false, error: res.message }, 500);
  if (res.kind === "duplicate") {
    return json({ ok: true, id: res.row.id, checkout_id: res.row.square_checkout_id, status: res.row.status, deduped: true });
  }
  const rowId = res.rowId;

  const r = await sq("POST", "terminals/checkouts", {
    // Keyed on the CLIENT's op id when present. This used to key on rowId --
    // a NEW row per attempt -- so every tap minted a fresh idempotency key and
    // Square saw an unrelated payment, which is exactly what the key exists to
    // prevent. The rowId fallback only runs when an older cached
    // assets/square-pay.js sends no op id, and rowId is now guaranteed non-null
    // because reserveRow refuses to reach this line without owning a row.
    idempotency_key: opId ? ("mrt-vt-" + opId) : ("mrt-vt-" + rowId + "-" + amount),
    checkout: {
      amount_money: { amount, currency: "USD" },
      device_options: { device_id: deviceId, skip_receipt_screen: false },
      reference_id: ticket ? ("Ticket " + ticket) : ("MRT-" + rowId),
      note: note || undefined,
      deadline_duration: "PT10M",   // give the counter 10 minutes before it times out
    },
  });
  const co = r.data?.checkout;
  if (r.status !== 200 || !co?.id) {
    const err = r.data?.errors?.[0]?.detail || r.data?.errors?.[0]?.code || ("HTTP " + r.status);
    if (rowId) await updRow(rowId, { status: "failed", error: err });
    return json({ ok: false, error: err, detail: r.data?.errors }, 502);
  }
  if (rowId) await updRow(rowId, { square_checkout_id: co.id, status: String(co.status || "PENDING").toLowerCase() });
  return json({ ok: true, id: rowId, checkout_id: co.id, status: co.status });
}

async function actionTerminalStatus(payload: any, caller: any) {
  const id = Number(payload?.id);
  const { data: row } = await admin.from("square_payments").select("*").eq("id", id).maybeSingle();
  if (!row?.square_checkout_id) return json({ ok: false, error: "unknown payment" }, 404);
  // Row-level scope check. `id` is a small sequential integer, so without this
  // any signed-in person can enumerate payments and read another store's
  // in-flight checkout. The entry-point gate cannot cover this: the store is
  // not in the payload, it is on the row. 404 rather than 403 so the response
  // does not confirm that the row exists.
  if (caller && !callerAtStore(caller, row.store)) return json({ ok: false, error: "unknown payment" }, 404);
  const r = await sq("GET", "terminals/checkouts/" + row.square_checkout_id);
  const co = r.data?.checkout;
  if (r.status !== 200 || !co) return json({ ok: false, error: "HTTP " + r.status }, 502);
  const status = String(co.status || "").toLowerCase();   // pending | in_progress | completed | canceled | cancel_requested
  const patch: Record<string, unknown> = { status };
  if (co.payment_ids?.length) patch.square_payment_id = co.payment_ids[0];
  if (co.cancel_reason) patch.error = co.cancel_reason;
  await updRow(id, patch);
  return json({ ok: true, id, status, cancel_reason: co.cancel_reason || null, payment_ids: co.payment_ids || [] });
}

async function actionTerminalCancel(payload: any, caller: any) {
  const id = Number(payload?.id);
  const { data: row } = await admin.from("square_payments").select("*").eq("id", id).maybeSingle();
  if (!row?.square_checkout_id) return json({ ok: false, error: "unknown payment" }, 404);
  // The sharpest of the three: without this, any signed-in person -- a
  // `candidate` included -- can cancel another store's in-flight checkout at
  // the counter, mid-transaction, by guessing a sequential id.
  if (caller && !callerAtStore(caller, row.store)) return json({ ok: false, error: "unknown payment" }, 404);
  const r = await sq("POST", "terminals/checkouts/" + row.square_checkout_id + "/cancel");
  if (r.status !== 200) return json({ ok: false, error: r.data?.errors?.[0]?.detail || ("HTTP " + r.status) }, 502);
  await updRow(id, { status: "canceled", error: "canceled from MRT" });
  return json({ ok: true, id, status: "canceled" });
}

async function actionLinkCreate(payload: any, takenBy: string) {
  const store = String(payload?.store || "");
  const amount = cents(payload?.amount_cents);
  if (!store || !amount) return json({ ok: false, error: "store and amount (min $1) required" }, 400);
  const locId = await locationFor(store);
  if (!locId) return json({ ok: false, error: "No Square location matched '" + store + "'" }, 400);
  const ticket = String(payload?.ticket_no || "").trim() || null;
  const note = String(payload?.note || "").trim() || null;
  const name = String(payload?.name || "").trim() || ("CPR repair" + (ticket ? " — ticket " + ticket : ""));

  const opId = String(payload?.client_op_id || "").trim() || null;
  const res = await reserveRow({
    store, mode: "link", amount_cents: amount, ticket_no: ticket, note,
    customer_name: payload?.customer_name || null, customer_phone: payload?.customer_phone || null,
    customer_email: payload?.customer_email || null, taken_by: takenBy || null, status: "pending",
  }, opId, store, "link", amount);
  if (res.kind === "conflict") return json({ ok: false, error: "That payment reference is already in use for a different charge." }, 409);
  if (res.kind === "error")    return json({ ok: false, error: res.message }, 500);
  if (res.kind === "duplicate") {
    return json({ ok: true, id: res.row.id, url: res.row.payment_link_url, order_id: res.row.square_order_id, deduped: true });
  }
  const rowId = res.rowId;

  const r = await sq("POST", "online-checkout/payment-links", {
    idempotency_key: opId ? ("mrt-vl-" + opId) : ("mrt-vl-" + rowId + "-" + amount),
    quick_pay: { name, price_money: { amount, currency: "USD" }, location_id: locId },
    checkout_options: { ask_for_shipping_address: false },
    pre_populated_data: payload?.customer_email ? { buyer_email: payload.customer_email } : undefined,
    payment_note: (ticket ? "Ticket " + ticket : "MRT-" + rowId) + (note ? " · " + note : ""),
  });
  const link = r.data?.payment_link;
  if (r.status !== 200 || !link?.url) {
    const err = r.data?.errors?.[0]?.detail || ("HTTP " + r.status);
    if (rowId) await updRow(rowId, { status: "failed", error: err });
    return json({ ok: false, error: err }, 502);
  }
  if (rowId) await updRow(rowId, { payment_link_url: link.url, square_order_id: link.order_id || null, status: "sent" });
  return json({ ok: true, id: rowId, url: link.url, order_id: link.order_id || null });
}

async function actionLinkStatus(payload: any, caller: any) {
  const id = Number(payload?.id);
  const { data: row } = await admin.from("square_payments").select("*").eq("id", id).maybeSingle();
  if (!row?.square_order_id) return json({ ok: false, error: "unknown payment" }, 404);
  if (caller && !callerAtStore(caller, row.store)) return json({ ok: false, error: "unknown payment" }, 404);
  const r = await sq("GET", "orders/" + row.square_order_id);
  const state = String(r.data?.order?.state || "").toLowerCase();
  const tenders = r.data?.order?.tenders || [];
  const paid = state === "completed" || tenders.length > 0;
  if (paid && row.status !== "completed") await updRow(id, { status: "completed", square_payment_id: tenders[0]?.payment_id || null });
  return json({ ok: true, id, paid, state });
}

/* sweep_pending — the cron's job. The panel polls only while it is open, so a
   link paid after the tech closes it would sit at 'sent' forever. This asks
   Square about every still-open payment from the last 3 days and, when one has
   been paid, stamps the row and tells the tech who took it plus that store's
   managers. Alerts are best-effort: a notification failure must never stop the
   row from being marked paid. */
async function actionSweepPending() {
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows } = await admin.from("square_payments")
    .select("id, store, mode, amount_cents, ticket_no, customer_name, taken_by, square_order_id, status")
    .in("status", ["sent", "pending"])
    .not("square_order_id", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(50);
  const checked: any[] = [];
  for (const row of (rows || [])) {
    let paid = false, state = "";
    try {
      const r = await sq("GET", "orders/" + row.square_order_id);
      state = String(r.data?.order?.state || "").toLowerCase();
      const tenders = r.data?.order?.tenders || [];
      paid = state === "completed" || tenders.length > 0;
      if (paid) {
        await updRow(row.id, { status: "completed", square_payment_id: tenders[0]?.payment_id || null });
        await notifyPaid(row);
      }
    } catch (e) {
      state = "error: " + String((e as Error)?.message || e);
    }
    checked.push({ id: row.id, paid, state });
  }
  return json({ ok: true, checked: checked.length, paid: checked.filter((c) => c.paid).length, detail: checked });
}

/* who hears about it: the tech who took the payment + the managers over that
   store (home store or authorized there) */
async function notifyPaid(row: any) {
  try {
    const ids = new Set<number>();
    if (row.taken_by) {
      const { data: tech } = await admin.from("staff")
        .select("id").eq("display_name", row.taken_by).eq("active", true).maybeSingle();
      if (tech?.id) ids.add(Number(tech.id));
    }
    const { data: mgrs } = await admin.from("staff")
      .select("id, home_store, authorized_stores, role").eq("active", true).in("role", ["admin", "owner"]);
    for (const m of (mgrs || [])) {
      const auth = Array.isArray(m.authorized_stores) ? m.authorized_stores : [];
      if (m.home_store === row.store || auth.indexOf(row.store) > -1) ids.add(Number(m.id));
    }
    if (!ids.size) return;
    const amount = "$" + (Number(row.amount_cents || 0) / 100).toFixed(2);
    const who = row.customer_name ? (" from " + row.customer_name) : "";
    const tkt = row.ticket_no ? (" · ticket " + String(row.ticket_no).replace(/^#0*/, "")) : "";
    await fetch(SB_URL + "/functions/v1/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE },
      body: JSON.stringify({
        action: "send", secret: NOTIFY_SECRET, kind: "payment",
        title: "Square payment received — " + amount,
        body: amount + who + tkt + " (" + row.store + ") has been paid.",
        link: "index.html", icon: "banknote",
        staff_ids: Array.from(ids),
      }),
    });
  } catch (e) { /* the payment is recorded either way */ }
}

async function actionKeyedCharge(payload: any, takenBy: string) {
  const store = String(payload?.store || "");
  const amount = cents(payload?.amount_cents);
  const source = String(payload?.source_id || "");
  if (!store || !amount || !source) return json({ ok: false, error: "store, amount and card token required" }, 400);
  const locId = await locationFor(store);
  if (!locId) return json({ ok: false, error: "No Square location matched '" + store + "'" }, 400);
  const ticket = String(payload?.ticket_no || "").trim() || null;
  const note = String(payload?.note || "").trim() || null;

  // The card-not-present path -- the one where a double tap is a real second
  // charge on a real card, with no terminal screen for the customer to notice it.
  const opId = String(payload?.client_op_id || "").trim() || null;
  const res = await reserveRow({
    store, mode: "keyed", amount_cents: amount, ticket_no: ticket, note,
    customer_name: payload?.customer_name || null, customer_email: payload?.customer_email || null,
    taken_by: takenBy || null, status: "pending",
  }, opId, store, "keyed", amount);
  if (res.kind === "conflict") return json({ ok: false, error: "That payment reference is already in use for a different charge." }, 409);
  if (res.kind === "error")    return json({ ok: false, error: res.message }, 500);
  if (res.kind === "duplicate") {
    return json({ ok: true, id: res.row.id, payment_id: res.row.square_payment_id, status: res.row.status, deduped: true });
  }
  const rowId = res.rowId;

  const r = await sq("POST", "payments", {
    idempotency_key: opId ? ("mrt-vk-" + opId) : ("mrt-vk-" + rowId + "-" + amount),
    source_id: source,
    amount_money: { amount, currency: "USD" },
    location_id: locId,
    reference_id: ticket ? ("Ticket " + ticket) : ("MRT-" + rowId),
    note: note || undefined,
    buyer_email_address: payload?.customer_email || undefined,
  });
  const p = r.data?.payment;
  if (r.status !== 200 || !p?.id) {
    const err = r.data?.errors?.[0]?.detail || r.data?.errors?.[0]?.code || ("HTTP " + r.status);
    if (rowId) await updRow(rowId, { status: "failed", error: err });
    return json({ ok: false, error: err }, 502);
  }
  await updRow(rowId!, { square_payment_id: p.id, status: String(p.status || "completed").toLowerCase() });
  return json({ ok: true, id: rowId, payment_id: p.id, status: p.status, receipt_url: p.receipt_url || null });
}

async function actionRecent(payload: any, caller: any) {
  let q = admin.from("square_payments").select("*").order("id", { ascending: false }).limit(20);
  if (payload?.store) {
    q = q.eq("store", payload.store);       // already checked against the caller's stores above
  } else if (caller && roleKey(caller.role) !== "owner") {
    // No store asked for used to mean EVERY store -- customer names, phones and
    // emails for all three, to anyone signed in. Scope it to the caller's own.
    q = q.in("store", storesFor(caller));
  }
  const { data } = await q;
  return json({ ok: true, rows: data || [] });
}

/* ---------------- entry ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let payload: any = {};
  try { payload = await req.json(); } catch { /* empty */ }

  // the cron sweep authenticates by secret, not by a signed-in tech
  if (payload?.action === "sweep_pending") {
    if (!NOTIFY_SECRET || String(payload?.secret || "") !== NOTIFY_SECRET) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    if (!SQ_TOKEN) return json({ ok: false, error: "SQUARE_ACCESS_TOKEN not set" }, 500);
    try { return await actionSweepPending(); }
    catch (e) { return json({ ok: false, error: String((e as Error)?.message || e) }, 502); }
  }

  // Resolve the signed-in staff member: identity for the audit trail, and role
  // plus stores for authorization. Anonymous calls refused.
  const caller = await resolveCaller(req);
  const takenBy = caller ? (caller.display_name || "") : "";
  if (!caller && payload?.action !== "config") {
    return json({ ok: false, error: "Sign in from the Dashboard first" }, 401);
  }

  if (caller) {
    const act = String(payload?.action || "");
    // Anything that moves money needs the permission AND membership of the
    // store being charged. A signed-in session is not authorization: `candidate`
    // holds one and has no business putting a card through.
    if (act === "terminal_create" || act === "link_create" || act === "keyed_charge") {
      if (!(await roleHasPerm(caller.role, "payments.take"))) {
        return json({ ok: false, error: "You do not have permission to take payments." }, 403);
      }
      const store = String(payload?.store || "");
      if (!store || !callerAtStore(caller, store)) {
        return json({ ok: false, error: "You cannot take a payment for that store." }, 403);
      }
    }
    // Reads are scoped too. These run under the service role, so the RLS on
    // square_payments (is_admin(norm_store(store))) does NOT protect them --
    // without this check the function is a way around its own table policy.
    if (act === "devices" || act === "recent") {
      const store = String(payload?.store || "");
      if (store && !callerAtStore(caller, store)) {
        return json({ ok: false, error: "You cannot view that store." }, 403);
      }
    }
  }

  try {
    if (!SQ_TOKEN) return json({ ok: false, error: "SQUARE_ACCESS_TOKEN not set" }, 500);
    if (payload?.action === "config") return json({ ok: true, keyed_ready: !!SQ_APP_ID, app_id: SQ_APP_ID || null });
    if (payload?.action === "devices") return await actionDevices(payload);
    if (payload?.action === "terminal_create") return await actionTerminalCreate(payload, takenBy);
    if (payload?.action === "terminal_status") return await actionTerminalStatus(payload, caller);
    if (payload?.action === "terminal_cancel") return await actionTerminalCancel(payload, caller);
    if (payload?.action === "link_create") return await actionLinkCreate(payload, takenBy);
    if (payload?.action === "link_status") return await actionLinkStatus(payload, caller);
    if (payload?.action === "keyed_charge") return await actionKeyedCharge(payload, takenBy);
    if (payload?.action === "recent") return await actionRecent(payload, caller);
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
