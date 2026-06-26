import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

// DEPLOY NOTE: this function authenticates via the ?token= query param, NOT a
// Supabase JWT. It MUST be deployed with verify_jwt=false (deploy metadata), or
// the gateway 401s every Looker delivery before it reaches this code. A redeploy
// without the flag once knocked all feeds offline — keep it false.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const J = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
const num = (v: unknown) => { const n = parseInt(String(v ?? "").trim(), 10); return isNaN(n) ? 0 : n; };
// money parser: claim dollar values arrive like "$357.44" / "$1,234.50" — strip
// the $ and commas (parseInt/num would choke on the $ and return 0).
const money = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, "")); return isNaN(n) ? 0 : n; };
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

// Minimal RFC-4180 CSV parser -> array of row objects keyed by the header row.
// (Handles quoted fields, so money values like "$1,234.50" survive the comma.)
function parseCsv(text: string): any[] {
  text = text.replace(/^﻿/, "");
  const recs: string[][] = []; let f = "", row: string[] = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); recs.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); recs.push(row); }
  if (!recs.length) return [];
  const head = recs[0].map((h) => h.trim());
  const out: any[] = [];
  for (let r = 1; r < recs.length; r++) {
    const rr = recs[r];
    if (rr.length === 1 && rr[0] === "") continue;                       // blank line
    const o: Record<string, string> = {};
    for (let c = 0; c < head.length; c++) o[head[c]] = rr[c] ?? "";
    out.push(o);
  }
  return out;
}

// Looker "merged" reports can ONLY be delivered as a dashboard, which sends the
// CSV(s) inside a base64 ZIP attachment (mimetype application/zip;base64).
// Decode -> unzip -> parse the first CSV so those feeds ingest like the inline ones.
function rowsFromZip(b64: string): any[] | null {
  try {
    const bin = Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    const files = unzipSync(bin);
    const names = Object.keys(files);
    const name = names.find((n) => /\.csv$/i.test(n)) ?? names[0];
    if (!name) return null;
    return parseCsv(new TextDecoder().decode(files[name]));
  } catch { return null; }
}

async function storeMap() {
  const { data } = await admin.from("stores").select("store, rq_name");
  const m: Record<string, string> = {};
  (data ?? []).forEach((s: any) => { if (s.rq_name) m[s.rq_name] = s.store; m[s.store] = s.store; });
  return m;
}

// Best-effort RepairQ-name -> staff.id resolver. Exact display_name first, then
// same last name + first-name prefix match (so "Josh Kirk" -> "Joshua Kirk").
// Returns null when there is no unambiguous match (caller stores the raw name).
async function staffResolver() {
  const { data } = await admin.from("staff").select("id, display_name").eq("active", true);
  const exact: Record<string, number> = {};
  const list = (data ?? []).map((s: any) => {
    const dn = String(s.display_name ?? "").trim().toLowerCase();
    exact[dn] = s.id;
    const p = dn.split(/\s+/);
    return { id: s.id as number, first: p[0] ?? "", last: p[p.length - 1] ?? "" };
  });
  return (name: string): number | null => {
    const n = String(name ?? "").trim().toLowerCase(); if (!n) return null;
    if (exact[n] != null) return exact[n];
    const p = n.split(/\s+/); const first = p[0] ?? "", last = p[p.length - 1] ?? "";
    const hit = list.filter((s) => s.last === last && s.first && first && (s.first.startsWith(first) || first.startsWith(s.first)));
    return hit.length === 1 ? hit[0].id : null;
  };
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
    let rows = extractRows(body);
    if (!rows && body?.attachment && typeof body.attachment.data === "string" && /zip/i.test(String(body.attachment.mimetype ?? ""))) {
      rows = rowsFromZip(body.attachment.data);                          // Looker merged/dashboard => zipped CSV
    }
    if (!rows) { await admin.from("ingest_debug").insert({ feed, payload: body }); return J({ ok: false, reason: "could not parse rows; saved to ingest_debug" }); }
    // TEMP diagnostic: log a breadcrumb for claims feeds so we can confirm
    // arrival, row count, and the column names being sent.
    if (feed.startsWith("claim") || feed.startsWith("commission")) { try { await admin.from("ingest_debug").insert({ feed: "dbg:" + feed, payload: { rows: rows.length, keys: rows[0] ? Object.keys(rows[0]) : [], sample: rows[0] ?? null } }); } catch (_) {} }

    const sm = await storeMap();
    const norm = (x: string) => sm[x] ?? x;

    // ---------- CONSUMPTION: one row per (date, store, sku); Count summed ----------
    if (feed === "consumption") {
      // GUARD: a real consumption report carries a business-date column. Without
      // it the payload is the wrong feed — refuse rather than write junk rows.
      if (!rows.some((r) => ("Status Updated Date" in r) || ("Date" in r))) {
        await admin.from("ingest_debug").insert({ feed: "reject:consumption", payload: { reason: "no date column — wrong feed?", keys: rows[0] ? Object.keys(rows[0]) : [] } });
        return J({ ok: false, reason: "not a consumption report (no date column); refused" });
      }
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
      // Looker doesn't send payout_date, but Claim Invoice # maps 1:1 to a payout
      // date — build invoice -> payout_date from rows that already have one.
      const invMap: Record<string, string> = {};
      {
        const { data: known } = await admin.from("claim_repairs").select("claim_invoice,payout_date").not("payout_date", "is", null);
        (known ?? []).forEach((r: any) => { if (r.claim_invoice && r.payout_date && !invMap[r.claim_invoice]) invMap[r.claim_invoice] = r.payout_date; });
      }
      const out: any[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const ticket_id = pick(r, "RQ Ticket #", "Ticket ID", "ticket_id");
        if (!ticket_id || seen.has(ticket_id)) continue; seen.add(ticket_id);
        const claim_invoice = pick(r, "Claim Invoice #");
        out.push({
          ticket_id,
          payout_date: dnorm(pick(r, "payout_date", "Payout Date")) ?? (invMap[claim_invoice] ?? null),
          location: norm(pick(r, "Location", "Name")),
          provider: pick(r, "Provider"),
          program: pick(r, "Program", "Service Program Name"),
          device: pick(r, "Device", "Device Catalog Item Name", "Ticket Device Claim Model"),
          description: pick(r, "Description", "Device Description"),
          ticket_date: dnorm(pick(r, "Returned to Cust", "Ticket Picked Up Date")),
          total: money(r["Total"] ?? r["Ticket Item All Net Repair Sale Total"]),
          cogs: money(r["COGS"] ?? r["Ticket Item All Net COGS Total"]),
          royalty: money(r["Royalty Due"] ?? r["Royalty"]),
          gross_profit: money(r["Gross Profit"]),
          claim_invoice,
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
      const invMap: Record<string, string> = {};
      {
        const { data: known } = await admin.from("claim_repairs").select("claim_invoice,payout_date").not("payout_date", "is", null);
        (known ?? []).forEach((r: any) => { if (r.claim_invoice && r.payout_date && !invMap[r.claim_invoice]) invMap[r.claim_invoice] = r.payout_date; });
      }
      const out: any[] = [];
      for (const r of rows) {
        const ticket_id = pick(r, "RQ Ticket #", "Ticket ID", "ticket_id");
        if (!ticket_id) continue;
        out.push({
          ticket_id,
          payout_date: dnorm(pick(r, "payout_date", "Payout Date")) ?? (invMap[pick(r, "Claim Invoice #")] ?? null),
          location: norm(pick(r, "Location", "Name")),
          provider: pick(r, "Provider"),
          program: pick(r, "Program", "Service Program Name"),
          device: pick(r, "Device", "Device Catalog Item Name"),
          part_name: pick(r, "Name", "Part Name"),
          ticket_date: dnorm(pick(r, "Returned to Cust", "Ticket Picked Up Date")),
          consigned: pick(r, "Is Consigned", "Consigned (Yes / No)"),
          part_cost: money(r["Part Cost"] ?? r["All Net COGS Total"]),
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
      // GUARD: a real stock report carries an Instock column. If it's absent the
      // payload is the wrong feed (e.g. a consumption report mis-pointed here) —
      // refuse rather than delete a store's stock and replace it with zeros.
      if (!rows.some((r) => ("Instock" in r) || ("Inventory Item Instock" in r) || ("In Stock" in r))) {
        await admin.from("ingest_debug").insert({ feed: "reject:stock", payload: { reason: "no Instock column — wrong feed?", keys: rows[0] ? Object.keys(rows[0]) : [] } });
        return J({ ok: false, reason: "not a stock report (no Instock column); refused to overwrite stock" });
      }
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

    // ---------- COMMISSION: accessories (tickets + accessory $/units/GP) ----------
    if (feed === "commission_accessory" || feed === "commission_accy") {
      if (!rows.some((r) => ("Accy Tkt #" in r) || ("Accy Count" in r) || ("Accy GP" in r))) {
        await admin.from("ingest_debug").insert({ feed: "reject:commission_accessory", payload: { reason: "no accessory columns — wrong feed?", keys: rows[0] ? Object.keys(rows[0]) : [] } });
        return J({ ok: false, reason: "not an accessory report; refused" });
      }
      const resolve = await staffResolver();
      const out: any[] = [];
      for (const r of rows) {
        const store = norm(pick(r, "Location", "Store", "Name"));
        const employee = pick(r, "Employee", "Full Name");
        const biz_date = dnorm(pick(r, "Accounted on Date", "Date"));
        if (!store || !employee || !biz_date) continue; // skips the grand-total row
        out.push({ biz_date, store, employee, staff_id: resolve(employee),
          tickets: num(r["Accy Tkt #"] ?? r["Tickets"]),
          accy_units: num(r["Accy Count"] ?? r["Accy Units"]),
          accy_net: money(r["Accy Total"] ?? r["Net Accy Sales"]),
          accy_gp: money(r["Accy GP"]) });
      }
      if (out.length) { const { error } = await admin.from("commission_sales").upsert(out as any, { onConflict: "biz_date,store,employee" }); if (error) return J({ ok: false, table: "commission_sales", error: error.message }); }
      return J({ ok: true, feed, rows_written: out.length });
    }

    // ---------- COMMISSION: devices (units/returns/net/GP) ----------
    if (feed === "commission_device" || feed === "commission_devices") {
      if (!rows.some((r) => ("Device Sales" in r) || ("Device Sale Count" in r) || ("Device Net Sales" in r) || ("Device Net Sale Price" in r) || ("Device Gross Profit" in r))) {
        await admin.from("ingest_debug").insert({ feed: "reject:commission_device", payload: { reason: "no device columns — wrong feed?", keys: rows[0] ? Object.keys(rows[0]) : [] } });
        return J({ ok: false, reason: "not a device report; refused" });
      }
      // The report is per ticket-item (one row per device, with a model + ticket number),
      // so SUM rows per employee/day — otherwise multiple devices in a day would
      // overwrite each other on upsert. Ticket numbers are collected for reference, and
      // the per-ticket Accessory Count (paid attach) is summed once per ticket.
      // NOTE: "Device" is the device MODEL here, so it is NOT a store fallback.
      const resolve = await staffResolver();
      const agg: Record<string, any> = {};
      for (const r of rows) {
        const store = norm(pick(r, "Location", "Store"));
        const employee = pick(r, "Employee", "Full Name");
        const biz_date = dnorm(pick(r, "Accounted on Date", "Date"));
        if (!store || !employee || !biz_date) continue;        // skips the grand-total row
        const k = biz_date + "" + store + "" + employee;
        const a = agg[k] || (agg[k] = { biz_date, store, employee, staff_id: resolve(employee),
          device_units: 0, device_net: 0, device_gp: 0, device_attach: 0, device_tickets: [] as string[] });
        // device_returns / device_return_* are owned by the commission_device_return feed
        // (disjoint columns), so a sales post and a returns post for the same daily row
        // never clobber each other. The sales report is returns-free (filtered to sales).
        a.device_units   += num(pick(r, "Device Sale Count", "Device Sales", "Device Units"));
        a.device_net     += money(pick(r, "Device Net Sale Price", "Device Net Sales", "Device Rev"));
        a.device_gp      += money(pick(r, "Device Gross Profit", "Device GP"));
        // Accessory Count is per TICKET ($0 giveaways already filtered out in Looker via
        // the Net Sale > 0 dimension). Attribute it once per ticket — a 2-device ticket
        // repeats the same count on both rows, so guard on first sight of the ticket.
        const id = pick(r, "Ticket Number", "ID", "Ticket ID", "Ticket", "Ticket #");
        if (id && a.device_tickets.indexOf(id) < 0) { a.device_tickets.push(id); a.device_attach += num(pick(r, "Accessory Count", "Accessories on Ticket", "Ticket Item All Sale Count")); }
      }
      const out = Object.values(agg);
      if (out.length) { const { error } = await admin.from("commission_sales").upsert(out as any, { onConflict: "biz_date,store,employee" }); if (error) return J({ ok: false, table: "commission_sales", error: error.message }); }
      return J({ ok: true, feed, rows_written: out.length });
    }

    // ---------- COMMISSION: device RETURNS (clawback count/net/GP + returned attach) ----------
    // Mirror of commission_device, filtered to returns. Lands in DISJOINT columns so a sales
    // post and a returns post for the same (date, store, employee) never overwrite each other.
    // Looker sends returns as: Return Count positive; Net Sale Price / Gross Profit negative.
    // The engine nets these out downstream (count off netDev, GP off device GP, returned
    // accessories off the attach numerator).
    if (feed === "commission_device_return" || feed === "commission_device_returns") {
      if (!rows.some((r) => ("Device Return Count" in r) || ("Accessories Returned" in r))) {
        await admin.from("ingest_debug").insert({ feed: "reject:commission_device_return", payload: { reason: "no return columns — wrong feed?", keys: rows[0] ? Object.keys(rows[0]) : [] } });
        return J({ ok: false, reason: "not a device-return report; refused" });
      }
      const resolve = await staffResolver();
      const agg: Record<string, any> = {};
      for (const r of rows) {
        const store = norm(pick(r, "Location", "Store"));
        const employee = pick(r, "Employee", "Sold By Full Name", "Full Name");
        const biz_date = dnorm(pick(r, "Accounted on Date", "Date"));
        if (!store || !employee || !biz_date) continue;
        // Only count rows where money was actually refunded (Net Sale < 0). This skips both
        // EXCHANGES (device returned AND re-sold on the same ticket, net ~$0 — the sold side
        // is already in the sales report) and $0-refund warranty/RMA "returns" that move no
        // money but carry a GP entry. Neither should touch commission.
        if (money(pick(r, "Device Net Sale Price", "Device Net Sales", "Device Rev")) >= 0) continue;
        const k = biz_date + "" + store + "" + employee;
        const a = agg[k] || (agg[k] = { biz_date, store, employee, staff_id: resolve(employee),
          device_returns: 0, device_return_net: 0, device_return_gp: 0, device_attach_return: 0, _tix: [] as string[] });
        a.device_returns    += num(pick(r, "Device Return Count", "Device Returns", "Return Count"));
        a.device_return_net += money(pick(r, "Device Net Sale Price", "Device Return Net", "Device Net Sales"));
        a.device_return_gp  += money(pick(r, "Device Gross Profit", "Device Return GP", "Device GP"));
        // Accessories Returned is per ticket — count once per ticket (a 2-device return repeats it).
        const id = pick(r, "Ticket Number", "ID", "Ticket ID", "Ticket", "Ticket #");
        if (id && a._tix.indexOf(id) < 0) { a._tix.push(id); a.device_attach_return += num(pick(r, "Accessories Returned", "Accessory Return Count", "Accessory Count")); }
      }
      const out = Object.values(agg).map((a: any) => { const { _tix, ...rest } = a; return rest; });
      if (out.length) { const { error } = await admin.from("commission_sales").upsert(out as any, { onConflict: "biz_date,store,employee" }); if (error) return J({ ok: false, table: "commission_sales", error: error.message }); }
      return J({ ok: true, feed, rows_written: out.length });
    }

    // ---------- COMMISSION: services (per-SKU daily counts -> services jsonb) ----------
    if (feed === "commission_service" || feed === "commission_services") {
      // Known RepairQ service labels -> stable short SKU (back-compat). ANY other
      // service column passes through as a slug of its name, so new commissionable
      // services surface automatically and the Settings payout list stays in sync.
      const SVC_MAP: Record<string, string> = {
        "Device Cleaning Fee": "cleaning", "Device Cleaning": "cleaning", "Cleaning": "cleaning",
        "Express Repair Service": "express", "Express Repair": "express", "Express Fee": "express", "Express": "express",
        "Malware/Virus Removal - Phone": "malware", "Malware/Virus Removal": "malware", "Virus Removal": "malware", "Malware": "malware",
      };
      const SVC_DIM = new Set(["location", "name", "store", "employee", "full name", "accounted on date", "date"]);
      const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      // The report is a pivot: each service has a COUNT column and a NET TOTAL ($)
      // column, so column keys carry a measure word. Detect the measure regardless
      // of how the service name is concatenated; strip it to recover the service.
      const isRev = (s: string) => /(net\s*sale|net\s*total|sale\s*total|net\s*sales|\bnet\b|revenue|amount|\$)/i.test(s) && !/count|qty|unit/i.test(s);
      const isCount = (s: string) => /(sale\s*count|all\s*sale\s*count|\bcount\b|\bqty\b|\bunits?\b)/i.test(s);
      const stripMeasure = (s: string) => s
        .replace(/\s*[-|.–]\s*(all\s*)?(net\s*)?(sale\s*)?(count|total|qty|units?|revenue|amount|sales?)\s*$/i, "")
        .replace(/^\s*(all\s*)?(net\s*)?(sale\s*)?(count|total|qty|units?)\s*[-|.–]\s*/i, "").trim();
      const isMeasureOnly = (s: string) => !s || /^(all\s*)?(net\s*)?(sale\s*)?(count|total|qty|units?|sales?|revenue|amount)$/i.test(s);
      const resolve = await staffResolver();
      const out: any[] = [];
      for (const r of rows) {
        const store = norm(pick(r, "Location", "Name", "Store"));
        const employee = pick(r, "Employee", "Full Name");
        const biz_date = dnorm(pick(r, "Accounted on Date", "Date"));
        if (!store || !employee || !biz_date) continue;
        const services: Record<string, number> = {};
        let service_net = 0;
        for (const k in r) {
          const kl = k.trim(); const low = kl.toLowerCase();
          if (!kl || /^\d+$/.test(kl) || SVC_DIM.has(low)) continue;             // skip dimensions / index col
          if (isRev(low)) { service_net += money(r[k]); continue; }              // service sales $ -> service_net
          const c = num(r[k]); if (!c) continue;                                 // only numeric service counts
          const svcName = isCount(low) ? stripMeasure(kl) : kl;                  // recover the service name
          if (isMeasureOnly(svcName)) continue;                                  // a bare "Count"/"Total" col, no service
          const key = SVC_MAP[svcName] || SVC_MAP[kl] || slug(svcName);
          if (key) services[key] = (services[key] ?? 0) + c;
        }
        out.push({ biz_date, store, employee, staff_id: resolve(employee), services, service_net });
      }
      if (out.length) { const { error } = await admin.from("commission_sales").upsert(out as any, { onConflict: "biz_date,store,employee" }); if (error) return J({ ok: false, table: "commission_sales", error: error.message }); }
      return J({ ok: true, feed, rows_written: out.length });
    }

    // ---------- COMMISSION: accessory categories (per-category unit counts) ----------
    if (feed === "commission_category" || feed === "commission_categories") {
      // RepairQ category column label -> short category key used by the dashboard.
      const CAT_MAP: Record<string, string> = {
        "Accessory - Case": "Case", "Case": "Case",
        "Accessory - Screen Protector": "Screen Protector", "Screen Protector": "Screen Protector",
        "Accessory - Power": "Power", "Power": "Power",
        "Accessory - Misc": "Misc", "Misc": "Misc",
        "Accessory - Other": "Other", "Other": "Other",
      };
      if (!rows.some((r) => Object.keys(r).some((k) => k.trim() in CAT_MAP))) {
        await admin.from("ingest_debug").insert({ feed: "reject:commission_category", payload: { reason: "no category columns — wrong feed?", keys: rows[0] ? Object.keys(rows[0]) : [] } });
        return J({ ok: false, reason: "not a category report; refused" });
      }
      const resolve = await staffResolver();
      const out: any[] = []; let undated = 0;
      for (const r of rows) {
        const store = norm(pick(r, "Location", "Name", "Store"));
        const employee = pick(r, "Employee", "Full Name");
        const biz_date = dnorm(pick(r, "Accounted on Date", "Date"));
        if (!store || !employee) continue;
        if (!biz_date) { undated++; continue; } // needs a date dimension to merge per-day
        const categories: Record<string, number> = {};
        for (const k in r) { const cat = CAT_MAP[k.trim()]; if (cat) { const c = num(r[k]); if (c) categories[cat] = (categories[cat] ?? 0) + c; } }
        out.push({ biz_date, store, employee, staff_id: resolve(employee), categories });
      }
      if (undated && !out.length) {
        await admin.from("ingest_debug").insert({ feed: "reject:commission_category", payload: { reason: "category rows have no date column — add 'Accounted on Date' to the report", keys: rows[0] ? Object.keys(rows[0]) : [] } });
        return J({ ok: false, reason: "category report has no date column; add 'Accounted on Date' to match the other feeds", undated });
      }
      if (out.length) { const { error } = await admin.from("commission_sales").upsert(out as any, { onConflict: "biz_date,store,employee" }); if (error) return J({ ok: false, table: "commission_sales", error: error.message }); }
      return J({ ok: true, feed, rows_written: out.length, undated });
    }

    await admin.from("ingest_debug").insert({ feed, payload: body });
    return J({ ok: false, reason: "unknown feed; saved to ingest_debug" });
  } catch (e) { return J({ ok: false, crash: String(e) }); }
});
