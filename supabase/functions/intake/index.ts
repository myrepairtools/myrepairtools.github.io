// intake — public new-hire intake proxy (token = the credential, same pattern
// as contracts/interviews). The browser NEVER touches staff_intake directly:
// candidates GET their invite + POST their submission here with the token;
// managers create invites / promote via their JWT (admin role checked).
// Deploy with verify_jwt:false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function manager(req: Request) {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff").select("id, display_name, role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s && ["owner", "admin", "manager"].includes(s.role) ? s : null;
}
const PUBLIC_FIELDS = "token, status, invited_name, invited_store, legal_first, legal_middle, legal_last, preferred_name, dob, phone, personal_email, address, emergency, emergency2, shirt_size, availability, i9_docs, submitted_at";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body.action || "");

  // ---- candidate side (token auth) ----
  if (action === "get") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data } = await admin.from("staff_intake").select(PUBLIC_FIELDS).eq("token", token).maybeSingle();
    if (!data) return json({ error: "not_found" }, 404);
    return json({ ok: true, intake: data });
  }
  if (action === "submit") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data: row } = await admin.from("staff_intake").select("id, status").eq("token", token).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    if (row.status === "promoted") return json({ error: "already_promoted" }, 409);
    const f = (k: string, max = 200) => body[k] == null ? null : String(body[k]).slice(0, max) || null;
    const patch: Record<string, unknown> = {
      legal_first: f("legal_first"), legal_middle: f("legal_middle"), legal_last: f("legal_last"),
      preferred_name: f("preferred_name"), dob: f("dob", 10), phone: f("phone", 30),
      personal_email: f("personal_email"),
      address: body.address && typeof body.address === "object" ? body.address : null,
      emergency: body.emergency && typeof body.emergency === "object" ? body.emergency : null,
      emergency2: body.emergency2 && typeof body.emergency2 === "object" ? body.emergency2 : null,
      shirt_size: f("shirt_size", 10), i9_docs: f("i9_docs"),
      availability: Array.isArray(body.availability) ? (body.availability as unknown[]).slice(0, 7) : null,
      status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from("staff_intake").update(patch).eq("id", row.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- manager side (JWT auth) ----
  const mgr = await manager(req);
  if (!mgr) return json({ error: "forbidden" }, 403);
  if (action === "create") {
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const { data, error } = await admin.from("staff_intake").insert({
      token, status: "sent",
      invited_name: String(body.invited_name || "").slice(0, 120) || null,
      invited_store: String(body.invited_store || "").slice(0, 60) || null,
      invited_by: mgr.id,
    }).select("id, token").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id, token: data.token });
  }
  if (action === "promote") {
    // copy the intake onto an existing staff row + staff_profiles, stamp the
    // link, and fire module auto-assign for the hire. staff_id required (the
    // staff row is created by the QB Time sync or Team Members first).
    const intakeId = Number(body.intake_id), staffId = Number(body.staff_id);
    if (!intakeId || !staffId) return json({ error: "intake_id and staff_id required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("id", intakeId).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    const { data: st } = await admin.from("staff").select("id, role, start_date, birthday, first_name, last_name, preferred_name").eq("id", staffId).maybeSingle();
    if (!st) return json({ error: "staff_not_found" }, 404);
    const patch: Record<string, unknown> = {};
    if (it.legal_first && !st.first_name) patch.first_name = it.legal_first;
    if (it.legal_last && !st.last_name) patch.last_name = it.legal_last;
    if (it.preferred_name && !st.preferred_name) patch.preferred_name = it.preferred_name;
    if (it.dob && !st.birthday) patch.birthday = it.dob;
    if (Object.keys(patch).length) await admin.from("staff").update(patch).eq("id", staffId);
    // contact + emergency onto staff_profiles (never overwrite non-empty)
    const { data: prof } = await admin.from("staff_profiles").select("staff_id, phone, personal_email, emergency").eq("staff_id", staffId).maybeSingle();
    await admin.from("staff_profiles").upsert({
      staff_id: staffId,
      phone: prof?.phone || it.phone || null,
      personal_email: prof?.personal_email || it.personal_email || null,
      emergency: prof?.emergency || it.emergency || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "staff_id" });
    await admin.from("staff_intake").update({
      status: "promoted", promoted_staff_id: staffId, promoted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", intakeId);
    // fire auto-assign: modules whose rule matches this hire
    const { data: mods } = await admin.from("onboarding_modules").select("id, auto_assign_role, auto_assign_from").eq("active", true);
    const hired = String(st.start_date || new Date().toISOString().slice(0, 10));
    let assigned = 0;
    for (const m of (mods || [])) {
      if (!m.auto_assign_role) continue;
      const roleOk = m.auto_assign_role === "any" || m.auto_assign_role === st.role
        || (m.auto_assign_role === "team_member" && ["employee", "team_member"].includes(st.role));
      const dateOk = !m.auto_assign_from || hired >= String(m.auto_assign_from);
      if (!roleOk || !dateOk) continue;
      const { error } = await admin.from("onboarding_assignments")
        .upsert({ staff_id: staffId, module_id: m.id, assigned_by: mgr.id }, { onConflict: "staff_id,module_id", ignoreDuplicates: true });
      if (!error) assigned++;
    }
    return json({ ok: true, assigned });
  }
  return json({ error: "unknown action" }, 400);
});
