/* phone-bill — two jobs, both outside the owner-only RLS on phone_bill_*:

     POST { action:'view', phone }         → the payer's own read-only view.
       The phone number IS the credential (this is a friend tracking a shared
       cell plan, not store data): it must match phone_bill_config.payer_phone.
       Returns only what he needs — his months, his totals, the Zelle note —
       never the household's other lines, the bill totals, or the PDFs.

     POST { action:'rollover', secret }    → the monthly cron. Creates the row
       for any billing cycle whose service period has fully closed, so an
       unpaid month shows up on its own instead of waiting for someone to open
       the page. Amounts come from phone_bill_config.default_lines when set
       (the recurring amounts), else the previous month's, else blank.

   Everything else about phone bills stays in the owner-gated page. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

/** last 10 digits — how two people write the same number rarely matches byte for byte */
function digits(v: unknown): string {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}
function sum(lines: Record<string, unknown> | null): number {
  let t = 0;
  for (const k of Object.keys(lines || {})) { const n = Number((lines as any)[k]); if (Number.isFinite(n)) t += n; }
  return Math.round(t * 100) / 100;
}
function iso(d: Date): string {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
/** "today" in the owner's timezone — a cycle closes on a calendar day, not a UTC instant */
function todayPacific(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/* Insert every cycle whose service period has already ENDED. Never the cycle
   still in progress — that bill does not exist yet. */
async function rollover(): Promise<{ ok: boolean; created: string[] }> {
  const created: string[] = [];
  const { data: cfg } = await admin.from("phone_bill_config").select("default_lines").eq("id", true).maybeSingle();
  const defaults = (cfg?.default_lines && Object.keys(cfg.default_lines).length) ? cfg.default_lines : null;
  const today = todayPacific();
  for (let guard = 0; guard < 24; guard++) {
    const { data: latest } = await admin.from("phone_bill_months")
      .select("due_date, service_end, lines").order("due_date", { ascending: false }).limit(1).maybeSingle();
    if (!latest?.service_end) break;
    const s = new Date(latest.service_end + "T00:00:00Z"); s.setUTCDate(s.getUTCDate() + 1);
    const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate() - 1));
    if (today <= iso(e)) break;                       // cycle still running
    const due = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 8));
    const lines = defaults || latest.lines || {};
    const { data: row, error } = await admin.from("phone_bill_months").insert({
      due_date: iso(due), service_start: iso(s), service_end: iso(e),
      lines, payer_total: sum(lines), status: "unpaid",
    }).select("due_date").single();
    if (error) break;
    created.push(row.due_date);
  }
  return { ok: true, created };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");

  if (action === "rollover") {
    if (!NOTIFY_SECRET || String(body?.secret || "") !== NOTIFY_SECRET) return json({ error: "forbidden" }, 403);
    return json(await rollover());
  }

  if (action === "view") {
    const { data: cfg } = await admin.from("phone_bill_config")
      .select("payer_name, payer_phone, zelle_note").eq("id", true).maybeSingle();
    const want = digits(cfg?.payer_phone);
    const got = digits(body?.phone);
    if (!want || got.length < 10 || got !== want) return json({ error: "no_match" }, 403);
    const { data: rows } = await admin.from("phone_bill_months")
      .select("due_date, service_start, service_end, payer_total, lines, status, paid_at")
      .order("due_date", { ascending: false });
    const months = (rows || []).map((r) => ({
      due_date: r.due_date, service_start: r.service_start, service_end: r.service_end,
      amount: r.payer_total != null ? Number(r.payer_total) : sum(r.lines),
      status: r.status, paid_at: r.paid_at,
    }));
    return json({
      ok: true, name: cfg?.payer_name || null, zelle_note: cfg?.zelle_note || null, months,
    });
  }

  return json({ error: "bad_action" }, 400);
});
