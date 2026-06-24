/* ===========================================================================
 * CPR pin-gate.js — the single front door for the whole site.
 *
 * Drop into any page with: <script src="assets/pin-gate.js"></script>
 * (load it BEFORE assets/nav.js). It covers the page until a valid Supabase
 * PIN session exists, then reveals it. One personal PIN = logged in + identified;
 * role (from the PIN) decides which tools are reachable. Replaces the old shared
 * site-wide password and every per-page PIN lock.
 *
 * Flow: no session -> PIN box. On login it sets the session and RELOADS, so the
 * page boots with the session present (its own legacy lock never appears). A
 * session without the required role for this page -> "no access". 5-min idle.
 * Skipped inside an iframe (RepairQ embeds) like the other gates.
 * ========================================================================= */
(function () {
  'use strict';
  if (window.self !== window.top) return;

  var SB_URL  = 'https://xuvsehrevxackuhmbmry.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var SB_FN   = SB_URL + '/functions/v1/cpr-auth';

  // pages that need more than "any logged-in user" (mirrors nav.js PRIVILEGED)
  var MINROLE = {
    'cash-admin.html':'admin', 'employee-records.html':'admin',
    'claim-ledger.html':'owner', 'commission-calculator.html':'owner',
    'profit-first.html':'owner', 'staff-management.html':'owner', 'settings.html':'owner'
  };
  var RANK = { none:0, team_member:1, employee:1, manager:2, admin:2, owner:3 };
  var file = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var NEED = RANK[MINROLE[file] || 'team_member'] || 1;
  var IDLE_MS = 5 * 60 * 1000;

  var sb = null, sbReady = null, idleTimer = null;
  function loadSB(){
    if (sbReady) return sbReady;
    sbReady = import('https://esm.sh/@supabase/supabase-js@2')
      .then(function(m){ sb = m.createClient(SB_URL, SB_ANON); return sb; })
      .catch(function(){ sb = null; return null; });
    return sbReady;
  }
  function device(){ try { var d = localStorage.getItem('cpr_device_id'); if (!d){ d = 'dev-'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem('cpr_device_id', d); } return d; } catch(_){ return 'dev-x'; } }
  function rankOf(role){ return RANK[role === 'manager' ? 'admin' : role] || 0; }

  // full-screen cover, up immediately so page content never shows pre-auth
  var host = document.createElement('div');
  host.id = 'cpr-pingate';
  host.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;background:#2D2D3B;display:flex;align-items:center;justify-content:center;font-family:Nunito Sans,system-ui,sans-serif;padding:24px');
  host.innerHTML = '<div style="color:rgba(255,255,255,.45);font-weight:700;font-family:Nunito,system-ui">…</div>';
  (function(){ var st=document.createElement('style'); st.textContent='#cpr-pingate input::placeholder{color:rgba(255,255,255,.45)}#cpr-pingate input:focus{border-color:#4FB0E3 !important;background:rgba(255,255,255,.10) !important}'; (document.head||document.documentElement).appendChild(st); })();
  (document.body || document.documentElement).appendChild(host);

  // myRepairTools wordmark, inlined with a tight viewBox so the art centers
  // (the source SVG's 0 0 372 64 box has ~80px of empty space on the right).
  function logoSvg(w, mb){
    return '<svg viewBox="0 0 308 64" width="'+w+'" style="max-width:100%;height:auto;display:block;margin:0 auto '+mb+'px" xmlns="http://www.w3.org/2000/svg" fill="none" role="img" aria-label="myRepairTools">'
      + '<path d="M30 18 18 32l12 14M44 18l12 14-12 14" stroke="#DC282E" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"></path>'
      + '<text x="74" y="44" font-family="&#39;Nunito&#39;,&#39;Trebuchet MS&#39;,sans-serif" font-size="30" font-weight="800"><tspan fill="#FFFFFF">myRepair</tspan><tspan fill="#DC282E">Tools</tspan></text>'
      + '</svg>';
  }
  function reveal(){ if (host && host.parentNode) host.parentNode.removeChild(host); armIdle(); }
  function armIdle(){ ['click','keydown','mousemove','touchstart','scroll'].forEach(function(ev){ window.addEventListener(ev, bumpIdle, { passive:true }); }); bumpIdle(); }
  function bumpIdle(){ clearTimeout(idleTimer); idleTimer = setTimeout(signOutReload, IDLE_MS); }
  function signOutReload(){ loadSB().then(function(c){ if (c) c.auth.signOut().then(function(){ location.reload(); }, function(){ location.reload(); }); else location.reload(); }); }

  function gateForm(msg){
    host.innerHTML = ''
      + '<div style="width:300px;max-width:calc(100% - 40px);text-align:center">'
      +   logoSvg(236, 28)
      +   '<input id="cpr-pg-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="Enter PIN" style="width:100%;font-family:Nunito Sans,system-ui;font-size:1.05rem;text-align:center;letter-spacing:4px;padding:13px;border:1.5px solid rgba(255,255,255,.18);border-radius:11px;background:rgba(255,255,255,.06);color:#fff;outline:none">'
      +   '<button id="cpr-pg-go" style="width:100%;font-family:Nunito,system-ui;font-weight:800;font-size:.95rem;border:none;border-radius:11px;padding:13px;margin-top:11px;background:#DC282E;color:#fff;cursor:pointer">Sign in</button>'
      +   '<div id="cpr-pg-err" style="color:#F7A6A8;font-size:.78rem;font-weight:700;margin-top:11px;min-height:1em">'+(msg||'')+'</div>'
      + '</div>';
    var pin = host.querySelector('#cpr-pg-pin'), go = host.querySelector('#cpr-pg-go'), err = host.querySelector('#cpr-pg-err');
    if (pin) pin.focus();
    function submit(){
      var v = pin.value.trim(); if (!v) return;
      go.disabled = true; err.textContent = 'Signing in…';
      loadSB().then(function(c){
        if (!c){ go.disabled = false; err.textContent = 'Could not reach the server.'; return; }
        fetch(SB_FN, { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+SB_ANON, 'apikey':SB_ANON }, body: JSON.stringify({ action:'login', pin:v, device_id:device() }) })
          .then(function(r){ return r.json().then(function(d){ return { status:r.status, data:d }; }, function(){ return { status:r.status, data:{} }; }); })
          .then(function(res){
            var d = res.data || {};
            if (res.status !== 200 || !d.access_token){
              go.disabled = false;
              err.textContent = d.error === 'invalid' ? ('Wrong PIN.' + (d.remaining!=null ? (' '+d.remaining+' left.') : ''))
                              : (res.status === 423 || d.locked) ? 'Locked — too many tries.'
                              : (d.error || 'Could not sign in.');
              return;
            }
            // Tokens are valid; setSession persists them to storage. Its promise
            // can reject/hang on lock contention from the other Supabase clients
            // on the page, so reload regardless once it settles (or after a
            // backstop) — the reloaded page picks up the saved session.
            var reloaded = false;
            function proceed(){ if (reloaded) return; reloaded = true; location.reload(); }
            try { c.auth.setSession({ access_token:d.access_token, refresh_token:d.refresh_token }).then(proceed, proceed); }
            catch (e) { proceed(); }
            setTimeout(proceed, 2000);
          }, function(){ go.disabled = false; err.textContent = 'Could not reach the server.'; });
      });
    }
    if (go) go.onclick = submit;
    if (pin) pin.addEventListener('keydown', function(e){ if (e.key === 'Enter') submit(); });
  }

  function noAccess(name){
    host.innerHTML = ''
      + '<div style="width:330px;max-width:calc(100% - 40px);text-align:center;color:#fff">'
      +   logoSvg(196, 24)
      +   '<div style="font-family:Nunito,system-ui;font-weight:900;font-size:1.05rem">No access to this tool</div>'
      +   '<div style="font-size:.82rem;color:rgba(255,255,255,.6);font-weight:600;margin:7px 0 18px">Signed in as '+(name||'you')+'. This tool needs a higher access level.</div>'
      +   '<button id="cpr-pg-home" style="font-family:Nunito,system-ui;font-weight:800;font-size:.82rem;border:none;border-radius:9px;padding:10px 16px;background:#DC282E;color:#fff;cursor:pointer;margin-right:8px">Home</button>'
      +   '<button id="cpr-pg-switch" style="font-family:Nunito,system-ui;font-weight:800;font-size:.82rem;border:1.5px solid rgba(255,255,255,.22);border-radius:9px;padding:10px 16px;background:transparent;color:#fff;cursor:pointer">Switch user</button>'
      + '</div>';
    host.querySelector('#cpr-pg-home').onclick = function(){ location.href = 'index.html'; };
    host.querySelector('#cpr-pg-switch').onclick = signOutReload;
  }

  loadSB().then(function(c){
    if (!c){ gateForm('Offline — could not load sign-in.'); return; }
    c.auth.getSession().then(function(res){
      var sess = res && res.data && res.data.session;
      if (!sess){ gateForm(''); return; }
      c.from('staff').select('display_name,role').eq('auth_uid', sess.user.id).maybeSingle().then(function(sr){
        var role = sr && sr.data ? sr.data.role : null;
        if (!role){ reveal(); return; }                       // valid session, role unknown -> let RLS govern
        if (rankOf(role) < NEED){ noAccess(sr.data.display_name); return; }
        reveal();
      }, function(){ reveal(); });                            // role read failed -> fail open (data still RLS-protected)
    }, function(){ gateForm(''); });
  });
})();
