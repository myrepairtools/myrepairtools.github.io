// report-issue — techs file extension glitches from a link in RepairQ.
// Inserts the report into extension_issues (service role) and texts the owner
// so problems surface immediately. Called by the extension's bg.js with the
// public anon key (verify_jwt off); the RingCentral creds stay server-side in
// the messaging function this calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
// where the alert text goes; overridable via secret without a redeploy of code
const ALERT_TO = Deno.env.get("ISSUE_ALERT_NUMBER") || "+15415154212";

const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let p: any = {};
  try { p = await req.json(); } catch { /* empty */ }
  const message = String(p?.message || "").trim();
  if (!message) return json({ ok: false, error: "message required" }, 400);

  // kind:'debug' = extension self-diagnostics (e.g. a note write that failed
  // both paths) — logged for remote inspection, never texted to the owner
  const isDebug = p?.kind === "debug";

  const row: Record<string, unknown> = {
    message,
    store: p?.store || null,
    reporter: p?.reporter || null,
    ticket_no: p?.ticket_no ? String(p.ticket_no) : null,
    url: p?.url || null,
    ext_version: p?.ext_version || null,
    user_agent: p?.user_agent || null,
  };
  if (isDebug) row.status = "debug";

  const { data, error } = await admin.from("extension_issues").insert(row).select("id").single();
  if (error) return json({ ok: false, error: error.message }, 500);

  if (isDebug) return json({ ok: true, id: data.id });

  // fire the owner alert (best-effort — a texting hiccup must not lose the report)
  let sms: any = null;
  try {
    const parts = ["🐞 MRT extension issue #" + data.id];
    if (row.store) parts.push(row.store);
    if (row.reporter) parts.push(row.reporter);
    if (row.ticket_no) parts.push("tkt " + row.ticket_no);
    if (row.ext_version) parts.push("v" + row.ext_version);
    const body = parts.join(" · ") + "\n" + message.slice(0, 300);
    const r = await fetch(`${SB_URL}/functions/v1/messaging`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ANON}`, "apikey": ANON },
      body: JSON.stringify({ action: "send", to: ALERT_TO, body, store: row.store || undefined, agent_name: "issue-bot" }),
    });
    sms = await r.json().catch(() => null);
  } catch (e) {
    sms = { ok: false, error: String((e as Error).message || e) };
  }

  return json({ ok: true, id: data.id, sms_ok: !!(sms && sms.ok) });
});
