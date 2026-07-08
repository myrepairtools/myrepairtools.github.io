// ai-compose — help staff write better customer text messages (myRepairTools)
//
// A small server-side helper so the ANTHROPIC_API_KEY never touches the
// browser (same rule as cpr-assistant). The RingCentral panel's compose box
// calls this to polish a rough draft or draft from a short instruction.
//
// Secret: ANTHROPIC_API_KEY (shared project secret, already set for cpr-assistant).
// Action (POST JSON):
//   { text, mode?: 'polish'|'draft', tone?, customer_name?, store? }
//   → { ok, message }  — a single ready-to-send SMS (no preamble, no quotes)
//
// Deploy with verify_jwt OFF — called through bg.js with the anon key, like
// the other extension-facing functions.

const KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = "claude-haiku-4-5-20251001";   // fast + cheap; this is a rewrite task

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM =
  "You help phone-repair shop staff write SMS messages to customers. Rewrite or draft " +
  "ONE text message that is warm, professional, and clear. Rules: keep it SHORT (SMS " +
  "length, ideally under 320 characters); plain American English; no emoji unless the " +
  "input clearly wants a light one; never invent facts, prices, dates, or promises that " +
  "aren't in the input; keep the customer's name if given; sound like a friendly local " +
  "repair shop, not a corporation. Output ONLY the message text — no quotes, no preamble, " +
  "no options, no explanation.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, 500);

  let p: any = {};
  try { p = await req.json(); } catch { /* empty */ }
  const text = String(p?.text || "").trim();
  if (!text) return json({ ok: false, error: "text required" }, 400);

  const mode = p?.mode === "draft" ? "draft" : "polish";
  const bits: string[] = [];
  if (p?.customer_name) bits.push(`Customer name: ${String(p.customer_name).trim()}`);
  if (p?.store) bits.push(`Store: ${String(p.store).trim()}`);
  if (p?.tone) bits.push(`Tone: ${String(p.tone).trim()}`);
  const ctx = bits.length ? `\n\nContext:\n${bits.join("\n")}` : "";
  const instruction = mode === "draft"
    ? `Write a customer text message based on this note:\n\n${text}${ctx}`
    : `Polish this rough customer text message so it reads well — keep the meaning, fix tone/grammar/clarity:\n\n${text}${ctx}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 400, system: SYSTEM,
        messages: [{ role: "user", content: instruction }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return json({ ok: false, error: data?.error?.message || `HTTP ${r.status}` }, 502);
    const msg = (data?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim()
      .replace(/^["']|["']$/g, "");   // strip stray wrapping quotes
    return json({ ok: true, message: msg });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
