/* ===========================================================================
 * CPR auth.js — Unified access client (the "base").
 * ---------------------------------------------------------------------------
 * Replaces, over time, the three legacy gates:
 *   - site-gate.js   (shared site password)          → STORE SESSION
 *   - admin-gate.js  (per-person passcode)           → PERSONAL SESSION
 *   - nav.js auth    (cprNavAuth role passcode)       → can() visibility
 *
 * It is ADDITIVE for now: including this file changes nothing on its own. Pages
 * opt in by calling CPRAuth.requireStore() / CPRAuth.requirePin(key) and by
 * reading CPRAuth.can(key). We cut tools over one at a time (Consumption first).
 *
 * ── Two session layers (see Access & Auth migration hand-off, §2) ───────────
 *   STORE SESSION    one shared password → a device is "in" a store, all day,
 *                    no idle timer. Cached in localStorage. Re-auth only when
 *                    the store password is rotated (pw_version changes).
 *   PERSONAL SESSION an employee PIN unlock layered on top — identifies WHO is
 *                    standing there. 5-min idle relock. Cached in sessionStorage.
 *                    Carries the JWT + the person's effective permission keys
 *                    for the active store.
 *
 * Effective permission at a store = union of every role the person holds there
 * (direct + via groups). That union is resolved SERVER-SIDE and returned by the
 * pin_unlock call; the client copy below is for UX only (hiding tiles/buttons).
 * Real enforcement is Supabase RLS keyed to the unlocked employee — never trust
 * can() for security.
 *
 * ── Edge Function contract this client expects (cpr-auth, POST JSON) ─────────
 * All requests: { action, token: API_TOKEN, ...args }. All responses: JSON.
 *
 *   action:'store_login'  { store, password }
 *     → { ok:true, pw_version:<int> }                      | { ok:false, error }
 *
 *   action:'pw_version'   { }
 *     → { ok:true, pw_version:<int> }      // for rotation check on load
 *
 *   action:'pin_unlock'   { store, pin }
 *     → { ok:true, access_token, refresh_token, expires_at,
 *         staff:{ id, name }, permissions:[ "<key>", ... ] }  // effective @ store
 *                                                            | { ok:false, error, remaining?, locked? }
 *
 * The `permissions` array is the resolver output (hand-off §4) for THIS store.
 * ========================================================================= */
(function (global) {
  'use strict';

  // ── Config (anon key is public on purpose — see CLAUDE.md) ────────────────
  var SB_URL    = 'https://xuvsehrevxackuhmbmry.supabase.co';
  var ANON      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var AUTH_FN   = SB_URL + '/functions/v1/cpr-auth';   // unified auth service
  var API_TOKEN = '';                                  // TODO: set when the unified fn token is minted

  var STORE_KEY = 'cpr_store_session';   // localStorage — all day
  var PIN_KEY   = 'cpr_personal_session'; // sessionStorage — 5-min idle
  var IDLE_MS   = 5 * 60 * 1000;

  var inIframe = (global.self !== global.top);  // tools embedded in RepairQ skip gating

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function now(){ return Date.now(); }
  function lget(k){ try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(_){ return null; } }
  function lset(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(_){} }
  function ldel(k){ try { localStorage.removeItem(k); } catch(_){} }
  function sget(k){ try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch(_){ return null; } }
  function sset(k,v){ try { sessionStorage.setItem(k, JSON.stringify(v)); } catch(_){} }
  function sdel(k){ try { sessionStorage.removeItem(k); } catch(_){} }
  function emit(name, detail){ try { global.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch(_){} }

  function callFn(body){
    return fetch(AUTH_FN, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'apikey': ANON, 'Authorization':'Bearer ' + ANON },
      body: JSON.stringify(Object.assign({ token: API_TOKEN }, body))
    }).then(function(r){ return r.json().then(function(d){ return { status:r.status, data:d }; },
                                              function(){ return { status:r.status, data:{} }; }); });
  }

  // ── STORE SESSION (layer 1) ───────────────────────────────────────────────
  function storeSession(){ return lget(STORE_KEY); }            // {store, pw_version, ts} | null
  function storeName(){ var s = storeSession(); return s ? s.store : null; }
  function hasStore(){ return !!storeSession(); }

  function storeLogin(store, password){
    return callFn({ action:'store_login', store:store, password:password }).then(function(r){
      if (r.status === 200 && r.data && r.data.ok){
        lset(STORE_KEY, { store:store, pw_version:r.data.pw_version || 0, ts:now() });
        emit('cpr-auth:store', { store:store });
        return { ok:true };
      }
      return { ok:false, error:(r.data && r.data.error) || 'Incorrect password' };
    });
  }
  function storeSignOut(){ ldel(STORE_KEY); personalLock(); emit('cpr-auth:store', { store:null }); }

  // Re-auth the device if the shared password was rotated since this session.
  function checkRotation(){
    var s = storeSession(); if (!s) return Promise.resolve(true);
    return callFn({ action:'pw_version' }).then(function(r){
      if (r.status === 200 && r.data && r.data.ok && r.data.pw_version > (s.pw_version || 0)){
        storeSignOut(); return false;   // forces re-login
      }
      return true;
    }).catch(function(){ return true; }); // network blip → don't lock the shop out
  }

  // ── PERSONAL SESSION (layer 2) ────────────────────────────────────────────
  function personal(){ var p = sget(PIN_KEY); return (p && (now() - p.last) < IDLE_MS) ? p : null; }
  function user(){ var p = personal(); return p ? { id:p.staff_id, name:p.name } : null; }
  function token(){ var p = personal(); return p ? p.access_token : null; }
  function isUnlocked(){ return !!personal(); }

  function pinUnlock(pin){
    var store = storeName();
    if (!store) return Promise.resolve({ ok:false, error:'No store session' });
    return callFn({ action:'pin_unlock', store:store, pin:pin }).then(function(r){
      var d = r.data || {};
      if (r.status === 200 && d.ok){
        sset(PIN_KEY, {
          staff_id: d.staff && d.staff.id, name: d.staff && d.staff.name,
          access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at,
          store: store, perms: d.permissions || [], last: now()
        });
        emit('cpr-auth:user', { user:user(), store:store });
        return { ok:true, user:user() };
      }
      if (r.status === 423 || d.locked) return { ok:false, error:'Locked — an owner must reset this device.', locked:true };
      return { ok:false, error: d.error || 'Wrong PIN', remaining: d.remaining };
    });
  }
  function personalLock(){ if (sget(PIN_KEY)){ sdel(PIN_KEY); emit('cpr-auth:lock', {}); } }
  function touch(){ var p = sget(PIN_KEY); if (p && (now() - p.last) < IDLE_MS){ p.last = now(); sset(PIN_KEY, p); } }

  // ── ACCESS RESOLVER (client copy — UX only) ───────────────────────────────
  // can(key[, store]): does the unlocked employee hold `key` at `store`?
  // Defaults to the active store session. Cross-store checks need a fresh
  // unlock/resolve in v1 (the cached perms are for the active store).
  function can(key, store){
    var p = personal(); if (!p) return false;
    if (store && store !== p.store) return false;   // v1: only the active store is cached
    return (p.perms || []).indexOf(key) > -1;
  }
  function permissions(){ var p = personal(); return (p ? (p.perms || []) : []).slice(); }

  // ── idle relock loop ──────────────────────────────────────────────────────
  if (!inIframe){
    ['mousemove','keydown','click','scroll','touchstart'].forEach(function(ev){
      try { document.addEventListener(ev, touch, { passive:true }); } catch(_){}
    });
    setInterval(function(){ var p = sget(PIN_KEY); if (p && (now() - p.last) >= IDLE_MS) personalLock(); }, 20 * 1000);
  }

  // ── public API ────────────────────────────────────────────────────────────
  global.CPRAuth = {
    // store session
    storeSession: storeSession, storeName: storeName, hasStore: hasStore,
    storeLogin: storeLogin, storeSignOut: storeSignOut, checkRotation: checkRotation,
    // personal session
    user: user, token: token, isUnlocked: isUnlocked,
    pinUnlock: pinUnlock, lock: personalLock,
    // access
    can: can, permissions: permissions,
    // overlays (UI wired in a follow-up: requireStore / requirePin) — see TODO below
    requireStore: function(){ /* TODO: store sign-in overlay (rewrite of site-gate) */ },
    requirePin: function(/* key */){ /* TODO: PIN unlock overlay (rewrite of admin-gate) */ },
    // meta
    config: { SB_URL: SB_URL, ANON: ANON, AUTH_FN: AUTH_FN }
  };
})(typeof window !== 'undefined' ? window : this);
