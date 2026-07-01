/* ===========================================================================
 * CPR myrepairtools.github.io — Shared Navigation Shell (v2)
 * Three-part shell: icon rail (areas) + menu pane (tools) + static red top bar.
 * Drop into any page with: <script src="assets/nav.js"></script>
 * Auth/lock/idle/role logic preserved from v1.
 * ========================================================================= */
(function () {
  'use strict';
  if (window.self !== window.top) return;   // skip inside iframes

  // Single sign-on: role comes from the shared Supabase PIN session (same
  // session the pages use), so one PIN unlock covers the nav and every page.
  var SB_URL  = 'https://xuvsehrevxackuhmbmry.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var SB_FN   = SB_URL + '/functions/v1/cpr-auth';
  var sbClient = null, sbReady = null;
  var NAV_ROLE = null, NAV_NAME = '', NAV_PERMS = null; // NAV_PERMS: Set of granted permission keys (null = not loaded yet)
  var NAV_STAFF = null;                                  // { id, home_store, authorized_stores } for the signed-in user
  var CLOCK = { on:false, id:null, start:null, busy:false, tick:null };  // top-rail time-clock state
  var HOME = 'index.html';

  // Ordering & Inventory — parts/supplier ordering and stock.
  var ORDERING = [
    { label:'Consumption & Ordering', url:'consumption-report.html', icon:'📊', acc:'consumption.view' },
    { label:'Jerry Ding Order',    url:'jerry-ding-order.html',    icon:'📋', acc:'orders.jerryding' },
    { label:'PO Converter',        url:'po-converter.html',        icon:'📦', acc:'orders.po' },
    { label:'Hyla Orders',         url:'hyla-orders.html',         icon:'♻️', img:'assets/images/Assurant_icon.png', acc:'orders.hyla' }
  ];
  // Sales & Pricing — quoting and customer-facing pricing.
  var PRICING = [
    { label:'Price Calculator',    url:'price-calculator.html',    icon:'🧮', acc:'pricing.view' },
    { label:'Price Guide',         url:'price-guide.html',         icon:'📱', acc:'pricing.view' }
  ];
  // Operations — store-floor / daily ops.
  var OPERATIONS = [
    { label:'Cash Tracker',        url:'cash-tracker.html',        icon:'💵', acc:'cash.view' },
    { label:'Tech Damage Tracker', url:'damage-tracker.html',      icon:'🔧', acc:'damage.view' }
  ];
  // Employee-facing self-service area ("My Hub"): a tech's own stuff.
  var HUB = [
    { label:'Dashboard',           url:'index.html',                icon:'🏠' },
    { label:'My Commission',       url:'commission-dashboard.html', icon:'📈', acc:'commission.dashboard' },
    { label:'My Time',             url:'my-schedule.html',          icon:'🗓️', acc:'schedule.view' }
  ];
  // Reports — read-only reports (managers/owner); each report is its own page.
  // (No `acc` yet — there's no 'reports.view' permission in the catalog, and canSee(acc)
  // would filter every report out of the list. The rail icon is rank-gated; pages gate by role.)
  var REPORTS = [
    { label:'Overtime Report', url:'report-overtime.html', icon:'⏱️', minRole:'admin' }
  ];
  // Employees — people management (managers/owner): roster, scheduling, time off.
  var EMPLOYEES = [
    { label:'Team Members',   url:'employee-records.html', icon:'📁', minRole:'admin', acc:'staff.view' },
    { label:'Schedule Admin', url:'schedule-admin.html',   icon:'🗓️', minRole:'admin', acc:'schedule.admin' },
    { label:'Time Off',       url:'time-off.html',         icon:'🌴', minRole:'admin', acc:'schedule.admin' }
  ];
  var PRIVILEGED = [
    { label:'Cash Admin',       url:'cash-admin.html',            icon:'💰', minRole:'admin', acc:'cash.admin' },
    { label:'Claim Payouts',    url:'claim-payouts.html',         icon:'📊', minRole:'owner', acc:'claims.view' },
    { label:'Commission Calculator', url:'commission-calculator.html', icon:'🧾', minRole:'owner', acc:'commission.view' },
    { label:'Profit First',     url:'profit-first.html',          icon:'🏦', minRole:'owner', acc:'profit.view' }
  ];

  var RANK = { none:0, employee:1, team_member:1, manager:2, admin:2, owner:3 };
  var COLLAPSE_KEY = 'cprNavCollapsed';   // desktop: menu pane collapsed to icon rail
  var collapsed = false;

  var currentFile = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var ON_HOME = (currentFile === '' || currentFile === 'index.html' ||
                 currentFile === 'operations.html' || currentFile === 'admin.html');

  // ── AUTH STATE (Supabase PIN session — single sign-on) ───────────────
  function loadSB(){
    if (sbReady) return sbReady;
    sbReady = import('https://esm.sh/@supabase/supabase-js@2')
      .then(function(m){ sbClient = m.createClient(SB_URL, SB_ANON); return sbClient; })
      .catch(function(){ sbClient = null; return null; });
    return sbReady;
  }
  function navDevice(){ try { var d = localStorage.getItem('cpr_device_id'); if (!d){ d = 'dev-'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem('cpr_device_id', d); } return d; } catch(_){ return 'dev-x'; } }
  function normRole(r){ return r === 'manager' ? 'admin' : (r || null); }   // legacy manager ranks as admin
  function currentRole(){ return NAV_ROLE; }
  function rank(){ return RANK[NAV_ROLE] || 0; }
  function broadcastRole(){
    window.CPRNavRole = NAV_ROLE;
    window.CPRNavName = NAV_NAME || '';
    window.CPRPerms = NAV_PERMS ? Array.from(NAV_PERMS) : null;
    try { window.dispatchEvent(new CustomEvent('cprnav:auth', { detail:{ role:NAV_ROLE, name:NAV_NAME||'', perms:window.CPRPerms } })); } catch(_){}
  }
  // read the current role from the shared session, then re-render
  function refreshRole(){
    loadSB().then(function(sb){
      if (!sb){ NAV_ROLE = null; NAV_NAME = ''; renderPriv(); return; }
      sb.auth.getSession().then(function(res){
        var sess = res && res.data && res.data.session;
        if (!sess){ NAV_ROLE = null; NAV_NAME = ''; renderPriv(); return; }
        sb.from('staff').select('id,display_name,role,home_store,authorized_stores').eq('auth_uid', sess.user.id).maybeSingle().then(function(sr){
          if (sr && sr.data){ NAV_ROLE = normRole(sr.data.role); NAV_NAME = sr.data.display_name || '';
            NAV_STAFF = { id:sr.data.id, home_store:sr.data.home_store, authorized_stores:sr.data.authorized_stores||[] }; loadClock(); }
          else { NAV_ROLE = null; NAV_NAME = ''; NAV_STAFF = null; }
          // load the granted permission keys, then render once (so tools don't flash)
          sb.rpc('my_permissions').then(function(pr){
            NAV_PERMS = new Set((pr && pr.data) ? pr.data : []);
            renderPriv();
          }, function(){ NAV_PERMS = null; renderPriv(); });
        }, function(){ renderPriv(); });
      }, function(){ NAV_ROLE = null; NAV_NAME = ''; renderPriv(); });
    });
  }
  // sign out -> back to the front door (pin-gate re-gates on load)
  function signOutThen(go){
    loadSB().then(function(sb){
      function done(){ go(); }
      if (sb && sb.auth) sb.auth.signOut().then(done, done); else done();
    });
  }
  function doSignOut(){ signOutThen(function(){ window.location.href = HOME; }); }     // sign out -> Home
  function doSwitchUser(){ signOutThen(function(){ window.location.reload(); }); }      // re-PIN here

  // ── top-rail time clock (writes punches to QB Time via the qbtime-sync function) ──
  function clockFetch(action, body){
    return loadSB().then(function(sb){
      if (!sb) return null;
      return sb.auth.getSession().then(function(res){
        var sess = res && res.data && res.data.session;
        if (!sess) return null;
        return fetch(SB_URL + '/functions/v1/qbtime-sync?action=' + action, {
          method:'POST',
          headers:{ 'Authorization':'Bearer ' + sess.access_token, 'apikey':SB_ANON, 'Content-Type':'application/json' },
          body: JSON.stringify(body || {})
        }).then(function(r){ return r.json(); }).catch(function(){ return null; });
      });
    });
  }
  function clockStores(){
    var set = []; if (NAV_STAFF && NAV_STAFF.home_store) set.push(NAV_STAFF.home_store);
    ((NAV_STAFF && NAV_STAFF.authorized_stores) || []).forEach(function(s){ if (set.indexOf(s) < 0) set.push(s); });
    return set;
  }
  function clkStoreName(s){ return (window.CPRLocations && CPRLocations.display) ? CPRLocations.display(s) : String(s||'').replace(/^CPR\s*/,''); }
  function clkStoreColor(s){ try { var x = window.CPRLocations && CPRLocations.find && CPRLocations.find(s); return (x && x.color) || '#4FB0E3'; } catch(_){ return '#4FB0E3'; } }
  function clkElapsed(){
    if (!CLOCK.start) return '🟢 On clock';
    var t = new Date(CLOCK.start).getTime(); if (isNaN(t)) return '🟢 On clock';
    var mins = Math.max(0, Math.floor((Date.now() - t) / 60000)), h = Math.floor(mins/60), m = mins%60;
    return '🟢 ' + (h > 0 ? (h + 'h ' + m + 'm') : (m + 'm'));
  }
  function renderClock(){
    var b = document.querySelector('.cpr-tb-clock'); if (!b) return;
    b.classList.toggle('on', CLOCK.on); b.classList.toggle('busy', CLOCK.busy);
    var lbl = b.querySelector('.lbl');
    if (lbl) lbl.textContent = CLOCK.busy ? '…' : (CLOCK.on ? clkElapsed() : '🕐 Clock in');
    b.title = CLOCK.on ? 'On the clock — click to clock out' : 'Click to clock in';
    if (CLOCK.on && !CLOCK.tick) CLOCK.tick = setInterval(function(){ var l = document.querySelector('.cpr-tb-clock .lbl'); if (l && CLOCK.on && !CLOCK.busy) l.textContent = clkElapsed(); }, 30000);
    if (!CLOCK.on && CLOCK.tick){ clearInterval(CLOCK.tick); CLOCK.tick = null; }
  }
  function loadClock(){
    if (!NAV_STAFF) return;
    clockFetch('clock_status', {}).then(function(d){
      if (d && d.ok){ CLOCK.on = !!d.on_the_clock; CLOCK.id = d.id; CLOCK.start = d.start; }
      renderClock();
    });
  }
  function clockIn(store){
    if (!store){ toastNav('No store set for clock-in', true); return; }
    CLOCK.busy = true; renderClock();
    clockFetch('clock_in', { store: store }).then(function(d){
      CLOCK.busy = false;
      if (d && d.ok){ toastNav('Clocked in · ' + clkStoreName(store)); loadClock(); }
      else { renderClock(); toastNav((d && (d.detail || d.error)) || 'Clock-in failed', true); }
    });
  }
  function clockOut(){
    CLOCK.busy = true; renderClock();
    clockFetch('clock_out', {}).then(function(d){
      CLOCK.busy = false;
      if (d && d.ok){ CLOCK.on = false; CLOCK.id = null; CLOCK.start = null; renderClock(); toastNav('Clocked out'); }
      else { renderClock(); toastNav((d && (d.detail || d.error)) || 'Clock-out failed', true); }
    });
  }
  function doClockClick(ev){
    if (CLOCK.busy) return;
    if (CLOCK.on){ clockOut(); return; }
    var opts = clockStores();
    if (opts.length <= 1) clockIn(opts[0] || (NAV_STAFF && NAV_STAFF.home_store) || '');
    else openStorePicker(ev.currentTarget);
  }
  function openStorePicker(anchor){
    closeClockPop();
    var pop = document.createElement('div'); pop.className = 'cpr-clockpop'; pop.id = 'cprClockPop';
    pop.innerHTML = '<div class="h">Clock in at…</div>' + clockStores().map(function(s){
      return '<button data-cin="' + esc(s) + '"><span class="sdot" style="background:' + esc(clkStoreColor(s)) + '"></span>' + esc(clkStoreName(s)) + '</button>';
    }).join('');
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.querySelectorAll('[data-cin]').forEach(function(btn){ btn.onclick = function(){ var s = btn.getAttribute('data-cin'); closeClockPop(); clockIn(s); }; });
    setTimeout(function(){ document.addEventListener('click', clockPopAway); }, 0);
  }
  function clockPopAway(e){ var p = document.getElementById('cprClockPop'); if (p && !p.contains(e.target) && !e.target.closest('.cpr-tb-clock')) closeClockPop(); }
  function closeClockPop(){ var p = document.getElementById('cprClockPop'); if (p) p.remove(); document.removeEventListener('click', clockPopAway); }
  function enterKiosk(){
    if (window.CPRKiosk && window.CPRKiosk.open){ window.CPRKiosk.open(); return; }
    var s = document.createElement('script'); s.src = 'assets/kiosk.js';
    s.onload = function(){ if (window.CPRKiosk && window.CPRKiosk.open) window.CPRKiosk.open(); };
    s.onerror = function(){ toastNav('Could not load kiosk', true); };
    document.head.appendChild(s);
  }
  function wireClock(){
    var b = document.querySelector('.cpr-tb-clock'); if (!b) return;
    b.addEventListener('click', doClockClick);
    // right-click (desktop) or long-press (iPad) → kiosk mode
    b.addEventListener('contextmenu', function(e){ e.preventDefault(); enterKiosk(); });
    var lp = null;
    b.addEventListener('touchstart', function(){ lp = setTimeout(function(){ lp = null; enterKiosk(); }, 650); }, { passive:true });
    b.addEventListener('touchend', function(){ if (lp){ clearTimeout(lp); lp = null; } });
    b.addEventListener('touchmove', function(){ if (lp){ clearTimeout(lp); lp = null; } });
    loadClock();
  }
  function toastNav(msg, err){
    var t = document.createElement('div'); t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:3000;background:' + (err ? '#DC282E' : '#2D2D3B') + ';color:#fff;padding:10px 18px;border-radius:10px;font-family:Nunito,sans-serif;font-weight:800;font-size:.82rem;box-shadow:0 8px 24px rgba(0,0,0,.2)';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 300); }, 2200);
  }

  // Which area is the current page in?
  var inAdmin   = PRIVILEGED.some(function(t){ return t.url.toLowerCase() === currentFile; });
  var inHub     = HUB.some(function(t){ return t.url.toLowerCase() === currentFile; });
  var inOrder   = ORDERING.some(function(t){ return t.url.toLowerCase() === currentFile; });
  var inPricing = PRICING.some(function(t){ return t.url.toLowerCase() === currentFile; });
  var inReports = REPORTS.some(function(t){ return t.url.toLowerCase() === currentFile; });
  var inEmployees = EMPLOYEES.some(function(t){ return t.url.toLowerCase() === currentFile; });
  var ACTIVE_AREA = inHub ? 'hub' : inAdmin ? 'admin' : inEmployees ? 'employees' : inOrder ? 'order' : inPricing ? 'pricing' : inReports ? 'reports' : 'ops';   // default ops (incl. home)

  // ── STYLES ───────────────────────────────────────────────────────────
  var RAIL_W = 64, PANE_W = 248;
  var css = `
  /* Smooth cross-document navigations (MPA) — cross-fade instead of a white flash.
     Both the leaving and entering page opt in via this rule; nav.js is on every page.
     Browsers without support just fall back to the normal instant navigation. */
  @view-transition { navigation: auto; }
  ::view-transition-old(root),::view-transition-new(root){ animation-duration:.18s; }

  :root{ --cpr-rail-w:${RAIL_W}px; --cpr-pane-w:${PANE_W}px; --cpr-nav-w:${RAIL_W+PANE_W}px; --cpr-top-h:52px;
    --cpr-blue-dark:#2D2D3B; --cpr-blue:#4FB0E3; --cpr-red:#DC282E; }
  .cpr-rail,.cpr-pane,.cpr-rail *,.cpr-pane *{ box-sizing:border-box; font-family:'Nunito','Nunito Sans',sans-serif; }

  /* icon rail — CPR Blue Dark, white icons. Starts below the top bar (app shell). */
  .cpr-rail{ position:fixed; top:var(--cpr-top-h); left:0; bottom:0; width:var(--cpr-rail-w);
    background:var(--cpr-blue-dark); z-index:1001; display:flex; flex-direction:column; align-items:center; padding-top:12px; gap:6px; }
  .cpr-rail .cpr-burger2{ display:none; width:40px; height:40px; border:none; background:none; color:#fff; font-size:1.3rem; cursor:pointer; border-radius:11px; }
  .cpr-rail .cpr-burger2:hover{ background:rgba(255,255,255,.12); }
  .cpr-rail .cpr-areabtn{ width:40px; height:40px; border-radius:11px; display:flex; align-items:center; justify-content:center;
    font-size:1.15rem; cursor:pointer; color:#fff; border:none; background:none; }
  .cpr-rail .cpr-areabtn:hover{ background:rgba(255,255,255,.12); }
  .cpr-rail .cpr-areabtn.active{ background:var(--cpr-blue); color:#fff; }
  .cpr-rail .cpr-railsp{ flex:1; }
  .cpr-rail .cpr-raildiv{ width:28px; height:1px; background:rgba(255,255,255,.16); margin:3px 0; }
  .cpr-rail .cpr-railgear{ width:40px; height:40px; border-radius:11px; border:none; background:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; margin-bottom:14px; text-decoration:none; opacity:.78; }
  .cpr-rail .cpr-railgear:hover{ background:rgba(255,255,255,.12); opacity:1; }
  .cpr-usermenu{ position:fixed; top:calc(var(--cpr-top-h) + 6px); right:14px; width:206px; background:#fff; border:1px solid #E0E2EA; border-radius:12px; box-shadow:0 16px 38px rgba(45,45,59,.24); z-index:1003; padding:6px; display:none; font-family:'Nunito Sans',sans-serif; }
  .cpr-usermenu.show{ display:block; }
  .cpr-usermenu .who{ padding:9px 10px 8px; }
  .cpr-usermenu .who .nm{ font-family:'Nunito'; font-weight:800; font-size:.86rem; color:#2D2D3B; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cpr-usermenu .who .rl{ font-size:.62rem; font-weight:800; color:#4FB0E3; text-transform:uppercase; letter-spacing:.5px; margin-top:1px; }
  .cpr-usermenu .umdiv{ height:1px; background:#E0E2EA; margin:4px 6px 5px; }
  .cpr-usermenu button{ display:flex; align-items:center; gap:9px; width:100%; text-align:left; border:none; background:none; font-family:'Nunito'; font-weight:700; font-size:.82rem; color:#4E4E50; padding:9px 10px; border-radius:8px; cursor:pointer; }
  .cpr-usermenu button .umic{ width:16px; text-align:center; flex:none; opacity:.85; }
  .cpr-usermenu button:hover{ background:#F3F2F2; color:#2D2D3B; }
  .cpr-usermenu button.danger:hover{ color:#DC282E; background:#FFF1F1; }
  .cpr-rail .cpr-collapse{ width:40px; height:40px; border-radius:11px; border:none; background:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; margin-bottom:6px; opacity:.7; }
  .cpr-rail .cpr-collapse:hover{ background:rgba(255,255,255,.12); opacity:1; }

  /* collapsed flyout — hover an area icon to reach its tools without expanding */
  .cpr-flyout{ position:fixed; left:calc(var(--cpr-rail-w) + 6px); width:224px; background:#fff;
    border:1px solid #E0E2EA; border-radius:12px; box-shadow:0 14px 34px rgba(45,45,59,.20);
    z-index:1002; padding:6px 0; display:none; }
  .cpr-flyout.show{ display:block; }
  .cpr-flyout .cpr-fly-hd{ font-family:'Nunito',sans-serif; font-weight:800; font-size:.6rem; text-transform:uppercase; letter-spacing:.9px; color:#B9BDCB; padding:9px 16px 5px; }
  .cpr-flyout .cpr-fly-lock{ display:flex; gap:9px; align-items:flex-start; padding:4px 14px 6px; font-size:.74rem; color:#4E4E50; line-height:1.35; }
  .cpr-flyout .cpr-fly-lock .pad{ font-size:.95rem; line-height:1; }
  @media(max-width:859px){ .cpr-flyout{ display:none !important; } }

  /* menu pane */
  .cpr-pane{ position:fixed; top:var(--cpr-top-h); left:var(--cpr-rail-w); bottom:0; width:var(--cpr-pane-w);
    background:#fff; border-right:1.5px solid #E0E2EA; z-index:1000; overflow-y:auto; display:flex; flex-direction:column; transition:transform .2s ease; }
  .cpr-pane a{ text-decoration:none; }
  .cpr-grp{ font-family:'Nunito',sans-serif; font-weight:800; font-size:.6rem; text-transform:uppercase; letter-spacing:.9px; color:#B9BDCB; padding:14px 18px 6px; }
  .cpr-link{ display:flex; align-items:center; gap:11px; padding:10px 18px; font-family:'Nunito',sans-serif; font-weight:700; font-size:.88rem; color:#4E4E50; border-left:3px solid transparent; cursor:pointer; }
  .cpr-link .ic{ width:21px; text-align:center; font-size:1rem; flex:none; }
  .cpr-link .ic img{ width:18px; height:18px; object-fit:contain; display:block; margin:0 auto; }
  .cpr-link:hover{ background:#F3F2F2; color:#2D2D3B; }
  .cpr-link.active{ background:#EAF6FD; border-left-color:var(--cpr-blue); color:#2D2D3B; font-weight:800; }
  .cpr-link .tag{ margin-left:auto; font-family:'Nunito',sans-serif; font-weight:800; font-size:.5rem; letter-spacing:.4px; text-transform:uppercase; color:#B9BDCB; border:1px solid #E0E2EA; border-radius:5px; padding:1px 5px; }
  .cpr-link .tag.owner{ color:#DC282E; border-color:#F6C9CA; background:#FFF1F1; }
  .cpr-div{ height:1px; background:#E0E2EA; margin:10px 16px; }
  .cpr-spacer{ flex:1; }
  /* mobile menu profile header */
  .cpr-mhd{ display:flex; align-items:center; gap:11px; padding:15px 18px 12px; border-bottom:1px solid #EEF0F4; }
  .cpr-mhd .cpr-mav{ width:38px; height:38px; border-radius:50%; background:var(--cpr-red); color:#fff; display:flex; align-items:center; justify-content:center; font-family:'Nunito',sans-serif; font-weight:900; font-size:.82rem; flex:none; }
  .cpr-mhd .nm{ font-family:'Nunito',sans-serif; font-weight:800; font-size:.92rem; color:#2D2D3B; }
  .cpr-mhd .rl{ font-size:.62rem; font-weight:800; color:var(--cpr-blue); text-transform:uppercase; letter-spacing:.5px; margin-top:1px; }
  .cpr-foot{ padding:10px 18px 16px; font-size:.58rem; color:#B9BDCB; }

  /* admin lock card */
  .cpr-lock{ margin:6px 14px 14px; background:#F3F2F2; border:1px solid #E0E2EA; border-radius:12px; padding:13px; }
  .cpr-lock .hd{ display:flex; align-items:center; gap:9px; font-family:'Nunito',sans-serif; font-weight:800; font-size:.84rem; color:#2D2D3B; }
  .cpr-lock .hd .pad{ width:28px; height:28px; border-radius:8px; background:#fff; border:1px solid #E0E2EA; display:flex; align-items:center; justify-content:center; font-size:.9rem; }
  .cpr-lock p{ font-size:.72rem; color:#4E4E50; margin:8px 0 10px; line-height:1.4; }
  .cpr-btn{ font-family:'Nunito',sans-serif; font-weight:800; border:none; border-radius:9px; cursor:pointer; font-size:.82rem; padding:9px 12px; width:100%; }
  .cpr-btn.red{ background:#DC282E; color:#fff; }
  .cpr-passwrap{ display:none; margin-top:9px; }
  .cpr-passwrap.show{ display:block; }
  .cpr-passwrap input{ width:100%; font-family:'Nunito Sans',sans-serif; font-size:.9rem; padding:9px; border:1.5px solid #E0E2EA; border-radius:9px; }
  .cpr-passwrap input:focus{ outline:none; border-color:#4FB0E3; box-shadow:0 0 0 3px rgba(79,176,227,.15); }
  .cpr-err{ display:none; color:#DC282E; font-size:.72rem; font-weight:700; margin-top:7px; }
  .cpr-err.show{ display:block; }
  .cpr-unlocked-hd{ display:flex; align-items:center; gap:7px; padding:0 18px 6px; }
  .cpr-pill{ display:inline-flex; align-items:center; gap:6px; font-family:'Nunito',sans-serif; font-weight:800; font-size:.64rem; color:#23A62F; }
  .cpr-pill .dot{ width:7px; height:7px; border-radius:50%; background:#23A62F; }
  .cpr-lockbtn{ margin-left:auto; font-family:'Nunito',sans-serif; font-weight:800; font-size:.62rem; color:#4E4E50; background:none; border:none; cursor:pointer; text-transform:uppercase; letter-spacing:.5px; }
  .cpr-lockbtn:hover{ color:#DC282E; }
  .cpr-gear{ display:flex; align-items:center; gap:10px; padding:11px 18px; margin:6px 0; cursor:pointer; font-family:'Nunito',sans-serif; font-weight:700; font-size:.84rem; color:#4E4E50; border-top:1px solid #E0E2EA; }
  .cpr-gear:hover{ background:#F3F2F2; color:#2D2D3B; }

  /* top bar — persistent app-shell header: spans the full width on top of the rail,
     so the dark bar + dark rail read as one continuous frame. Holds brand, clock
     (soon), bell, identity. */
  .cpr-topbar{ position:fixed; top:0; left:0; right:0; height:var(--cpr-top-h);
    background:var(--cpr-blue-dark); display:flex; align-items:center; gap:12px; padding:0 16px 0 0; z-index:1002; }
  .cpr-tb-burger{ display:none; width:44px; height:var(--cpr-top-h); align-items:center; justify-content:center; border:none; background:none; color:#fff; font-size:1.4rem; cursor:pointer; flex:none; }
  .cpr-tb-burger:hover{ opacity:.85; }
  .cpr-tb-brand{ height:var(--cpr-top-h); display:flex; align-items:center; flex:none; text-decoration:none; padding:0 16px; }
  .cpr-tb-brand:hover{ opacity:.85; }
  .cpr-tb-brand .cpr-tb-wm{ display:flex; }                 /* full <> myRepairTools wordmark */
  .cpr-tb-brand .cpr-tb-ico{ display:none; }                /* chevron-only, mobile */
  .cpr-tb-sp{ flex:1; }
  .cpr-tb-chip{ display:inline-flex; align-items:center; gap:6px; font-family:'Nunito',sans-serif; font-weight:800; font-size:.7rem; color:rgba(255,255,255,.55); background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.10); padding:5px 10px; border-radius:999px; white-space:nowrap; cursor:default; }
  .cpr-tb-clock{ display:inline-flex; align-items:center; gap:7px; font-family:'Nunito',sans-serif; font-weight:800; font-size:.74rem; color:#fff; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12); padding:6px 12px; border-radius:999px; white-space:nowrap; cursor:pointer; -webkit-user-select:none; user-select:none; }
  .cpr-tb-clock:hover{ background:rgba(255,255,255,.16); }
  .cpr-tb-clock.on{ background:rgba(46,158,91,.22); border-color:rgba(46,158,91,.5); }
  .cpr-tb-clock.busy{ opacity:.55; cursor:default; }
  .cpr-tb-clock .dot{ width:8px; height:8px; border-radius:50%; background:#9aa0b0; flex:none; }
  .cpr-tb-clock.on .dot{ background:#39d98a; animation:cprpulse 2s infinite; }
  @keyframes cprpulse{0%{box-shadow:0 0 0 0 rgba(57,217,138,.5)}70%{box-shadow:0 0 0 6px rgba(57,217,138,0)}100%{box-shadow:0 0 0 0 rgba(57,217,138,0)}}
  .cpr-clockpop{ position:fixed; z-index:1400; background:#fff; border:1px solid #E0E2EA; border-radius:12px; box-shadow:0 14px 34px rgba(45,45,59,.24); padding:6px; min-width:186px; }
  .cpr-clockpop .h{ font-family:'Nunito',sans-serif; font-weight:800; font-size:.58rem; letter-spacing:.6px; text-transform:uppercase; color:#B9BDCB; padding:8px 12px 5px; }
  .cpr-clockpop button{ display:flex; align-items:center; gap:9px; width:100%; text-align:left; border:none; background:none; padding:9px 12px; border-radius:8px; cursor:pointer; font-family:'Nunito',sans-serif; font-weight:800; font-size:.82rem; color:#2D2D3B; }
  .cpr-clockpop button:hover{ background:#F3F2F2; }
  .cpr-clockpop .sdot{ width:9px; height:9px; border-radius:50%; flex:none; }
  .cpr-tb-bell{ position:relative; width:34px; height:34px; border:none; border-radius:9px; background:rgba(255,255,255,.08); color:#fff; cursor:pointer; font-size:15px; display:flex; align-items:center; justify-content:center; }
  .cpr-tb-bell:hover{ background:rgba(255,255,255,.16); }
  .cpr-tb-bell .bdg{ position:absolute; top:5px; right:6px; min-width:8px; height:8px; border-radius:999px; background:var(--cpr-red); border:2px solid var(--cpr-blue-dark); display:none; }
  .cpr-tb-role{ display:inline-flex; align-items:center; gap:7px; font-family:'Nunito',sans-serif; font-weight:800; font-size:.78rem; color:#fff; white-space:nowrap; cursor:pointer; border:none; background:none; padding:6px 8px; border-radius:9px; }
  .cpr-tb-role:hover{ background:rgba(255,255,255,.10); }
  .cpr-tb-role .dot{ width:7px; height:7px; border-radius:50%; background:#2E9E5B; flex:none; }
  .cpr-tb-role .nm-ini{ display:none; width:26px; height:26px; border-radius:50%; background:var(--cpr-red); color:#fff; font-size:.68rem; font-weight:900; align-items:center; justify-content:center; }
  .cpr-belldd{ position:fixed; top:calc(var(--cpr-top-h) + 6px); right:14px; width:300px; background:#fff; border:1px solid #E0E2EA; border-radius:13px; box-shadow:0 16px 44px rgba(45,45,59,.22); z-index:1004; display:none; overflow:hidden; }
  .cpr-belldd.show{ display:block; }
  .cpr-belldd .h{ padding:12px 14px; font-family:'Nunito',sans-serif; font-weight:900; font-size:.84rem; color:#2D2D3B; border-bottom:1px solid #EEF0F4; }
  .cpr-belldd .empty{ padding:20px 14px; font-family:'Nunito Sans',sans-serif; font-size:.82rem; color:#9aa0b0; text-align:center; line-height:1.5; }
  @media(max-width:560px){
    .cpr-tb-chip{ display:none; }
    .cpr-tb-role .nm-full, .cpr-tb-role .dot, .cpr-tb-role .nm-role{ display:none; }
    .cpr-tb-role .nm-ini{ display:inline-flex; }
    .cpr-tb-role{ padding:2px; }
    .cpr-tb-brand .cpr-tb-wm{ display:none; }
    .cpr-tb-brand .cpr-tb-ico{ display:flex; }
    .cpr-tb-brand{ width:auto; justify-content:center; padding:0 4px; }
  }

  /* push page content clear of shell */
  body{ padding-top:var(--cpr-top-h) !important; }
  @media(min-width:860px){
    body{ margin-left:var(--cpr-nav-w) !important; }
    body.cpr-nav-collapsed{ margin-left:var(--cpr-rail-w) !important; }
    body.cpr-nav-collapsed .cpr-pane{ transform:translateX(-100%); }
  }

  /* mobile — rail stays visible, pane slides */
  .cpr-scrim{ display:none; position:fixed; inset:0; background:rgba(45,45,59,.45); z-index:999; }
  .cpr-scrim.show{ display:block; }
  @media(max-width:859px){
    .cpr-rail{ display:none; }                              /* no rail on mobile — hamburger menu instead */
    .cpr-tb-burger{ display:flex; }                         /* hamburger lives in the top bar */
    .cpr-pane{ left:0; width:min(86vw,330px); border-right:none; box-shadow:0 18px 50px rgba(45,45,59,.28);
      transform:translateX(-100%); transition:transform .22s ease; }
    .cpr-pane.open{ transform:translateX(0); }
    body{ margin-left:0 !important; }                       /* content goes full width */
  }
  `;

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  var MARK = '<svg viewBox="0 0 24 24"><path fill="#fff" d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/></svg>';

  // white line icons for the rail area buttons
  var RAIL_ICONS = {
    home:  'M3 10.6 12 3l9 7.6M5.5 9.2V20h13V9.2',
    tools: 'M14.6 6.4a3.8 3.8 0 0 0-5 4.9L3.5 17.4V20.5H6.6l6.1-6.1a3.8 3.8 0 0 0 4.9-5l-2.4 2.4-2-2 2.4-2.4Z',
    order: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16ZM3.3 7 12 12l8.7-5M12 22V12',
    tag:   'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8ZM7.5 7.5h.01',
    user:  'M12 12.4a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4ZM5.6 20v-.4c0-3 2.9-4.8 6.4-4.8s6.4 1.8 6.4 4.8V20',
    lock:  'M6.5 10.5V7.5a5.5 5.5 0 0 1 11 0v3M5 10.5h14v9.5H5zM12 14.5v2.5',
    gear:  'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 12a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-2-1.2L14.6 3h-3.9l-.4 2.5a7.3 7.3 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 2 1.2l.4 2.5h3.9l.4-2.5a7.3 7.3 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2Z',
    chart: 'M3 21h18M6.5 21V11M12 21V5M17.5 21v-7',
    people: 'M9 11.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM2.5 19.5v-.3c0-2.7 2.6-4.3 6.5-4.3s6.5 1.6 6.5 4.3v.3M16 5.3a3.2 3.2 0 0 1 0 6.2M17.5 14.6c2.5.5 4 1.9 4 4v.3'
  };
  function railIcon(name){
    var d = RAIL_ICONS[name]; if (!d) return '';
    return '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="'+d+'"/></svg>';
  }
  function chevron(dir){
    var d = (dir === 'right') ? 'M9 5l6 7-6 7' : 'M15 5l-6 7 6 7';
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="'+d+'"/></svg>';
  }

  function linkHtml(t, tag){
    var active = (t.url.toLowerCase() === currentFile) ? ' active' : '';
    var tagHtml = tag ? (' <span class="tag '+(tag==='Owner'?'owner':'')+'">'+tag+'</span>') : '';
    var ic = t.img
      ? '<img src="'+esc(t.img)+'" alt="'+esc(t.icon||'')+'" onerror="this.outerHTML=this.alt">'
      : (t.icon||'');
    return '<a class="cpr-link'+active+'" href="'+esc(t.url)+'"><span class="ic">'+ic+'</span> '+esc(t.label)+tagHtml+'</a>';
  }

  // a tool is visible if its access permission is granted (perms not yet loaded -> show, to avoid a flash)
  function canSee(t){ if (!t || !t.acc) return true; if (NAV_PERMS === null) return true; return NAV_PERMS.has(t.acc); }

  function privilegedHtml(){
    if (!NAV_ROLE){   // no session (pin-gate normally prevents this) -> PIN unlock card
      return ''
        + '<div class="cpr-grp">Admin &amp; Owner</div>'
        + '<div class="cpr-lock">'
        +   '<div class="hd"><span class="pad">🔒</span> Locked tools</div>'
        +   '<p>Owner &amp; manager tools are hidden. Enter your PIN to unlock them.</p>'
        +   '<button class="cpr-btn red" data-act="show-pass">Unlock</button>'
        +   '<div class="cpr-passwrap" data-pass>'
        +     '<input type="password" inputmode="numeric" placeholder="PIN" data-passinput>'
        +     '<div style="height:8px"></div>'
        +     '<button class="cpr-btn red" data-act="do-unlock">Sign in</button>'
        +     '<div class="cpr-err" data-err>That PIN doesn\'t have admin access.</div>'
        +   '</div>'
        + '</div>';
    }
    var vis = PRIVILEGED.filter(canSee);
    if (!vis.length){   // signed in, but no admin/owner pages granted to this role
      return ''
        + '<div class="cpr-grp">Admin &amp; Owner</div>'
        + '<div class="cpr-lock">'
        +   '<div class="hd"><span class="pad">🔒</span> No admin tools</div>'
        +   '<p>Signed in as '+esc(NAV_NAME||'you')+'. Your role doesn\'t include any owner or manager tools.</p>'
        +   '<button class="cpr-btn red" data-act="lock">Sign out</button>'
        + '</div>';
    }
    var roleLabel = (currentRole()==='owner') ? 'Owner' : 'Admin';
    var links = vis.map(function(t){ return linkHtml(t, t.minRole==='owner' ? 'Owner' : 'Admin'); }).join('');
    return ''
      + '<div class="cpr-grp" style="padding-bottom:6px">Admin &amp; Owner</div>'
      + '<div class="cpr-unlocked-hd"><span class="cpr-pill"><span class="dot"></span> '+esc(roleLabel)+(NAV_NAME?(' · '+esc(NAV_NAME)):'')+'</span>'
      +   '<button class="cpr-lockbtn" data-act="lock">Lock</button></div>'
      + links + '<div class="cpr-spacer"></div>';
  }

  // build the contents of the collapsed-rail hover flyout for an area
  function flyoutLinksHtml(area){
    if (area === 'ops'){
      return '<div class="cpr-fly-hd">Operations</div>'
        + OPERATIONS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    }
    if (area === 'order'){
      return '<div class="cpr-fly-hd">Ordering &amp; Inventory</div>'
        + ORDERING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    }
    if (area === 'pricing'){
      return '<div class="cpr-fly-hd">Sales &amp; Pricing</div>'
        + PRICING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    }
    if (area === 'hub'){
      return '<div class="cpr-fly-hd">My Hub</div>'
        + HUB.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    }
    if (area === 'employees'){
      return '<div class="cpr-fly-hd">Employees</div>'
        + EMPLOYEES.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    }
    if (area === 'reports'){
      return '<div class="cpr-fly-hd">Reports</div>'
        + REPORTS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    }
    // admin area
    if (!NAV_ROLE){
      return '<div class="cpr-fly-hd">Admin &amp; Owner</div>'
        + '<div class="cpr-fly-lock"><span class="pad">🔒</span><div>Owner &amp; manager tools are locked. Unlock to access them.</div></div>'
        + '<div style="padding:2px 12px 8px"><button class="cpr-btn red" data-act="flyout-unlock">Unlock</button></div>';
    }
    var vis = PRIVILEGED.filter(canSee);
    if (!vis.length){
      return '<div class="cpr-fly-hd">Admin &amp; Owner</div>'
        + '<div class="cpr-fly-lock"><span class="pad">🔒</span><div>No owner or manager tools for your role.</div></div>';
    }
    var links = vis.map(function(t){ return linkHtml(t, t.minRole==='owner' ? 'Owner' : 'Admin'); }).join('');
    return '<div class="cpr-fly-hd">Admin &amp; Owner</div>' + links;
  }

  // white-on-dark wordmark for the top bar (myRepair white, Tools red, red chevron),
  // plus a chevron-only mark shown in its place on mobile.
  function navLogoTop(){
    var wm = '<span class="cpr-tb-wm"><svg viewBox="0 0 308 64" width="148" height="31" style="display:block" xmlns="http://www.w3.org/2000/svg" fill="none" role="img" aria-label="myRepairTools">'
      + '<path d="M30 18 18 32l12 14M44 18l12 14-12 14" stroke="#DC282E" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"></path>'
      + '<text x="74" y="44" font-family="\'Nunito\',sans-serif" font-size="30" font-weight="800"><tspan fill="#fff">myRepair</tspan><tspan fill="#DC282E">Tools</tspan></text>'
      + '</svg></span>';
    var ico = '<span class="cpr-tb-ico"><svg viewBox="13 8 48 48" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M30 18 18 32l12 14M44 18l12 14-12 14" stroke="#DC282E" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>';
    return wm + ico;
  }
  function paneInner(area){
    var hd = '';   // brand now lives in the top bar; the pane starts at its tool list
    if (area === 'admin'){
      return hd + '<div data-priv>' + privilegedHtml() + '</div>'
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
    if (area === 'hub'){
      var hub = HUB.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
      return hd
        + '<div class="cpr-grp">My Hub</div>'
        + (hub || '<div class="cpr-foot" style="padding:8px 16px">Nothing here for your role yet.</div>')
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
    if (area === 'employees'){
      var emp = EMPLOYEES.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
      return hd + '<div class="cpr-grp">Employees</div>'
        + (emp || '<div class="cpr-foot" style="padding:8px 16px">Nothing here for your role yet.</div>')
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
    if (area === 'reports'){
      var rep = REPORTS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
      return hd + '<div class="cpr-grp">Reports</div>'
        + (rep || '<div class="cpr-foot" style="padding:8px 16px">Nothing here for your role yet.</div>')
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
    if (area === 'order'){
      var ord = ORDERING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
      return hd + '<div class="cpr-grp">Ordering &amp; Inventory</div>' + ord
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
    if (area === 'pricing'){
      var pr = PRICING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
      return hd + '<div class="cpr-grp">Sales &amp; Pricing</div>' + pr
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
    var ops = OPERATIONS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    return hd
      + '<div class="cpr-grp">Operations</div>'
      + ops
      + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
  }

  function isMobile(){ return window.innerWidth < 860; }
  // mobile has no rail to switch areas, so the slide-in menu shows every section
  // the user can see at once (profile · My Hub · Operations · Admin · Settings).
  function paneMobileInner(){
    var h = '<div class="cpr-mhd"><span class="cpr-mav">'+esc(avatarInitials())+'</span>'
      + '<div><div class="nm">'+(NAV_NAME?esc(NAV_NAME):'Not signed in')+'</div><div class="rl">'+esc(roleText())+'</div></div></div>';
    var hub = HUB.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (hub) h += '<div class="cpr-grp">My Hub</div>' + hub;
    var pr = PRICING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (pr) h += '<div class="cpr-grp">Sales &amp; Pricing</div>' + pr;
    var ord = ORDERING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (ord) h += '<div class="cpr-grp">Ordering &amp; Inventory</div>' + ord;
    var ops = OPERATIONS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (ops) h += '<div class="cpr-grp">Operations</div>' + ops;
    var emp = EMPLOYEES.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (emp) h += '<div class="cpr-grp">Employees</div>' + emp;
    var rep = REPORTS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (rep) h += '<div class="cpr-grp">Reports</div>' + rep;
    if (hasAdminArea()) h += '<div data-priv>' + privilegedHtml() + '</div>';
    if (canSee({ acc:'staff.manage' })) h += '<div class="cpr-div"></div><a class="cpr-link" href="settings.html"><span class="ic">⚙️</span> Settings</a>';
    return h + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
  }
  function paneContent(){ return isMobile() ? paneMobileInner() : paneInner(ACTIVE_AREA); }

  var rail, pane, scrim, top, usermenu;
  function setArea(area){
    ACTIVE_AREA = area;
    rail.querySelectorAll('.cpr-areabtn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-area')===area); });
    pane.innerHTML = paneInner(area);
    wirePriv();
  }

  // true if this user has any owner/manager tool (or Settings). Drives whether
  // the admin (lock) rail icon shows at all. Perms unknown -> fall back to role
  // rank so admins aren't hidden on a slow/failed permissions read.
  function hasAdminArea(){
    if (NAV_PERMS === null) return rank() >= RANK.admin;
    return PRIVILEGED.some(canSee) || canSee({ acc:'staff.manage' });
  }
  function updateAdminIcon(){
    var b = rail && rail.querySelector('.cpr-areabtn[data-area="admin"]');
    if (b) b.style.display = hasAdminArea() ? '' : 'none';
  }
  // Reports rail icon: managers/owner (team data). Gated by role rank so it doesn't depend on a
  // DB permission yet; add a 'reports.view' permission later for finer RBAC.
  function updateReportsIcon(){
    var b = rail && rail.querySelector('.cpr-reportsbtn');
    if (b) b.style.display = (rank() >= RANK.admin) ? '' : 'none';
  }
  // Employees rail icon: shows if the user can see any Employees tool (fall back to rank).
  function updateEmployeesIcon(){
    var b = rail && rail.querySelector('.cpr-employeesbtn');
    if (!b) return;
    var show = (NAV_PERMS === null) ? (rank() >= RANK.admin) : EMPLOYEES.some(canSee);
    b.style.display = show ? '' : 'none';
  }
  // the rail-bottom gear → Settings shows only for users who can actually use it
  function updateGearIcon(){
    var g = rail && rail.querySelector('.cpr-railgear');
    if (g) g.style.display = canSee({ acc:'staff.manage' }) ? '' : 'none';
  }

  function renderPriv(){
    if (pane){ pane.innerHTML = paneContent(); wirePriv(); }
    broadcastRole();
    updateAvatar();
    updateAdminIcon();
    updateReportsIcon();
    updateEmployeesIcon();
    updateGearIcon();
    // top bar identity (name)
    if (top){ var rp = top.querySelector('[data-roleslot]'); if (rp) rp.innerHTML = roleSlotHtml(); wireTop(); }
  }
  function roleText(){ var r = currentRole(); return r === 'owner' ? 'Owner' : (rank() >= RANK.admin ? 'Admin' : (r ? 'Team Member' : 'Not signed in')); }
  function updateAvatar(){
    if (usermenu){
      var nm = usermenu.querySelector('[data-um-name]'); if (nm) nm.textContent = NAV_NAME || 'Signed in';
      var rl = usermenu.querySelector('[data-um-role]'); if (rl) rl.textContent = roleText();
    }
  }

  function wirePriv(){
    if (!pane) return;
    pane.querySelectorAll('[data-act]').forEach(function(el){
      var act = el.getAttribute('data-act');
      el.onclick = function(e){
        if (act === 'show-pass'){ var w = pane.querySelector('[data-pass]'); if (w){ w.classList.add('show'); var i = w.querySelector('[data-passinput]'); if (i) i.focus(); } }
        else if (act === 'do-unlock'){ doUnlock(); }
        else if (act === 'lock'){ doSignOut(); }
        else if (act === 'settings'){ e.preventDefault(); window.location.href = 'settings.html'; }
      };
    });
    var input = pane.querySelector('[data-passinput]');
    if (input) input.onkeydown = function(e){ if (e.key === 'Enter') doUnlock(); };
  }

  // PIN login -> shared Supabase session (unlocks nav + every page)
  function doUnlock(){
    var input = pane.querySelector('[data-passinput]');
    var err = pane.querySelector('[data-err]');
    var btn = pane.querySelector('[data-act="do-unlock"]');
    var pin = input ? input.value.trim() : '';
    if (!pin) return;
    if (err) err.classList.remove('show');
    if (btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }
    function fail(msg){ if (err){ err.textContent = msg; err.classList.add('show'); } if (btn){ btn.disabled = false; btn.textContent = 'Sign in'; } }
    loadSB().then(function(sb){
      if (!sb) return fail('Could not reach the server. Try again.');
      fetch(SB_FN, { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+SB_ANON, 'apikey':SB_ANON }, body: JSON.stringify({ action:'login', pin:pin, device_id:navDevice() }) })
        .then(function(r){ return r.json().then(function(d){ return { status:r.status, data:d }; }, function(){ return { status:r.status, data:{} }; }); })
        .then(function(res){
          var d = res.data || {};
          if (res.status !== 200 || !d.access_token){
            return fail(d.error === 'invalid' ? 'Wrong PIN.' + (d.remaining!=null ? (' '+d.remaining+' left.') : '')
                      : (res.status === 423 || d.locked) ? 'Locked — too many tries.'
                      : (d.error || 'Could not sign in.'));
          }
          sb.auth.setSession({ access_token:d.access_token, refresh_token:d.refresh_token }).then(function(){
            var st = d.staff || {};
            NAV_ROLE = normRole(st.role); NAV_NAME = st.display_name || '';
            renderPriv();
            if (rank() < RANK.admin && err){ err.textContent = 'Signed in — no admin tools for this account.'; err.classList.add('show'); }
          }, function(){ fail('Could not start your session.'); });
        }, function(){ fail('Could not reach the server. Try again.'); });
    });
  }

  // inner content of the top-bar identity slot (the [data-roleslot] span)
  function roleSlotHtml(){
    if (!currentRole() && !NAV_NAME) return '<span class="nm-full" style="color:rgba(255,255,255,.5);font-weight:700">Not signed in</span>';
    return '<span class="dot"></span><span class="nm-full">'+(NAV_NAME?esc(NAV_NAME):'Signed in')+'</span>'
      + '<span class="nm-ini">'+esc(avatarInitials())+'</span>';
  }
  function wireTop(){
    if (!top) return;
    var bell = top.querySelector('[data-tbact="bell"]');
    if (bell && !bell._wired){ bell._wired = true; bell.onclick = function(e){ e.stopPropagation(); var dd = document.querySelector('.cpr-belldd'); if (dd) dd.classList.toggle('show'); }; }
    // the identity (name) is the account-menu trigger now that the rail avatar is gone
    var id = top.querySelector('[data-roleslot]');
    if (id && !id._wired){ id._wired = true; id.onclick = function(e){ e.stopPropagation(); if (usermenu){ updateAvatar(); usermenu.classList.toggle('show'); } }; }
  }

  function avatarInitials(){
    var name = NAV_NAME;
    if (!name) return 'CPR';
    var p = name.trim().split(/\s+/);
    return (p[0][0] + (p[1]?p[1][0]:'')).toUpperCase();
  }

  function injectNav(){
    var styleEl = document.createElement('style'); styleEl.textContent = css; document.head.appendChild(styleEl);

    scrim = document.createElement('div'); scrim.className = 'cpr-scrim';
    document.body.insertBefore(scrim, document.body.firstChild);

    // menu pane
    pane = document.createElement('div'); pane.className = 'cpr-pane';
    pane.innerHTML = paneContent();
    document.body.insertBefore(pane, document.body.firstChild);

    // icon rail
    rail = document.createElement('nav'); rail.className = 'cpr-rail';
    rail.innerHTML = ''
      + '<button class="cpr-burger2" aria-label="Menu">☰</button>'
      + '<a class="cpr-areabtn'+(ON_HOME?' active':'')+'" href="'+esc(HOME)+'" title="Home">'+railIcon('home')+'</a>'
      + '<span class="cpr-raildiv"></span>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='hub'?' active':'')+'" data-area="hub" title="My Hub">'+railIcon('user')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='pricing'?' active':'')+'" data-area="pricing" title="Sales &amp; Pricing">'+railIcon('tag')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='order'?' active':'')+'" data-area="order" title="Ordering &amp; Inventory">'+railIcon('order')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='ops'?' active':'')+'" data-area="ops" title="Operations">'+railIcon('tools')+'</button>'
      + '<button class="cpr-areabtn cpr-employeesbtn'+(ACTIVE_AREA==='employees'?' active':'')+'" data-area="employees" title="Employees" style="display:none">'+railIcon('people')+'</button>'
      + '<button class="cpr-areabtn cpr-reportsbtn'+(ACTIVE_AREA==='reports'?' active':'')+'" data-area="reports" title="Reports" style="display:none">'+railIcon('chart')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='admin'?' active':'')+'" data-area="admin" title="Admin & Owner" style="display:none">'+railIcon('lock')+'</button>'
      + '<span class="cpr-railsp"></span>'
      + '<button class="cpr-collapse" aria-label="Collapse menu" title="Collapse menu">'+chevron('left')+'</button>'
      + '<a class="cpr-railgear" href="settings.html" title="Settings" aria-label="Settings" style="display:none">'+railIcon('gear')+'</a>';
    document.body.insertBefore(rail, document.body.firstChild);

    // ── top bar (persistent): page title · clock (soon) · bell · identity ─
    top = document.createElement('div'); top.className = 'cpr-topbar';
    top.innerHTML = ''
      + '<button class="cpr-tb-burger" aria-label="Menu">☰</button>'
      + '<a class="cpr-tb-brand" href="'+esc(HOME)+'" title="myRepairTools — Home" aria-label="Home">'+navLogoTop()+'</a>'
      + '<span class="cpr-tb-sp"></span>'
      + '<button class="cpr-tb-clock" data-clock title="Time clock — click to clock in/out"><span class="dot"></span><span class="lbl">🕐 Clock in</span></button>'
      + '<button class="cpr-tb-bell" data-tbact="bell" title="Notifications" aria-label="Notifications">🔔<span class="bdg"></span></button>'
      + '<span class="cpr-tb-role" data-roleslot>' + roleSlotHtml() + '</span>';
    document.body.insertBefore(top, document.body.firstChild);
    var belldd = document.createElement('div'); belldd.className = 'cpr-belldd';
    belldd.innerHTML = '<div class="h">Notifications</div><div class="empty">No notifications yet.<br>Coming soon.</div>';
    document.body.appendChild(belldd);
    document.addEventListener('click', function(e){
      if (belldd.classList.contains('show') && !belldd.contains(e.target) && !e.target.closest('.cpr-tb-bell')) belldd.classList.remove('show');
    });
    wireTop();
    wireClock();

    // ── collapse (desktop): hide the menu pane, keep the icon rail ───────
    var collapseBtn = rail.querySelector('.cpr-collapse');
    function updateCollapseBtn(){
      if (!collapseBtn) return;
      collapseBtn.innerHTML = chevron(collapsed ? 'right' : 'left');
      collapseBtn.title = collapsed ? 'Expand menu' : 'Collapse menu';
      collapseBtn.setAttribute('aria-label', collapseBtn.title);
    }
    function setCollapsed(v){
      collapsed = !!v;
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch(_){}
      document.body.classList.toggle('cpr-nav-collapsed', collapsed);
      updateCollapseBtn();
    }
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch(_){ collapsed = false; }
    document.body.classList.toggle('cpr-nav-collapsed', collapsed);
    updateCollapseBtn();
    if (collapseBtn) collapseBtn.onclick = function(){ setCollapsed(!collapsed); };

    // ── account menu : opens from the top-bar identity (name) ───────────
    usermenu = document.createElement('div'); usermenu.className = 'cpr-usermenu';
    usermenu.innerHTML = ''
      + '<div class="who"><div class="nm" data-um-name>Signed in</div><div class="rl" data-um-role></div></div>'
      + '<div class="umdiv"></div>'
      + '<button data-um="switch"><span class="umic">⇄</span> Switch user</button>'
      + '<button class="danger" data-um="signout"><span class="umic">⏏</span> Sign out</button>';
    document.body.appendChild(usermenu);
    usermenu.querySelector('[data-um="switch"]').onclick = function(){ usermenu.classList.remove('show'); doSwitchUser(); };
    usermenu.querySelector('[data-um="signout"]').onclick = function(){ usermenu.classList.remove('show'); doSignOut(); };
    var idBtn = top && top.querySelector('[data-roleslot]');
    document.addEventListener('click', function(e){
      if (usermenu.classList.contains('show') && !usermenu.contains(e.target) && !(idBtn && idBtn.contains(e.target))) usermenu.classList.remove('show');
    });

    // ── collapsed flyout: hover an area icon to reach its tools ──────────
    var flyout = document.createElement('div'); flyout.className = 'cpr-flyout';
    document.body.appendChild(flyout);
    var flyHideT = null;
    function wireFlyout(){
      var ub = flyout.querySelector('[data-act="flyout-unlock"]');
      if (ub) ub.onclick = function(){ flyout.classList.remove('show'); setCollapsed(false); setArea('admin'); };
    }
    function showFlyout(area, btn){
      if (!collapsed || window.innerWidth < 860) return;     // collapsed desktop only
      if (['ops','hub','admin','order','pricing','employees','reports'].indexOf(area) < 0) return;
      clearTimeout(flyHideT);
      flyout.innerHTML = flyoutLinksHtml(area);
      flyout.classList.add('show');
      var rect = btn.getBoundingClientRect();
      var top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - flyout.offsetHeight - 8));
      flyout.style.top = top + 'px';
      wireFlyout();
    }
    function hideFlyoutSoon(){ clearTimeout(flyHideT); flyHideT = setTimeout(function(){ flyout.classList.remove('show'); }, 200); }
    flyout.addEventListener('mouseenter', function(){ clearTimeout(flyHideT); });
    flyout.addEventListener('mouseleave', hideFlyoutSoon);

    rail.querySelectorAll('.cpr-areabtn').forEach(function(b){
      b.onclick = function(){
        flyout.classList.remove('show');
        setArea(b.getAttribute('data-area'));
        if (window.innerWidth < 860){ pane.classList.add('open'); scrim.classList.add('show'); }
        else if (collapsed){ setCollapsed(false); }   // expand to reveal the area's tools
      };
      var area = b.getAttribute('data-area');
      if (area){
        b.addEventListener('mouseenter', function(){ showFlyout(area, b); });
        b.addEventListener('mouseleave', hideFlyoutSoon);
      }
    });

    wirePriv();

    var burger = rail.querySelector('.cpr-burger2');
    var tbBurger = top.querySelector('.cpr-tb-burger');
    function setMenu(open){ pane.classList.toggle('open', open); scrim.classList.toggle('show', open); if (tbBurger) tbBurger.innerHTML = open ? '✕' : '☰'; }
    function closeMenu(){ setMenu(false); }
    function toggleMenu(){ setMenu(!pane.classList.contains('open')); }
    if (burger) burger.onclick = toggleMenu;
    if (tbBurger) tbBurger.onclick = toggleMenu;
    scrim.onclick = closeMenu;
    // close the menu after tapping a tool on mobile
    pane.addEventListener('click', function(e){ if (e.target.closest('.cpr-link')) closeMenu(); });
    var wasMobile = isMobile();
    window.addEventListener('resize', function(){
      flyout.classList.remove('show');
      if (window.innerWidth >= 860) closeMenu();
      var m = isMobile(); if (m !== wasMobile){ wasMobile = m; pane.innerHTML = paneContent(); wirePriv(); }
    });

    // single sign-on: pick up the shared session, and react when it changes
    // here, in another tab, or on another page (login / logout / refresh).
    loadSB().then(function(sb){ if (sb && sb.auth && sb.auth.onAuthStateChange){ sb.auth.onAuthStateChange(function(){ refreshRole(); }); } });
    window.addEventListener('storage', function(e){ if (e.key && e.key.indexOf('-auth-token') >= 0) refreshRole(); });

    broadcastRole();
    refreshRole();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectNav);
  else injectNav();

  // Site-wide AI chat widget (loads once; self-skips inside iframes).
  (function loadAssistant(){
    if (document.querySelector('script[data-cpr-assistant]')) return;
    var s = document.createElement('script');
    s.src = 'assets/cpr-assistant.js'; s.defer = true; s.setAttribute('data-cpr-assistant', '1');
    document.head.appendChild(s);
  })();
})();
