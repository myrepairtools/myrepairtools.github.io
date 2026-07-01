// holiday-sync — expands the recurring holiday_catalog into concrete dated `holidays`
// rows ~14 months ahead, and pre-fills each new instance's store hours from the SAME
// holiday's previous occurrence (Memorial Day -> last Memorial Day). New instances land
// hours_confirmed=false so the app can nudge the owner to confirm. Optionally emails a
// reminder for upcoming unconfirmed / bank holidays (dormant until an email key is set).
//
// Auth: owner JWT (Authorization: Bearer <session>) OR ?secret=<QBT_SYNC_SECRET> /
//        header x-qbt-secret (cron/server — reuses the existing sync secret).
//
// GET/POST ?action=seed   (default) -> expand catalog + pre-fill, returns {created,prefilled}
//          ?action=remind          -> compute + (if configured) send the reminder digest
//          ?action=daily           -> seed then remind (what the cron calls)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_SECRET = Deno.env.get("QBT_SYNC_SECRET") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const ALERT_TO = Deno.env.get("HOLIDAY_ALERT_TO") || "";       // comma-separated recipient emails
const ALERT_FROM = Deno.env.get("HOLIDAY_ALERT_FROM") || "CPR Holidays <onboarding@resend.dev>";
const LEAD_DAYS = Number(Deno.env.get("HOLIDAY_LEAD_DAYS") || "7");   // checklist / reminder window
const SEED_AHEAD_DAYS = 430;                                          // ~14 months

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-qbt-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function authed(req: Request): Promise<boolean> {
  const u = new URL(req.url);
  const secret = u.searchParams.get("secret") || req.headers.get("x-qbt-secret") || "";
  if (SYNC_SECRET && secret === SYNC_SECRET) return true;
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return false;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return false;
  const { data: s } = await admin.from("staff").select("role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return !!s && ["owner", "admin", "manager"].includes(s.role);
}

// ---- date math (all UTC to keep calendar dates stable across timezones) ----
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dowUTC = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
function nthWeekday(y: number, m: number, w: number, n: number): string {
  const first = dowUTC(y, m, 1);
  const day = 1 + ((w - first + 7) % 7) + 7 * (n - 1);
  return ymd(y, m, day);
}
function lastWeekday(y: number, m: number, w: number): string {
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = dowUTC(y, m, dim);
  return ymd(y, m, dim - ((last - w + 7) % 7));
}
function addDays(iso: string, off: number): string {
  const [Y, M, D] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D + off));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
// Anonymous Gregorian computus -> Easter Sunday
function easter(y: number): { month: number; day: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
    f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}
function computeDate(rule: string, y: number): string | null {
  const parts = rule.split(":");
  const type = parts[0];
  if (type === "FIXED") { const [mm, dd] = parts[1].split("-").map(Number); return ymd(y, mm, dd); }
  if (type === "NTH") return nthWeekday(y, +parts[3], +parts[2], +parts[1]);
  if (type === "LAST") return lastWeekday(y, +parts[2], +parts[1]);
  if (type === "EASTER") { const e = easter(y); return addDays(ymd(y, e.month, e.day), +(parts[1] || 0)); }
  if (type === "THANKS") return addDays(nthWeekday(y, 11, 4, 4), +(parts[1] || 0));
  return null;
}

function todayISO(): string {
  const n = new Date();
  return ymd(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}

// ---- seed: expand catalog into holidays ~14 months out ----
async function seed(): Promise<{ created: number; prefilled: number }> {
  const { data: cat } = await admin.from("holiday_catalog").select("id,name,rule,is_federal,observed,active").eq("active", true);
  const today = todayISO();
  const horizon = addDays(today, SEED_AHEAD_DAYS);
  const thisYear = Number(today.slice(0, 4));
  let created = 0, prefilled = 0;

  for (const c of (cat ?? [])) {
    for (const y of [thisYear, thisYear + 1, thisYear + 2]) {
      const date = computeDate(c.rule, y);
      if (!date || date < today || date > horizon) continue;
      // already seeded? (unique on catalog_id, holiday_date)
      const { data: exist } = await admin.from("holidays").select("id").eq("catalog_id", c.id).eq("holiday_date", date).maybeSingle();
      if (exist) continue;
      const { data: ins, error } = await admin.from("holidays")
        .insert({ catalog_id: c.id, name: c.name, holiday_date: date, is_federal: c.is_federal, hours_confirmed: false })
        .select("id").single();
      if (error || !ins) continue;
      created++;
      // pre-fill store hours from this holiday's previous occurrence, if any had hours
      if (c.observed) {
        const { data: prev } = await admin.from("holidays").select("id")
          .eq("catalog_id", c.id).lt("holiday_date", date).order("holiday_date", { ascending: false }).limit(1).maybeSingle();
        if (prev) {
          const { data: ph } = await admin.from("holiday_hours").select("store,closed,open_min,close_min").eq("holiday_id", prev.id);
          if (ph && ph.length) {
            await admin.from("holiday_hours").insert(ph.map((r) => ({
              holiday_id: ins.id, store: r.store, closed: r.closed, open_min: r.open_min, close_min: r.close_min,
            })));
            prefilled++;
          }
        }
      }
    }
  }
  return { created, prefilled };
}

// ---- remind: upcoming items needing attention within the lead window ----
async function remindPayload() {
  const today = todayISO();
  const until = addDays(today, LEAD_DAYS);
  const { data: hols } = await admin.from("holidays")
    .select("id,name,holiday_date,is_federal,hours_confirmed,catalog_id,catalog:holiday_catalog(observed)")
    .gte("holiday_date", today).lte("holiday_date", until).order("holiday_date");
  const needHours: any[] = [], bank: any[] = [];
  for (const h of (hols ?? [])) {
    const observed = h.catalog ? (h.catalog as any).observed : true;
    if (observed && !h.hours_confirmed) needHours.push(h);
    if (h.is_federal) bank.push(h);
  }
  return { window_days: LEAD_DAYS, needHours, bank };
}

async function sendEmail(subject: string, html: string): Promise<{ sent: boolean; reason?: string }> {
  if (!RESEND_KEY || !ALERT_TO) return { sent: false, reason: "email_not_configured" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: ALERT_FROM, to: ALERT_TO.split(",").map((s) => s.trim()), subject, html }),
  });
  return { sent: r.ok, reason: r.ok ? undefined : `resend_${r.status}` };
}

async function remind(send: boolean) {
  const p = await remindPayload();
  if (!send || (!p.needHours.length && !p.bank.length)) return { ...p, email: { sent: false, reason: "nothing_or_no_send" } };
  const li = (h: any, tail = "") => `<li><b>${h.name}</b> — ${h.holiday_date}${tail}</li>`;
  const html = `<h3>Holiday reminders (next ${p.window_days} days)</h3>` +
    (p.needHours.length ? `<p><b>Store hours need confirming:</b></p><ul>${p.needHours.map((h) => li(h)).join("")}</ul>` : "") +
    (p.bank.length ? `<p><b>Bank holidays (check payroll timing):</b></p><ul>${p.bank.map((h) => li(h, " — federal")).join("")}</ul>` : "");
  const email = await sendEmail("CPR — upcoming holidays need attention", html);
  return { ...p, email };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({}, 200);
  if (!(await authed(req))) return json({ error: "forbidden" }, 403);
  const action = new URL(req.url).searchParams.get("action") || "seed";
  try {
    if (action === "remind") return json({ ok: true, ...(await remind(true)) });
    if (action === "daily") {
      const s = await seed();
      const r = await remind(true);
      return json({ ok: true, seed: s, remind: r });
    }
    // default: seed (owner can trigger on demand to populate immediately)
    return json({ ok: true, ...(await seed()) });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
