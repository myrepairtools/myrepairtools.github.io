// intake — public new-hire intake proxy (token = the credential, same pattern
// as contracts/interviews). The browser NEVER touches staff_intake directly:
// candidates GET their invite + POST their submission here with the token;
// managers create invites / promote via their JWT (admin role checked).
//
// Candidate stage (v3): a link created WITH an offer letter opens as a
// candidate flow — sign the offer (or decline), sign the Employee Handbook
// acknowledgment (rendered live from the KB's Employee Handbook category),
// THEN the new-hire form. Signatures follow the contracts pattern (png
// data-url + typed name + ip/ua). Milestones fire a 'hiring' alert to the
// manager who created the link. Links created without an offer_body keep the
// original form-only behavior.
// Deploy with verify_jwt:false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
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
const PUBLIC_FIELDS = "token, status, invited_name, invited_store, position, start_hint, " +
  "offer_body, offer_signed_at, offer_signed_name, offer_declined_at, " +
  "handbook_signed_at, handbook_signed_name, " +
  "legal_first, legal_middle, legal_last, preferred_name, dob, phone, personal_email, " +
  "address, emergency, emergency2, shirt_size, availability, i9_docs, submitted_at";

// Signature validation — same bounds as the contracts function.
function badSig(sig: string): boolean {
  return !sig.startsWith("data:image/png;base64,") || sig.length < 1000 || sig.length > 400000;
}
function sigMeta(req: Request) {
  return {
    ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim(),
    ua: (req.headers.get("user-agent") || "").slice(0, 300),
    at: new Date().toISOString(),
  };
}

// Best-effort 'hiring' alert to the manager who created the link — a
// notification problem must never break the candidate's flow.
async function alertMgr(staffId: unknown, title: string, body: string) {
  const id = Number(staffId);
  if (!id || !NOTIFY_SECRET) return;
  try {
    await fetch(SB_URL + "/functions/v1/alerts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send", secret: NOTIFY_SECRET, kind: "hiring",
        title, body, link: "onboarding-dashboard.html", staff_ids: [id],
      }),
    });
  } catch { /* best-effort */ }
}

// The Employee Handbook, rendered live from the KB so candidates always sign
// the current wording. Read with the service role but filtered to published,
// employee-visible articles only.
async function handbookArticles() {
  const { data: cat } = await admin.from("kb_categories").select("id").ilike("name", "%handbook%").maybeSingle();
  if (!cat) return [];
  const { data } = await admin.from("kb_articles")
    .select("slug, title, body, sort_order")
    .eq("category_id", cat.id).eq("status", "published").eq("min_role", "employee")
    .order("sort_order").order("id");
  return (data || []).map((a) => ({ slug: a.slug, title: a.title, body: a.body }));
}

function candName(it: Record<string, unknown>): string {
  return String(it.offer_signed_name || it.invited_name ||
    [it.legal_first, it.legal_last].filter(Boolean).join(" ") || "Candidate");
}

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
    // Hand the handbook over only when it's the next thing to sign.
    let handbook: unknown[] | undefined;
    if (data.offer_body && data.offer_signed_at && !data.offer_declined_at && !data.handbook_signed_at) {
      handbook = await handbookArticles();
    }
    return json({ ok: true, intake: data, ...(handbook ? { handbook } : {}) });
  }

  if (action === "sign_offer" || action === "decline_offer" || action === "sign_handbook") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("token", token).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (it.status === "promoted") return json({ error: "already_promoted" }, 409);
    if (!it.offer_body) return json({ error: "no_offer" }, 409);
    if (it.offer_declined_at) return json({ error: "declined" }, 409);
    const now = new Date().toISOString();
    const meta = (it.signed_meta && typeof it.signed_meta === "object") ? it.signed_meta : {};

    if (action === "sign_offer") {
      if (it.offer_signed_at) return json({ error: "already_signed" }, 409);
      const name = String(body.signed_name || "").trim();
      const sig = String(body.signature || "");
      if (name.length < 2) return json({ error: "name_required" }, 400);
      if (badSig(sig)) return json({ error: "signature_required" }, 400);
      const { error } = await admin.from("staff_intake").update({
        offer_signature: sig, offer_signed_name: name.slice(0, 120), offer_signed_at: now,
        signed_meta: { ...meta, offer: sigMeta(req) }, updated_at: now,
      }).eq("id", it.id).is("offer_signed_at", null);
      if (error) return json({ error: error.message }, 500);
      await alertMgr(it.invited_by, "Offer signed — " + name,
        name + " accepted and signed their offer" + (it.position ? " (" + it.position + ")" : "") + ". Handbook + new-hire form are next.");
      return json({ ok: true });
    }

    if (action === "decline_offer") {
      if (it.offer_signed_at) return json({ error: "already_signed" }, 409);
      const note = body.note == null ? null : String(body.note).slice(0, 500) || null;
      const { error } = await admin.from("staff_intake").update({
        status: "declined", offer_declined_at: now, decline_note: note, updated_at: now,
      }).eq("id", it.id).is("offer_declined_at", null);
      if (error) return json({ error: error.message }, 500);
      await alertMgr(it.invited_by, "Offer declined — " + candName(it),
        candName(it) + " declined the offer" + (it.position ? " (" + it.position + ")" : "") + (note ? '. "' + note + '"' : "."));
      return json({ ok: true });
    }

    // sign_handbook
    if (!it.offer_signed_at) return json({ error: "offer_first" }, 409);
    if (it.handbook_signed_at) return json({ error: "already_signed" }, 409);
    const name = String(body.signed_name || "").trim();
    const sig = String(body.signature || "");
    if (name.length < 2) return json({ error: "name_required" }, 400);
    if (badSig(sig)) return json({ error: "signature_required" }, 400);
    const { error } = await admin.from("staff_intake").update({
      handbook_signature: sig, handbook_signed_name: name.slice(0, 120), handbook_signed_at: now,
      signed_meta: { ...meta, handbook: sigMeta(req) }, updated_at: now,
    }).eq("id", it.id).is("handbook_signed_at", null);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "submit") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data: row } = await admin.from("staff_intake")
      .select("id, status, invited_by, position, offer_body, offer_signed_at, offer_declined_at, handbook_signed_at")
      .eq("token", token).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    if (row.status === "promoted") return json({ error: "already_promoted" }, 409);
    if (row.offer_declined_at) return json({ error: "declined" }, 409);
    // Docs flow: the form only opens after both signatures.
    if (row.offer_body && (!row.offer_signed_at || !row.handbook_signed_at)) return json({ error: "docs_first" }, 409);
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
    const nm = [patch.legal_first, patch.legal_last].filter(Boolean).join(" ") || "A candidate";
    await alertMgr(row.invited_by, "New-hire form in — " + nm,
      nm + " finished their paperwork" + (row.offer_body ? " (offer + handbook signed)" : "") + " — ready to convert to a New Employee.");
    return json({ ok: true });
  }

  // ---- manager side (JWT auth) ----
  const mgr = await manager(req);
  if (!mgr) return json({ error: "forbidden" }, 403);
  if (action === "create") {
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const s = (k: string, max = 200) => String(body[k] || "").slice(0, max) || null;
    const { data, error } = await admin.from("staff_intake").insert({
      token, status: "sent",
      invited_name: s("invited_name", 120),
      invited_store: s("invited_store", 60),
      invited_by: mgr.id,
      position: s("position", 80), pay: s("pay", 120), start_hint: s("start_hint", 60),
      offer_body: body.offer_body == null ? null : String(body.offer_body).slice(0, 8000) || null,
      phone: s("phone", 30), personal_email: s("personal_email"),
    }).select("id, token").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id, token: data.token });
  }
  if (action === "cancel") {
    // delete an un-promoted intake (test rows, rescinded offers, declines).
    // Promoted intakes are history — they can't be removed from here.
    const intakeId = Number(body.intake_id);
    if (!intakeId) return json({ error: "intake_id required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("id, status").eq("id", intakeId).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (it.status === "promoted") return json({ error: "already_promoted" }, 409);
    const { error } = await admin.from("staff_intake").delete().eq("id", intakeId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "promote") {
    // copy the intake onto an existing staff row + staff_profiles, stamp the
    // link, and fire module auto-assign for the hire. staff_id required (the
    // staff row is created by the QB Time sync or Team Members first).
    // Doc gating lives in the UI (a paper-signed candidate can still be
    // converted) — but a declined offer is a hard no.
    const intakeId = Number(body.intake_id), staffId = Number(body.staff_id);
    if (!intakeId || !staffId) return json({ error: "intake_id and staff_id required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("id", intakeId).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (it.offer_declined_at) return json({ error: "declined" }, 409);
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
