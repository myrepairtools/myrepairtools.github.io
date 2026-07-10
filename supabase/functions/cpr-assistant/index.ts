// cpr-assistant — Supabase Edge Function (CPR Oregon AI assistant proxy).
//
// Holds ANTHROPIC_API_KEY server-side (never shipped to the browser) and proxies
// chat to the Anthropic Messages API, streaming the response back as SSE.
//
// Auth: the caller must present a valid CPR staff session (the same Supabase JWT
// the PIN login issues). We verify it, identify the staff member for personalization,
// and refuse anyone who isn't active staff.
//
// DEPLOY NOTE: must be deployed with verify_jwt:false (auth is enforced in-code, and
// the browser sends the user access token in the Authorization header).
//
// Phase 1: chat only. Phase 1.5 (now): Knowledge Base RAG — before each reply we
// full-text-search kb_articles for the user's question and inject the top
// matches into the system prompt with citation instructions, so the assistant
// answers from OUR docs (streaming stays a pure pass-through; a full tool-use
// loop can replace this later without schema changes). Phase 2 adds read-only
// query tools; Phase 3 adds permission-checked, confirm-gated writes. CLAUDE.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB_URL = Deno.env.get("SUPABASE_URL");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const admin = createClient(SB_URL, SERVICE, {
  auth: {
    persistSession: false
  }
});
// Only these models may be requested from the browser (cost/abuse guard).
const ALLOWED_MODELS = new Set([
  "claude-opus-4-8",
  "claude-haiku-4-5"
]);
const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_TOKENS = 4096;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (b, s = 200)=>new Response(JSON.stringify(b), {
    status: s,
    headers: {
      ...CORS,
      "Content-Type": "application/json"
    }
  });
// ---- Knowledge Base retrieval (permission-aware: employees never see manager-only articles) ----
const KB_URL = "https://myrepairtools.github.io/knowledge.html";
function isMgrRole(role) {
  return ["manager", "admin", "owner"].includes(String(role || ""));
}
async function kbRetrieve(question, staff) {
  const q = String(question || "").trim();
  if (q.length < 4) return [];
  try {
    // kb_retrieve: strict websearch match ranked first, loose OR fallback so
    // natural questions still hit ("...water damaged phone?" finds articles
    // that never say "phone"). Manager-only articles only for managers.
    const { data } = await admin.rpc("kb_retrieve", {
      q,
      mgr: isMgrRole(staff?.role),
      max_results: 4
    });
    return (data || []).map((a) => ({
      slug: a.slug,
      title: a.title,
      summary: a.summary || "",
      body: String(a.body || "").slice(0, 2600)
    }));
  } catch {
    return [];
  }
}
function kbBlock(articles) {
  if (!articles.length) return "";
  const docs = articles.map((a, i) =>
    `<article index="${i + 1}" title="${a.title}" link="${KB_URL}#a=${a.slug}">\n${a.summary ? a.summary + "\n" : ""}${a.body}\n</article>`
  ).join("\n\n");
  return [
    "",
    "KNOWLEDGE BASE — CPR Oregon's own documentation, retrieved for this question:",
    docs,
    "",
    "Rules for using the Knowledge Base:",
    "- When these articles answer the question, answer FROM them — they are company policy and beat your general knowledge.",
    "- Cite what you used at the end of your reply, one per line, as: `from: [<article title>](<link>)` using the link attribute above.",
    "- If the articles don't cover the question, say the Knowledge Base doesn't cover it yet, then answer from general knowledge (clearly as such). Never invent company policy.",
  ].join("\n");
}
function systemPrompt(staff) {
  const name = staff?.display_name || "a CPR team member";
  const role = staff?.role || "team member";
  const store = staff?.home_store ? ` based at ${staff.home_store}` : "";
  return [
    "You are the CPR Assistant, an AI helper embedded in the internal web tools of CPR Oregon, a phone- and device-repair business.",
    "CPR Oregon runs three stores: Eugene, Salem Northeast, and Clackamas.",
    `You are currently helping ${name}, whose role is ${role}${store}.`,
    "",
    "You help the team with:",
    "- Drafting clear, friendly, professional replies to customers (match a warm, helpful repair-shop voice).",
    "- Analyzing iPhone panic logs, crash/diagnostic dumps, and error output to identify the likely failure (e.g. which IC, baseband, power, display, or board-level fault).",
    "- Repair process, part identification, pricing logic, and general technical questions.",
    "",
    "Guidelines:",
    "- Be concise and practical — you are shown in a small chat window. Lead with the answer, then brief supporting detail. Use short paragraphs and simple bullet lists. No LaTeX.",
    "- You have access to the company Knowledge Base (SOPs, policies, repair knowledge, training) — relevant articles are provided below when they match the question.",
    "- NEVER state or imply a CPR-specific policy, price, or process unless it comes from Knowledge Base articles provided to you. If none were provided (or they don't cover it), say the Knowledge Base doesn't cover it yet and give general industry guidance clearly labeled as general — do not present it as 'CPR's process'.",
    "- You do NOT yet have access to the company's live database (sales, schedules, inventory, orders). If asked for specific live numbers, say that direct data access is coming soon and answer what you can from what the user pastes in.",
    "- You cannot take actions or change any records yet. If asked to update something, explain that write access is planned and offer to draft what should change.",
    "- When unsure, say so plainly rather than guessing."
  ].join("\n");
}
async function getStaff(req) {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff").select("id, display_name, role, home_store, active").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s || null;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: CORS
  });
  if (req.method !== "POST") return json({
    error: "method_not_allowed"
  }, 405);
  if (!ANTHROPIC_KEY) return json({
    error: "not_configured",
    detail: "ANTHROPIC_API_KEY secret is not set."
  }, 503);
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "bad_json"
    }, 400);
  }
  // Auth is OPTIONAL: being on RepairQ already means the employee authenticated.
  // A valid PIN session elevates to that person (personalization + manager-only
  // KB); no session = anonymous "team member" at employee KB scope. The assistant
  // is read-only, so nothing here mutates records. Manager-only articles stay
  // protected because kbRetrieve gates on isMgrRole(staff?.role) → false when null.
  const staff = await getStaff(req);
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length) return json({
    error: "no_messages"
  }, 400);
  // Keep only role + string content; cap history so a runaway client can't blow the context.
  const clean = messages.filter((m)=>m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-24).map((m)=>({
      role: m.role,
      content: String(m.content).slice(0, 16000)
    }));
  if (!clean.length || clean[clean.length - 1].role !== "user") return json({
    error: "bad_messages"
  }, 400);
  const model = ALLOWED_MODELS.has(body?.model) ? body.model : DEFAULT_MODEL;
  // Knowledge Base RAG: search on the latest user turn (plus the one before it
  // for follow-ups like "what about Samsung?").
  const lastUser = clean[clean.length - 1].content;
  const prevUser = clean.filter((m)=>m.role === "user").slice(-2, -1).map((m)=>m.content).join(" ");
  let kb = await kbRetrieve(lastUser, staff);
  if (!kb.length && prevUser) kb = await kbRetrieve(prevUser + " " + lastUser, staff);
  const system = systemPrompt(staff) + kbBlock(kb);
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      stream: true,
      system,
      messages: clean
    })
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(()=>"");
    return json({
      error: "upstream_error",
      status: upstream.status,
      detail: detail.slice(0, 500)
    }, 502);
  }
  // Pass Anthropic's SSE stream straight through to the browser.
  return new Response(upstream.body, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
});
