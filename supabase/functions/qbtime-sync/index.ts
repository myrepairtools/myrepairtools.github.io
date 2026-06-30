// QuickBooks Time data layer: keeps the OAuth token fresh and runs syncs.
// Auth: owner JWT (Authorization: Bearer <session>) OR ?secret=<QBT_SYNC_SECRET> (cron/server).
//
// Actions (GET ?action=):
//   ping     -> calls /current_user; proves the token works, returns account info
//   refresh  -> force a token refresh (keep-alive); returns the new expiry
//   users    -> pull all QB Time users, upsert qbtime_users, auto-match to staff by name/username
//
// The access token is short-lived (~10d); getValidToken() trades the refresh token for a new
// access+refresh pair when it's within 2 days of expiry, so the connection never goes stale.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("QBT_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("QBT_CLIENT_SECRET") || "";
const SYNC_SECRET = Deno.env.get("QBT_SYNC_SECRET") || "";
const PROVIDER = "qbtime";
const API = "https://rest.tsheets.com/api/v1/";
const GRANT = "https://rest.tsheets.com/api/v1/grant";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return false;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return false;
  const { data: s } = await admin.from("staff").select("role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s?.role === "owner";
}

// Returns a valid access token, refreshing (and persisting) if it's near expiry.
async function getValidToken(): Promise<string> {
  const { data: tok } = await admin.from("integration_tokens").select("*").eq("provider", PROVIDER).maybeSingle();
  if (!tok || !tok.access_token) throw new Error("not_connected");
  const exp = tok.expires_at ? new Date(tok.expires_at).getTime() : 0;
  const soon = Date.now() > exp - 2 * 24 * 3600 * 1000; // refresh within 2 days of expiry
  if (!soon) return tok.access_token;
  if (!tok.refresh_token) throw new Error("no_refresh_token");

  const form = new URLSearchParams({
    grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: tok.refresh_token,
  });
  const r = await fetch(GRANT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("refresh_failed: " + (d.error || r.status));
  const expires_at = new Date(Date.now() + (Number(d.expires_in) || 0) * 1000).toISOString();
  await admin.from("integration_tokens").update({
    access_token: d.access_token,
    refresh_token: d.refresh_token || tok.refresh_token,
    expires_at,
    meta: { scope: d.scope, token_type: d.token_type, client_url: d.client_url },
    updated_at: new Date().toISOString(),
  }).eq("provider", PROVIDER);
  return d.access_token;
}

async function qbtGet(path: string, token: string, params?: Record<string, string | number>) {
  const u = new URL(API + path);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString(), { headers: { Authorization: "Bearer " + token } });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function norm(s: unknown) { return String(s ?? "").trim().toLowerCase(); }

// Pull every QB Time user, upsert into qbtime_users, and match each to a staff row.
async function syncUsers(token: string) {
  const users: Record<string, unknown>[] = [];
  let page = 1;
  for (let i = 0; i < 50; i++) { // hard page cap
    const { status, data } = await qbtGet("users", token, { page, per_page: 50, active: "both" });
    if (status !== 200) return { ok: false, error: `users_${status}`, detail: data };
    const obj = (data?.results?.users || {}) as Record<string, Record<string, unknown>>;
    users.push(...Object.values(obj));
    if (!data?.more) break;
    page++;
  }

  // staff lookup for matching (by first+last, fallback username)
  const { data: staff } = await admin.from("staff").select("id, first_name, last_name, username, display_name");
  const byName = new Map<string, number>(), byUser = new Map<string, number>();
  for (const s of staff || []) {
    const fn = norm(s.first_name), ln = norm(s.last_name);
    if (fn && ln) byName.set(fn + "|" + ln, s.id as number);
    if (s.username) byUser.set(norm(s.username), s.id as number);
    // also index display_name split as a fallback
    const dn = String(s.display_name || "").trim().split(/\s+/);
    if (dn.length >= 2) byName.set(norm(dn[0]) + "|" + norm(dn.slice(1).join(" ")), s.id as number);
  }

  const rows = users.map((u) => {
    const fn = norm(u.first_name), ln = norm(u.last_name);
    const staff_id = byName.get(fn + "|" + ln) ?? byUser.get(norm(u.username)) ?? null;
    return {
      qbt_id: String(u.id),
      staff_id,
      first_name: (u.first_name as string) || null,
      last_name: (u.last_name as string) || null,
      email: (u.email as string) || null,
      username: (u.username as string) || null,
      active: u.active === undefined ? null : !!u.active,
      raw: u,
      last_synced: new Date().toISOString(),
    };
  });

  if (rows.length) {
    const { error } = await admin.from("qbtime_users").upsert(rows, { onConflict: "qbt_id" });
    if (error) return { ok: false, error: "db_" + error.message };
  }
  return {
    ok: true,
    fetched: rows.length,
    matched: rows.filter((r) => r.staff_id != null).length,
    unmatched: rows.filter((r) => r.staff_id == null).map((r) => `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim()),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "ping";

  // auth: owner JWT or shared sync secret
  const secret = url.searchParams.get("secret") || req.headers.get("x-qbt-secret") || "";
  const authed = (SYNC_SECRET && secret === SYNC_SECRET) || (await isOwner(req));
  if (!authed) return json({ error: "forbidden", detail: "Owner or sync secret required." }, 403);

  let token: string;
  try { token = await getValidToken(); }
  catch (e) { return json({ error: "token", detail: String((e as Error).message) }, 409); }

  if (action === "refresh") {
    const { data } = await admin.from("integration_tokens").select("expires_at, updated_at").eq("provider", PROVIDER).maybeSingle();
    return json({ ok: true, expires_at: data?.expires_at, updated_at: data?.updated_at });
  }
  if (action === "ping") {
    const { status, data } = await qbtGet("current_user", token);
    if (status !== 200) return json({ ok: false, error: `ping_${status}`, detail: data }, 502);
    const u = Object.values((data?.results?.users || {}) as Record<string, Record<string, unknown>>)[0] || {};
    return json({ ok: true, account: data?.results?.users ? (u.client_url || data?.supplemental_data?.client_url) : null,
      user: { id: u.id, name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim(), email: u.email } });
  }
  if (action === "users") {
    return json(await syncUsers(token));
  }
  return json({ error: "bad_action" }, 400);
});
