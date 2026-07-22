// MobileSentrix (Magento) api-consumer OAuth callback.
// Magento POSTs integration credentials here when the consumer is activated;
// we store whatever arrives in ms_callback_log (owner-only read) so the
// one-time handshake payload is never lost. GET answers ok for form validators.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let body = "";
  try { body = await req.text(); } catch { /* keep empty */ }
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { if (k !== "authorization" && k !== "apikey") headers[k] = v; });
  try {
    const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
    await admin.from("ms_callback_log").insert({ method: req.method, path: url.pathname + url.search, headers, body });
  } catch { /* logging must never fail the handshake */ }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
