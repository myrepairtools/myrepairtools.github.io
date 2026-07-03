// LCD Buyback capture feed — the myRepairTools Chrome extension's server side.
//
// When a tech adds an iPhone / Galaxy S / Galaxy Note / Pixel screen-repair SKU
// to a RepairQ ticket, the extension pops a Good/Bad OLED modal and POSTs the
// answer here; the row lands in lcd_displays keyed by the RepairQ ticket number
// (which is also the display's serial + QR content on the Dymo 30334 send
// label). The label printer content script reads the record back at
// /ticket/printLabel time to stamp + append the send-display label.
//
// Actions (?action=):
//   capture — POST { ticket_no, item_key?, store, model, item_name?,
//                    status: 'good'|'bad', graded_by? }
//             Upserts on (ticket_no, item_key). A changed status appends to
//             status_history. store accepts RepairQ locationName
//             ("CPR Clackamas OR") and resolves against the stores table.
//   get     — ?ticket=16147720 → { rows: [...] } for that ticket (label print).
//   printed — POST { ticket_no, item_key? } → bumps label_prints.
//   status  — sanity: row counts per store for the current month.
//
// Auth: header x-cpr-secret or ?secret= must equal the LCD_SECRET function
// secret (same pattern as square-tips). Writes use the service role — RLS on
// lcd_displays stays manager-only for status edits from the site.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("LCD_SECRET") || "";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cpr-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function authed(req: Request, url: URL): boolean {
  if (!SECRET) return false;
  return req.headers.get("x-cpr-secret") === SECRET || url.searchParams.get("secret") === SECRET;
}

/* ---------- store name resolution (same idea as square-tips) ---------- */
let STORE_CACHE: string[] | null = null;
async function storeNames(): Promise<string[]> {
  if (STORE_CACHE) return STORE_CACHE;
  const { data } = await admin.from("stores").select("store");
  STORE_CACHE = (data || []).map((r) => String(r.store)).filter(Boolean);
  return STORE_CACHE;
}
async function resolveStore(name: string): Promise<string | null> {
  const stores = await storeNames();
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  for (const s of stores) if (s.toLowerCase() === n) return s;
  for (const s of stores) {
    const keys = s.toLowerCase().split(/\s+/).filter((w) => w !== "cpr" && w.length >= 4);
    if (keys.some((k) => n.includes(k))) return s;
  }
  return null;
}

/* ---------- tech name → staff row ---------- */
async function resolveStaff(name: string): Promise<number | null> {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  const { data } = await admin.from("staff")
    .select("id,display_name,first_name,last_name,preferred_name")
    .eq("active", true);
  for (const s of data || []) {
    const full = `${s.first_name || ""} ${s.last_name || ""}`.trim().toLowerCase();
    const pref = `${s.preferred_name || ""} ${s.last_name || ""}`.trim().toLowerCase();
    if ([String(s.display_name || "").toLowerCase(), full, pref].includes(n)) return Number(s.id);
  }
  // last resort: unique first-token match ("Corey" → Corey Bates)
  const first = n.split(/\s+/)[0];
  const hits = (data || []).filter((s) =>
    [s.display_name, s.first_name, s.preferred_name]
      .some((v) => String(v || "").toLowerCase().split(/\s+/)[0] === first));
  return hits.length === 1 ? Number(hits[0].id) : null;
}

async function capture(body: Record<string, unknown>) {
  const ticket = String(body.ticket_no || "").replace(/\D/g, "");
  const status = String(body.status || "").toLowerCase();
  if (!ticket) return json({ ok: false, error: "ticket_no required" }, 400);
  if (status !== "good" && status !== "bad") return json({ ok: false, error: "status must be good|bad" }, 400);
  const store = await resolveStore(String(body.store || ""));
  if (!store) return json({ ok: false, error: "unknown store: " + body.store }, 400);

  const itemKey = String(body.item_key || "");
  const gradedBy = String(body.graded_by || "").trim() || null;
  const row = {
    ticket_no: ticket,
    item_key: itemKey,
    store,
    model: String(body.model || "").trim() || "Unknown device",
    item_name: String(body.item_name || "").trim() || null,
    status,
    graded_by: gradedBy,
    staff_id: gradedBy ? await resolveStaff(gradedBy) : null,
    source: "extension",
  };

  const { data: existing } = await admin.from("lcd_displays")
    .select("id,status,status_history").eq("ticket_no", ticket).eq("item_key", itemKey).maybeSingle();

  if (existing) {
    const patch: Record<string, unknown> = {
      model: row.model, item_name: row.item_name, store,
      graded_by: row.graded_by ?? undefined, staff_id: row.staff_id ?? undefined,
    };
    if (existing.status !== status) {
      patch.status = status;
      patch.status_history = [
        ...(Array.isArray(existing.status_history) ? existing.status_history : []),
        { from: existing.status, to: status, by: gradedBy || "extension", at: new Date().toISOString() },
      ];
    }
    const { data, error } = await admin.from("lcd_displays").update(patch).eq("id", existing.id).select().single();
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, row: data, updated: true });
  }

  const { data, error } = await admin.from("lcd_displays").insert(row).select().single();
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, row: data, created: true });
}

async function getForTicket(url: URL) {
  const ticket = String(url.searchParams.get("ticket") || "").replace(/\D/g, "");
  if (!ticket) return json({ ok: false, error: "ticket required" }, 400);
  const { data, error } = await admin.from("lcd_displays")
    .select("id,ticket_no,item_key,store,model,item_name,status,graded_by,captured_at,label_prints")
    .eq("ticket_no", ticket).eq("deleted", false).order("id");
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, rows: data || [] });
}

async function printed(body: Record<string, unknown>) {
  const ticket = String(body.ticket_no || "").replace(/\D/g, "");
  const itemKey = String(body.item_key || "");
  if (!ticket) return json({ ok: false, error: "ticket_no required" }, 400);
  const { data } = await admin.from("lcd_displays")
    .select("id,label_prints").eq("ticket_no", ticket).eq("item_key", itemKey).maybeSingle();
  if (!data) return json({ ok: false, error: "not found" }, 404);
  await admin.from("lcd_displays").update({ label_prints: (Number(data.label_prints) || 0) + 1 }).eq("id", data.id);
  return json({ ok: true });
}

async function statusReport() {
  const month = new Date().toISOString().slice(0, 7);
  const { data } = await admin.from("lcd_displays")
    .select("store,status").gte("captured_at", month + "-01").eq("deleted", false);
  const by: Record<string, { good: number; bad: number }> = {};
  for (const r of data || []) {
    const b = (by[r.store] ||= { good: 0, bad: 0 });
    if (r.status === "good") b.good++; else b.bad++;
  }
  return json({ ok: true, month, stores: by });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (!authed(req, url)) return json({ ok: false, error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") || "";
  try {
    if (action === "capture") return await capture(await req.json());
    if (action === "get") return await getForTicket(url);
    if (action === "printed") return await printed(await req.json());
    if (action === "status") return await statusReport();
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
