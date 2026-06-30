// cpr-auth — Supabase Edge Function (recovered from the deployed v14 bundle).
// PIN-based auth + staff admin for the Supabase stack. Service-role backed.
//
// 2026-06-23: made role-checks bilingual for the staff.role cutover —
//   caller() accepts owner | manager | admin
//   canManageRole() targets employee | team_member
// so it works whether staff.role holds the legacy or the new vocabulary.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const URL = Deno.env.get("SUPABASE_URL");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SETUP_SECRET = Deno.env.get("SETUP_SECRET") ?? "";
const LOCK_AT = 5;
const admin = createClient(URL, SERVICE, {
  auth: {
    persistSession: false
  }
});
// ---- PIN hashing (PBKDF2 / Web Crypto) ----
const toHex = (b)=>[
    ...b
  ].map((x)=>x.toString(16).padStart(2, "0")).join("");
const fromHex = (h)=>new Uint8Array(h.match(/.{2}/g).map((x)=>parseInt(x, 16)));
async function hashPin(pin, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, [
    "deriveBits"
  ]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations: 100000,
    hash: "SHA-256"
  }, key, 256);
  return toHex(salt) + ":" + toHex(new Uint8Array(bits));
}
async function verifyPin(pin, stored) {
  const [saltHex] = stored.split(":");
  const re = await hashPin(pin, saltHex);
  if (re.length !== stored.length) return false;
  let diff = 0;
  for(let i = 0; i < re.length; i++)diff |= re.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}
const json = (b, s = 200)=>new Response(JSON.stringify(b), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*"
    }
  });
async function caller(req, body) {
  if (SETUP_SECRET && body.setup_secret === SETUP_SECRET) return {
    id: 0,
    role: "owner",
    boot: true
  };
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff").select("id, role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s && (s.role === "owner" || s.role === "manager" || s.role === "admin") ? s : null;
}
function canManageRole(callerRole, targetRole) {
  if (callerRole === "owner") return true;
  return targetRole === "employee" || targetRole === "team_member";
}
const displayFrom = (first, last, username)=>[
    first,
    last
  ].filter(Boolean).join(" ").trim() || (username ?? "");
// Shown name = owner-set preferred, else legal. Keeps display_name = preferred || legal so every
// existing reader of display_name shows the right thing (RepairQ report names are separate).
const displayName = (preferred, first, last, username)=>(String(preferred ?? "").trim() || displayFrom(first, last, username));
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return json({}, 200);
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "bad body"
    }, 400);
  }
  const action = body.action;
  // ---------- LOGIN (by PIN; username optional) ----------
  if (action === "login") {
    const { username, pin, device_id, store } = body;
    if (!pin || !device_id) return json({
      error: "missing fields"
    }, 400);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "";
    const { data: att } = await admin.from("login_attempts").select("*").eq("device_id", device_id).maybeSingle();
    if (att?.locked) return json({
      error: "locked",
      locked: true
    }, 423);
    // Identify the staff member: by username if given, else by PIN alone.
    // PIN-only must resolve to exactly ONE active staff member, so PINs must
    // be unique across staff; an ambiguous PIN is rejected like a bad PIN.
    let staff = null;
    if (username) {
      const { data } = await admin.from("staff").select("*").ilike("username", username).eq("active", true).limit(1).maybeSingle();
      staff = (data && await verifyPin(pin, data.pin_hash)) ? data : null;
    } else {
      const { data: all } = await admin.from("staff").select("*").eq("active", true);
      const matches = [];
      for (const s of (all ?? [])){
        if (s.pin_hash && await verifyPin(pin, s.pin_hash)) matches.push(s);
      }
      staff = matches.length === 1 ? matches[0] : null;
    }
    const ok = !!staff;
    if (!ok) {
      const fails = (att?.fails ?? 0) + 1;
      await admin.from("login_attempts").upsert({
        device_id,
        ip,
        fails,
        locked: fails >= LOCK_AT,
        last_attempt: new Date().toISOString()
      }, {
        onConflict: "device_id"
      });
      return json({
        error: "invalid",
        remaining: Math.max(0, LOCK_AT - fails),
        locked: fails >= LOCK_AT
      }, 401);
    }
    await admin.from("login_attempts").upsert({
      device_id,
      ip,
      fails: 0,
      locked: false,
      last_attempt: new Date().toISOString()
    }, {
      onConflict: "device_id"
    });
    const { data: u } = await admin.auth.admin.getUserById(staff.auth_uid);
    const { data: link } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: u.user.email
    });
    const { data: sess } = await admin.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "email"
    });
    return json({
      access_token: sess.session.access_token,
      refresh_token: sess.session.refresh_token,
      start_store: store ?? null,
      staff: {
        display_name: staff.display_name,
        role: staff.role,
        home_store: staff.home_store,
        authorized_stores: staff.authorized_stores
      }
    });
  }
  // ---------- ADMIN: list full staff ----------
  if (action === "list_staff_admin") {
    const c = await caller(req, body);
    if (!c) return json({
      error: "forbidden"
    }, 403);
    const { data } = await admin.from("staff").select("id, display_name, first_name, last_name, username, role, home_store, authorized_stores, active").order("active", {
      ascending: false
    }).order("display_name");
    return json({
      staff: data ?? [],
      me_role: c.role
    });
  }
  // ---------- ADMIN: list locked devices ----------
  if (action === "list_lockouts") {
    const c = await caller(req, body);
    if (!c) return json({
      error: "forbidden"
    }, 403);
    const { data } = await admin.from("login_attempts").select("device_id, ip, fails, last_attempt").eq("locked", true).order("last_attempt", {
      ascending: false
    });
    return json({
      lockouts: data ?? []
    });
  }
  // ---------- CREATE STAFF ----------
  if (action === "create_staff") {
    const c = await caller(req, body);
    if (!c) return json({
      error: "forbidden"
    }, 403);
    const { first_name, last_name, username, preferred_name, role, home_store, authorized_stores, pin, title, start_date, hr_status } = body;
    const newRole = role ?? "employee";
    if (!canManageRole(c.role, newRole)) return json({
      error: "managers can only create employees"
    }, 403);
    if (!username || !home_store || !pin) return json({
      error: "username, home store and PIN are required"
    }, 400);
    const email = `${crypto.randomUUID()}@pin.cpr.local`;
    const { data: created, error: ce } = await admin.auth.admin.createUser({
      email,
      password: crypto.randomUUID(),
      email_confirm: true
    });
    if (ce) return json({
      error: ce.message
    }, 400);
    const pin_hash = await hashPin(pin);
    const { error: ie } = await admin.from("staff").insert({
      auth_uid: created.user.id,
      display_name: displayName(preferred_name, first_name, last_name, username),
      preferred_name: (String(preferred_name ?? "").trim() || null),
      first_name: first_name ?? null,
      last_name: last_name ?? null,
      username,
      role: newRole,
      home_store,
      authorized_stores: authorized_stores ?? [],
      pin_hash,
      title: title ?? null,
      start_date: start_date || null,
      hr_status: hr_status ?? "active",
      active: true
    });
    if (ie) {
      await admin.auth.admin.deleteUser(created.user.id).catch(()=>{});
      const msg = /duplicate|unique/i.test(ie.message) ? "That username is already taken." : ie.message;
      return json({
        error: msg
      }, 400);
    }
    return json({
      ok: true
    });
  }
  // ---------- UPDATE STAFF ----------
  if (action === "update_staff") {
    const c = await caller(req, body);
    if (!c) return json({
      error: "forbidden"
    }, 403);
    const { staff_id, first_name, last_name, username, preferred_name, role, home_store, authorized_stores, active, title, start_date, hr_status, notes, archived } = body;
    if (!staff_id) return json({
      error: "missing staff_id"
    }, 400);
    const { data: target } = await admin.from("staff").select("role, first_name, last_name, username, preferred_name").eq("id", staff_id).maybeSingle();
    if (!target) return json({
      error: "not found"
    }, 404);
    if (!canManageRole(c.role, target.role)) return json({
      error: "managers cannot modify admins"
    }, 403);
    if (role && !canManageRole(c.role, role)) return json({
      error: "managers cannot assign admin roles"
    }, 403);
    const patch = {};
    if (first_name != null) patch.first_name = first_name;
    if (last_name != null) patch.last_name = last_name;
    if (username != null) patch.username = username;
    if (role != null) patch.role = role;
    if (home_store != null) patch.home_store = home_store;
    if (authorized_stores != null) patch.authorized_stores = authorized_stores;
    if (active != null) patch.active = active;
    if (title != null) patch.title = title;
    if (start_date != null) patch.start_date = start_date || null;
    if (hr_status != null) patch.hr_status = hr_status;
    if (notes != null) patch.notes = notes;
    if (archived != null) patch.archived = archived;
    // preferred_name: "" clears the override (back to legal), a value sets it, omitted leaves as-is.
    if (preferred_name != null) patch.preferred_name = (String(preferred_name).trim() || null);
    if (first_name != null || last_name != null || username != null || preferred_name != null) {
      const pref = preferred_name != null ? preferred_name : target.preferred_name;
      patch.display_name = displayName(pref, first_name ?? target.first_name, last_name ?? target.last_name, username ?? target.username);
    }
    const { error } = await admin.from("staff").update(patch).eq("id", staff_id);
    if (error) {
      const msg = /duplicate|unique/i.test(error.message) ? "That username is already taken." : error.message;
      return json({
        error: msg
      }, 400);
    }
    return json({
      ok: true
    });
  }
  // ---------- SET / RESET PIN ----------
  if (action === "set_pin") {
    const c = await caller(req, body);
    if (!c) return json({
      error: "forbidden"
    }, 403);
    const { staff_id, pin } = body;
    if (!staff_id || !pin) return json({
      error: "missing fields"
    }, 400);
    const { data: target } = await admin.from("staff").select("role").eq("id", staff_id).maybeSingle();
    if (!target) return json({
      error: "not found"
    }, 404);
    if (!canManageRole(c.role, target.role)) return json({
      error: "managers cannot reset an admin's PIN"
    }, 403);
    const { error } = await admin.from("staff").update({
      pin_hash: await hashPin(pin)
    }).eq("id", staff_id);
    return error ? json({
      error: error.message
    }, 400) : json({
      ok: true
    });
  }
  // ---------- RESET LOCKOUT ----------
  if (action === "reset_lockout") {
    const c = await caller(req, body);
    if (!c) return json({
      error: "forbidden"
    }, 403);
    const { device_id } = body;
    if (!device_id) return json({
      error: "missing device_id"
    }, 400);
    await admin.from("login_attempts").update({
      fails: 0,
      locked: false
    }).eq("device_id", device_id);
    return json({
      ok: true
    });
  }
  return json({
    error: "unknown action"
  }, 400);
});
