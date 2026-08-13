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
const ANON = Deno.env.get("SUPABASE_ANON_KEY");
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const admin = createClient(SB_URL, SERVICE, {
  auth: {
    persistSession: false
  }
});
// A client that queries AS the signed-in user — every db tool call runs through
// this, so RLS scopes results to exactly what that person can already see in
// the tools. The service-role client is never exposed to the model.
function userClient(jwt) {
  return createClient(SB_URL, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });
}
// ---- public-schema map (assistant_schema RPC; cached per boot) ----
let SCHEMA = null; // Map<table, cols string>
async function schemaMap() {
  if (SCHEMA) return SCHEMA;
  try {
    const { data } = await admin.rpc("assistant_schema");
    SCHEMA = new Map((data || []).map((r) => [String(r.tbl), String(r.cols)]));
  } catch { SCHEMA = new Map(); }
  return SCHEMA;
}
// ---- db tools (read-only, RLS-scoped via the caller's JWT) ----
const DB_TOOLS = [
  {
    name: "table_columns",
    description: "Get the column list for one database table. Use before db_select when unsure of column names.",
    input_schema: { type: "object", properties: { table: { type: "string" } }, required: ["table"] }
  },
  {
    name: "db_select",
    description: "Read rows from a database table. Runs AS the signed-in user — row-level security scopes what comes back, same as the web tools. Read-only. Keep limits small and filter server-side.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        columns: { type: "string", description: "comma-separated columns, default *" },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is", "contains"] },
              value: { description: "filter value; array for in/contains; null for is" }
            },
            required: ["column", "op"]
          }
        },
        order: { type: "object", properties: { column: { type: "string" }, desc: { type: "boolean" } } },
        limit: { type: "integer", description: "max rows, default 25, cap 100" },
        count_only: { type: "boolean", description: "true = return just the row count for the filters" }
      },
      required: ["table"]
    }
  }
];
async function runDbTool(name, input, jwt) {
  const schema = await schemaMap();
  const table = String(input?.table || "");
  if (!schema.has(table)) return { error: `unknown table '${table}' — check the table list` };
  if (name === "table_columns") return { table, columns: schema.get(table) };
  const uc = userClient(jwt);
  const limit = Math.max(1, Math.min(100, Number(input?.limit) || 25));
  let q = input?.count_only
    ? uc.from(table).select(String(input?.columns || "*").replace(/[^\w,.* ()->'"]/g, ""), { count: "exact", head: true })
    : uc.from(table).select(String(input?.columns || "*").replace(/[^\w,.* ()->'"]/g, ""));
  for (const f of (Array.isArray(input?.filters) ? input.filters : [])) {
    const col = String(f?.column || ""), op = String(f?.op || "eq"), v = f?.value;
    if (!col) continue;
    if (op === "in" && Array.isArray(v)) q = q.in(col, v);
    else if (op === "contains" && v != null) q = q.contains(col, v);
    else if (op === "is") q = q.is(col, v ?? null);
    else if (["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike"].includes(op)) q = q[op](col, v);
  }
  if (input?.order?.column) q = q.order(String(input.order.column), { ascending: !input.order.desc });
  if (!input?.count_only) q = q.limit(limit);
  const r = await q;
  if (r.error) return { error: r.error.message };
  if (input?.count_only) return { table, count: r.count ?? 0 };
  const rows = r.data || [];
  let out = JSON.stringify(rows);
  if (out.length > 14000) out = out.slice(0, 14000) + `…(truncated — ${rows.length} rows returned; filter tighter)`;
  return { table, rows: rows.length, data: out };
}
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
const KB_URL = "https://myrepairtools.com/knowledge.html";
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
// ---- Price Guide retrieval (price_guide_entries — imported from price-guide.html) ----
async function pgRetrieve(question) {
  const q = String(question || "").trim();
  if (q.length < 3) return [];
  // only bother when the question smells like pricing/quoting/SKUs
  if (!/price|pricing|cost|charge|quote|sku|how much|\$|fee|guide|screen protector|case|repair.*(run|cost)|consult/i.test(q)) return [];
  try {
    const terms = q.replace(/[^\w\s+-]/g, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 8).join(" | ");
    if (!terms) return [];
    const { data } = await admin.from("price_guide_entries")
      .select("section, subsection, item, details, sku, price")
      .textSearch("search", terms, { type: "websearch" })
      .limit(20);
    if (data?.length) return data;
    // loose fallback: OR the terms
    const { data: loose } = await admin.from("price_guide_entries")
      .select("section, subsection, item, details, sku, price")
      .textSearch("search", terms.split(" | ").join(" or "), { type: "websearch" })
      .limit(20);
    return loose || [];
  } catch {
    return [];
  }
}
function pgBlock(rows) {
  if (!rows.length) return "";
  const lines = rows.map((r) =>
    `- [${r.section}${r.subsection ? " › " + r.subsection : ""}] ${r.item}${r.details ? " — " + r.details : ""}${r.sku ? " · SKU " + r.sku : ""}${r.price ? " · " + r.price : ""}`
  ).join("\n");
  return [
    "",
    "PRICE GUIDE — CPR Oregon's official pricing, matched to this question:",
    lines,
    "",
    "Rules for using the Price Guide:",
    "- Quote prices and SKUs EXACTLY as listed — never round, estimate, or invent a price.",
    "- Pricing rules like \"Parts + $100\" are formulas, not totals: explain that the final number needs the part cost (the Price Calculator does this).",
    "- If the item asked about isn't in the entries above, say the Price Guide doesn't list it and point them to price-guide.html — do not guess.",
  ].join("\n");
}
function dbBlock(staff, schema) {
  if (!staff) return "";
  const tables = [...schema.keys()].join(", ");
  return [
    "",
    "LIVE DATABASE ACCESS — you have two read-only tools: db_select (query rows) and table_columns (inspect a table).",
    "Every query runs AS the signed-in user through row-level security, so results are exactly what this person is allowed to see in the web tools — nothing needs extra permission checks on your side, and an empty result may simply mean their access doesn't cover it (say so).",
    "Available tables: " + tables,
    "Guidance:",
    "- Prefer filters + small limits over dumping tables; use count_only for 'how many' questions.",
    "- Check table_columns when a select errors on a column name.",
    "- Dates are ISO strings; stores use canonical names like 'CPR Eugene OR' (staff rows carry home_store).",
    "- Money/commission questions: commission_snapshots.total is commission only — tips are separate.",
    "- Present results in friendly prose or small lists, not raw JSON. Round money to cents.",
    "- You are READ-ONLY: you cannot change records. Offer to explain where in the tools a change is made.",
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
    "- You have access to the company Knowledge Base (SOPs, policies, repair knowledge, training) and the official Price Guide — relevant articles and price entries are provided below when they match the question.",
    "- NEVER state or imply a CPR-specific policy, price, or process unless it comes from the Knowledge Base articles or Price Guide entries provided to you. If none were provided (or they don't cover it), say so and give general industry guidance clearly labeled as general — do not present it as 'CPR's process'.",
    "- When signed in, you can also READ the live database with the db_select tool (RLS-scoped to the signed-in user) — see LIVE DATABASE ACCESS below. Without a session there are no database tools.",
    "- You cannot take actions or change any records. If asked to update something, explain that write access is planned and offer to draft what should change.",
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
  const pg = await pgRetrieve(lastUser);
  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") || "";
  const schema = staff ? await schemaMap() : new Map();
  const system = systemPrompt(staff) + kbBlock(kb) + pgBlock(pg) + dbBlock(staff, schema);
  const tools = staff ? DB_TOOLS : [];
  // Tool-use loop with pass-through streaming: each round's text deltas are
  // forwarded to the browser as they arrive (the widget reads only
  // content_block_delta/text_delta lines); when a round stops on tool_use we
  // run the RLS-scoped db tools and continue. Capped rounds keep cost bounded.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
      const say = (text) => emit({ type: "content_block_delta", delta: { type: "text_delta", text } });
      let msgs = clean.slice();
      try {
        for (let round = 0; round < 6; round++) {
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
              messages: msgs,
              ...(tools.length ? { tools } : {})
            })
          });
          if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text().catch(() => "");
            say("⚠ The assistant hit an upstream error (" + upstream.status + "). Try again in a moment.");
            console.error("upstream_error", upstream.status, detail.slice(0, 300));
            break;
          }
          // parse this round's SSE: forward text, reconstruct content blocks
          const blocks = [];
          let stop = null, buf = "";
          const reader = upstream.body.getReader();
          const dec = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() || "";
            for (const part of parts) {
              const line = part.split("\n").find((l) => l.startsWith("data:"));
              if (!line) continue;
              let j;
              try { j = JSON.parse(line.slice(5)); } catch { continue; }
              if (j.type === "content_block_start") {
                blocks[j.index] = j.content_block?.type === "tool_use"
                  ? { type: "tool_use", id: j.content_block.id, name: j.content_block.name, _json: "" }
                  : { type: "text", text: "" };
              } else if (j.type === "content_block_delta") {
                const b = blocks[j.index];
                if (!b) continue;
                if (j.delta?.type === "text_delta") { b.text += j.delta.text; say(j.delta.text); }
                else if (j.delta?.type === "input_json_delta") b._json += j.delta.partial_json || "";
              } else if (j.type === "message_delta" && j.delta?.stop_reason) stop = j.delta.stop_reason;
            }
          }
          const content = blocks.filter(Boolean)
            .map((b) => b.type === "tool_use"
              ? { type: "tool_use", id: b.id, name: b.name, input: (() => { try { return JSON.parse(b._json || "{}"); } catch { return {}; } })() }
              : { type: "text", text: b.text })
            .filter((b) => b.type !== "text" || b.text);
          if (stop !== "tool_use" || !content.some((b) => b.type === "tool_use")) break;
          msgs = msgs.concat([{ role: "assistant", content }]);
          const results = [];
          for (const b of content) {
            if (b.type !== "tool_use") continue;
            let res;
            try { res = await runDbTool(b.name, b.input, jwt); } catch (e) { res = { error: String(e?.message || e).slice(0, 200) }; }
            results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(res) });
          }
          msgs = msgs.concat([{ role: "user", content: results }]);
        }
      } catch (e) {
        say("⚠ Assistant error: " + String(e?.message || e).slice(0, 200));
      }
      emit({ type: "message_stop" });
      controller.close();
    }
  });
  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
});
