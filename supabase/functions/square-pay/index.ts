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

async function logRow(row: Record<string, unknown>) {
  const { data } = await admin.from("square_payments").insert(row).select("id").single();
  return data?.id ?? null;
}
async function updRow(id: number, patch: Record<string, unknown>) {
  await admin.from("square_payments").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

async function actionTerminalCreate(payload: any, takenBy: string) {
  const store = String(payload?.store || "");
  const amount = cents(payload?.amount_cents);
  const deviceId = String(payload?.device_id || "");
  if (!store || !amount) return json({ ok: false, error: "store and amount (min $1) required" }, 400);
  if (!deviceId) return json({ ok: false, error: "device_id required" }, 400);
  const ticket = String(payload?.ticket_no || "").trim() || null;
  const note = String(payload?.note || "").trim() || null;

  const rowId = await logRow({
    store, mode: "terminal", amount_cents: amount, ticket_no: ticket, note,
    taken_by: takenBy || null, device_id: deviceId, device_name: payload?.device_name || null, status: "pending",
  });

  const r = await sq("POST", "terminals/checkouts", {
    idempotency_key: "mrt-vt-" + rowId + "-" + amount,
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

async function actionTerminalStatus(payload: any) {
  const id = Number(payload?.id);
  const { data: row } = await admin.from("square_payments").select("*").eq("id", id).maybeSingle();
  if (!row?.square_checkout_id) return json({ ok: false, error: "unknown payment" }, 404);
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

async function actionTerminalCancel(payload: any) {
  const id = Number(payload?.id);
  const { data: row } = await admin.from("square_payments").select("*").eq("id", id).maybeSingle();
  if (!row?.square_checkout_id) return json({ ok: false, error: "unknown payment" }, 404);
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

  const rowId = await logRow({
    store, mode: "link", amount_cents: amount, ticket_no: ticket, note,
    customer_name: payload?.customer_name || null, customer_phone: payload?.customer_phone || null,
    customer_email: payload?.customer_email || null, taken_by: takenBy || null, status: "pending",
  });

  const r = await sq("POST", "online-checkout/payment-links", {
    idempotency_key: "mrt-vl-" + rowId + "-" + amount,
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

async function actionLinkStatus(payload: any) {
  const id = Number(payload?.id);
  const { data: row } = await admin.from("square_payments").select("*").eq("id", id).maybeSingle();
  if (!row?.square_order_id) return json({ ok: false, error: "unknown payment" }, 404);
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
        action: "send", secret: NOTIFY_SECRET, kind: "system",
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

  const rowId = await logRow({
    store, mode: "keyed", amount_cents: amount, ticket_no: ticket, note,
    customer_name: payload?.customer_name || null, customer_email: payload?.customer_email || null,
    taken_by: takenBy || null, status: "pending",
  });

  const r = await sq("POST", "payments", {
    idempotency_key: "mrt-vk-" + rowId + "-" + amount,
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

async function actionRecent(payload: any) {
  let q = admin.from("square_payments").select("*").order("id", { ascending: false }).limit(20);
  if (payload?.store) q = q.eq("store", payload.store);
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

  // resolve the signed-in staff member (audit trail); anonymous calls refused
  let takenBy = "";
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const { data } = await admin.auth.getUser(authHeader.slice(7));
      if (data?.user) {
        const { data: staff } = await admin.from("staff").select("display_name").eq("auth_uid", data.user.id).maybeSingle();
        takenBy = staff?.display_name || data.user.email || "";
      }
    } catch { /* not signed in */ }
  }
  if (!takenBy && payload?.action !== "config") {
    return json({ ok: false, error: "Sign in from the Dashboard first" }, 401);
  }

  try {
    if (!SQ_TOKEN) return json({ ok: false, error: "SQUARE_ACCESS_TOKEN not set" }, 500);
    if (payload?.action === "config") return json({ ok: true, keyed_ready: !!SQ_APP_ID, app_id: SQ_APP_ID || null });
    if (payload?.action === "devices") return await actionDevices(payload);
    if (payload?.action === "terminal_create") return await actionTerminalCreate(payload, takenBy);
    if (payload?.action === "terminal_status") return await actionTerminalStatus(payload);
    if (payload?.action === "terminal_cancel") return await actionTerminalCancel(payload);
    if (payload?.action === "link_create") return await actionLinkCreate(payload, takenBy);
    if (payload?.action === "link_status") return await actionLinkStatus(payload);
    if (payload?.action === "keyed_charge") return await actionKeyedCharge(payload, takenBy);
    if (payload?.action === "recent") return await actionRecent(payload);
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
