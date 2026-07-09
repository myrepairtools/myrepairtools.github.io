// sickw-check — IMEI blacklist checks via Sickw (myRepairTools)
//
// Born from selling a blacklisted Hyla device: every cellular device added to
// a RepairQ ticket must pass a blacklist check before it walks out the door.
// The extension (scripts/sickwCheck.js via bg.js) pops a forced modal when a
// device with an IMEI lands on a ticket and calls this function; the result is
// written to the ticket notes AND logged to `blacklist_checks`.
//
// The Sickw API key stays HERE (SICKW_API_KEY secret) — never in the browser.
// SICKW_SERVICE_ID picks which Sickw service runs (a blacklist-status service);
// changeable without code edits (redeploy to refresh warm env).
//
// Actions (POST JSON):
//   check    — {imei, ticket_no?, device_name?, store?, agent_name?, force?}
//              24h cache on (imei) unless force; classifies the result text as
//              clean | blacklisted | review and logs every live check.
//   balance  — current Sickw account balance
//   services — Sickw's service list (id, name, price) — for picking SERVICE_ID
//   history  — recent blacklist_checks rows (audit)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const KEY = Deno.env.get("SICKW_API_KEY") || "";
const SERVICE = Deno.env.get("SICKW_SERVICE_ID") || "54";          // WW BLACKLIST STATUS ($0.04)
const SERVICE_IPHONE = Deno.env.get("SICKW_SERVICE_IPHONE") || "61";  // iPHONE CARRIER & FMI & BLACKLIST ($0.10)
const SERVICE_SAMSUNG = Deno.env.get("SICKW_SERVICE_SAMSUNG") || "6"; // WW BLACKLIST STATUS - PRO ($0.12)

// Route by manufacturer: iPhones get the carrier+FMI+blacklist combo (FMI ON =
// iCloud-locked = just as unsellable as blacklisted), Samsungs get the PRO
// blacklist, everything else the standard worldwide check.
function routeService(deviceName: string): string {
  const n = String(deviceName || "").toLowerCase();
  if (/iphone|ipad|apple/.test(n)) return SERVICE_IPHONE;
  if (/galaxy|samsung/.test(n)) return SERVICE_SAMSUNG;
  return SERVICE;
}
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

function luhnOk(s: string): boolean {
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

// Sickw results are loose text/HTML. Classify defensively: blacklist flags win,
// then FMI/iCloud lock (iPhone service — an FMI-ON device is just as unsellable),
// then an explicit CLEAN; anything ambiguous → review (raw text shown, human
// decides).
function classify(text: string): "clean" | "blacklisted" | "fmi_on" | "review" {
  const t = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (/black\s*list(?:ed)?\s*(?:status)?\s*[:\-]?\s*(yes|true|blacklisted|blocked|barred)/i.test(t)) return "blacklisted";
  if (/\bBLACKLISTED\b|\bBLOCKED\b|\bBARRED\b|GSMA\s*:?\s*BLACKLISTED/i.test(t)) return "blacklisted";
  if (/(?:FMI|Find\s*My(?:\s*iPhone)?|iCloud\s*Lock)\s*[:\-]?\s*(on|active|enabled|locked)/i.test(t)) return "fmi_on";
  if (/black\s*list(?:ed)?\s*(?:status)?\s*[:\-]?\s*(no|false|clean|not\s+found)/i.test(t) || /\bCLEAN\b/i.test(t)) return "clean";
  return "review";
}

async function sickw(params: Record<string, string>): Promise<{ ok: boolean; data: any; text: string }> {
  const qs = new URLSearchParams({ key: KEY, ...params });
  const r = await fetch(`https://sickw.com/api.php?${qs}`, { headers: { "user-agent": "myRepairTools/1.0" } });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* balance returns bare text */ }
  return { ok: r.ok, data, text };
}

async function actionCheck(p: any) {
  if (!KEY) return json({ ok: false, error: "SICKW_API_KEY not configured" }, 500);
  const service = String(p?.service || routeService(p?.device_name) || "").trim();
  if (!service) return json({ ok: false, error: "SICKW_SERVICE_ID not configured (pick one via action=services)" }, 500);
  const imei = String(p?.imei || "").replace(/\D/g, "");
  if (imei.length !== 15 || !luhnOk(imei)) return json({ ok: false, error: "Not a valid 15-digit IMEI" }, 400);

  // 24h cache — a device checked this morning doesn't need a paid re-check at
  // the counter an hour later. force:true bypasses.
  if (!p?.force) {
    const { data: prior } = await admin.from("blacklist_checks")
      .select("status, result_raw, created_at").eq("imei", imei)
      .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (prior && prior.status !== "error") {
      return json({ ok: true, cached: true, imei, status: prior.status, result: prior.result_raw, checked_at: prior.created_at });
    }
  }

  const r = await sickw({ format: "json", imei, service });
  const ok = r.data?.status === "success";
  const resultText = String(r.data?.result ?? r.text ?? "").trim();
  const status = ok ? classify(resultText) : "error";

  await admin.from("blacklist_checks").insert({
    imei, ticket_no: p?.ticket_no || null, device_name: p?.device_name || null,
    store: p?.store || null, status, result_raw: resultText.slice(0, 4000),
    service, price: r.data?.price != null ? Number(r.data.price) : null,
    checked_by: p?.agent_name || null,
  });

  if (!ok) return json({ ok: false, error: resultText.slice(0, 300) || "Sickw error", imei }, 502);
  return json({ ok: true, cached: false, imei, status, result: resultText, balance: r.data?.balance ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let p: any = {};
  try { p = await req.json(); } catch { /* empty */ }
  try {
    if (p?.action === "check") return await actionCheck(p);
    if (p?.action === "balance") {
      const r = await sickw({ action: "balance" });
      return json({ ok: true, balance: r.text.trim(), service_configured: SERVICE || null });
    }
    if (p?.action === "services") {
      const r = await sickw({ action: "services" });
      return json({ ok: true, services: r.data?.["Service List"] ?? r.data ?? r.text });
    }
    if (p?.action === "history") {
      const { data } = await admin.from("blacklist_checks")
        .select("imei, ticket_no, device_name, store, status, checked_by, created_at")
        .order("created_at", { ascending: false }).limit(Number(p?.limit || 50));
      return json({ ok: true, checks: data || [] });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
