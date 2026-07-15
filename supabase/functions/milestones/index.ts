// Milestone watcher: fires notifications when employees hit their monthly goals and
// ahead of work anniversaries. Runs on pg_cron; delivery goes through the notify
// function so the Settings › Notifications rules (enabled? routed where? keyword?)
// stay in charge:
//   ?action=goals          -> commission.goal_hit    (hourly)
//   ?action=anniversaries  -> records.anniversary    (daily)
//
// Idempotency: notify_log (dedupe_key pk). A hit is only logged after a successful
// send, so enabling the rule mid-month still announces this month's earlier hits on
// the next run. Auth: ?secret=<NOTIFY_SECRET> (same trust domain as notify).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const NOTIFY_FN = SB_URL + "/functions/v1/notify";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function monthISO(d: Date) { return d.toISOString().slice(0, 7) + "-01"; }
function isLeapYear(y: number) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

// personal alert (feed + push/SMS per prefs) via the alerts function — best effort
const ALERTS_FN = SB_URL + "/functions/v1/alerts";
async function sendAlert(staffIds: number[], kind: string, title: string, body: string, link?: string) {
  try {
    await fetch(ALERTS_FN, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", secret: NOTIFY_SECRET, staff_ids: staffIds, kind, title, body, link }) });
  } catch (_) { /* the manager channels above already delivered */ }
}

async function sendVia(eventKey: string, subject: string, text: string) {
  const r = await fetch(`${NOTIFY_FN}?secret=${encodeURIComponent(NOTIFY_SECRET)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", event_key: eventKey, subject, text }),
  });
  const d = await r.json().catch(() => ({}));
  // delivered only if the rule is enabled, routed, and at least one channel succeeded
  const delivered = !!(r.ok && d.ok && Array.isArray(d.results) && d.results.length);
  return { delivered, detail: d };
}

/* ===== goal hits ===== */
type Hit = { staffId: number; key: string; line: string };
const ATTACH_MIN_DEV = 5;  // attach % needs a real device count before it means anything

async function checkGoals() {
  const now = new Date(), mISO = monthISO(now), mKey = mISO.slice(0, 7);
  const [st, rs, gl, sl, lg] = await Promise.all([
    admin.from("staff").select("id,display_name,role,active").eq("active", true).neq("role", "owner"),
    admin.from("commission_roster").select("staff_id,accy_goal,commission_active"),
    admin.from("commission_goals").select("*").eq("month", mISO),
    admin.from("commission_sales").select("staff_id,accy_net,device_units,device_returns,device_attach,device_attach_return,categories,services")
      .gte("biz_date", mISO).lte("biz_date", ymd(now)),
    admin.from("notify_log").select("dedupe_key").like("dedupe_key", `goalhit:%:${mKey}:%`),
  ]);
  const roster: Record<number, { accy_goal: number; commission_active: boolean }> = {};
  (rs.data || []).forEach((r) => { roster[r.staff_id] = { accy_goal: Number(r.accy_goal) || 0, commission_active: r.commission_active !== false }; });
  const goals: Record<number, Record<string, unknown>> = {};
  (gl.data || []).forEach((g) => { goals[g.staff_id] = g; });
  const seen = new Set((lg.data || []).map((x) => x.dedupe_key));

  // month-to-date aggregates per person
  type Agg = { accy: number; dev: number; att: number; cats: Record<string, number>; svcs: Record<string, number> };
  const agg: Record<number, Agg> = {};
  (sl.data || []).forEach((r) => {
    if (r.staff_id == null) return;
    const a = agg[r.staff_id] || (agg[r.staff_id] = { accy: 0, dev: 0, att: 0, cats: {}, svcs: {} });
    a.accy += Number(r.accy_net) || 0;
    a.dev += (Number(r.device_units) || 0) - (Number(r.device_returns) || 0);
    a.att += (Number(r.device_attach) || 0) - (Number(r.device_attach_return) || 0);
    const ct = r.categories || {}; for (const k in ct) a.cats[k] = (a.cats[k] || 0) + (Number(ct[k]) || 0);
    const sv = r.services || {}; for (const k in sv) a.svcs[k] = (a.svcs[k] || 0) + (Number(sv[k]) || 0);
  });

  // service labels for readable lines
  const rates = await admin.from("commission_rates").select("sku,label");
  const skuLabel: Record<string, string> = {};
  (rates.data || []).forEach((r) => { skuLabel[r.sku] = r.label || r.sku; });

  const hits: Hit[] = [];
  for (const s of (st.data || [])) {
    const ros = roster[s.id];
    if (ros && !ros.commission_active) continue;
    const a = agg[s.id]; if (!a) continue;
    const g = goals[s.id] || {};
    const first = String(s.display_name || "").split(" ")[0];
    const add = (metric: string, line: string) => {
      const key = `goalhit:${s.id}:${mKey}:${metric}`;
      if (!seen.has(key)) hits.push({ staffId: s.id, key, line });
    };
    // accessory $: month goal wins, else roster default (matches the engine's resolution)
    const accyTgt = g.accy_goal != null ? Number(g.accy_goal) : (ros ? ros.accy_goal : 0);
    if (accyTgt > 0 && a.accy >= accyTgt) add("accy", `🎯 ${s.display_name} hit the accessory goal — ${money(a.accy)} of ${money(accyTgt)}`);
    if (g.device_goal != null && a.dev >= Number(g.device_goal)) add("device", `📱 ${first} hit the device target — ${a.dev} of ${g.device_goal} units`);
    if (g.device_attach_goal != null && a.dev >= ATTACH_MIN_DEV) {
      const cur = Math.round((a.att / a.dev) * 100);
      if (cur >= Number(g.device_attach_goal)) add("attach", `🔗 ${first} hit the accessories-per-device target — ${cur}% (goal ${g.device_attach_goal}%)`);
    }
    const cats: Array<[string, string, string]> = [["case_goal", "Case", "cases"], ["sp_goal", "Screen Protector", "screen protectors"], ["power_goal", "Power", "power"]];
    for (const [col, cat, label] of cats) {
      if (g[col] != null && (a.cats[cat] || 0) >= Number(g[col])) add(col, `🧩 ${first} hit the ${label} target — ${a.cats[cat] || 0} of ${g[col]}`);
    }
    const sgs = (g.service_goals || {}) as Record<string, number>;
    for (const sku in sgs) {
      const tgt = Number(sgs[sku]) || 0; if (!tgt) continue;
      if ((a.svcs[sku] || 0) >= tgt) add(`svc:${sku}`, `🛠 ${first} hit the ${skuLabel[sku] || sku} target — ${a.svcs[sku] || 0} of ${tgt}`);
    }
  }
  if (!hits.length) return json({ ok: true, hits: 0 });

  const mLabel = now.toLocaleString("en-US", { month: "long" });
  const subject = hits.length === 1 ? "Goal hit" : `${hits.length} goals hit`;
  const text = `${mLabel} goal${hits.length === 1 ? "" : "s"} reached:\n\n` + hits.map((h) => h.line).join("\n");
  const res = await sendVia("commission.goal_hit", subject, text);
  if (res.delivered) {
    await admin.from("notify_log").insert(hits.map((h) => ({ dedupe_key: h.key, kind: "goal_hit", staff_id: h.staffId, detail: h.line })));
    // personal push to each person who hit — their own lines only
    const byStaff: Record<number, string[]> = {};
    hits.forEach((h) => { (byStaff[h.staffId] = byStaff[h.staffId] || []).push(h.line); });
    for (const sid in byStaff) {
      await sendAlert([Number(sid)], "goal", "🎯 You hit a goal!", byStaff[sid].join("\n"), "commission-dashboard.html#goals");
    }
  }
  return json({ ok: true, hits: hits.length, delivered: res.delivered, notify: res.detail });
}

/* ===== work anniversaries + birthdays ===== */
const NUMWORD = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
async function checkAnniversaries() {
  const st = await admin.from("staff").select("id,display_name,start_date,birthday,active").eq("active", true);
  const today = new Date(); const todayISO = ymd(today);
  const in7 = new Date(today.getTime() + 7 * 86400000); const in7ISO = ymd(in7);
  const events: Hit[] = [];
  const posts: Array<{ source_key: string; kind: string; title: string; body: string }> = [];
  for (const s of (st.data || [])) {
    const first = String(s.display_name || "").split(" ")[0];
    // day-of birthday -> Communications feed post (in-app only, no email/Teams)
    if (s.birthday) {
      const bmd = String(s.birthday).slice(5, 10);
      if (bmd === todayISO.slice(5) || (bmd === "02-29" && todayISO.slice(5) === "02-28" && !isLeapYear(today.getFullYear()))) {
        posts.push({ source_key: `bday:${s.id}:${todayISO}`, kind: "birthday",
          title: `🎂 Happy birthday, ${first}!`,
          body: `It's ${s.display_name}'s birthday today — wish them a good one!` });
      }
    }
    if (!s.start_date) continue;
    const sd = String(s.start_date).slice(0, 10);
    const [sy, sm, sdd] = sd.split("-").map(Number);
    for (const [when, whenISO] of [["day", todayISO], ["wk", in7ISO]] as Array<[string, string]>) {
      const [ty, tm, td] = whenISO.split("-").map(Number);
      if (tm !== sm || td !== sdd) continue;
      const years = ty - sy; if (years < 1) continue;
      const key = `anniv:${s.id}:${whenISO}:${when}`;
      const nice = new Date(ty, tm - 1, td).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      if (when === "day") {
        posts.push({ source_key: `anniv:${s.id}:${todayISO}`, kind: "anniversary",
          title: `🎉 ${first} hits ${NUMWORD[years] || years} year${years === 1 ? "" : "s"} at CPR`,
          body: `${s.display_name} started on ${sd} — ${years} year${years === 1 ? "" : "s"} today. Congrats!` });
      }
      events.push({ staffId: s.id, key,
        line: when === "day"
          ? `🎉 ${s.display_name} hits ${years} year${years === 1 ? "" : "s"} at CPR today — started ${sd}`
          : `📅 Heads-up: ${s.display_name}'s ${years}-year anniversary is ${nice} — started ${sd}` });
    }
  }
  // feed posts first (idempotent on source_key); independent of the Teams rule below
  let posted = 0;
  if (posts.length) {
    const ins = await admin.from("communications").upsert(posts, { onConflict: "source_key", ignoreDuplicates: true }).select("id");
    posted = (ins.data || []).length;
    // fresh day-of posts also ping the PERSON directly (source_key carries staff id)
    for (const p of posts) {
      const sid = Number(String(p.source_key).split(":")[1]);
      if (!Number.isFinite(sid) || !posted) continue;
      if (p.kind === "birthday") await sendAlert([sid], "birthday", "🎂 Happy birthday!", "From all of us at CPR — have a great one!");
      if (p.kind === "anniversary") await sendAlert([sid], "anniversary", p.title.replace(/^🎉 /, "🎉 "), p.body);
    }
  }
  if (!events.length) return json({ ok: true, anniversaries: 0, feed_posts: posted });
  const lg = await admin.from("notify_log").select("dedupe_key").in("dedupe_key", events.map((e) => e.key));
  const seen = new Set((lg.data || []).map((x) => x.dedupe_key));
  const fresh = events.filter((e) => !seen.has(e.key));
  if (!fresh.length) return json({ ok: true, anniversaries: 0, skipped: "already_sent" });
  const subject = fresh.length === 1 ? "Work anniversary" : "Work anniversaries";
  const res = await sendVia("records.anniversary", subject, fresh.map((e) => e.line).join("\n"));
  if (res.delivered) {
    await admin.from("notify_log").insert(fresh.map((e) => ({ dedupe_key: e.key, kind: "anniversary", staff_id: e.staffId, detail: e.line })));
  }
  return json({ ok: true, anniversaries: fresh.length, delivered: res.delivered, notify: res.detail });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!NOTIFY_SECRET || url.searchParams.get("secret") !== NOTIFY_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") || "";
  try {
    if (action === "goals") return await checkGoals();
    if (action === "anniversaries") return await checkAnniversaries();
    return json({ ok: false, error: "unknown action (goals|anniversaries)" }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err) }, 500);
  }
});
