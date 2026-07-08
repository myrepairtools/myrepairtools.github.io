// ai-compose — help staff write better customer text messages (myRepairTools)
//
// Server-side so ANTHROPIC_API_KEY never touches the browser (same rule as
// cpr-assistant). Powers the RingCentral panel's compose box and the site
// CPR Assistant.
//
// Actions (POST JSON):
//   (no action) { text, mode?:'polish'|'draft', tone?, customer_name?, store? }
//        → { ok, message }  — legacy quick polish/draft of a rough note.
//   { action:'templates' }
//        → { ok, templates }  — active compose scenarios (owner-configured).
//   { action:'guided_questions', scenario_id, note?, customer_name? }
//        → { ok, scenario, questions }  — the scenario's base questions PLUS,
//          if the scenario allows it, up to 2 AI follow-up questions tailored
//          to the note. (The hybrid: owner templates + smart follow-ups.)
//   { action:'guided_compose', scenario_id, answers, customer_name?, store? }
//        → { ok, message }  — compose the customer text from the answers.
//
// Secret: ANTHROPIC_API_KEY (shared project secret). Deploy verify_jwt OFF.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = "claude-haiku-4-5-20251001";   // fast + cheap; rewrite / short-form task
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM =
  "You help phone-repair shop staff write SMS messages to customers. Write ONE text " +
  "message that is warm, professional, and clear. Rules: keep it SHORT (SMS length, " +
  "ideally under 320 characters); plain American English; light emoji only if it fits; " +
  "NEVER invent facts, prices, dates, or promises that aren't in the input; keep the " +
  "customer's name if given; sound like a friendly local repair shop, not a corporation. " +
  "Output ONLY the message text — no quotes, no preamble, no options, no explanation.";

async function anthropic(system: string, user: string, maxTokens = 500): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, error: data?.error?.message || `HTTP ${r.status}` };
    const text = (data?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

function answersToLines(scenario: any, answers: Record<string, any>): string {
  const qs: any[] = Array.isArray(scenario?.questions) ? scenario.questions : [];
  const byKey: Record<string, string> = {};
  qs.forEach((q) => { byKey[q.key] = q.label; });
  const lines: string[] = [];
  for (const k of Object.keys(answers || {})) {
    const v = String(answers[k] == null ? "" : answers[k]).trim();
    if (!v) continue;
    lines.push(`- ${byKey[k] || k}: ${v}`);
  }
  return lines.join("\n");
}

async function getScenario(id: any) {
  const { data } = await admin.from("compose_templates").select("*").eq("id", Number(id)).eq("active", true).maybeSingle();
  return data;
}

/* ---------------- actions ---------------- */

async function actionTemplates() {
  const { data, error } = await admin.from("compose_templates").select("id,name,description,icon,questions,ai_followups,sort")
    .eq("active", true).order("sort", { ascending: true });
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, templates: data || [] });
}

async function actionGuidedQuestions(p: any) {
  const scenario = await getScenario(p?.scenario_id);
  if (!scenario) return json({ ok: false, error: "scenario not found" }, 404);
  const base: any[] = Array.isArray(scenario.questions) ? scenario.questions : [];
  let followups: any[] = [];
  const note = String(p?.note || "").trim();
  if (scenario.ai_followups && KEY) {
    const sys = "You help a phone-repair shop write a great customer text. Given a scenario and the " +
      "employee's rough note, list UP TO 2 short extra questions (only if genuinely useful and NOT already " +
      "covered by the base questions) that would make the message better. Return STRICT JSON: " +
      '{"questions":[{"key":"snake_case","label":"short question","type":"text"}]} — empty array if none needed.';
    const usr = `Scenario: ${scenario.name} — ${scenario.instruction || ""}\n` +
      `Base questions already asked: ${base.map((q) => q.label).join("; ")}\n` +
      `Employee note: ${note || "(none)"}\n\nReturn the JSON only.`;
    const r = await anthropic(sys, usr, 300);
    if (r.ok && r.text) {
      try {
        const m = r.text.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : {};
        followups = (parsed.questions || []).slice(0, 2).filter((q: any) => q && q.label).map((q: any) => ({
          key: String(q.key || ("extra_" + Math.abs(hash(q.label)))), label: String(q.label), type: "text", ai: true,
        }));
      } catch { /* ignore bad json */ }
    }
  }
  // dedupe follow-ups whose key collides with a base question
  const baseKeys = new Set(base.map((q) => q.key));
  followups = followups.filter((q) => !baseKeys.has(q.key));
  return json({ ok: true, scenario: { id: scenario.id, name: scenario.name, icon: scenario.icon }, questions: base.concat(followups) });
}

function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

async function actionGuidedCompose(p: any) {
  const scenario = await getScenario(p?.scenario_id);
  if (!scenario) return json({ ok: false, error: "scenario not found" }, 404);
  const lines = answersToLines(scenario, p?.answers || {});
  const bits: string[] = [];
  if (p?.customer_name) bits.push(`Customer name: ${String(p.customer_name).trim()}`);
  if (p?.store) bits.push(`Store: ${String(p.store).trim()}`);
  if (scenario.tone) bits.push(`Tone: ${scenario.tone}`);
  const ctx = bits.length ? `\n\nContext:\n${bits.join("\n")}` : "";
  const usr = `Scenario: ${scenario.name}.\n${scenario.instruction || ""}\n\n` +
    `Here's what the employee told us:\n${lines || "(no details given)"}${ctx}\n\nWrite the customer text message.`;
  const r = await anthropic(SYSTEM, usr, 500);
  if (!r.ok) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, message: (r.text || "").replace(/^["']|["']$/g, "") });
}

// legacy quick polish / draft
async function actionQuick(p: any) {
  const text = String(p?.text || "").trim();
  if (!text) return json({ ok: false, error: "text required" }, 400);
  const mode = p?.mode === "draft" ? "draft" : "polish";
  const bits: string[] = [];
  if (p?.customer_name) bits.push(`Customer name: ${String(p.customer_name).trim()}`);
  if (p?.store) bits.push(`Store: ${String(p.store).trim()}`);
  if (p?.tone) bits.push(`Tone: ${String(p.tone).trim()}`);
  const ctx = bits.length ? `\n\nContext:\n${bits.join("\n")}` : "";
  const usr = mode === "draft"
    ? `Write a customer text message based on this note:\n\n${text}${ctx}`
    : `Polish this rough customer text message so it reads well — keep the meaning, fix tone/grammar/clarity:\n\n${text}${ctx}`;
  const r = await anthropic(SYSTEM, usr, 400);
  if (!r.ok) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, message: (r.text || "").replace(/^["']|["']$/g, "") });
}

/* ---------------- entry ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, 500);
  let p: any = {};
  try { p = await req.json(); } catch { /* empty */ }
  try {
    if (p?.action === "templates") return await actionTemplates();
    if (p?.action === "guided_questions") return await actionGuidedQuestions(p);
    if (p?.action === "guided_compose") return await actionGuidedCompose(p);
    return await actionQuick(p);   // default: legacy polish/draft
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
