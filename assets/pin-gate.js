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

  /* ---- window.CPRAuth — the one resolved-identity contract ----------------
     Pages must never re-derive identity for themselves. Twelve pages currently
     ship their own getSession()+staff lookup, and that duplication is what the
     passcode glitch is made of: this file already races getSession against a 4s
     timeout because three Supabase clients (here, nav.js, and the page's own)
     share one storage key and the call can HANG rather than reject. A page that
     repeats the call reproduces the hang on a page we have already revealed.

     Use it:  CPRAuth.ready.then(function(me){ ...render... })
                           .catch(function(e){ ...fail CLOSED... });

     It settles ONCE, and only on a definitive outcome:
       resolve — identity known. The page is (or is about to be) revealed.
       reject  — identity could NOT be established. Fail closed; do not render
                 as though the viewer were a manager. e.reason is one of
                 'no-staff-row' | 'staff-read-failed' | 'no-access'.
       pending — deliberately, while the PIN box is up, while offline, and
                 through every reconnect retry. Signing in RELOADS the page and
                 the network-heal path reveals WITHOUT a reload, so a promise
                 that stayed pending is exactly right: the page's boot code has
                 not run yet and will be resolved when boot finally succeeds.
                 Never poll this; await it.

     resolve payload:
       { id, name, role, home_store, authorized_stores,
         isOwner, isAdmin,          // isAdmin maps manager->admin like nav.js:163
         perms,                     // array, or null if not fetched on this page
         permsUnknown,              // true if the permission read failed
         gateSkipped }              // true only inside a non-?embed=1 iframe

     NOTE the fail-OPEN asymmetry, deliberately left as-is here: when the
     permission read fails this file still reveal()s the page (data stays
     RLS-protected). CPRAuth resolves in that case but sets permsUnknown, so a
     page that wants to fail closed can. Changing reveal() itself is a
     behavioural change with real lockout risk and does not belong in the commit
     that merely introduces this contract. */
  var authSettled = false, authResolveFn, authRejectFn, permsPromise = null;
  var CPRAuth = {
    ready: new Promise(function (res, rej) { authResolveFn = res; authRejectFn = rej; }),
    user: null,
    // Permission list on demand, cached. boot() only fetches permissions when
    // the page declares one, so pages that need the full list ask for it here
    // rather than re-implementing the RPC.
    perms: function () {
      if (permsPromise) return permsPromise;
      permsPromise = loadSB().then(function (c) {
        if (!c) return [];
        return c.rpc('my_permissions').then(function (pr) { return (pr && pr.data) || []; },
                                            function () { return []; });
      }, function () { return []; });
      return permsPromise;
    }
  };
  window.CPRAuth = CPRAuth;
  // Marks the rejection handled so a page that only uses .then() doesn't log an
  // unhandled rejection. The original promise still rejects for real consumers.
  CPRAuth.ready.catch(function () {});

  function authUser(row, perms, permsUnknown) {
    var role = row && row.role ? row.role : null;
    return {
      id: row ? row.id : null,
      name: (row && row.display_name) || '',
      role: role,
      home_store: row ? row.home_store : null,
      authorized_stores: (row && row.authorized_stores) || [],
      isOwner: role === 'owner',
      isAdmin: role === 'owner' || role === 'admin' || role === 'manager',
      perms: perms || null,
      permsUnknown: !!permsUnknown,
      gateSkipped: false
    };
  }
  function authResolve(u) { if (authSettled) return; authSettled = true; CPRAuth.user = u; authResolveFn(u); }
  function authReject(reason) {
    if (authSettled) return; authSettled = true;
    var e = new Error('CPRAuth: ' + reason); e.reason = reason; authRejectFn(e);
  }

  // Skipped inside an iframe (RepairQ embeds) — EXCEPT an explicit ?embed=1
  // surface like the extension's New Contract modal. That iframe gets its own
  // partitioned storage, so it can't see the top-level myrepairtools session:
  // without a gate of its own the page waits forever for a session that never
  // arrives and the modal just sits blank. Let the tech sign in right there.
  var IS_EMBED = (function () {
    try { return new URLSearchParams(location.search).get('embed') === '1'; } catch (e) { return false; }
  })();
  if (window.self !== window.top && !IS_EMBED) {
    // The gate does not run here, so identity is genuinely unknown — but a
    // pending promise would hang every embedded page forever. Resolve with
    // gateSkipped so a migrated page can take its own path instead of waiting.
    authResolve({ id:null, name:'', role:null, home_store:null, authorized_stores:[],
                  isOwner:false, isAdmin:false, perms:null, permsUnknown:true, gateSkipped:true });
    return;
  }

  var SB_URL  = 'https://xuvsehrevxackuhmbmry.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var SB_FN   = SB_URL + '/functions/v1/cpr-auth';

  // each page's "Access <Page>" permission key (owner bypasses; pages absent here
  // just need any valid session). Mirrors the permissions catalog / nav.js.
  var PAGEACC = {
    'cash-tracker.html':'cash.view', 'consumption-report.html':'consumption.view',
    'device-orders.html':'consumption.view',
    'damage-tracker.html':'damage.view', 'hyla-orders.html':'orders.hyla',
    'jerry-ding-order.html':'orders.jerryding',
    'price-calculator.html':'pricing.view', 'price-guide.html':'pricing.view',
    'cash-admin.html':'cash.admin', 'cash-journal.html':'cash.journal', 'expenses.html':'expenses.record',
    /* employee-records.html is deliberately absent: it is BOTH the Team Members
       roster and every employee's own "My Profile" (the avatar menu points here
       via #me). Gating the page on staff.view locked every non-manager out of
       their own record. The roster/self split is decided inside the page by
       SELFONLY, and the data by RLS — staff_self_read, staff_documents_read,
       staff_pips_read and alert_prefs all scope a team member to their own row. */
    'settings.html':'staff.manage',
    'daily-digest.html':'reports.digest',
    'claim-payouts.html':'claims.view', 'claim-ledger.html':'claims.view', 'commission-calculator.html':'commission.view',
    'commission-dashboard.html':'commission.dashboard',
    'profit-first.html':'profit.view'
  };
  var file = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var NEED_PERM = PAGEACC[file] || null;
  var IDLE_MS = 5 * 60 * 1000;
  // Installed home-screen apps are personal devices — the phone's own lock screen
  // is the security boundary, and iOS fires an expired idle timer the moment the
  // app resumes, which read as "logs me out every time I open it". So: standalone
  // mode never auto-signs-out (sign in once per install); the 5-min relock stays
  // for shared browsers at the stores.
  var STANDALONE = (window.matchMedia && matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;

  var sb = null, sbReady = null, idleTimer = null, netWait = false;
  // The Supabase client is an ESM import from a public CDN. esm.sh has frequent
  // blips (slow / rate-limited / momentarily down) that used to fail the whole
  // front door ("Offline — could not load sign-in") even for already-signed-in
  // users. So: try several CDNs in order, time each out, and on total failure
  // reset sbReady so the next call (and the auto-retry in boot) tries again.
  var SB_CDNS = [
    '/assets/supabase-js.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
    'https://cdn.skypack.dev/@supabase/supabase-js@2'
  ];
  function importRace(url){
    return Promise.race([
      import(url),
      new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('timeout')); }, 5000); })
    ]);
  }
  function loadSB(){
    if (sbReady) return sbReady;
    function attempt(i){
      if (i >= SB_CDNS.length) return Promise.resolve(null);
      return importRace(SB_CDNS[i]).then(
        function(m){ sb = m.createClient(SB_URL, SB_ANON); return sb; },
        function(){ return attempt(i + 1); }
      );
    }
    sbReady = attempt(0).then(function(c){ if (!c) sbReady = null; return c; });  // reset on failure → retryable
    return sbReady;
  }
  function device(){ try { var d = localStorage.getItem('cpr_device_id'); if (!d){ d = 'dev-'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem('cpr_device_id', d); } return d; } catch(_){ return 'dev-x'; } }

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
  function reveal(){ netWait = false; if (host && host.parentNode) host.parentNode.removeChild(host); armIdle(); }
  // Idle sign-out is SHARED ACROSS TABS: activity in ANY tab keeps them all
  // alive (a shared last-activity timestamp in localStorage). Without this, an
  // idle tab fired signOut() — which clears the localStorage session and
  // broadcasts to every tab — logging you out of the tab you were USING.
  var ACT_KEY = 'cpr_last_activity', lastActWrite = 0;
  function markActivity(){ try { localStorage.setItem(ACT_KEY, String(Date.now())); } catch(_){} }
  function lastActivity(){ try { return Number(localStorage.getItem(ACT_KEY)) || 0; } catch(_){ return 0; } }
  function armIdle(){
    if (STANDALONE) return;
    ['click','keydown','mousemove','touchstart','scroll'].forEach(function(ev){ window.addEventListener(ev, bumpIdle, { passive:true }); });
    // another tab's activity (shared key change) resets THIS tab's countdown
    window.addEventListener('storage', function(e){ if (e.key === ACT_KEY) rearm(); });
    bumpIdle();
  }
  function bumpIdle(){
    var now = Date.now();
    if (now - lastActWrite > 4000){ markActivity(); lastActWrite = now; }   // throttle cross-tab writes
    rearm();
  }
  function rearm(){ clearTimeout(idleTimer); idleTimer = setTimeout(onIdle, IDLE_MS); }
  function onIdle(){
    // this tab went quiet — but only sign out if EVERY tab has been idle.
    var since = Date.now() - lastActivity();
    if (since < IDLE_MS){ idleTimer = setTimeout(onIdle, (IDLE_MS - since) + 500); return; }   // someone was active elsewhere
    signOutLock();
  }
  // Idle lock renders the PIN box IN PLACE — it must not navigate. Reloading a
  // machine that has been sitting idle (wifi asleep, laptop dozing) hands you
  // Chrome's "can't reach server" page instead of the lock screen, and the only
  // way out is a manual refresh. Signing back in still reloads, but by then the
  // person is at the keyboard and the network is awake.
  function signOutLock(){
    loadSB().then(function(c){
      var done = function(){ lockInPlace('Signed out — inactive'); };
      if (c) c.auth.signOut().then(done, done); else done();
    }, function(){ lockInPlace('Signed out — inactive'); });
  }
  function lockInPlace(msg){
    netWait = false;
    try { if (host && !host.parentNode) (document.body || document.documentElement).appendChild(host); } catch (_) {}
    gateForm(msg || '');
  }
  // explicit "switch user" — the person is right there, so a clean reload is fine
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

  // Boot with silent retries so a CDN blip doesn't strand an already-signed-in
  // user on an "Offline" screen — it keeps trying and reveals the page the
  // moment the library loads (no manual refresh needed).
  function boot(tries){
    loadSB().then(function(c){
    if (!c){
      if (tries > 0){ setTimeout(function(){ boot(tries - 1); }, 800); return; }   // transient blip — retry quietly
      netWait = true;
      gateForm('Offline — reconnecting…');                                          // still failing: show status…
      setTimeout(function(){ boot(4); }, 3000);                                      // …and keep self-healing in the background
      return;
    }
    // getSession() can HANG (not reject) when the network is gone — a resuming
    // app would sit on the loading dots forever. Race it.
    Promise.race([
      c.auth.getSession(),
      new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('timeout')); }, 4000); })
    ]).then(function(res){
      var sess = res && res.data && res.data.session;
      // No session in hand is NOT the same as "signed out". A backgrounded app
      // (installed Expenses, a phone waking up) resumes with an expired access
      // token and refreshes it — if the network isn't up yet that refresh fails
      // and we used to demand a PIN, which is useless offline anyway since
      // signing in needs the same network. Retry while credentials are still on
      // the device; supabase-js clears them itself if the token is truly dead.
      if (!sess){
        if (storedCreds()){ waitForNet(tries); return; }
        gateForm(''); return;
      }
      netWait = false;
      // id / home_store / authorized_stores are fetched for CPRAuth's benefit —
      // same single round trip, and they are exactly the fields the pages that
      // still roll their own identity lookup go on to ask for.
      c.from('staff').select('id,display_name,role,home_store,authorized_stores').eq('auth_uid', sess.user.id).maybeSingle().then(function(sr){
        var row  = sr && sr.data ? sr.data : null;
        var role = row ? row.role : null;
        var nm   = row ? row.display_name : '';
        if (!role){ reveal(); authReject('no-staff-row'); return; }  // reveal (RLS governs) but identity is unknown
        if (role === 'owner' || !NEED_PERM){                         // owner sees all; page has no access perm
          reveal(); authResolve(authUser(row, null, false)); return;
        }
        c.rpc('my_permissions').then(function(pr){                   // gate by the page's Access permission
          var perms = (pr && pr.data) ? pr.data : [];
          if (perms.indexOf(NEED_PERM) > -1){ reveal(); authResolve(authUser(row, perms, false)); }
          else { noAccess(nm); authReject('no-access'); }
        }, function(){ reveal(); authResolve(authUser(row, null, true)); });  // perm read failed -> fail open, flagged
      }, function(){ reveal(); authReject('staff-read-failed'); });  // role read failed -> reveal, identity unknown
    }, function(){                                            // getSession itself threw — same rule as above
      if (storedCreds()){ waitForNet(tries); return; }
      gateForm('');
    });
    });
  }

  // Are this device's credentials still on file? (supabase-js wipes them when a
  // refresh token is genuinely rejected, so "present" means worth retrying.)
  function storedCreds(){
    try {
      var raw = localStorage.getItem('sb-xuvsehrevxackuhmbmry-auth-token');
      if (!raw) return false;
      var o = JSON.parse(raw);
      return !!(o && (o.refresh_token || (o.currentSession && o.currentSession.refresh_token)));
    } catch (_) { return false; }
  }
  // Hold the lock on "Reconnecting…" instead of demanding a PIN, and keep
  // retrying quietly until the network comes back.
  function waitForNet(tries){
    netWait = true;
    // Say what's happening straight away rather than sitting on the dots — but
    // only redraw the form once, so a retry never wipes a PIN mid-typing.
    var err = host.querySelector('#cpr-pg-err');
    if (!err) gateForm('Reconnecting…');
    else if (err.textContent !== 'Reconnecting…') err.textContent = 'Reconnecting…';
    setTimeout(function(){ if (netWait) boot(tries > 0 ? tries - 1 : 4); }, tries > 0 ? 800 : 3000);
  }
  // A resumed app or a returning network should heal instantly, not on the next
  // 3s tick — but only while we're actually waiting on the network, so this
  // never wipes a PIN someone is mid-way through typing.
  window.addEventListener('online', function(){ if (netWait) boot(4); });
  document.addEventListener('visibilitychange', function(){ if (netWait && !document.hidden) boot(4); });

  boot(4);
})();
