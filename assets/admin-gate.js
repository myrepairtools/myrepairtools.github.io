/* ===========================================================================
 * CPR admin-gate.js — shared per-person passcode gate for protected pages.
 * ---------------------------------------------------------------------------
 * Add to any page that should require an admin login:
 *   <script src="assets/admin-gate.js"></script>
 * Public tools simply omit it.
 *
 * - Passcodes are verified server-side (Cash Tracker web app) and never stored
 *   in any page. This file only asks "is this code valid?".
 * - One unlock covers every gated page for the session; auto-relocks after
 *   30 minutes of inactivity.
 * - Exposes window.CPRGate: user(), ownerCode(), lock(), and fires a
 *   'cpr-unlocked' event with detail {name, role} when access is granted.
 * ========================================================================= */
(function () {
  'use strict';

  // ── Standalone CPR Auth service (its own sheet + deployment) ──
  // Paste the auth web-app /exec URL here after you deploy auth-Code.gs:
  var AUTH_URL  = 'https://script.google.com/macros/s/AKfycbwdMg4UB4W8tsRqAK9a5qJZpkcw6-8fVy926WRZwsyf3-KYHNRN0R7q4GtA7PjpXkNYRQ/exec';
  var API_TOKEN = '1b22aae72481896270d294fd8ef8e6319b55002edcd8e90b5348407b0f0caad5';
  var WEBAPP_URL = AUTH_URL;
  var IDLE_MS = 30 * 60 * 1000;            // 30-minute idle relock
  var KEY = 'cpr_admin_session';

  function now(){ return Date.now(); }
  function getS(){ try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function setS(s){ try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function clearS(){ try { sessionStorage.removeItem(KEY); } catch (e) {} }
  function valid(s){ return !!(s && s.name && (now() - s.last) < IDLE_MS); }

  // ---- overlay ----
  var overlay = null;
  function buildOverlay(){
    var o = document.createElement('div');
    o.id = 'cpr-gate';
    o.innerHTML =
      '<div class="cg-box">' +
        '<div class="cg-ic">&#128274;</div>' +
        '<div class="cg-title">Admin Access</div>' +
        '<div class="cg-sub">Enter your passcode</div>' +
        '<input id="cg-code" type="password" inputmode="numeric" autocomplete="off" placeholder="Passcode" />' +
        '<button id="cg-go" type="button">Unlock</button>' +
        '<div class="cg-err" id="cg-err"></div>' +
      '</div>';
    var css = document.createElement('style');
    css.textContent =
      '#cpr-gate{position:fixed;inset:0;background:#2D2D3B;z-index:2147483000;display:flex;align-items:center;justify-content:center;font-family:Nunito,system-ui,sans-serif}' +
      '#cpr-gate .cg-box{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:34px 38px;width:100%;max-width:330px;text-align:center}' +
      '#cpr-gate .cg-ic{font-size:30px;margin-bottom:14px}' +
      '#cpr-gate .cg-title{font-weight:900;font-size:18px;color:#fff;margin-bottom:4px}' +
      '#cpr-gate .cg-sub{font-size:12px;color:rgba(255,255,255,.45);font-weight:600;margin-bottom:22px}' +
      '#cpr-gate input{width:100%;background:rgba(255,255,255,.08);border:1.5px solid rgba(255,255,255,.16);border-radius:8px;padding:12px 14px;font-size:16px;color:#fff;margin-bottom:12px;font-family:inherit}' +
      '#cpr-gate input:focus{outline:none;border-color:#DC282E}' +
      '#cpr-gate button{width:100%;background:#DC282E;border:none;border-radius:8px;padding:12px;font-weight:800;font-size:14px;color:#fff;cursor:pointer;font-family:inherit}' +
      '#cpr-gate button:hover{background:#F15F5E}' +
      '#cpr-gate .cg-err{color:#ef4444;font-size:12px;font-weight:700;min-height:16px;margin-top:10px}';
    document.head.appendChild(css);
    document.body.appendChild(o);
    var input = o.querySelector('#cg-code');
    var go = o.querySelector('#cg-go');
    var err = o.querySelector('#cg-err');
    function attempt(){
      var code = input.value.trim();
      if (!code) return;
      go.disabled = true; err.textContent = 'Checking…';
      fetch(WEBAPP_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
        body: JSON.stringify({ action:'login', token:API_TOKEN, code:code }) })
        .then(function(r){ return r.json(); })
        .then(function(res){
          go.disabled = false;
          if (res && res.ok){
            setS({ name:res.name, role:res.role, code:code, last:now() });
            err.textContent = '';
            removeOverlay();
            document.dispatchEvent(new CustomEvent('cpr-unlocked', { detail:{ name:res.name, role:res.role } }));
          } else {
            input.value = ''; err.textContent = (res && res.error) || 'Invalid passcode';
            setTimeout(function(){ err.textContent=''; }, 2200);
          }
        })
        .catch(function(){ go.disabled=false; err.textContent='Connection error'; });
    }
    go.onclick = attempt;
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter') attempt(); });
    setTimeout(function(){ input.focus(); }, 60);
    return o;
  }
  function showOverlay(){ if (!overlay) overlay = buildOverlay(); }
  function removeOverlay(){ if (overlay){ overlay.remove(); overlay = null; } }

  // ---- idle tracking ----
  function touch(){ var s = getS(); if (valid(s)){ s.last = now(); setS(s); } }
  ['mousemove','keydown','click','scroll','touchstart'].forEach(function(ev){
    document.addEventListener(ev, touch, { passive:true });
  });
  setInterval(function(){
    var s = getS();
    if (s && (now() - s.last) >= IDLE_MS){ clearS(); showOverlay(); }
  }, 20 * 1000);

  // ---- public API ----
  function ownerPost(action, extra){
    var s = getS(); if (!valid(s)) return Promise.reject('Locked');
    var body = { action:action, token:API_TOKEN, code:s.code };
    if (extra) for (var k in extra) body[k] = extra[k];
    return fetch(WEBAPP_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(body) }).then(function(r){ return r.json(); });
  }
  window.CPRGate = {
    user: function(){ var s = getS(); return valid(s) ? { name:s.name, role:s.role } : null; },
    ownerCode: function(){ var s = getS(); return valid(s) ? s.code : null; },
    lock: function(){ clearS(); showOverlay(); },
    listAdmins: function(){ return ownerPost('listAdmins'); },
    saveAdmins: function(rows){ return ownerPost('saveAdmins', { rows:rows }); },
    saveAdmins: function(rows){ return ownerPost('saveAdmins', { rows:rows }); },
    // Roster (any logged-in user; the server filters/permits by role)
    listEmployees: function(){ return ownerPost('listEmployees'); },
    saveEmployee: function(emp){ return ownerPost('saveEmployee', { data: JSON.stringify(emp) }); },
    deleteEmployee: function(id){ return ownerPost('deleteEmployee', { id:id }); }
  };
  };

  // ---- init ----
  function init(){
    var s = getS();
    if (valid(s)){
      document.dispatchEvent(new CustomEvent('cpr-unlocked', { detail:{ name:s.name, role:s.role } }));
    } else {
      clearS(); showOverlay();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
