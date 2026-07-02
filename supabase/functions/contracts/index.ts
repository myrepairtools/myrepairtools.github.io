// Microsoldering contract flow: customer-side signing + Square payment.
//
// The staff tool (micro-contract.html) creates rows in micro_contracts directly
// (authenticated RLS). This function serves the CUSTOMER side, where there is no
// Supabase session — the contract's random token IS the credential (capability URL).
//
// Actions (?action=):
//   view       GET  &t=<token>            -> public-safe contract fields for the signing page
//   sign       POST {t, signed_name, outcome, signature} -> stores the signature, then (if
//              collect > 0) creates a Square payment link and returns pay_url. Sign → pay
//              is one motion: the page jumps straight to the payment.
//   paystatus  GET  &t=<token>            -> checks the Square order; flips status to 'paid'
//   send       POST {t}  (staff JWT)      -> emails the customer their signing link
//
// Square: payment links via /v2/online-checkout/payment-links (quick_pay). Location
// resolved from the contract's store by name-matching /v2/locations (same rule as
// square-tips). Redirect returns the customer to contract-sign.html to confirm.
// Email: Resend (RESEND_API_KEY) with Gmail SMTP fallback — same envs as notify.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SQ_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM") || "onboarding@resend.dev";
const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") || "";
const SITE = "https://myrepairtools.github.io";
const SQ_API = "https://connect.squareup.com/v2/";
const SQ_VERSION = "2025-01-23";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function callerStaff(req: Request): Promise<Record<string, unknown> | null> {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff").select("id, role, display_name")
    .eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s || null;
}

async function byToken(t: string) {
  if (!t || t.length < 20) return null;
  const { data } = await admin.from("micro_contracts").select("*").eq("token", t).maybeSingle();
  return data || null;
}

/* ---------- Square ---------- */
async function sq(method: string, path: string, body?: unknown) {
  const r = await fetch(SQ_API + path, {
    method,
    headers: { Authorization: "Bearer " + SQ_TOKEN, "Square-Version": SQ_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function locationFor(store: string): Promise<string | null> {
  const r = await sq("GET", "locations");
  if (r.status !== 200) return null;
  const keys = store.toLowerCase().split(/\s+/).filter((w: string) => w !== "cpr" && w.length >= 4);
  for (const l of (r.data.locations || [])) {
    if (l.status && l.status !== "ACTIVE") continue;
    const n = String(l.name || "").toLowerCase();
    if (keys.some((k: string) => n.includes(k))) return String(l.id);
  }
  return null;
}
async function makePayLink(c: Record<string, unknown>) {
  const locId = await locationFor(String(c.store));
  if (!locId) return { error: "no_square_location_for_store" };
  const cents = Math.round(Number(c.collect) * 100);
  const body = {
    idempotency_key: "mc-" + c.token + "-" + cents,
    quick_pay: {
      name: "Microsoldering repair" + (c.device ? " — " + c.device : ""),
      price_money: { amount: cents, currency: "USD" },
      location_id: locId,
    },
    checkout_options: {
      redirect_url: SITE + "/contract-sign.html?t=" + c.token + "&ret=1",
      ask_for_shipping_address: false,
    },
    pre_populated_data: c.customer_email ? { buyer_email: c.customer_email } : undefined,
    payment_note: "Contract " + String(c.token).slice(0, 8) + (c.ticket_ref ? " · ticket " + c.ticket_ref : ""),
  };
  const r = await sq("POST", "online-checkout/payment-links", body);
  if (r.status !== 200) return { error: "square_" + r.status, detail: r.data };
  const link = r.data.payment_link || {};
  return { url: String(link.url || ""), order_id: String(link.order_id || "") };
}

/* ---------- email (Resend, Gmail fallback — mirrors notify) ---------- */
function emailHtml(text: string): string {
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2D2D3B;line-height:1.55;white-space:pre-line">' +
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(https:\/\/[^\s]+)/g, '<a href="$1">$1</a>') + "</div>";
}
async function sendEmail(to: string, subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, text, html: emailHtml(text) }),
    });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
    if (!GMAIL_USER) return { ok: false, error: (d && (d.message || d.name)) || `resend_${r.status}` };
  }
  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
      const client = new SMTPClient({
        connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
      });
      await client.send({ from: `CPR Cell Phone Repair <${GMAIL_USER}>`, to, subject, content: text, html: emailHtml(text) });
      await client.close();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "gmail_" + String((e as Error)?.message || e) };
    }
  }
  return { ok: false, error: "no_email_transport" };
}

/* ---------- public-safe view ---------- */
function pub(c: Record<string, unknown>) {
  return {
    status: c.status, store: c.store, customer_name: c.customer_name,
    device: c.device, ticket_ref: c.ticket_ref, scope: c.scope,
    price: c.price, collect: c.collect, terms: c.terms, outcome: c.outcome,
    signed_name: c.signed_name, signed_at: c.signed_at, signature: c.signature,
    paid_at: c.paid_at, paid_amount: c.paid_amount, created_at: c.created_at,
    pay_url: (c.status === "signed" && Number(c.collect) > 0) ? c.square_link_url : null,
  };
}

async function checkPaid(c: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (c.status !== "signed" || !c.square_order_id) return c;
  const r = await sq("GET", "orders/" + c.square_order_id);
  if (r.status !== 200) return c;
  const order = r.data.order || {};
  const tenders = (order.tenders || []) as Record<string, unknown>[];
  let paidCents = 0;
  for (const t of tenders) paidCents += Number((t.amount_money as Record<string, unknown>)?.amount) || 0;
  const wanted = Math.round(Number(c.collect) * 100);
  if (paidCents >= wanted && wanted > 0) {
    const patch = { status: "paid", paid_at: new Date().toISOString(), paid_amount: Math.round(paidCents) / 100, updated_at: new Date().toISOString() };
    await admin.from("micro_contracts").update(patch).eq("id", c.id);
    return { ...c, ...patch };
  }
  return c;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "view";
  try {
    if (action === "view") {
      let c = await byToken(url.searchParams.get("t") || "");
      if (!c) return json({ ok: false, error: "not_found" }, 404);
      c = await checkPaid(c);
      return json({ ok: true, contract: pub(c) });
    }

    if (action === "sign" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const c = await byToken(String(b.t || ""));
      if (!c) return json({ ok: false, error: "not_found" }, 404);
      if (c.status !== "draft" && c.status !== "sent") return json({ ok: false, error: "already_" + c.status }, 409);
      const signedName = String(b.signed_name || "").trim();
      const outcome = String(b.outcome || "").trim();
      const signature = String(b.signature || "");
      if (!signedName || signedName.length < 2) return json({ ok: false, error: "name_required" }, 400);
      if (!outcome) return json({ ok: false, error: "outcome_required" }, 400);
      if (!signature.startsWith("data:image/png;base64,") || signature.length < 1000 || signature.length > 400000)
        return json({ ok: false, error: "signature_required" }, 400);
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
      const patch: Record<string, unknown> = {
        status: "signed", outcome, signature, signed_name: signedName,
        signed_at: new Date().toISOString(), signed_ip: ip,
        signed_ua: (req.headers.get("user-agent") || "").slice(0, 300),
        updated_at: new Date().toISOString(),
      };
      let payUrl: string | null = null, payErr: string | null = null;
      if (Number(c.collect) > 0) {
        const pl = await makePayLink(c);
        if (pl.url) { patch.square_link_url = pl.url; patch.square_order_id = pl.order_id; payUrl = pl.url; }
        else payErr = pl.error || "pay_link_failed";
      }
      const { error } = await admin.from("micro_contracts").update(patch).eq("id", c.id).eq("status", c.status);
      if (error) return json({ ok: false, error: "db_" + error.message }, 500);
      return json({ ok: true, pay_url: payUrl, pay_error: payErr });
    }

    if (action === "paystatus") {
      let c = await byToken(url.searchParams.get("t") || "");
      if (!c) return json({ ok: false, error: "not_found" }, 404);
      c = await checkPaid(c);
      return json({ ok: true, status: c.status, paid_at: c.paid_at, paid_amount: c.paid_amount });
    }

    if (action === "send" && req.method === "POST") {
      const staff = await callerStaff(req);
      if (!staff) return json({ ok: false, error: "unauthorized" }, 401);
      const b = await req.json().catch(() => ({}));
      const c = await byToken(String(b.t || ""));
      if (!c) return json({ ok: false, error: "not_found" }, 404);
      if (!c.customer_email) return json({ ok: false, error: "no_customer_email" }, 400);
      if (c.status === "void") return json({ ok: false, error: "void" }, 409);
      const link = SITE + "/contract-sign.html?t=" + c.token;
      const txt = "Hi " + c.customer_name + ",\n\n"
        + "Here is your microsoldering repair agreement from CPR Cell Phone Repair"
        + (c.store ? " (" + c.store + ")" : "") + (c.device ? " for your " + c.device : "") + ".\n\n"
        + "Review and sign here:\n" + link + "\n\n"
        + (Number(c.collect) > 0 ? "Payment of $" + Number(c.collect).toFixed(2) + " is collected right after signing, on the same page.\n\n" : "")
        + "Questions? Just reply to this email or call the store.\n\n— CPR Cell Phone Repair";
      const r = await sendEmail(String(c.customer_email), "Your CPR repair agreement — review & sign", txt);
      if (!r.ok) return json({ ok: false, error: r.error }, 500);
      await admin.from("micro_contracts").update({
        status: c.status === "draft" ? "sent" : c.status,
        sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", c.id);
      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
