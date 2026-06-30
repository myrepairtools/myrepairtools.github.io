// RepairQ → Supabase webhook: "Repairs without parts" report.
// RepairQ POSTs the report rows here; we write them to public.repairs_no_parts
// (service-role, bypassing RLS). The consumption report's no-parts panel reads
// that table and hyperlinks each ticket to cpr.repairq.io/ticket/<id>.
//
// Auth: shared secret in the `x-rq-secret` header OR `?secret=` query param,
//       compared to the RQ_WEBHOOK_SECRET function secret.
// Deployed with verify_jwt:false so RepairQ can call it without a Supabase JWT.
//
// Accepted body (tolerant): a single object, a bare array, or { rows|data|items|records: [...] }.
// Each row maps by these aliases:
//   store  <- store | Store | location | store_name | locationName
//   ticket <- ticket | ticketId | ticket_id | id | ID | "Ticket ID" | ticketNumber
//   tech   <- tech | technician | fullName | "Full Name" | full_name | assignedTo
//   device <- device | item | itemName | description | repair | lineItem | "Name"
//   note   <- note | Note | notes
//   date   <- date | biz_date | accountedOn | "Accounted on Date" | accounted_on_date | closedDate
//
// Modes (?mode=): "replace" (default) treats the delivery as a snapshot and
//   replaces every (store, day) it covers — resolved tickets drop off.
//   "upsert" only inserts/updates the rows sent, leaving the rest untouched.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET       = Deno.env.get("RQ_WEBHOOK_SECRET") || "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const J = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function pick(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function normStore(s: string): string {
  const low = s.toLowerCase().replace(/^cpr\s+/, "").trim();
  if (low.startsWith("eugene")) return "CPR Eugene";
  if (low.startsWith("salem")) return "CPR Salem Northeast";
  if (low.startsWith("clack")) return "CPR Clackamas";
  return s.trim(); // unknown → pass through unchanged
}

function todayIn(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

function normDate(d: string): string | null {
  if (!d) return null;
  d = d.trim();
  let m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const t = new Date(d);
  return isNaN(+t) ? null : t.toISOString().slice(0, 10);
}

function mapRow(r: Record<string, unknown>) {
  const store  = normStore(pick(r, ["store", "Store", "Location", "location", "store_name", "locationName"]));
  const ticket = pick(r, ["ticket", "Ticket Number", "ticketId", "ticket_id", "id", "ID", "Ticket ID", "ticketNumber"]);
  const tech   = pick(r, ["tech", "technician", "fullName", "Full Name", "full_name", "assignedTo"]);
  const device = pick(r, ["device", "Catalog Item", "item", "itemName", "description", "repair", "lineItem", "Name"]);
  const note   = pick(r, ["note", "Note", "notes"]);
  const biz_date = normDate(pick(r, ["date", "biz_date", "accountedOn", "Accounted on Date", "accounted_on_date", "closedDate"]));
  return { store, ticket, tech, device, note: note || null, biz_date };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") return new Response("repairq-no-parts webhook is live", { status: 200 });
  if (req.method !== "POST") return J({ error: "method not allowed" }, 405);

  if (!SECRET) return J({ error: "webhook not configured: set the RQ_WEBHOOK_SECRET function secret" }, 500);
  const got = req.headers.get("x-rq-secret") || url.searchParams.get("secret") || "";
  if (got !== SECRET) return J({ error: "unauthorized" }, 401);

  let body: unknown;
  try { body = await req.json(); } catch { return J({ error: "invalid JSON body" }, 400); }

  let rows: Record<string, unknown>[];
  if (Array.isArray(body)) {
    rows = body as Record<string, unknown>[];
  } else {
    const b = body as Record<string, unknown>;
    // Looker webhook envelope (how RepairQ Analytics delivers): the report rows are a
    // JSON *string* in attachment.data (or inline in data). Parse that out first.
    const att = b.attachment as Record<string, unknown> | undefined;
    const rawStr = (att && typeof att.data === "string") ? att.data
                 : (typeof b.data === "string") ? (b.data as string) : null;
    if (rawStr !== null) {
      try { const p = JSON.parse(rawStr); rows = Array.isArray(p) ? p : [p]; }
      catch { rows = []; }
    } else {
      const inner = (b.rows || b.data || b.items || b.records) as Record<string, unknown>[] | undefined;
      rows = Array.isArray(inner) ? inner : [b];
    }
  }

  const recs: ReturnType<typeof mapRow>[] = [];
  const skipped: unknown[] = [];
  for (const r of rows) {
    const rec = mapRow(r as Record<string, unknown>);
    if (rec.store && rec.ticket && rec.biz_date) recs.push(rec);
    else skipped.push(r);
  }
  const mode = (url.searchParams.get("mode") || "replace").toLowerCase();
  let dateParam = url.searchParams.get("date");      // YYYY-MM-DD or "today" — replace this whole day (handles empty reports)
  const storeParam = url.searchParams.get("store");  // optional: scope the day-clear to one store
  const tzParam = url.searchParams.get("tz") || "America/Los_Angeles";  // for date=today; MUST match the RepairQ report's TZ
  if (dateParam && dateParam.toLowerCase() === "today") dateParam = todayIn(tzParam);

  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam))
    return J({ ok: false, error: "date must be YYYY-MM-DD or 'today'" }, 400);

  // Without an explicit ?date=, an empty payload is a no-op — we only ever clear days we can see.
  if (!recs.length && !dateParam) {
    return J({ ok: false, received: rows.length, written: 0, skipped: skipped.length,
      error: "no valid rows — each needs store, ticket and a date", sample: rows.slice(0, 2) }, 422);
  }

  if (mode === "upsert") {
    if (!recs.length) return J({ ok: true, mode, received: rows.length, written: 0, skipped: skipped.length });
    const { error } = await sb.from("repairs_no_parts").upsert(recs, { onConflict: "store,biz_date,ticket" });
    if (error) return J({ ok: false, error: error.message }, 500);
    return J({ ok: true, mode, received: rows.length, written: recs.length, skipped: skipped.length });
  }

  // ── replace mode ──────────────────────────────────────────────────────────
  // ?date= replaces that ENTIRE day (optionally for one ?store=), clearing it even
  // when the report is empty — so a store/day correctly drops to zero once every
  // ticket is fixed. This is the mode to use for the hourly snapshots.
  if (dateParam) {
    const nStore = storeParam ? normStore(storeParam) : null;
    let delq = sb.from("repairs_no_parts").delete().eq("biz_date", dateParam);
    if (nStore) delq = delq.eq("store", nStore);
    const del = await delq;
    if (del.error) return J({ ok: false, error: del.error.message }, 500);
    // insert this store's rows under whatever accounted date they carry (upsert = idempotent
    // across the hourly runs); the clear above used `date` so an empty report still zeroes the day.
    const toInsert = nStore ? recs.filter((r) => r.store === nStore) : recs;
    if (toInsert.length) {
      const ins = await sb.from("repairs_no_parts").upsert(toInsert, { onConflict: "store,biz_date,ticket" });
      if (ins.error) return J({ ok: false, error: ins.error.message }, 500);
    }
    return J({ ok: true, mode: "replace", date: dateParam, store: nStore ?? "(all stores)",
      received: rows.length, written: toInsert.length, skipped: skipped.length,
      ignored_other_store_rows: (nStore ? recs.length - toInsert.length : 0) || undefined });
  }

  // No ?date=: replace only the (store, day) groups present in this delivery.
  const groups = new Map<string, ReturnType<typeof mapRow>[]>();
  for (const r of recs) {
    const k = r.store + "|" + r.biz_date;
    (groups.get(k) || groups.set(k, []).get(k)!).push(r);
  }
  const errors: string[] = [];
  for (const [k, grp] of groups) {
    const [store, biz_date] = k.split("|");
    const del = await sb.from("repairs_no_parts").delete().eq("store", store).eq("biz_date", biz_date);
    if (del.error) { errors.push(`${k}: ${del.error.message}`); continue; }
    const ins = await sb.from("repairs_no_parts").insert(grp);
    if (ins.error) errors.push(`${k}: ${ins.error.message}`);
  }
  return J({
    ok: errors.length === 0, mode, received: rows.length, written: recs.length,
    groups: groups.size, skipped: skipped.length, errors: errors.length ? errors : undefined,
  }, errors.length ? 207 : 200);
});
