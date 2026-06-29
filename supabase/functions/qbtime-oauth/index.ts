// =============================================================================
// qbtime-oauth — QuickBooks Time (TSheets) OAuth 2.0 connection handler.
//
// Holds the QBT client secret + tokens server-side; the browser never sees them.
// Deployed with verify_jwt:false because the OAuth callback from QuickBooks Time
// arrives with no Supabase JWT. Owner-only control actions are checked in-code.
//
//   GET ?action=start       (owner JWT)  -> { url } to send the browser to consent
//   GET ?code=..&state=..   (from QBT)   -> exchange code, store tokens, redirect back
//   GET ?action=status      (owner JWT)  -> { connected, expires_at, updated_at }
//   GET ?action=disconnect  (owner JWT)  -> delete the stored token
//
// Secrets used: QBT_CLIENT_ID, QBT_CLIENT_SECRET (+ SUPABASE_URL/SERVICE_ROLE_KEY).
// Register this exact URL as the app's Redirect URI:
//   https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/qbtime-oauth
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("QBT_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("QBT_CLIENT_SECRET") || "";

const REDIRECT_URI = "https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/qbtime-oauth";
const RETURN_URL = "https://myrepairtools.github.io/settings.html";
const AUTHORIZE = "https://rest.tsheets.com/api/v1/authorize";
const GRANT = "https://rest.tsheets.com/api/v1/grant";
const PROVIDER = "qbtime";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const redirect = (url: string) => new Response(null, { status: 302, headers: { ...CORS, Location: url } });

async function getStaff(req: Request) {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff")
    .select("id, display_name, role, active").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s || null;
}

// HMAC-signed state so the callback can be trusted without a DB round-trip.
const enc = new TextEncoder();
function b64url(buf: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(SERVICE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function makeState(staffId: number) {
  const body = `${staffId}.${Date.now() + 10 * 60 * 1000}`;
  return `${body}.${await hmac(body)}`;
}
async function checkState(state: string | null) {
  const p = String(state || "").split(".");
  if (p.length !== 3) return null;
  const body = `${p[0]}.${p[1]}`;
  if ((await hmac(body)) !== p[2]) return null;
  if (Date.now() > Number(p[1])) return null;
  return p[0];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const code = url.searchParams.get("code");
  const oauthErr = url.searchParams.get("error");

  // ---- OAuth callback from QuickBooks Time (no JWT) ----
  if (code || oauthErr) {
    if (oauthErr) return redirect(`${RETURN_URL}?qbtime=error&detail=${encodeURIComponent(url.searchParams.get("error_description") || oauthErr)}`);
    const staffId = await checkState(url.searchParams.get("state"));
    if (!staffId) return redirect(`${RETURN_URL}?qbtime=error&detail=bad_state`);
    if (!CLIENT_ID || !CLIENT_SECRET) return redirect(`${RETURN_URL}?qbtime=error&detail=not_configured`);
    const form = new URLSearchParams({
      grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      code: code!, redirect_uri: REDIRECT_URI,
    });
    const r = await fetch(GRANT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) return redirect(`${RETURN_URL}?qbtime=error&detail=${encodeURIComponent(d.error || ("grant_" + r.status))}`);
    const expires_at = new Date(Date.now() + (Number(d.expires_in) || 0) * 1000).toISOString();
    await admin.from("integration_tokens").upsert({
      provider: PROVIDER, access_token: d.access_token, refresh_token: d.refresh_token, expires_at,
      realm_id: d.company_id ? String(d.company_id) : null,
      meta: { scope: d.scope, token_type: d.token_type, client_url: d.client_url },
      connected_by: Number(staffId), updated_at: new Date().toISOString(),
    }, { onConflict: "provider" });
    return redirect(`${RETURN_URL}?qbtime=connected`);
  }

  // ---- owner-only control actions ----
  const staff = await getStaff(req);
  if (!staff || staff.role !== "owner") return json({ error: "forbidden", detail: "Owner only." }, 403);

  if (action === "start") {
    if (!CLIENT_ID) return json({ error: "not_configured", detail: "QBT_CLIENT_ID secret is not set." }, 503);
    const state = await makeState(staff.id);
    const u = `${AUTHORIZE}?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
    return json({ url: u });
  }
  if (action === "status") {
    const { data } = await admin.from("integration_tokens").select("expires_at, updated_at, meta").eq("provider", PROVIDER).maybeSingle();
    return json({ connected: !!data, expires_at: data?.expires_at || null, updated_at: data?.updated_at || null });
  }
  if (action === "disconnect") {
    await admin.from("integration_tokens").delete().eq("provider", PROVIDER);
    return json({ ok: true });
  }
  return json({ error: "bad_action" }, 400);
});
