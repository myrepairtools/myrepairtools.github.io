/* ===========================================================================
 * CPR myrepairtools.github.io — Shared Navigation Shell (v2)
 * Three-part shell: icon rail (areas) + menu pane (tools) + static red top bar.
 * Drop into any page with: <script src="assets/nav.js"></script>
 * Auth/lock/idle/role logic preserved from v1.
 * ========================================================================= */
(function () {
  'use strict';

  // Force HTTPS — Square's card form (and clipboard, and everything modern)
  // requires a secure origin, and old http:// bookmarks linger on shop PCs.
  // GitHub Pages' "Enforce HTTPS" does this server-side too; this catches
  // pages already loaded insecurely. Runs even inside iframes on purpose.
  if (location.protocol === 'http:' && !/^(localhost|127\.|10\.|192\.168\.)/.test(location.hostname)) {
    location.replace('https://' + location.host + location.pathname + location.search + location.hash);
    return;
  }

  if (window.self !== window.top) return;   // skip inside iframes

  // Installed home-screen app: flag the root (CSS safe-area rules key off it, and
  // the display-mode media query misses some iOS versions), and make sure env()
  // actually resolves — it needs viewport-fit=cover, which not every page declares.
  if (navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)) {
    document.documentElement.classList.add('mrt-standalone');
    var vpMeta = document.querySelector('meta[name="viewport"]');
    if (vpMeta && vpMeta.content.indexOf('viewport-fit') < 0) vpMeta.content += ',viewport-fit=cover';
  }

  // Service worker (network-first; see sw.js) — keeps installed home-screen apps
  // on the LATEST deploy instead of iOS's sticky cache, and hosts push later.
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('/sw.js'); } catch (_) {}
  }

  // Home-screen icon: give every page the myRepairTools app icon (iOS uses
  // apple-touch-icon; the SVG favicon is ignored for the home screen) + theme
  // color + web manifest. Injected here so all pages get it without per-file edits.
  (function iconMeta(){
    try{
      var head = document.head || document.getElementsByTagName('head')[0]; if(!head) return;
      var add = function(tag, attrs){ if(document.querySelector(attrs.sel)) return;
        var el = document.createElement(tag); for(var k in attrs){ if(k!=='sel') el.setAttribute(k, attrs[k]); } head.appendChild(el); };
      add('link', { sel:'link[rel="apple-touch-icon"]', rel:'apple-touch-icon', href:'/apple-touch-icon.png' });
      add('meta', { sel:'meta[name="theme-color"]', name:'theme-color', content:'#2D2D3B' });
      add('link', { sel:'link[rel="manifest"]', rel:'manifest', href:'/manifest.webmanifest' });
    }catch(e){}
  })();

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
    { label:'Consumption & Ordering', url:'consumption-report.html', icon:'chart-column', acc:'consumption.view' },
    { label:'Device Ordering',     url:'device-orders.html',       icon:'tablet-smartphone', acc:'consumption.view' },
    { label:'Jerry Ding Order',    url:'jerry-ding-order.html',    icon:'clipboard-list', acc:'orders.jerryding' },
    { label:'PO Converter',        url:'po-converter.html',        icon:'package', acc:'orders.po' },
    { label:'Hyla Orders',         url:'hyla-orders.html',         icon:'recycle', img:'assets/images/Assurant_icon.png', acc:'orders.hyla' }
  ];
  // Sales & Pricing — quoting and customer-facing pricing.
  var PRICING = [
    { label:'Price Calculator',    url:'price-calculator.html',    icon:'calculator', acc:'pricing.view' },
    { label:'Price Guide',         url:'price-guide.html',         icon:'smartphone', acc:'pricing.view' }
  ];
  // Operations — store-floor / daily ops.
  var OPERATIONS = [
    { label:'Cash Tracker',        url:'cash-tracker.html',        icon:'banknote', acc:'cash.view' },
    { label:'Contracts',            url:'contracts.html',           icon:'pen-line' },
    { label:'LCD Buyback',         url:'lcd-buyback.html',         icon:'monitor-smartphone' },
    { label:'Tech Damage Tracker', url:'damage-tracker.html',      icon:'wrench', acc:'damage.view' }
  ];
  // Utilities that live under Operations as their own "Tools" sub-group —
  // single-purpose gadgets rather than day-to-day trackers.
  var TOOLS = [
    { label:'Label Resizer',       url:'label-resizer.html',       icon:'printer' },
    { label:'Get the Extension',   url:'extension.html',           icon:'download' }
  ];
  // Employee-facing self-service area ("My Hub"): a tech's own stuff.
  var HUB = [
    { label:'Dashboard',           url:'index.html',                icon:'house' },
    { label:'Checklist',           url:'checklist.html',            icon:'list-checks' },
    { label:'Alerts',              url:'alerts.html',               icon:'bell' },
    { label:'Communications',      url:'communications.html',       icon:'megaphone' },
    { label:'My Commission',       url:'commission-dashboard.html', icon:'chart-line', acc:'commission.dashboard' },
    { label:'My Time',             url:'my-schedule.html',          icon:'calendar-days', acc:'schedule.view' }
  ];
  // Reports — read-only reports (managers/owner); each report is its own page.
  // (No `acc` yet — there's no 'reports.view' permission in the catalog, and canSee(acc)
  // would filter every report out of the list. The rail icon is rank-gated; pages gate by role.)
  var REPORTS = [
    { label:'Google Traffic',  url:'google-traffic.html',  icon:'map-pin', minRole:'admin' },
    { label:'Google Reviews',  url:'google-reviews.html',  icon:'star', minRole:'admin', badge:'gbp' },
    { label:'Overtime Report', url:'report-overtime.html', icon:'timer', minRole:'admin' }
  ];
  // Employees — people management (managers/owner): roster, scheduling, time off.
  var EMPLOYEES = [
    { label:'Team Members',   url:'employee-records.html', icon:'users', minRole:'admin', acc:'staff.view' },
    // Schedule/Task Admin reached from buttons on My Time / Checklist (hidden from menus)
    { label:'Schedule Admin', url:'schedule-admin.html',   icon:'calendar-cog', minRole:'admin', acc:'schedule.admin', hidden:true },
    { label:'Task Admin',     url:'task-admin.html',       icon:'folder-kanban', minRole:'admin', hidden:true },
    { label:'KB Compliance',  url:'kb-compliance.html',    icon:'clipboard-check', minRole:'admin', hidden:true },
    { label:'Time Entries',   url:'time-entries.html',     icon:'clock-4', minRole:'admin', acc:'schedule.admin' },
    { label:'Time Off',       url:'time-off.html',         icon:'palmtree', minRole:'admin', acc:'schedule.admin' }
  ];
  var PRIVILEGED = [
    // Cash Admin reached from a button on Cash Tracker (hidden from menus)
    { label:'Cash Admin',       url:'cash-admin.html',            icon:'wallet', minRole:'admin', acc:'cash.admin', hidden:true },
    { label:'Claim Payouts',    url:'claim-payouts.html',         icon:'chart-pie', minRole:'owner', acc:'claims.view' },
    { label:'Payroll · Commission & Tips', url:'commission-calculator.html', icon:'receipt', minRole:'owner', acc:'commission.view' },
    { label:'Profit First',     url:'profit-first.html',          icon:'landmark', minRole:'owner', acc:'profit.view' },
    { label:'Cash Journal',     url:'cash-journal.html',          icon:'notebook-tabs', minRole:'owner', acc:'cash.journal' },
    { label:'Expenses',         url:'expenses.html',              icon:'receipt-text', minRole:'owner', acc:'expenses.record' }
  ];
  // Settings — the rail gear is a real area now (design handoff): clicking it swaps
  // the pane to this list instead of navigating. Gear visibility stays staff.manage;
  // rows gate individually. Hash links open that tab on settings.html directly.
  var SETTINGS = [
    { label:'Team Members',        url:'settings.html#staff',      icon:'users', acc:'staff.manage' },
    { label:'Locations',           url:'settings.html#loc',        icon:'map-pin', acc:'staff.manage' },
    { label:'Notifications',       url:'settings.html#notif',      icon:'bell', acc:'staff.manage' },
    { label:'Page Settings',       url:'settings.html#pages',      icon:'file-cog', acc:'staff.manage' },
    { label:'Commission',          url:'settings.html#commission', icon:'percent', acc:'staff.manage' },
    { label:'Integrations',        url:'settings.html#integ',      icon:'plug', acc:'staff.manage' },
    { label:'Roles & Permissions', url:'settings.html#roles',      icon:'shield', acc:'staff.manage' }
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
    sbReady = import('/assets/supabase-js.js')
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
    window.CPRNavStaff = NAV_STAFF;   // { id, home_store, authorized_stores } — Square panel & co.
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
    if (lbl) lbl.textContent = CLOCK.busy ? '…' : (CLOCK.on ? clkElapsed() : 'Clock in');
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
  // settings pages highlight the gear (employee-records stays under Employees even
  // though it's also listed in the Settings pane)
  var inSettings = (currentFile === 'settings.html');
  var inKb = (currentFile === 'knowledge.html' || currentFile === 'kb-compliance.html');
  var ACTIVE_AREA = inKb ? 'kb' : inSettings ? 'settings' : inHub ? 'hub' : inAdmin ? 'admin' : inEmployees ? 'employees' : inOrder ? 'order' : inPricing ? 'pricing' : inReports ? 'reports' : 'ops';   // default ops (incl. home)

  // ── STYLES ───────────────────────────────────────────────────────────
  var RAIL_W = 64, PANE_W = 248;
  var css = `
  /* Smooth cross-document navigations (MPA) — cross-fade instead of a white flash.
     Both the leaving and entering page opt in via this rule; nav.js is on every page.
     Browsers without support just fall back to the normal instant navigation. */
  @view-transition { navigation: auto; }
  ::view-transition-old(root),::view-transition-new(root){ animation-duration:.18s; }
  @media (prefers-reduced-motion: reduce){ @view-transition { navigation: none; } }
  /* Pin the app chrome: same view-transition-name on both pages = treated as the
     SAME element, so the top bar / rail / menu pane hold perfectly still while
     only the page content cross-fades. */
  .cpr-topbar{ view-transition-name: cpr-topbar; }
  .cpr-rail{ view-transition-name: cpr-rail; }
  .cpr-pane{ view-transition-name: cpr-pane; }
  ::view-transition-group(cpr-topbar),::view-transition-group(cpr-rail),::view-transition-group(cpr-pane){ animation-duration:0s; }
  ::view-transition-old(cpr-topbar),::view-transition-new(cpr-topbar),
  ::view-transition-old(cpr-rail),::view-transition-new(cpr-rail),
  ::view-transition-old(cpr-pane),::view-transition-new(cpr-pane){ animation:none; }

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
  .cpr-rail .cpr-railgear.active{ background:var(--cpr-blue); opacity:1; }
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
  .cpr-tb-sq{ position:relative; width:34px; height:34px; border:none; border-radius:9px; background:rgba(255,255,255,.08); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .cpr-tb-sq:hover{ background:rgba(255,255,255,.16); }
  .cpr-tb-sq.open{ background:rgba(255,255,255,.22); }
  .cpr-tb-bell{ position:relative; width:34px; height:34px; border:none; border-radius:9px; background:rgba(255,255,255,.08); color:#fff; cursor:pointer; font-size:15px; display:flex; align-items:center; justify-content:center; }
  .cpr-tb-bell:hover{ background:rgba(255,255,255,.16); }
  .cpr-tb-bell .bdg{ position:absolute; top:1px; right:1px; min-width:16px; height:16px; padding:0 4px; border-radius:999px;
    background:var(--cpr-red); border:2px solid var(--cpr-blue-dark); display:none; align-items:center; justify-content:center;
    font-family:'Nunito',sans-serif; font-weight:900; font-size:.56rem; color:#fff; line-height:1; }
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
    .cpr-rail{ display:none; }                              /* no rail on mobile — bottom tab bar instead */
    .cpr-pane{ left:0; width:min(86vw,330px); border-right:none; box-shadow:0 18px 50px rgba(45,45,59,.28);
      transform:translateX(-100%); transition:transform .22s ease; }
    .cpr-pane.open{ transform:translateX(0); }
    body{ margin-left:0 !important; }                       /* content goes full width */
  }

  /* Added-to-Home-Screen (standalone): the iOS status bar draws over the page —
     grow the top bar down by the safe-area inset on EVERY page. html:root
     outranks the plain :root default above. */
  @media (display-mode: standalone){
    html:root{ --cpr-top-h:calc(52px + env(safe-area-inset-top)); }
    .cpr-topbar{ padding-top:env(safe-area-inset-top); }
  }
  html.mrt-standalone{ --cpr-top-h:calc(52px + env(safe-area-inset-top)); }
  html.mrt-standalone .cpr-topbar{ padding-top:env(safe-area-inset-top); }

  /* mobile app shell — bottom tab bar (Home/Tasks/My Time/Commission/More).
     --cpr-bb-h lets pages with their own fixed footers sit above it. */
  :root{ --cpr-bb-h:0px; }
  .cpr-bottombar{ display:none; }
  @media(max-width:859px){
    :root{ --cpr-bb-h:calc(60px + env(safe-area-inset-bottom)); }
    .cpr-bottombar{ position:fixed; left:0; right:0; bottom:0; z-index:1001; display:flex; background:#fff;
      border-top:1px solid #E0E2EA; padding:7px 4px max(7px, calc(env(safe-area-inset-bottom) - 8px));
      box-shadow:0 -8px 22px rgba(45,45,59,.07); view-transition-name:cpr-bottombar; }
    body{ padding-bottom:var(--cpr-bb-h) !important; }
    .cpr-tb-burger{ display:none; }                         /* More tab replaces the hamburger */
    .cpr-tb-sq{ display:none; }                             /* Square lives under More on mobile */
    .cpra-fab{ bottom:calc(var(--cpr-bb-h) + 12px) !important; }  /* assistant ✨ sits above the tab bar */
  }
  .cpr-bb-tab{ flex:1; display:flex; flex-direction:column; align-items:center; gap:2px; border:none; background:none;
    font-family:'Nunito',sans-serif; font-weight:800; font-size:.6rem; color:var(--cpr-blue-dark); cursor:pointer;
    text-decoration:none; padding:2px 0; min-width:0; }
  .cpr-bb-tab .i{ font-size:1.3rem; line-height:1.1; }
  .cpr-bb-tab.on{ color:var(--cpr-blue); }
  ::view-transition-group(cpr-bottombar){ animation-duration:0s; }
  ::view-transition-old(cpr-bottombar),::view-transition-new(cpr-bottombar){ animation:none; }
  `;

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  // Lucide icons v1.24.0 (ISC/MIT, lucide.dev) — inlined inner markup; rendered by navIcon()
  var NAV_SVG = {
    'house': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
    'list-checks': '<path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" /><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" />',
    'bell': '<path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />',
    'star': '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />',
    'megaphone': '<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" /><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" /><path d="M8 6v8" />',
    'chart-line': '<path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m19 9-5 5-4-4-3 3" />',
    'calendar-days': '<path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /><path d="M8 14h.01" /><path d="M12 14h.01" /><path d="M16 14h.01" /><path d="M8 18h.01" /><path d="M12 18h.01" /><path d="M16 18h.01" />',
    'book-open': '<path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />',
    'timer': '<line x1="10" x2="14" y1="2" y2="2" /><line x1="12" x2="15" y1="14" y2="11" /><circle cx="12" cy="14" r="8" />',
    'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" />',
    'calendar-cog': '<path d="m15.228 16.852-.923-.383" /><path d="m15.228 19.148-.923.383" /><path d="M16 2v4" /><path d="m16.47 14.305.382.923" /><path d="m16.852 20.772-.383.924" /><path d="m19.148 15.228.383-.923" /><path d="m19.53 21.696-.382-.924" /><path d="m20.772 16.852.924-.383" /><path d="m20.772 19.148.924.383" /><path d="M21 10.592V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" /><path d="M3 10h18" /><path d="M8 2v4" /><circle cx="18" cy="18" r="3" />',
    'folder-kanban': '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /><path d="M8 10v4" /><path d="M12 10v2" /><path d="M16 10v6" />',
    'clock-4': '<circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />',
    'palmtree': '<path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4" /><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3" /><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35" /><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14" />',
    'wallet': '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />',
    'chart-pie': '<path d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z" /><path d="M21.21 15.89A10 10 0 1 1 8 2.83" />',
    'receipt': '<path d="M12 17V7" /><path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8" /><path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z" />',
    'landmark': '<path d="M10 18v-7" /><path d="M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z" /><path d="M14 18v-7" /><path d="M18 18v-7" /><path d="M3 22h18" /><path d="M6 18v-7" />',
    'notebook-tabs': '<path d="M2 6h4" /><path d="M2 10h4" /><path d="M2 14h4" /><path d="M2 18h4" /><rect width="16" height="20" x="4" y="2" rx="2" /><path d="M15 2v20" /><path d="M15 7h5" /><path d="M15 12h5" /><path d="M15 17h5" />',
    'receipt-text': '<path d="M13 16H8" /><path d="M14 8H8" /><path d="M16 12H8" /><path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z" />',
    'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" />',
    'file-cog': '<path d="M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z" /><path d="M20 8v12a2 2 0 0 1-2 2h-4.182" /><path d="m3.305 19.53.923-.382" /><path d="M4 10.592V4a2 2 0 0 1 2-2h8" /><path d="m4.228 16.852-.924-.383" /><path d="m5.852 15.228-.383-.923" /><path d="m5.852 20.772-.383.924" /><path d="m8.148 15.228.383-.923" /><path d="m8.53 21.696-.382-.924" /><path d="m9.773 16.852.922-.383" /><path d="m9.773 19.148.922.383" /><circle cx="7" cy="18" r="3" />',
    'percent': '<line x1="19" x2="5" y1="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" />',
    'plug': '<path d="M12 22v-5" /><path d="M15 8V2" /><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z" /><path d="M9 8V2" />',
    'shield': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />',
    'banknote': '<rect width="20" height="12" x="2" y="6" rx="2" /><circle cx="12" cy="12" r="2" /><path d="M6 12h.01M18 12h.01" />',
    'pen-line': '<path d="M13 21h8" /><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />',
    'monitor-smartphone': '<path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15" /><path d="M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" />',
    'smartphone': '<rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" />',
    'wrench': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />',
    'calculator': '<rect width="16" height="20" x="4" y="2" rx="2" /><line x1="8" x2="16" y1="6" y2="6" /><line x1="16" x2="16" y1="14" y2="18" /><path d="M16 10h.01" /><path d="M12 10h.01" /><path d="M8 10h.01" /><path d="M12 14h.01" /><path d="M8 14h.01" /><path d="M12 18h.01" /><path d="M8 18h.01" />',
    'chart-column': '<path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />',
    'tablet-smartphone': '<rect width="10" height="14" x="3" y="8" rx="2" /><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4" /><path d="M8 18h.01" />',
    'clipboard-list': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" />',
    'clipboard-check': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" />',
    'package': '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><polyline points="3.29 7 12 12 20.71 7" /><path d="m7.5 4.27 9 5.15" />',
    'recycle': '<path d="M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5" /><path d="M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12" /><path d="m14 16-3 3 3 3" /><path d="M8.293 13.596 7.196 9.5 3.1 10.598" /><path d="m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843" /><path d="m13.378 9.633 4.096 1.098 1.097-4.096" />',
    'menu': '<path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />',
    'circle-dollar-sign': '<circle cx="12" cy="12" r="10" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /><path d="M12 18V6" />',
    'sparkles': '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" />',
    'settings': '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" />',
    'printer': '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" />',
    'download': '<path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />'
  };
  function navIcon(name, size){
    if (!NAV_SVG[name]) return name || '';   // emoji / raw-text fallback for unmapped entries
    var s = size || 17;
    return '<svg viewBox="0 0 24 24" width="'+s+'" height="'+s+'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;margin:0 auto">'+NAV_SVG[name]+'</svg>';
  }

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
    people: 'M9 11.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM2.5 19.5v-.3c0-2.7 2.6-4.3 6.5-4.3s6.5 1.6 6.5 4.3v.3M16 5.3a3.2 3.2 0 0 1 0 6.2M17.5 14.6c2.5.5 4 1.9 4 4v.3',
    book:  'M3 5.5h5.2c1.6 0 3 .7 3.8 1.9.8-1.2 2.2-1.9 3.8-1.9H21v13h-5.2c-1.5 0-2.9.6-3.8 1.7-.9-1.1-2.3-1.7-3.8-1.7H3v-13ZM12 7.4V20.2'
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
    // hash links (settings.html#integ) are active only when their tab hash matches,
    // so the five settings.html rows don't all light up at once
    var u = t.url.toLowerCase(), base = u.split('#')[0], frag = u.indexOf('#') > -1 ? u.split('#')[1] : null;
    var active = (base === currentFile && (!frag || ('#' + frag) === location.hash.toLowerCase())) ? ' active' : '';
    var tagHtml = tag ? (' <span class="tag '+(tag==='Owner'?'owner':'')+'">'+tag+'</span>') : '';
    var ic = t.img
      ? '<img src="'+esc(t.img)+'" alt="" onerror="this.outerHTML=\''+(NAV_SVG[t.icon]?'':esc(t.icon||''))+'\'">'
      : navIcon(t.icon||'');
    return '<a class="cpr-link'+active+'" href="'+esc(t.url)+'"><span class="ic">'+ic+'</span> '+esc(t.label)+tagHtml+(t.badge?navCntHtml(t.badge):'')+'</a>';
  }

  // live count pills on menu rows (badge:'gbp' = unanswered Google reviews).
  // Rendered inline so pane re-renders keep the number; refreshed once per page load.
  var NAVCNT = {};
  function navCntHtml(key){
    var n = NAVCNT[key];
    return '<span data-navcnt="'+key+'" style="'+(n?'':'display:none;')
      +'margin-left:6px;background:#DC282E;color:#fff;font-size:.6rem;font-weight:900;border-radius:999px;padding:1px 7px;line-height:1.5;vertical-align:1px">'
      +(n ? (n>9?'9+':n) : '')+'</span>';
  }
  function applyNavCnt(){
    Object.keys(NAVCNT).forEach(function(k){
      var n = NAVCNT[k];
      document.querySelectorAll('[data-navcnt="'+k+'"]').forEach(function(el){
        el.textContent = n ? (n>9?'9+':String(n)) : '';
        el.style.display = n ? 'inline-block' : 'none';
      });
    });
  }

  // a tool is visible if its access permission is granted (perms not yet loaded -> show, to avoid a flash)
  // hidden:true = page stays registered (rail highlight, role gating) but never renders
  // in a menu — its access lives on a button inside the tool it manages instead.
  function canSee(t){ if (!t) return true; if (t.hidden) return false; if (!t.acc) return true; if (NAV_PERMS === null) return true; return NAV_PERMS.has(t.acc); }

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
    if (area === 'settings'){
      return '<div class="cpr-fly-hd">Settings</div>'
        + SETTINGS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
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
  // Knowledge Base pane: the KB's Browse list lives in the nav (no in-page
  // sidebar). knowledge.html publishes its categories/counts to localStorage
  // (cprKbNav) on every load; before the first visit we fall back to the core
  // rows. Rows are hash links, so clicks route inside the open KB page.
  function kbPaneHtml(){
    var items = null;
    try{ items = JSON.parse(localStorage.getItem('cprKbNav')||'null'); }catch(e){}
    if (!items || !items.length){
      items = [ {h:'c=all', i:'📚', l:'All articles'}, {h:'c=req', i:'⭐', l:'Required reading'} ];
      if (currentRole()==='admin'||currentRole()==='owner') items.push({grp:'Manage'},{h:'c=drafts',i:'✏️',l:'Drafts'},{h:'modules',i:'🧩',l:'Onboarding Setup'},{u:'kb-compliance.html',i:'📋',l:'Compliance'});
    }
    var here = currentFile==='knowledge.html' ? location.hash.replace('#','') : '';
    var h = '<div class="cpr-grp">Knowledge Base</div>';
    items.forEach(function(it){
      if (it.grp){ h += '<div class="cpr-grp">'+esc(it.grp)+'</div>'; return; }
      var href = it.u ? it.u : 'knowledge.html#'+it.h;
      var active = it.u ? (currentFile===it.u) : (currentFile==='knowledge.html' && (here===it.h || (!here && it.h==='c=all')));
      h += '<a class="cpr-link'+(active?' active':'')+'" href="'+esc(href)+'">'
        + '<span class="ic" style="font-size:15px;line-height:1">'+esc(it.i||'📄')+'</span>'
        + '<span style="flex:1">'+esc(it.l)+'</span>'
        + (it.b?'<span style="min-width:18px;text-align:center;background:#DC282E;color:#fff;border-radius:999px;font-size:.62rem;font-weight:800;padding:1px 6px">'+esc(String(it.b))+'</span>':'')
        + (it.c?'<span style="font-size:.68rem;font-weight:800;color:#B9BDCB">'+esc(String(it.c))+'</span>':'')
        + '</a>';
    });
    return h;
  }
  function paneInner(area){
    var hd = '';   // brand now lives in the top bar; the pane starts at its tool list
    if (area === 'kb'){
      return hd + kbPaneHtml()
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
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
    if (area === 'settings'){
      var st = SETTINGS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
      return hd + '<div class="cpr-grp">Settings</div>'
        + (st || '<div class="cpr-foot" style="padding:8px 16px">Nothing here for your role yet.</div>')
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
    var tls = TOOLS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    return hd
      + '<div class="cpr-grp">Operations</div>'
      + ops
      + (tls ? '<div class="cpr-grp">Tools</div>' + tls : '')
      + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
  }

  function isMobile(){ return window.innerWidth < 860; }
  // mobile has no rail to switch areas, so the slide-in menu shows every section
  // the user can see at once (profile · My Hub · Operations · Admin · Settings).
  function paneMobileInner(){
    var h = '<a class="cpr-mhd" href="profile.html" style="text-decoration:none;color:inherit"><span class="cpr-mav">'+esc(avatarInitials())+'</span>'
      + '<div><div class="nm">'+(NAV_NAME?esc(NAV_NAME):'Not signed in')+'</div><div class="rl">'+esc(roleText())+'</div></div></a>';
    h += linkHtml({ label:'Knowledge Base', url:'knowledge.html', icon:'book-open' });
    var hub = HUB.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (hub) h += '<div class="cpr-grp">My Hub</div>' + hub;
    var pr = PRICING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (pr) h += '<div class="cpr-grp">Sales &amp; Pricing</div>' + pr;
    var ord = ORDERING.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (ord) h += '<div class="cpr-grp">Ordering &amp; Inventory</div>' + ord;
    var ops = OPERATIONS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (ops) h += '<div class="cpr-grp">Operations</div>' + ops;
    var tls = TOOLS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (tls) h += '<div class="cpr-grp">Tools</div>' + tls;
    var emp = EMPLOYEES.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (emp) h += '<div class="cpr-grp">Employees</div>' + emp;
    var rep = REPORTS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
    if (rep) h += '<div class="cpr-grp">Reports</div>' + rep;
    if (hasAdminArea()) h += '<div data-priv>' + privilegedHtml() + '</div>';
    if (canSee({ acc:'staff.manage' })){
      var st = SETTINGS.filter(canSee).map(function(t){ return linkHtml(t); }).join('');
      if (st) h += '<div class="cpr-grp">Settings</div>' + st;
    }
    /* Square lives here on mobile (the top-bar button is hidden below 860px) */
    h += '<div class="cpr-grp">Register</div>'
      + '<div class="cpr-link" data-sqrow role="button" tabindex="0">'
      + '<svg viewBox="0 0 24 24" width="15" height="15" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex:none"><path fill="currentColor" d="M4.01 0A4.01 4.01 0 0 0 0 4.01v15.98A4.01 4.01 0 0 0 4.01 24h15.98A4.01 4.01 0 0 0 24 19.99V4.01A4.01 4.01 0 0 0 19.99 0H4.01zm1.62 4.36h12.74c.7 0 1.27.57 1.27 1.27v12.74c0 .7-.57 1.27-1.27 1.27H5.63c-.7 0-1.27-.57-1.27-1.27V5.63c0-.7.57-1.27 1.27-1.27zm3.83 4.35a.73.73 0 0 0-.73.73v5.12c0 .4.33.73.73.73h5.12c.4 0 .73-.33.73-.73V9.44a.73.73 0 0 0-.73-.73H9.46z"/></svg>'
      + ' Square · Backup Register</div>';
    return h + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
  }
  function paneContent(){ return isMobile() ? paneMobileInner() : paneInner(ACTIVE_AREA); }
  // KB pane rows are hash links — keep their active state in sync as the open
  // KB page routes, and let knowledge.html refresh counts after it loads data.
  window.addEventListener('hashchange', function(){
    if (ACTIVE_AREA === 'kb' && pane){ pane.innerHTML = paneContent(); wirePriv(); }
  });
  window.CPRKbNav = { refresh: function(){ if (ACTIVE_AREA === 'kb' && pane){ pane.innerHTML = paneContent(); wirePriv(); } } };

  var rail, pane, scrim, top, usermenu;
  function setArea(area){
    ACTIVE_AREA = area;
    rail.querySelectorAll('.cpr-areabtn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-area')===area); });
    var g = rail.querySelector('.cpr-railgear');                 // the gear is an area too
    if (g) g.classList.toggle('active', area === 'settings');
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
    updateAdminDivider();
  }
  // Reports rail icon: managers/owner (team data). Gated by role rank so it doesn't depend on a
  // DB permission yet; add a 'reports.view' permission later for finer RBAC.
  function updateReportsIcon(){
    var b = rail && rail.querySelector('.cpr-reportsbtn');
    if (b) b.style.display = (rank() >= RANK.admin) ? '' : 'none';
    updateAdminDivider();
  }
  // Employees rail icon: shows if the user can see any Employees tool (fall back to rank).
  function updateEmployeesIcon(){
    var b = rail && rail.querySelector('.cpr-employeesbtn');
    if (!b) return;
    var show = (NAV_PERMS === null) ? (rank() >= RANK.admin) : EMPLOYEES.some(canSee);
    b.style.display = show ? '' : 'none';
    updateAdminDivider();
  }
  // divider between employee-facing and admin-side rail icons: only show when
  // at least one admin-side icon (Employees / Reports / Admin) is visible
  function updateAdminDivider(){
    if (!rail) return;
    var d = rail.querySelector('.cpr-admindiv');
    if (!d) return;
    var any = ['.cpr-employeesbtn','.cpr-reportsbtn','.cpr-areabtn[data-area="admin"]'].some(function(sel){
      var b = rail.querySelector(sel);
      return b && b.style.display !== 'none';
    });
    d.style.display = any ? '' : 'none';
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
    if (bell && !bell._wired){ bell._wired = true; bell.onclick = function(){ location.href = 'alerts.html'; }; }
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
      + '<a class="cpr-areabtn'+(currentFile==='knowledge.html'?' active':'')+'" href="knowledge.html" title="Knowledge Base">'+railIcon('book')+'</a>'
      + '<span class="cpr-raildiv"></span>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='hub'?' active':'')+'" data-area="hub" title="My Hub">'+railIcon('user')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='pricing'?' active':'')+'" data-area="pricing" title="Sales &amp; Pricing">'+railIcon('tag')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='order'?' active':'')+'" data-area="order" title="Ordering &amp; Inventory">'+railIcon('order')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='ops'?' active':'')+'" data-area="ops" title="Operations">'+railIcon('tools')+'</button>'
      + '<span class="cpr-raildiv cpr-admindiv" style="display:none"></span>'
      + '<button class="cpr-areabtn cpr-employeesbtn'+(ACTIVE_AREA==='employees'?' active':'')+'" data-area="employees" title="Employees" style="display:none">'+railIcon('people')+'</button>'
      + '<button class="cpr-areabtn cpr-reportsbtn'+(ACTIVE_AREA==='reports'?' active':'')+'" data-area="reports" title="Reports" style="display:none">'+railIcon('chart')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='admin'?' active':'')+'" data-area="admin" title="Admin & Owner" style="display:none">'+railIcon('lock')+'</button>'
      + '<span class="cpr-railsp"></span>'
      + '<button class="cpr-collapse" aria-label="Collapse menu" title="Collapse menu">'+chevron('left')+'</button>'
      + '<button class="cpr-railgear'+(ACTIVE_AREA==='settings'?' active':'')+'" data-area="settings" title="Settings" aria-label="Settings" style="display:none">'+railIcon('gear')+'</button>';
    document.body.insertBefore(rail, document.body.firstChild);

    // ── top bar (persistent): page title · clock (soon) · bell · identity ─
    top = document.createElement('div'); top.className = 'cpr-topbar';
    top.innerHTML = ''
      + '<button class="cpr-tb-burger" aria-label="Menu">☰</button>'
      + '<a class="cpr-tb-brand" href="'+esc(HOME)+'" title="myRepairTools — Home" aria-label="Home">'+navLogoTop()+'</a>'
      + '<span class="cpr-tb-sp"></span>'
      + '<button class="cpr-tb-sq" data-square title="Square — take a payment (backup register)" aria-label="Square virtual terminal">'
      +   '<svg viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M4.01 0A4.01 4.01 0 0 0 0 4.01v15.98A4.01 4.01 0 0 0 4.01 24h15.98A4.01 4.01 0 0 0 24 19.99V4.01A4.01 4.01 0 0 0 19.99 0H4.01zm1.62 4.36h12.74c.7 0 1.27.57 1.27 1.27v12.74c0 .7-.57 1.27-1.27 1.27H5.63c-.7 0-1.27-.57-1.27-1.27V5.63c0-.7.57-1.27 1.27-1.27zm3.83 4.35a.73.73 0 0 0-.73.73v5.12c0 .4.33.73.73.73h5.12c.4 0 .73-.33.73-.73V9.44a.73.73 0 0 0-.73-.73H9.46z"/></svg>'
      + '</button>'
      + '<button class="cpr-tb-clock" data-clock title="Time clock — click to clock in/out"><span class="dot"></span><span class="lbl">Clock in</span></button>'
      + '<button class="cpr-tb-bell" data-tbact="bell" title="Notifications" aria-label="Notifications">'+navIcon('bell',17)+'<span class="bdg"></span></button>'
      + '<span class="cpr-tb-role" data-roleslot>' + roleSlotHtml() + '</span>';
    document.body.insertBefore(top, document.body.firstChild);

    // ── bottom tab bar (mobile app shell): Home / Tasks / My Time / Commission / More ──
    var BB_TABS = [
      { label:'Home',       url:'index.html',                icon:'house' },
      { label:'Tasks',      url:'checklist.html',            icon:'list-checks' },
      { label:'My Time',    url:'my-schedule.html',          icon:'calendar-days' },
      { label:'Commission', url:'commission-dashboard.html', icon:'circle-dollar-sign' }
    ];
    var curFile = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    var bb = document.createElement('nav'); bb.className = 'cpr-bottombar';
    bb.innerHTML = BB_TABS.map(function(t){
      return '<a class="cpr-bb-tab'+(t.url===curFile?' on':'')+'" href="'+esc(t.url)+'"><span class="i">'+navIcon(t.icon,22)+'</span>'+esc(t.label)+'</a>';
    }).join('') + '<button class="cpr-bb-tab" data-bbmore aria-label="More"><span class="i">'+navIcon('menu',22)+'</span>More</button>';
    document.body.appendChild(bb);
    // --cpr-bb-h = the bar's REAL rendered height (0 when hidden on desktop), so
    // page footers that sit on it (expenses save bar) are flush, not estimated.
    function sizeBB(){ document.documentElement.style.setProperty('--cpr-bb-h', (bb.offsetHeight || 0) + 'px'); }
    sizeBB();
    window.addEventListener('resize', sizeBB);

    wireTop();
    wireClock();

    // ── Square virtual terminal (backup register) — lazy-loaded panel.
    //    Desktop: the top-bar button. Mobile: the "Square · Backup Register"
    //    row under More (the top-bar button is hidden there).
    var sqBtn = top.querySelector('.cpr-tb-sq');
    function openSquare(){
      if (!window.CPRNavRole){ toastNav('Unlock myRepairTools first'); return; }
      if (window.CPRSquarePay){ window.CPRSquarePay.toggle(); return; }
      if (sqBtn) sqBtn.style.opacity = '.5';
      var s = document.createElement('script');
      s.src = 'assets/square-pay.js';
      s.onload = function(){ if (sqBtn) sqBtn.style.opacity = ''; if (window.CPRSquarePay) window.CPRSquarePay.open(); };
      s.onerror = function(){ if (sqBtn) sqBtn.style.opacity = ''; toastNav('Could not load the Square panel'); };
      document.head.appendChild(s);
    }
    if (sqBtn) sqBtn.addEventListener('click', openSquare);
    document.addEventListener('click', function(e){
      if (e.target.closest && e.target.closest('[data-sqrow]')){ e.preventDefault(); openSquare(); }
    });

    // ── unread-alerts count on the bell ──────────────────────────────────
    loadSB().then(function(c){
      if (!c) return;
      c.auth.getSession().then(function(r){
        if (!r || !r.data || !r.data.session) return;
        c.from('alerts').select('id', { count:'exact', head:true }).is('read_at', null).is('dismissed_at', null).then(function(q){
          var n = q.count || 0, b = top.querySelector('.cpr-tb-bell .bdg');
          if (b){ b.textContent = n > 9 ? '9+' : (n || ''); b.style.display = n ? 'flex' : 'none'; }
          // installed-app icon badge (the closest a web app gets to native widgets)
          try { if (navigator.setAppBadge){ if (n) navigator.setAppBadge(n); else navigator.clearAppBadge(); } } catch(_){}
        }, function(){});
        // unanswered Google reviews → count pill on the Google Reviews nav row (managers).
        // legacy_unanswered = the retired pre-engine backlog (owner decision) — never counted.
        if (rank() >= RANK.manager){
          c.from('gbp_reviews').select('id', { count:'exact', head:true }).is('reply_text', null).is('deleted_at', null).eq('legacy_unanswered', false).then(function(q){
            NAVCNT.gbp = q.count || 0; applyNavCnt();
          }, function(){});
        }
      });
    });

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
      + '<button data-um="profile"><span class="umic">'+navIcon('users',14)+'</span> My Profile</button>'
      + '<button data-um="switch"><span class="umic">⇄</span> Switch user</button>'
      + '<button class="danger" data-um="signout"><span class="umic">⏏</span> Sign out</button>';
    document.body.appendChild(usermenu);
    usermenu.querySelector('[data-um="profile"]').onclick = function(){ usermenu.classList.remove('show'); location.href = 'profile.html'; };
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
      if (['ops','hub','admin','order','pricing','employees','reports','settings'].indexOf(area) < 0) return;
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

    rail.querySelectorAll('.cpr-areabtn, .cpr-railgear[data-area]').forEach(function(b){
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
    var bbMore = document.querySelector('.cpr-bottombar [data-bbmore]');
    if (bbMore) bbMore.onclick = toggleMenu;
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

  // ── perf: prefetch a page the moment the user aims at its link, so the click
  //    lands on an already-downloaded page. Same-origin .html links only; each
  //    URL once per page-load. Browsers without rel=prefetch fall back to a
  //    plain fetch that lands in the HTTP cache (GH Pages sends max-age=600).
  (function hoverPrefetch(){
    if (window.self !== window.top) return;                       // not inside RepairQ iframes
    var seen = {};
    var linkOk = document.createElement('link').relList && document.createElement('link').relList.supports
      && document.createElement('link').relList.supports('prefetch');
    function arm(e){
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || a.origin !== location.origin) return;
      if (!/\.html$/.test(a.pathname)) return;
      if (a.pathname === location.pathname) return;               // same page (hash-only nav)
      if (seen[a.pathname]) return; seen[a.pathname] = 1;
      if (linkOk){
        var l = document.createElement('link'); l.rel = 'prefetch'; l.href = a.pathname;
        document.head.appendChild(l);
      } else {
        try { fetch(a.pathname, { credentials: 'same-origin' }); } catch(_){}
      }
    }
    document.addEventListener('pointerover', arm, { passive: true });
    document.addEventListener('touchstart', arm, { passive: true });
  })();

  // Site-wide AI chat widget (loads once; self-skips inside iframes).
  (function loadAssistant(){
    if (document.querySelector('script[data-cpr-assistant]')) return;
    var s = document.createElement('script');
    s.src = 'assets/cpr-assistant.js'; s.defer = true; s.setAttribute('data-cpr-assistant', '1');
    document.head.appendChild(s);
  })();

  (function loadComposeHelper(){
    if (document.querySelector('script[data-cpr-compose]')) return;
    var s = document.createElement('script');
    s.src = 'assets/compose-helper.js'; s.defer = true; s.setAttribute('data-cpr-compose', '1');
    document.head.appendChild(s);
  })();
})();
