// MobileSentrix (Magento) OAuth 1.0a handshake + callback.
//
// Each STORE has its own cpr.parts account, so each store gets its own
// long-lived access token (integration_tokens provider 'ms:<store>').
//
// Flow (per docs.mobilesentrix.com "Authentication Process"):
//   1. GET ?action=start&k=<MS_START_KEY>            → store picker page
//      GET ?action=start&k=<MS_START_KEY>&store=<name> → logs a START marker
//      (which store this flow is for) then 302 into
//      {base}/oauth/authorize/identifier?consumer=…&authtype=1&flowentry=SignIn
//        &consumer_key=…&consumer_secret=…&callback=<this function>
//      The owner signs in with THAT store's cpr.parts account; MS redirects
//      back here with oauth_token + oauth_verifier.
//   2. This function exchanges them at {base}/oauth/authorize/identifiercallback
//      (POST JSON) for the access_token + access_token_secret, resolves the
//      store from the most recent START marker, and upserts
//      integration_tokens provider 'ms:<store>' (meta.access_token_secret).
//      Tokens never expire unless revoked.
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

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function page(title: string, body: string, ok = true) {
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:'Nunito Sans',system-ui,sans-serif;background:#F3F2F2;display:grid;place-items:center;min-height:100vh;margin:0"><div style="background:#fff;border-radius:14px;padding:32px 36px;max-width:440px;box-shadow:0 8px 30px rgba(45,45,59,.12)"><h2 style="margin:0 0 10px;color:${ok ? "#2D2D3B" : "#DC282E"}">${title}</h2><div style="color:#555;line-height:1.5">${body}</div></div></body>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
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

  // Settings → Integrations card: per-store connection status + the start URL.
  // Owner-only (the Integrations tab is owner-gated).
  if (q.get("action") === "status") {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!jwt) return json({ error: "auth required" }, 401);
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "auth required" }, 401);
    const { data: me } = await admin.from("staff")
      .select("id, role, active").eq("auth_uid", u.user.id).eq("active", true).maybeSingle();
    if (!me || me.role !== "owner") return json({ error: "owner only" }, 403);
    const { data: stores } = await admin.from("stores").select("store").eq("active", true).order("display_order");
    const { data: toks } = await admin.from("integration_tokens").select("provider, meta, updated_at").like("provider", "ms:%");
    const byStore = new Map((toks || []).map((t: any) => [String(t.provider).slice(3), t]));
    return json({
      configured: !!(MS_KEY && MS_SECRET && START_KEY),
      base_url: MS_BASE,
      start_url: START_KEY ? `${SB_URL}/functions/v1/ms-callback?action=start&k=${encodeURIComponent(START_KEY)}` : null,
      stores: (stores || []).map((s: any) => {
        const t = byStore.get(s.store);
        return { store: s.store, connected: !!t, connected_at: t?.meta?.obtained_at || t?.updated_at || null };
      }),
    });
  }

  // Diagnostic: probe an API endpoint with a store's stored token
  // (OAuth 1.0a PLAINTEXT per the MS auth doc). Gated by the start key.
  if (q.get("action") === "api_test") {
    if (!START_KEY || q.get("k") !== START_KEY) return json({ error: "bad key" }, 403);
    const store = q.get("store") || "";
    const path = q.get("path") || "/api/rest/orders";
    const { data: t } = await admin.from("integration_tokens").select("access_token, meta").eq("provider", `ms:${store}`).maybeSingle();
    if (!t) return json({ error: "no token for store", store }, 404);
    const tokSecret = t.meta?.access_token_secret || "";
    const oauth = [
      `oauth_consumer_key="${encodeURIComponent(MS_KEY)}"`,
      `oauth_token="${encodeURIComponent(t.access_token)}"`,
      `oauth_signature_method="PLAINTEXT"`,
      `oauth_signature="${encodeURIComponent(MS_SECRET)}%26${encodeURIComponent(tokSecret)}"`,
      `oauth_timestamp="${Math.floor(Date.now() / 1000)}"`,
      `oauth_nonce="${crypto.randomUUID().replace(/-/g, "")}"`,
      `oauth_version="1.0"`,
    ].join(", ");
    try {
      const r = await fetch(`${MS_BASE}${path}`, {
        headers: { Authorization: `OAuth ${oauth}`, Accept: "application/json" },
        redirect: "manual",
      });
      const txt = await r.text();
      return json({
        store, path, status: r.status,
        location: r.headers.get("location") || undefined,
        content_type: r.headers.get("content-type") || undefined,
        body: txt.slice(0, 8000),
      });
    } catch (e) {
      return json({ store, path, error: String(e) }, 502);
    }
  }

  // TEMP: fetch a public asset (brand icon) and return it base64 — this
  // environment's egress is proxied but the edge runtime's isn't. Key-gated.
  if (q.get("action") === "fetch_icon") {
    if (!START_KEY || q.get("k") !== START_KEY) return json({ error: "bad key" }, 403);
    try {
      const r = await fetch(q.get("url") || "", { headers: { "User-Agent": "Mozilla/5.0" } });
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return json({ status: r.status, content_type: r.headers.get("content-type"), size: buf.length, b64: btoa(bin) });
    } catch (e) { return json({ error: String(e) }, 502); }
  }

  // Step 1: kick off the browser sign-in (per store — each store has its own
  // cpr.parts account).
  if (q.get("action") === "start") {
    if (!START_KEY || q.get("k") !== START_KEY) return page("Not authorized", "Bad or missing start key.", false);
    if (!MS_KEY || !MS_SECRET) return page("Not configured", "MS_CONSUMER_KEY / MS_CONSUMER_SECRET are not set.", false);
    const { data: stores } = await admin.from("stores").select("store").eq("active", true).order("display_order");
    const names: string[] = (stores || []).map((s: any) => s.store);
    const store = q.get("store") || "";
    if (!store || !names.includes(store)) {
      const { data: toks } = await admin.from("integration_tokens").select("provider,updated_at").like("provider", "ms:%");
      const connected = new Map((toks || []).map((t: any) => [t.provider.slice(3), t.updated_at]));
      const rows = names.map((n) => {
        const done = connected.get(n);
        const href = `${SB_URL}/functions/v1/ms-callback?action=start&k=${encodeURIComponent(START_KEY)}&store=${encodeURIComponent(n)}`;
        return `<a href="${href}" style="display:flex;justify-content:space-between;align-items:center;padding:13px 16px;margin:8px 0;border:1.5px solid #e2e2e8;border-radius:10px;text-decoration:none;color:#2D2D3B;font-weight:700">${n}<span style="font-weight:700;font-size:.85rem;color:${done ? "#1a9e55" : "#B9BDCB"}">${done ? "✓ connected" : "connect →"}</span></a>`;
      }).join("");
      return page("Connect cpr.parts Accounts", `Each store has its own cpr.parts account — connect them one at a time. <b>Sign out of cpr.parts (or use a private window) between stores</b> so each sign-in uses the right account.${rows}`);
    }
    try {
      await admin.from("ms_callback_log").insert({ method: "START", path: store, headers: {}, body: "" });
    } catch { /* marker best-effort */ }
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
      // Which store was this flow for? The most recent START marker.
      const { data: marks } = await admin.from("ms_callback_log").select("path,received_at")
        .eq("method", "START").order("received_at", { ascending: false }).limit(1);
      const store = marks?.[0]?.path || "";
      if (!store) return page("Token exchange worked, but…", "Couldn't tell which store this sign-in was for (no START marker). Go back to the store picker and click the store again.", false);
      const { error } = await admin.from("integration_tokens").upsert({
        provider: `ms:${store}`,
        access_token: tok,
        refresh_token: null,
        expires_at: null,
        realm_id: null,
        meta: { access_token_secret: tokSecret, base_url: MS_BASE, store, obtained_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: "provider" });
      if (error) return page("Stored… almost", `Got the access token but saving failed: ${error.message}`, false);
      const back = `${SB_URL}/functions/v1/ms-callback?action=start&k=${encodeURIComponent(START_KEY)}`;
      return page(`✅ ${store} Connected`, `This store's cpr.parts access token is stored server-side. <b>Sign out of cpr.parts (or switch to a private window)</b>, then <a href="${back}" style="color:#4FB0E3;font-weight:700">connect the next store →</a>`);
    } catch (e) {
      return page("Token exchange failed", String(e), false);
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
