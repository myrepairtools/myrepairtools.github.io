import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const J = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
const num = (v: unknown) => { const n = parseInt(String(v ?? "").trim(), 10); return isNaN(n) ? 0 : n; };
const pick = (r: Record<string, unknown>, ...ks: string[]) => { for (const k of ks) if (r[k] != null && String(r[k]).trim() !== "") return String(r[k]).trim(); return ""; };
// normalize a date string to YYYY-MM-DD (Looker sends ISO already; tolerate M/D/YYYY)
const dnorm = (v: unknown) => {
  const s = String(v ?? "").trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return null;
};

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
    const feed = u.searchParams.get("feed") ?? "";
    if (!INGEST_SECRET.trim() || tok !== INGEST_SECRET.trim()) {
      // TEMP diagnostic: record bad-token hits that carry a feed param so we can
      // see whether a claims delivery is arriving with the wrong/no token.
      if (feed) { try { await admin.from("ingest_debug").insert({ feed: "badtoken:" + feed, payload: { qs: u.search, has_token: !!tok } }); } catch (_) {} }
      return J({ ok: false, reason: "bad token" });
    }

    let body: any = null;
    try { body = await req.json(); } catch { try { body = { raw: await req.text() }; } catch { body = null; } }
    const rows = extractRows(body);
    if (!rows) { await admin.from("ingest_debug").insert({ feed, payload: body }); return J({ ok: false, reason: "could not parse rows; saved to ingest_debug" }); }
    // TEMP diagnostic: log a breadcrumb for claims feeds so we can confirm
    // arrival, row count, and the column names being sent.
    if (feed.startsWith("claim")) { try { await admin.from("ingest_debug").insert({ feed: "dbg:" + feed, payload: { rows: rows.length, keys: rows[0] ? Object.keys(rows[0]) : [], sample: rows[0] ?? null } }); } catch (_) {} }

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

    // ---------- CLAIMS: repairs (upsert by ticket; user `processed` flag preserved) ----------
    if (feed === "claim_repairs" || feed === "claims_repairs") {
      const out: any[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const ticket_id = pick(r, "RQ Ticket #", "Ticket ID", "ticket_id");
        if (!ticket_id || seen.has(ticket_id)) continue; seen.add(ticket_id);
        out.push({
          ticket_id,
          payout_date: dnorm(pick(r, "payout_date", "Payout Date")),
          location: norm(pick(r, "Location", "Name")),
          provider: pick(r, "Provider"),
          program: pick(r, "Program", "Service Program Name"),
          device: pick(r, "Device", "Device Catalog Item Name", "Ticket Device Claim Model"),
          description: pick(r, "Description", "Device Description"),
          ticket_date: dnorm(pick(r, "Returned to Cust", "Ticket Picked Up Date")),
          total: num(r["Total"] ?? r["Ticket Item All Net Repair Sale Total"]),
          cogs: num(r["COGS"] ?? r["Ticket Item All Net COGS Total"]),
          royalty: num(r["Royalty Due"] ?? r["Royalty"]),
          gross_profit: num(r["Gross Profit"]),
          claim_invoice: pick(r, "Claim Invoice #"),
          tkt_status: pick(r, "Tkt Status"),
          updated_at: new Date().toISOString(),
        });
      }
      if (out.length) {
        // NOTE: `processed`/`processed_date` are intentionally omitted so the
        // upsert never overwrites the flags users set in the app; new tickets
        // default to processed=false.
        const { error } = await admin.from("claim_repairs").upsert(out as any, { onConflict: "ticket_id" });
        if (error) return J({ ok: false, table: "claim_repairs", error: error.message });
      }
      return J({ ok: true, feed, rows_written: out.length });
    }

    // ---------- CLAIMS: parts (replace the parts of each ticket present) ----------
    if (feed === "claim_parts" || feed === "claims_parts") {
      const out: any[] = [];
      for (const r of rows) {
        const ticket_id = pick(r, "RQ Ticket #", "Ticket ID", "ticket_id");
        if (!ticket_id) continue;
        out.push({
          ticket_id,
          payout_date: dnorm(pick(r, "payout_date", "Payout Date")),
          location: norm(pick(r, "Location", "Name")),
          provider: pick(r, "Provider"),
          program: pick(r, "Program", "Service Program Name"),
          device: pick(r, "Device", "Device Catalog Item Name"),
          part_name: pick(r, "Name", "Part Name"),
          ticket_date: dnorm(pick(r, "Returned to Cust", "Ticket Picked Up Date")),
          consigned: pick(r, "Is Consigned", "Consigned (Yes / No)"),
          part_cost: num(r["Part Cost"] ?? r["All Net COGS Total"]),
        });
      }
      const tickets = [...new Set(out.map((x) => x.ticket_id))];
      for (let i = 0; i < tickets.length; i += 200) {
        await admin.from("claim_parts").delete().in("ticket_id", tickets.slice(i, i + 200));
      }
      if (out.length) {
        const { error } = await admin.from("claim_parts").insert(out as any);
        if (error) return J({ ok: false, table: "claim_parts", error: error.message });
      }
      return J({ ok: true, feed, tickets: tickets.length, rows_written: out.length });
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
