import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const J = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
const num = (v: unknown) => { const n = parseInt(String(v ?? "").trim(), 10); return isNaN(n) ? 0 : n; };
const pick = (r: Record<string, unknown>, ...ks: string[]) => { for (const k of ks) if (r[k] != null && String(r[k]).trim() !== "") return String(r[k]).trim(); return ""; };

function extractRows(body: any): any[] | null {
  if (Array.isArray(body)) return body;                                  // JSON - Label / Inline (bare array)
  if (typeof body?.attachment?.data === "string") { try { return JSON.parse(body.attachment.data); } catch { return null; } } // JSON - Simple (wrapped)
  if (Array.isArray(body?.data)) return body.data;
  return null;
}

async function storeMap() {
  const { data } = await admin.from("stores").select("store, rq_name");
  const m: Record<string, string> = {};
  (data ?? []).forEach((s: any) => { if (s.rq_name) m[s.rq_name] = s.store; m[s.store] = s.store; });
  return m;
}

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const tok = (u.searchParams.get("token") ?? "").trim();
    if (!INGEST_SECRET.trim() || tok !== INGEST_SECRET.trim()) return J({ ok: false, reason: "bad token" });
    const feed = u.searchParams.get("feed") ?? "";

    let body: any = null;
    try { body = await req.json(); } catch { try { body = { raw: await req.text() }; } catch { body = null; } }
    const rows = extractRows(body);
    if (!rows) { await admin.from("ingest_debug").insert({ feed, payload: body }); return J({ ok: false, reason: "could not parse rows; saved to ingest_debug" }); }

    const sm = await storeMap();
    const norm = (x: string) => sm[x] ?? x;

    // ---------- CONSUMPTION: one row per (date, store, sku); Count summed ----------
    if (feed === "consumption") {
      const agg: Record<string, any> = {};
      for (const r of rows) {
        const store = norm(pick(r, "Location", "Store", "Name"));
        const sku = pick(r, "SKU");
        if (!store || !sku) continue;
        const biz_date = pick(r, "Status Updated Date", "Date");
        const name = pick(r, "Inventory Item", "Catalog Item Name", "Item");
        const units = num(r["Count"] ?? r["Units"]);
        const key = biz_date + "|" + store + "|" + sku;
        if (!agg[key]) agg[key] = { biz_date, store, sku, name, units: 0 };
        agg[key].units += units || 1;
      }
      const out = Object.values(agg) as any[];
      // Replace only the (date, store) combos present in THIS payload, so a
      // partial / store-specific delivery never wipes stores it didn't include.
      // This lets separate per-store reports (e.g. a Clackamas-only schedule)
      // coexist with the main report for the same business date.
      const SEP = "";
      const combos = [...new Set(out.map((x) => x.biz_date + SEP + x.store).filter((s) => s.split(SEP)[0]))];
      for (const c of combos) {
        const i = c.indexOf(SEP);
        await admin.from("consumption_log").delete().eq("biz_date", c.slice(0, i)).eq("store", c.slice(i + 1));
      }
      if (out.length) {
        const { error } = await admin.from("consumption_log").insert(out as any);
        if (error) return J({ ok: false, table: "consumption_log", error: error.message });
      }
      const dates = [...new Set(out.map((x) => x.biz_date).filter(Boolean))];
      return J({ ok: true, feed, dates, combos: combos.length, rows_written: out.length });
    }

    // ---------- STOCK: full-replace per store present; Note carried ----------
    if (feed === "stock") {
      const out: any[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const store = norm(pick(r, "Location", "Store", "Name"));
        const sku = pick(r, "SKU");
        if (!store || !sku) continue;
        const key = store + "|" + sku;
        if (seen.has(key)) continue; seen.add(key);
        out.push({
          store, sku,
          name: pick(r, "Inventory Item", "Catalog Item Name", "Item"),
          in_stock: num(r["Instock"] ?? r["Inventory Item Instock"] ?? r["In Stock"]),
          on_order: num(r["On Order"] ?? r["Ordered Qty"]),
          max_baseline: num(r["Max Stock Level"] ?? r["Max"]),
          note: pick(r, "Note"),
        });
      }
      const stores = [...new Set(out.map(x => x.store))];
      if (stores.length) await admin.from("stock").delete().in("store", stores);
      if (out.length) {
        const { error } = await admin.from("stock").insert(out);
        if (error) return J({ ok: false, table: "stock", error: error.message });
      }
      return J({ ok: true, feed, stores, rows_written: out.length });
    }

    await admin.from("ingest_debug").insert({ feed, payload: body });
    return J({ ok: false, reason: "unknown feed; saved to ingest_debug" });
  } catch (e) { return J({ ok: false, crash: String(e) }); }
});
