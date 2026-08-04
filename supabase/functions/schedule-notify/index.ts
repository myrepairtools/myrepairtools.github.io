// schedule-notify — Saturday heads-up: if an employee's UPCOMING week differs
// from their standard recurring schedule, send them a personal notification
// (kind 'schedule_preview', preference-respecting) listing what changed.
//
//   POST { action:'weekly', secret }            (NOTIFY_SECRET — cron)
//   POST { action:'weekly', dry_run:true }      (admin/owner JWT) -> compute only
//         optional { anchor:'YYYY-MM-DD' }       -> pick the week from this date
//                                                   (defaults to "today" Pacific)
//
// "Different" = a schedule_overrides row for a date in the upcoming week whose
// store / shift / off-status differs from that weekday's recurring cell. Time
// off is NOT an override, so a self-requested PTO day never triggers this.
// Deduped once per person per week via notify_log (schedwk:<staff>:<weekStart>).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const ALERTS_FN = SB_URL + "/functions/v1/alerts";
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const laDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
// day-of-week (0=Sun) for a plain YYYY-MM-DD, timezone-agnostic (noon avoids DST edges)
const dow = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();
const addDays = (iso: string, n: number) => {
  const t = new Date(iso + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const shortStore = (s: string | null) => (s || "").replace(/^CPR\s+/, "") || "—";
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const prettyDay = (iso: string) => {
  const p = iso.split("-").map(Number);
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][p[1] - 1];
  return WD[dow(iso)] + " " + mo + " " + p[2];
};

type Cell = { off: boolean; store?: string | null; shift_id?: number | null; away?: boolean };
function normRec(v: any): Cell {
  if (!v || typeof v !== "object") return { off: true };
  if (v.off === true) return { off: true };
  if (v.label === "Off" && v.shift_id == null) return { off: true };
  if (v.away) return { off: false, store: v.store ?? null, shift_id: null, away: true };
  if (v.shift_id != null) return { off: false, store: v.store ?? null, shift_id: v.shift_id };
  if (v.store) return { off: false, store: v.store, shift_id: null };
  return { off: true };
}
function normOvr(o: any): Cell {
  if (o.is_off) return { off: true };
  return { off: false, store: o.store ?? null, shift_id: o.shift_id != null ? o.shift_id : null };
}
function differs(rec: Cell, ovr: Cell): boolean {
  if (rec.off !== ovr.off) return true;
  if (!rec.off && !ovr.off) {
    if ((rec.store || "") !== (ovr.store || "")) return true;
    if ((rec.shift_id ?? null) !== (ovr.shift_id ?? null)) return true;
  }
  return false;
}

async function callerOk(req: Request, body: Record<string, unknown>): Promise<boolean> {
  if (SECRET && body.secret === SECRET) return true;
  const u = new URL(req.url);
  if (SECRET && u.searchParams.get("secret") === SECRET) return true;
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return false;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return false;
  const { data: s } = await admin.from("staff").select("role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return !!s && ["admin", "manager", "owner"].includes(String(s.role));
}

async function runWeekly(anchor: string, dryRun: boolean) {
  // Upcoming week = the coming Sunday (on a Saturday run, that's tomorrow) .. +6.
  const aDow = dow(anchor);
  const daysToSun = (7 - aDow) % 7 || 7;         // strictly the NEXT Sunday
  const weekStart = addDays(anchor, daysToSun);
  const weekEnd = addDays(weekStart, 6);
  const weekDates: string[] = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const [{ data: staff }, { data: sched }, { data: ovrs }, { data: shifts }, { data: pto }] = await Promise.all([
    admin.from("staff").select("id, display_name, active, hide_from_recurring").eq("active", true),
    admin.from("staff_schedule").select("staff_id, shifts"),
    admin.from("schedule_overrides").select("staff_id, ovr_date, is_off, store, shift_id")
      .gte("ovr_date", weekStart).lte("ovr_date", weekEnd),
    admin.from("shifts").select("id, name"),
    admin.from("time_off_requests").select("staff_id, start_date, end_date, partial_days")
      .eq("status", "approved").lte("start_date", weekEnd).gte("end_date", weekStart),
  ]);
  // full-day PTO per staff (partial days still work — site convention) → a manager
  // "off" override that only mirrors the person's own approved time off is skipped.
  const ptoOff = new Map<number, Set<string>>();
  for (const t of (pto || [])) {
    const set = ptoOff.get(Number(t.staff_id)) || ptoOff.set(Number(t.staff_id), new Set()).get(Number(t.staff_id))!;
    const partial = new Set(Object.keys((t as any).partial_days || {}));
    for (let d = t.start_date; d <= t.end_date; d = addDays(d, 1)) if (!partial.has(d)) set.add(d);
  }
  const shiftName = new Map<number, string>((shifts || []).map((s: any) => [Number(s.id), s.name]));
  const recBy = new Map<number, any>((sched || []).map((r: any) => [Number(r.staff_id), r.shifts || {}]));
  const staffBy = new Map<number, any>((staff || []).map((s: any) => [Number(s.id), s]));
  const shName = (id: number | null | undefined) => (id != null && shiftName.get(id)) || "shift";

  // group overrides by staff
  const byStaff = new Map<number, any[]>();
  for (const o of (ovrs || [])) {
    const s = staffBy.get(Number(o.staff_id));
    if (!s || s.hide_from_recurring) continue;             // skip flex staff (e.g. owner)
    (byStaff.get(Number(o.staff_id)) || byStaff.set(Number(o.staff_id), []).get(Number(o.staff_id))!).push(o);
  }

  const affected: Array<{ id: number; name: string; lines: string[] }> = [];
  for (const [sid, list] of byStaff) {
    const rec = recBy.get(sid) || {};
    const lines: string[] = [];
    for (const o of list.sort((a: any, b: any) => a.ovr_date < b.ovr_date ? -1 : 1)) {
      const wd = dow(o.ovr_date);
      const r = normRec(rec[String(wd)]);
      const v = normOvr(o);
      if (!differs(r, v)) continue;
      // an "off" override that just mirrors the person's own approved PTO — they
      // already know; don't nag (owner's "skip self time off" preference).
      if (v.off && ptoOff.get(sid)?.has(o.ovr_date)) continue;
      const day = prettyDay(o.ovr_date);
      let phrase: string;
      if (v.off && !r.off) phrase = `${day}: OFF (normally working)`;
      else if (!v.off && r.off) phrase = `${day}: working ${shName(v.shift_id)} at ${shortStore(v.store!)} (normally off)`;
      else if ((r.store || "") !== (v.store || "")) phrase = `${day}: at ${shortStore(v.store!)} (normally ${shortStore(r.store!)})`;
      else phrase = `${day}: ${shName(v.shift_id)} (was ${shName(r.shift_id)})`;
      lines.push(phrase);
    }
    if (lines.length) affected.push({ id: sid, name: staffBy.get(sid)?.display_name || ("#" + sid), lines });
  }

  if (dryRun) {
    return { ok: true, dry_run: true, week_start: weekStart, week_end: weekEnd, affected_count: affected.length, affected };
  }

  // dedupe: one heads-up per person per week
  const keyFor = (id: number) => `schedwk:${id}:${weekStart}`;
  const keys = affected.map((a) => keyFor(a.id));
  const seen = new Set<string>();
  if (keys.length) {
    const lg = await admin.from("notify_log").select("dedupe_key").in("dedupe_key", keys);
    (lg.data || []).forEach((x: any) => seen.add(x.dedupe_key));
  }
  const fresh = affected.filter((a) => !seen.has(keyFor(a.id)));

  let sent = 0;
  const results: any[] = [];
  for (const a of fresh) {
    const title = "Your schedule next week is different";
    const body = a.lines.join("\n") + "\nOpen My Time for the full week.";
    try {
      const r = await fetch(ALERTS_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE, apikey: SERVICE },
        body: JSON.stringify({ action: "send", secret: SECRET, staff_ids: [a.id], kind: "schedule_preview", title, body, link: "my-schedule.html" }),
        signal: AbortSignal.timeout(20_000),
      });
      const ok = r.ok;
      results.push({ id: a.id, name: a.name, days: a.lines.length, ok });
      if (ok) {
        await admin.from("notify_log").insert({ dedupe_key: keyFor(a.id), kind: "schedule_preview", staff_id: a.id, detail: a.lines.length + " day(s)" });
        sent++;
      }
    } catch (e) {
      results.push({ id: a.id, name: a.name, error: String((e as Error).message || e) });
    }
  }
  return { ok: true, week_start: weekStart, week_end: weekEnd, affected_count: affected.length, sent, skipped_deduped: affected.length - fresh.length, results };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let body: Record<string, unknown> = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { /* empty */ } }
  const u = new URL(req.url);
  const action = String(body.action || u.searchParams.get("action") || "weekly");

  if (action === "ping") return json({ ok: true });
  if (!(await callerOk(req, body))) return json({ error: "forbidden" }, 403);

  if (action === "weekly") {
    const anchor = String(body.anchor || u.searchParams.get("anchor") || laDate());
    const dryRun = body.dry_run === true || u.searchParams.get("dry_run") === "1";
    return json(await runWeekly(anchor, dryRun));
  }
  return json({ error: "unknown_action" }, 400);
});
