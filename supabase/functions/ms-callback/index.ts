// MobileSentrix (Magento) OAuth 1.0a handshake + callback.
//
// Flow (per docs.mobilesentrix.com "Authentication Process"):
//   1. GET ?action=start&k=<MS_START_KEY>  → 302 into
//      {base}/oauth/authorize/identifier?consumer=…&authtype=1&flowentry=SignIn
//        &consumer_key=…&consumer_secret=…&callback=<this function>
//      The owner signs in with the cpr.parts account; MS redirects back here
//      with oauth_token + oauth_verifier.
//   2. This function exchanges them at {base}/oauth/authorize/identifiercallback
//      (POST JSON) for the long-lived access_token + access_token_secret and
//      stores them in integration_tokens (provider 'mobilesentrix',
//      access_token column + meta.access_token_secret). Tokens never expire
//      unless revoked.
// Everything that arrives is also logged to ms_callback_log (owner-only read)
// so the one-time handshake payload is never lost.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_KEY = Deno.env.get("MS_CONSUMER_KEY") || "";
const MS_SECRET = Deno.env.get("MS_CONSUMER_SECRET") || "";
const MS_BASE = (Deno.env.get("MS_BASE_URL") || "https://www.cpr.parts").replace(/\/+$/, "");
const MS_NAME = Deno.env.get("MS_CONSUMER_NAME") || "iRepair Phone Shop, LLC";
const START_KEY = Deno.env.get("MS_START_KEY") || "";

function page(title: string, body: string, ok = true) {
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:'Nunito Sans',system-ui,sans-serif;background:#F3F2F2;display:grid;place-items:center;min-height:100vh;margin:0"><div style="background:#fff;border-radius:14px;padding:32px 36px;max-width:440px;box-shadow:0 8px 30px rgba(45,45,59,.12)"><h2 style="margin:0 0 10px;color:${ok ? "#2D2D3B" : "#DC282E"}">${title}</h2><div style="color:#555;line-height:1.5">${body}</div></div></body>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  let body = "";
  try { body = await req.text(); } catch { /* keep empty */ }
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { if (k !== "authorization" && k !== "apikey") headers[k] = v; });
  const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
  try {
    await admin.from("ms_callback_log").insert({ method: req.method, path: url.pathname + url.search, headers, body });
  } catch { /* logging must never fail the handshake */ }

  // Step 1: kick off the browser sign-in.
  if (q.get("action") === "start") {
    if (!START_KEY || q.get("k") !== START_KEY) return page("Not authorized", "Bad or missing start key.", false);
    if (!MS_KEY || !MS_SECRET) return page("Not configured", "MS_CONSUMER_KEY / MS_CONSUMER_SECRET are not set.", false);
    const cb = `${SB_URL}/functions/v1/ms-callback`;
    const auth = `${MS_BASE}/oauth/authorize/identifier?consumer=${encodeURIComponent(MS_NAME)}&authtype=1&flowentry=SignIn&consumer_key=${encodeURIComponent(MS_KEY)}&consumer_secret=${encodeURIComponent(MS_SECRET)}&callback=${encodeURIComponent(cb)}`;
    return new Response(null, { status: 302, headers: { Location: auth } });
  }

  // Step 2: MS redirected back with the temporary token — exchange it.
  const oauthToken = q.get("oauth_token");
  const oauthVerifier = q.get("oauth_verifier");
  if (oauthToken && oauthVerifier) {
    try {
      const r = await fetch(`${MS_BASE}/oauth/authorize/identifiercallback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumer_key: MS_KEY,
          consumer_secret: MS_SECRET,
          oauth_token: oauthToken,
          oauth_verifier: oauthVerifier,
        }),
      });
      const txt = await r.text();
      let j: any = null;
      try { j = JSON.parse(txt); } catch { /* non-JSON */ }
      const tok = j?.data?.access_token;
      const tokSecret = j?.data?.access_token_secret;
      try {
        await admin.from("ms_callback_log").insert({
          method: "EXCHANGE", path: `/oauth/authorize/identifiercallback → ${r.status}`,
          headers: {}, body: tok ? JSON.stringify({ status: j?.status, got_token: true }) : txt.slice(0, 4000),
        });
      } catch { /* ignore */ }
      if (!tok || !tokSecret) {
        return page("Token exchange failed", `MobileSentrix answered HTTP ${r.status}. The response was logged — check ms_callback_log.`, false);
      }
      const { error } = await admin.from("integration_tokens").upsert({
        provider: "mobilesentrix",
        access_token: tok,
        refresh_token: null,
        expires_at: null,
        realm_id: null,
        meta: { access_token_secret: tokSecret, base_url: MS_BASE, obtained_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: "provider" });
      if (error) return page("Stored… almost", `Got the access token but saving failed: ${error.message}`, false);
      return page("✅ MobileSentrix Connected", "The access token is stored server-side. You can close this tab — the parts-order pipeline can now talk to the cpr.parts API.");
    } catch (e) {
      return page("Token exchange failed", String(e), false);
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
