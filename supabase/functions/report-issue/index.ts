// report-issue — techs file extension glitches from a link in RepairQ, and
// (v2) staff file MRT site issues + feature requests from the top bar.
// kinds: (none) = extension issue · 'debug' = extension self-diagnostics
// (logged, never texted) · 'site' = an MRT site issue (same extension_issues
// table, source='site') · 'feature' = a feature request (its OWN list —
// feature_requests — per the owner). Issues + features both text the owner.
// Called with the public anon key (verify_jwt off); the RingCentral creds
// stay server-side in the messaging function this calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
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
  const kind = String(p?.kind || "");
  const isDebug = kind === "debug";
  const isFeature = kind === "feature";
  const isSite = kind === "site";

  const row: Record<string, unknown> = {
    message,
    store: p?.store || null,
    reporter: p?.reporter || null,
    url: p?.url || null,
    user_agent: p?.user_agent || null,
  };
  let data: { id: number };
  if (isFeature) {
    const res = await admin.from("feature_requests").insert(row).select("id").single();
    if (res.error) return json({ ok: false, error: res.error.message }, 500);
    data = res.data;
  } else {
    row.ticket_no = p?.ticket_no ? String(p.ticket_no) : null;
    row.ext_version = p?.ext_version || null;
    if (isSite) row.source = "site";
    if (isDebug) row.status = "debug";
    const res = await admin.from("extension_issues").insert(row).select("id").single();
    if (res.error) return json({ ok: false, error: res.error.message }, 500);
    data = res.data;
  }

  if (isDebug) return json({ ok: true, id: data.id });

  // fire the owner alert (best-effort — a texting hiccup must not lose the report)
  let sms: any = null;
  try {
    const parts = [isFeature ? "💡 Feature request #" + data.id
      : isSite ? "🐞 MRT issue #" + data.id
      : "🐞 MRT extension issue #" + data.id];
    if (row.store) parts.push(row.store);
    if (row.reporter) parts.push(row.reporter);
    if (row.ticket_no) parts.push("tkt " + row.ticket_no);
    if (row.ext_version) parts.push("v" + row.ext_version);
    const body = parts.join(" · ") + "\n" + message.slice(0, 300);
    // send from the OFFICIAL alerts line (ALERTS_FROM_NUMBER — the 971 the
    // owner has saved as "MRT Notifications"), not the reporter's store line,
    // so every report threads under one contact
    const r = await fetch(`${SB_URL}/functions/v1/messaging`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ANON}`, "apikey": ANON },
      body: JSON.stringify({ action: "system_send", secret: NOTIFY_SECRET, to: ALERT_TO, body }),
    });
    sms = await r.json().catch(() => null);
  } catch (e) {
    sms = { ok: false, error: String((e as Error).message || e) };
  }

  return json({ ok: true, id: data.id, sms_ok: !!(sms && sms.ok) });
});
