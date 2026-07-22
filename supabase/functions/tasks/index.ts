// Checklist engine: turns task_templates into task_instances, one resolved person per day.
//   ?action=generate[&date=YYYY-MM-DD]  -> generate today's instances + auto-miss stale dailies
//
// Auth: ?secret=<NOTIFY_SECRET> (pg_cron) OR a signed-in user's JWT in Authorization
// (the Checklist page tops up on load so a template created mid-day appears immediately).
// Generation is idempotent: task_instances is unique on (template_id, gen_key).
//
// Assignment resolution (per design handoff):
//   person -> assignee; if they have approved time off that day and a fallback is set, fallback
//   shift  -> whoever's staff_schedule resolves to that shift at that store that weekday
//   role   -> unassigned; eligible = active staff at the store ('any') or admins ('manager')
//   group  -> strategy 'rotate': round-robin through pool starting at rotation_pos, skipping
//             people on time off (pointer advances past the chosen person); 'fixed': shared pool
//   completion 'each' -> unassigned; everyone in `eligible` must log a task_completions row.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" },
  });

/* ===== LA-local date helpers ===== */
const TZ = "America/Los_Angeles";
const ALERTS_FN = SB_URL + "/functions/v1/alerts";
function laTodayISO(): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // en-CA gives YYYY-MM-DD
}
function laOffset(dateISO: string): string {
  // UTC offset of LA at noon that day ('-07:00' or '-08:00')
  const probe = new Date(dateISO + "T12:00:00Z");
  const la = new Date(probe.toLocaleString("en-US", { timeZone: TZ }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  const min = Math.round((la.getTime() - utc.getTime()) / 60000);
  const sign = min < 0 ? "-" : "+", a = Math.abs(min);
  return sign + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0");
}
function dueAtISO(dateISO: string, hhmm: string): string {
  const t = /^\d{1,2}:\d{2}$/.test(hhmm || "") ? hhmm.padStart(5, "0") : "18:00";
  return new Date(`${dateISO}T${t}:00${laOffset(dateISO)}`).toISOString();
}
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function dowOf(iso: string): number { return new Date(iso + "T12:00:00Z").getUTCDay(); } // 0=Sun
function daysInMonth(iso: string): number { const [y, m] = iso.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function monthStart(iso: string): string { return iso.slice(0, 8) + "01"; }
function weekStartMon(iso: string): string { const dow = dowOf(iso); return addDays(iso, -((dow + 6) % 7)); } // Monday
function weekStartSun(iso: string): string { return addDays(iso, -dowOf(iso)); } // Sunday
function weeksBetween(aISO: string, bISO: string): number { return Math.round((Date.parse(weekStartSun(bISO) + "T00:00:00Z") - Date.parse(weekStartSun(aISO) + "T00:00:00Z")) / 604800000); }
function monthsBetween(aISO: string, bISO: string): number { const [ay, am] = aISO.split("-").map(Number); const [by, bm] = bISO.split("-").map(Number); return (by - ay) * 12 + (bm - am); }
// every-N interval gate: fire only on units divisible by the interval, never
// before the anchor. unit "week"|"month"; anchor falls back to created_at.
function intervalOn(recur: "week" | "month", interval: number, anchor: string, dateISO: string): boolean {
  if (interval <= 1) return true;
  const n = recur === "week" ? weeksBetween(anchor, dateISO) : monthsBetween(anchor, dateISO);
  return n >= 0 && n % interval === 0;
}

type Tpl = Record<string, any>;
type Staff = { id: number; display_name: string; role: string; home_store: string; active: boolean; hide_from_recurring: boolean };

function shortStore(s: string): string { return String(s || "").replace(/^CPR\s*/, ""); }

async function generate(dateISO: string) {
  const dow = dowOf(dateISO);
  const [tplR, stR, schR, shR, toR] = await Promise.all([
    admin.from("task_templates").select("*").eq("active", true),
    admin.from("staff").select("id,display_name,role,home_store,active,hide_from_recurring").eq("active", true),
    admin.from("staff_schedule").select("staff_id,store,shifts"),
    admin.from("shifts").select("id,name"),
    admin.from("time_off_requests").select("staff_id,status,start_date,end_date,partial_days").eq("status", "approved").lte("start_date", dateISO).gte("end_date", dateISO),
  ]);
  const tpls: Tpl[] = tplR.data || [];
  const staff: Staff[] = (stR.data || []) as Staff[];
  const staffById: Record<number, Staff> = {}; staff.forEach((s) => { staffById[s.id] = s; });
  const shiftName: Record<number, string> = {}; (shR.data || []).forEach((s: any) => { shiftName[s.id] = s.name; });
  // partial days (appointments etc.) don't count as off — they still work part of the shift
  const offToday = new Set((toR.data || []).filter((r: any) => !(r.partial_days && r.partial_days[dateISO])).map((r: any) => r.staff_id));

  // who works shift X at store Y today
  function shiftWorkers(shiftId: number, store: string): number[] {
    const out: number[] = [];
    for (const row of (schR.data || []) as any[]) {
      const v = (row.shifts || {})[String(dow)];
      if (v == null || v === "off") continue;
      const rec = typeof v === "string" ? { label: v } : v;
      if (rec.label === "Off") continue;
      let sid = rec.shift_id;
      if (sid == null && rec.label) {
        const m = (shR.data || []).find((s: any) => String(s.name).trim().toLowerCase() === String(rec.label).trim().toLowerCase());
        if (m) sid = m.id;
      }
      if (sid !== shiftId) continue;
      const st = rec.store || row.store;
      if (st !== store) continue;
      if (staffById[row.staff_id]) out.push(row.staff_id);
    }
    return out.sort((a, b) => a - b);
  }
  function storeStaff(store: string, managersOnly: boolean): number[] {
    return staff
      .filter((s) => s.home_store === store && s.role !== "owner" && !s.hide_from_recurring)
      .filter((s) => (managersOnly ? s.role === "admin" : true))
      .map((s) => s.id).sort((a, b) => a - b);
  }

  const rows: Record<string, any>[] = [];
  const rotBumps: Array<{ id: number; rotation_pos: number }> = [];

  for (const t of tpls) {
    // which gen_keys does this template want today?
    const wants: Array<{ key: string; taskDate: string; dueDate: string }> = [];
    // window_days: the task appears on its scheduled day but is DUE this many
    // days later (0 = same day). On-time keys off due_at, so completing any
    // day inside the window scores on-time — no false "late" in reporting.
    // Weekly/monthly only — dailies auto-close nightly, a window can't apply.
    const winDue = addDays(dateISO, Math.max(0, Math.min(14, Number(t.window_days) || 0)));
    if (t.recur === "daily") wants.push({ key: dateISO, taskDate: dateISO, dueDate: dateISO });
    else if (t.recur === "weekly") {
      // recur_interval > 1 = every-N-weeks (bi-weekly etc), counted from the
      // anchor week (or the template's creation week); see intervalOn.
      const anchor = String(t.recur_anchor || t.created_at || dateISO).slice(0, 10);
      if ((t.weekdays || []).includes(dow) && intervalOn("week", Number(t.recur_interval) || 1, anchor, dateISO))
        wants.push({ key: dateISO, taskDate: dateISO, dueDate: winDue });
    } else if (t.recur === "monthly") {
      const dim = daysInMonth(dateISO), day = Number(dateISO.slice(8, 10));
      const anchor = String(t.recur_anchor || t.created_at || dateISO).slice(0, 10);
      if ((t.month_dates || []).some((d: number) => Math.min(Number(d) || 0, dim) === day) && intervalOn("month", Number(t.recur_interval) || 1, anchor, dateISO))
        wants.push({ key: dateISO, taskDate: dateISO, dueDate: winDue });
    } else if (t.recur === "oneoff") {
      let due = dateISO;
      if (t.due_type === "date" && t.due_date) due = String(t.due_date).slice(0, 10);
      else if (t.due_type === "after" && t.due_after_n) {
        const mult = t.due_after_unit === "weeks" ? 7 : t.due_after_unit === "months" ? 30 : 1;
        due = addDays(String(t.created_at).slice(0, 10), Number(t.due_after_n) * mult);
      }
      wants.push({ key: "once", taskDate: dateISO, dueDate: due < dateISO ? dateISO : due });
    } else if (t.recur === "flexible") {
      const per = t.flex_per === "month" ? "month" : "week";
      const wStart = per === "week" ? weekStartMon(dateISO) : monthStart(dateISO);
      const len = per === "week" ? 7 : daysInMonth(dateISO);
      const n = Math.max(1, Math.min(14, Number(t.flex_n) || 1));
      for (let i = 1; i <= n; i++) {
        const dueDay = addDays(wStart, Math.ceil((i * len) / n) - 1);
        wants.push({ key: wStart + "#" + i, taskDate: dateISO, dueDate: dueDay < dateISO ? dateISO : dueDay });
      }
    }
    if (!wants.length) continue;

    // resolve assignment once per template per day. A per-weekday OVERRIDE in
    // day_assignments wins for that day (e.g. "weekdays → Mid shift, weekends →
    // Open shift"); otherwise the template's own target applies. `A` is the
    // effective assignment source; rotation state always stays on the template.
    const dayOv = (t.day_assignments && t.day_assignments[String(dow)]) || null;
    const A: any = dayOv ? { ...dayOv, store: t.store } : t;
    let assigned: number | null = null, kind = "Fixed", eligible: number[] = [];
    if (A.target === "person") {
      assigned = A.assignee_staff_id || null;
      if (assigned && offToday.has(assigned) && A.fallback_staff_id) assigned = A.fallback_staff_id;
      eligible = assigned ? [assigned] : [];
      kind = t.personal ? "Personal" : "Fixed";
    } else if (A.target === "shift") {
      const w = shiftWorkers(A.shift_id, t.store).filter((id) => !offToday.has(id));
      assigned = w[0] ?? null;
      eligible = w.length ? w : storeStaff(t.store, false);
      kind = (shiftName[A.shift_id] || "Shift") + " · " + shortStore(t.store);
    } else if (A.target === "role") {
      const mgr = A.role_key === "manager";
      eligible = storeStaff(t.store, mgr);
      assigned = null;
      kind = mgr ? "Manager" : "Any tech";
    } else if (A.target === "group") {
      const pool: number[] = (A.pool || []).filter((id: number) => staffById[id]);
      eligible = pool;
      if (A.strategy === "rotate" && pool.length) {
        const start = ((Number(t.rotation_pos) || 0) % pool.length + pool.length) % pool.length;
        let pick = -1;
        for (let i = 0; i < pool.length; i++) { const idx = (start + i) % pool.length; if (!offToday.has(pool[idx])) { pick = idx; break; } }
        if (pick < 0) pick = start;
        assigned = pool[pick];
        kind = "Rotating";
        // advance the pointer only when we actually create a new instance (checked below)
        (t as any).__nextPos = (pick + 1) % pool.length;
      } else { assigned = null; kind = "Group"; }
    }
    // completion 'each' is a template-level property (grid of everyone); an
    // override changing WHO is assigned still respects it.
    if (t.completion === "each") assigned = null;

    for (const w of wants) {
      rows.push({
        template_id: t.id, gen_key: w.key, store: t.store, task_date: w.taskDate,
        due_at: dueAtISO(w.dueDate, t.due_time), name: t.name, link_text: t.link_text, link_url: t.link_url,
        priority: t.priority, recur: t.recur, target: t.target, completion: t.completion, personal: !!t.personal,
        assign_kind: kind, assigned_staff_id: assigned, eligible,
      });
    }
  }

  // auto-miss: yesterday's (and older) still-open dailies close as missed — they regenerate fresh
  const missR = await admin.from("task_instances")
    .update({ status: "missed", on_time: false })
    .eq("status", "open").eq("recur", "daily").lt("task_date", dateISO).select("id");

  let created = 0;
  if (rows.length) {
    // insert only the ones that don't exist yet (idempotent on template_id+gen_key)
    const ins = await admin.from("task_instances").upsert(rows, { onConflict: "template_id,gen_key", ignoreDuplicates: true }).select("id,template_id");
    if (ins.error) return json({ ok: false, error: ins.error.message }, 500);
    created = (ins.data || []).length;
    // advance rotation pointers only for templates that actually got a fresh instance today
    const freshTpl = new Set((ins.data || []).map((r: any) => r.template_id));
    for (const t of tpls) {
      if ((t as any).__nextPos != null && freshTpl.has(t.id)) rotBumps.push({ id: t.id, rotation_pos: (t as any).__nextPos });
    }
    for (const b of rotBumps) await admin.from("task_templates").update({ rotation_pos: b.rotation_pos }).eq("id", b.id);
  }
  return json({ ok: true, date: dateISO, created, auto_missed: (missR.data || []).length, rotated: rotBumps.length });
}

/* ===== end-of-shift nudge =====
   Runs every 30 min (pg_cron). Anyone whose shift ends within the next 45
   minutes and still has open tasks gets ONE personal alert (feed + push/text
   per their prefs) for the day. Counted as "theirs": instances assigned to
   them, plus 'each'-completion instances they're eligible for and haven't
   completed. Unassigned any-pool tasks are deliberately NOT nudged (someone
   else may grab them — nudging everyone would be noise). */
async function nudge() {
  const dateISO = laTodayISO();
  const dow = dowOf(dateISO);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, hour: "2-digit", minute: "2-digit" })
    .format(new Date()).split(":").map(Number);
  const nowMin = hm[0] * 60 + hm[1];

  const [stR, schR, shR, hrR, toR] = await Promise.all([
    admin.from("staff").select("id,display_name,active").eq("active", true),
    admin.from("staff_schedule").select("staff_id,store,shifts"),
    admin.from("shifts").select("id,name"),
    admin.from("shift_hours").select("shift_id,store,weekday,start_min,end_min,closed,enabled"),
    admin.from("time_off_requests").select("staff_id,status,start_date,end_date,partial_days").eq("status", "approved").lte("start_date", dateISO).gte("end_date", dateISO),
  ]);
  const staffById: Record<number, { id: number; display_name: string }> = {};
  (stR.data || []).forEach((s: any) => { staffById[s.id] = s; });
  const offToday = new Set((toR.data || []).filter((r: any) => !(r.partial_days && r.partial_days[dateISO])).map((r: any) => r.staff_id));

  // resolve each working person's shift END minute today (weekday row beats the default)
  function endMin(shiftId: number, store: string): number | null {
    const rows = (hrR.data || []).filter((h: any) => h.shift_id === shiftId && h.store === store && h.enabled !== false);
    const day = rows.find((h: any) => h.weekday === dow);
    const pick = day || rows.find((h: any) => h.weekday == null);
    if (!pick || pick.closed || pick.end_min == null) return null;
    return Number(pick.end_min);
  }
  const endingSoon: Array<{ id: number; end: number }> = [];
  for (const row of (schR.data || []) as any[]) {
    if (!staffById[row.staff_id] || offToday.has(row.staff_id)) continue;
    const v = (row.shifts || {})[String(dow)];
    if (v == null || v === "off") continue;
    const rec = typeof v === "string" ? { label: v } : v;
    if (rec.label === "Off") continue;
    let sid = rec.shift_id;
    if (sid == null && rec.label) {
      const m = (shR.data || []).find((s: any) => String(s.name).trim().toLowerCase() === String(rec.label).trim().toLowerCase());
      if (m) sid = m.id;
    }
    if (sid == null) continue;
    const end = endMin(sid, rec.store || row.store);
    if (end == null) continue;
    const delta = end - nowMin;
    if (delta >= 0 && delta <= 45) endingSoon.push({ id: row.staff_id, end });
  }
  if (!endingSoon.length) return json({ ok: true, date: dateISO, now_min: nowMin, ending_soon: 0, nudged: 0 });

  // one nudge per person per day
  const keys = endingSoon.map((e) => `nudge:${e.id}:${dateISO}`);
  const lg = await admin.from("notify_log").select("dedupe_key").in("dedupe_key", keys);
  const seen = new Set((lg.data || []).map((x: any) => x.dedupe_key));
  const fresh = endingSoon.filter((e) => !seen.has(`nudge:${e.id}:${dateISO}`));
  if (!fresh.length) return json({ ok: true, date: dateISO, now_min: nowMin, ending_soon: endingSoon.length, nudged: 0, skipped: "already_nudged" });

  // open work due by end of today
  const eod = dueAtISO(dateISO, "23:59");
  const [instR, compR] = await Promise.all([
    admin.from("task_instances").select("id,name,completion,assigned_staff_id,eligible,status,due_at").eq("status", "open").lte("due_at", eod),
    admin.from("task_completions").select("instance_id,staff_id"),
  ]);
  const done = new Set((compR.data || []).map((c: any) => c.instance_id + ":" + c.staff_id));

  let nudged = 0;
  const results: Array<{ staff_id: number; open: number }> = [];
  for (const e of fresh) {
    const mine = (instR.data || []).filter((t: any) =>
      t.assigned_staff_id === e.id ||
      (t.completion === "each" && (t.eligible || []).includes(e.id) && !done.has(t.id + ":" + e.id)));
    results.push({ staff_id: e.id, open: mine.length });
    if (!mine.length) continue;
    const names = mine.slice(0, 3).map((t: any) => t.name).join(" · ") + (mine.length > 3 ? " …" : "");
    try {
      await fetch(ALERTS_FN, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", secret: NOTIFY_SECRET, staff_ids: [e.id], kind: "task",
          title: `✅ ${mine.length} task${mine.length === 1 ? "" : "s"} still open before you head out`,
          body: names, link: "checklist.html" }) });
      await admin.from("notify_log").insert({ dedupe_key: `nudge:${e.id}:${dateISO}`, kind: "task_nudge", staff_id: e.id, detail: `${mine.length} open` });
      nudged++;
    } catch (_) { /* next run retries — dedupe row only written on success */ }
  }
  return json({ ok: true, date: dateISO, now_min: nowMin, ending_soon: endingSoon.length, nudged, results });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const url = new URL(req.url);
  const secretOk = NOTIFY_SECRET && url.searchParams.get("secret") === NOTIFY_SECRET;
  let userOk = false;
  if (!secretOk) {
    const auth = req.headers.get("Authorization") || "";
    if (auth.startsWith("Bearer ")) {
      const anon = createClient(SB_URL, ANON, { auth: { persistSession: false } });
      const u = await anon.auth.getUser(auth.slice(7));
      userOk = !!u.data?.user;
    }
  }
  if (!secretOk && !userOk) return json({ ok: false, error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") || "generate";
  try {
    if (action === "nudge") {
      return await nudge();
    }
    if (action === "generate") {
      const date = url.searchParams.get("date") || laTodayISO();
      return await generate(date);
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err) }, 500);
  }
});
