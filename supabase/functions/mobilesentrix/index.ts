// =============================================================================
// mobilesentrix — the cpr.parts (Magento) API seam. READ-ONLY today: mirrors
// each store's orders into ms_orders hourly. Deliberately does NOT touch QBO —
// the owner wants to drive any book-keeping automation by hand.
//
//   POST { action:'sync', secret }   (NOTIFY_SECRET — cron)  -> pull recent
//        orders for every connected store (integration_tokens 'ms:<store>'),
//        upsert into ms_orders. Incremental on Magento updated_at with a
//        3-day overlap; first run backfills 60 days.
//   GET  ?action=sync                (admin/owner JWT) -> same, manual kick.
//
// Auth to cpr.parts: OAuth 1.0a PLAINTEXT (per MS docs) — consumer creds are
// the MS_CONSUMER_KEY / MS_CONSUMER_SECRET function secrets; per-store access
// tokens live in integration_tokens (meta.access_token_secret). Tokens are
// long-lived; a 401 for a store is reported so Settings can show Reconnect.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_KEY = Deno.env.get("MS_CONSUMER_KEY") || "";
const MS_SECRET = Deno.env.get("MS_CONSUMER_SECRET") || "";
const MS_BASE = (Deno.env.get("MS_BASE_URL") || "https://www.cpr.parts").replace(/\/+$/, "");
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function oauthHeader(token: string, tokenSecret: string) {
  return "OAuth " + [
    `oauth_consumer_key="${encodeURIComponent(MS_KEY)}"`,
    `oauth_token="${encodeURIComponent(token)}"`,
    `oauth_signature_method="PLAINTEXT"`,
    `oauth_signature="${encodeURIComponent(MS_SECRET)}%26${encodeURIComponent(tokenSecret)}"`,
    `oauth_timestamp="${Math.floor(Date.now() / 1000)}"`,
    `oauth_nonce="${crypto.randomUUID().replace(/-/g, "")}"`,
    `oauth_version="1.0"`,
  ].join(", ");
}

async function getStaff(req: Request) {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff")
    .select("id, display_name, role, active").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s || null;
}

// Magento datetimes are naive UTC ("2026-07-22 14:08:55").
const utc = (s: unknown) => (typeof s === "string" && s.trim()) ? s.trim().replace(" ", "T") + "Z" : null;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function syncStore(store: string, token: string, tokenSecret: string) {
  // Incremental watermark: newest updated_at we already hold, minus 3 days of
  // overlap (status flips re-touch updated_at). First run: 60 days back.
  const { data: wm } = await admin.from("ms_orders").select("updated_at")
    .eq("store", store).order("updated_at", { ascending: false }).limit(1);
  const since = wm?.[0]?.updated_at
    ? new Date(new Date(wm[0].updated_at).getTime() - 3 * 24 * 3600 * 1000)
    : new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const sinceStr = since.toISOString().slice(0, 19).replace("T", " ");

  let upserted = 0;
  for (let page = 1; page <= 10; page++) {
    const qs = `limit=100&page=${page}` +
      `&filter%5B1%5D%5Battribute%5D=updated_at&filter%5B1%5D%5Bgt%5D=${encodeURIComponent(sinceStr)}` +
      `&order=updated_at&dir=asc`;
    const r = await fetch(`${MS_BASE}/api/rest/orders?${qs}`, {
      headers: { Authorization: oauthHeader(token, tokenSecret), Accept: "application/json" },
    });
    const txt = await r.text();
    if (r.status === 401) return { store, error: "auth", detail: txt.slice(0, 200) };
    if (!r.ok) return { store, error: `http_${r.status}`, detail: txt.slice(0, 200), upserted };
    let obj: Record<string, any> = {};
    try { obj = JSON.parse(txt) || {}; } catch { return { store, error: "bad_json", upserted }; }
    const orders = Object.values(obj);
    if (!orders.length) break;
    const rows = orders.map((o: any) => ({
      entity_id: o.entity_id,
      store,
      increment_id: o.increment_id != null ? String(o.increment_id) : null,
      status: o.status || null,
      ordered_at: utc(o.created_at),
      updated_at: utc(o.updated_at),
      grand_total: num(o.grand_total),
      subtotal: num(o.subtotal),
      shipping_amount: num(o.shipping_amount),
      tax_amount: num(o.tax_amount),
      discount_amount: num(o.discount_amount),
      payment_method: o.payment_method || null,
      cc_type: o.payment_info?.cc_type || null,
      cc_last4: o.payment_info?.cc_last4 || null,
      tracking_number: o.tracking_number != null ? String(o.tracking_number) : null,
      items: Array.isArray(o.order_items) ? o.order_items.map((it: any) => ({
        sku: it.sku, name: it.name,
        qty: num(it.qty_ordered), qty_shipped: num(it.qty_shipped),
        qty_refunded: num(it.qty_refunded), qty_canceled: num(it.qty_canceled),
        price: num(it.price), row_total: num(it.row_total),
      })) : [],
      raw: o,
      synced_at: new Date().toISOString(),
    })).filter((r) => Number.isFinite(Number(r.entity_id)));
    if (rows.length) {
      const w = await admin.from("ms_orders").upsert(rows, { onConflict: "entity_id" });
      if (w.error) return { store, error: "db", detail: w.error.message, upserted };
      upserted += rows.length;
    }
    if (orders.length < 100) break;
  }
  return { store, upserted };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { /* empty */ } }
  const action = String(body.action || url.searchParams.get("action") || "");

  if (action === "ping") return json({ ok: true });

  if (action === "sync") {
    const bySecret = !!NOTIFY_SECRET && body.secret === NOTIFY_SECRET;
    if (!bySecret) {
      // Any signed-in staff may kick a sync (the consumption report does, so
      // "Ordered" reflects a purchase made minutes ago) — but the freshness
      // guard below keeps that from hammering the cpr.parts API.
      const staff = await getStaff(req);
      if (!staff) return json({ error: "forbidden" }, 403);
      const { data: fresh } = await admin.from("ms_orders").select("synced_at")
        .order("synced_at", { ascending: false }).limit(1);
      if (fresh?.[0]?.synced_at && Date.now() - new Date(fresh[0].synced_at).getTime() < 15 * 60 * 1000)
        return json({ ok: true, skipped: "fresh" });
    }
    if (!MS_KEY || !MS_SECRET) return json({ error: "not_configured" }, 503);
    const { data: toks } = await admin.from("integration_tokens")
      .select("provider, access_token, meta").like("provider", "ms:%");
    if (!toks?.length) return json({ error: "no_stores_connected" }, 503);
    const results = [];
    for (const t of toks) {
      const store = String(t.provider).slice(3);
      const secret = t.meta?.access_token_secret || "";
      results.push(await syncStore(store, t.access_token, secret));
    }
    return json({ ok: true, results });
  }

  // Live price + availability for specific SKUs (the consumption report's
  // order list). Serves a 30-min cache (ms_products); fetches the rest fresh
  // from cpr.parts in batches. price = our account's cost.
  if (action === "products") {
    const staff = await getStaff(req);
    if (!staff) return json({ error: "forbidden" }, 403);
    let skus: string[] = Array.isArray(body.skus) ? (body.skus as unknown[]).map((s) => String(s).trim()).filter(Boolean) : [];
    skus = [...new Set(skus)].slice(0, 300);
    if (!skus.length) return json({ products: [] });
    const { data: cached } = await admin.from("ms_products").select("*").in("sku", skus);
    const have = new Map<string, any>();
    const cutoff = Date.now() - 30 * 60 * 1000;
    (cached || []).forEach((c: any) => { if (new Date(c.synced_at).getTime() > cutoff) have.set(c.sku, c); });
    const need = skus.filter((s) => !have.has(s));
    if (need.length && MS_KEY && MS_SECRET) {
      const { data: toks } = await admin.from("integration_tokens")
        .select("access_token, meta").like("provider", "ms:%").limit(1);
      const t = toks?.[0];
      if (t) {
        const tokSecret = t.meta?.access_token_secret || "";
        for (let i = 0; i < need.length; i += 25) {
          const batch = need.slice(i, i + 25);
          const qs = "limit=25&filter%5B1%5D%5Battribute%5D=sku" +
            batch.map((s, j) => `&filter%5B1%5D%5Bin%5D%5B${j}%5D=${encodeURIComponent(s)}`).join("");
          try {
            const r = await fetch(`${MS_BASE}/api/rest/products?${qs}`, {
              headers: { Authorization: oauthHeader(t.access_token, tokSecret), Accept: "application/json" },
            });
            if (!r.ok) continue;
            const obj = await r.json().catch(() => null);
            if (!obj || typeof obj !== "object") continue;
            const rows = Object.values(obj).map((p: any) => ({
              sku: String(p.sku),
              name: p.name || null,
              price: num(p.customer_price),
              in_stock: p.is_in_stock === 1 || p.is_in_stock === true || p.is_in_stock === "1",
              stock_qty: num(p.in_stock_qty),
              saleable: !!p.is_saleable,
              order_status: p.product_order_status_text || null,
              url: p.url || null,
              image_url: p.image_url || null,
              synced_at: new Date().toISOString(),
            })).filter((r2) => r2.sku);
            if (rows.length) {
              await admin.from("ms_products").upsert(rows, { onConflict: "sku" });
              rows.forEach((r2) => have.set(r2.sku, r2));
            }
          } catch { /* batch is best-effort — stale cache below covers it */ }
        }
      }
    }
    (cached || []).forEach((c: any) => { if (!have.has(c.sku)) have.set(c.sku, c); });
    return json({ products: skus.map((s) => have.get(s)).filter(Boolean) });
  }

  return json({ error: "unknown_action" }, 400);
});
