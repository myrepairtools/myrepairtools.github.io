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
  var NAV_ROLE = null, NAV_NAME = '';
  var HOME = 'index.html';

  var OPERATIONS = [
    { label:'Cash Tracker',        url:'cash-tracker.html',        icon:'💵' },
    { label:'Hyla Orders',         url:'hyla-orders.html',         icon:'♻️', img:'assets/images/Assurant_icon.png' },
    { label:'Jerry Ding Order',    url:'jerry-ding-order.html',    icon:'📋' },
    { label:'PO Converter',        url:'po-converter.html',        icon:'📦' },
    { label:'Price Calculator',    url:'price-calc-and-guide.html',icon:'🧮' },
    { label:'Price Guide',         url:'price-guide.html',         icon:'📱' },
    { label:'Consumption & Ordering', url:'consumption-report.html', icon:'📊' },
    { label:'Tech Damage Tracker', url:'damage-tracker.html',      icon:'🔧' }
  ];
  var PRIVILEGED = [
    { label:'Cash Admin',       url:'cash-admin.html',            icon:'💰', minRole:'admin' },
    { label:'Employee Records', url:'employee-records.html',      icon:'📁', minRole:'admin' },
    { label:'Claim Ledger',     url:'claim-ledger.html',          icon:'📊', minRole:'owner' },
    { label:'Commission',       url:'commission-calculator.html', icon:'🧾', minRole:'owner' },
    { label:'Profit First',     url:'profit-first.html',          icon:'🏦', minRole:'owner' },
    { label:'Staff Management', url:'staff-management.html',      icon:'👥', minRole:'owner' }
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
    try { window.dispatchEvent(new CustomEvent('cprnav:auth', { detail:{ role:NAV_ROLE } })); } catch(_){}
  }
  // read the current role from the shared session, then re-render
  function refreshRole(){
    loadSB().then(function(sb){
      if (!sb){ NAV_ROLE = null; NAV_NAME = ''; renderPriv(); return; }
      sb.auth.getSession().then(function(res){
        var sess = res && res.data && res.data.session;
        if (!sess){ NAV_ROLE = null; NAV_NAME = ''; renderPriv(); return; }
        sb.from('staff').select('display_name,role').eq('auth_uid', sess.user.id).maybeSingle().then(function(sr){
          if (sr && sr.data){ NAV_ROLE = normRole(sr.data.role); NAV_NAME = sr.data.display_name || ''; }
          else { NAV_ROLE = null; NAV_NAME = ''; }
          renderPriv();
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

  // Which area is the current page in?
  var inAdmin = PRIVILEGED.some(function(t){ return t.url.toLowerCase() === currentFile; });
  var ACTIVE_AREA = inAdmin ? 'admin' : 'ops';   // default ops (incl. home)

  // ── STYLES ───────────────────────────────────────────────────────────
  var RAIL_W = 64, PANE_W = 248;
  var css = `
  :root{ --cpr-rail-w:${RAIL_W}px; --cpr-pane-w:${PANE_W}px; --cpr-nav-w:${RAIL_W+PANE_W}px;
    --cpr-blue-dark:#2D2D3B; --cpr-blue:#4FB0E3; --cpr-red:#DC282E; }
  .cpr-rail,.cpr-pane,.cpr-rail *,.cpr-pane *{ box-sizing:border-box; font-family:'Nunito','Nunito Sans',sans-serif; }

  /* icon rail — CPR Blue Dark, white icons */
  .cpr-rail{ position:fixed; top:0; left:0; bottom:0; width:var(--cpr-rail-w);
    background:var(--cpr-blue-dark); z-index:1001; display:flex; flex-direction:column; align-items:center; padding-top:12px; gap:6px; }
  .cpr-rail .cpr-brand{ width:42px; height:42px; border-radius:11px; background:var(--cpr-red); display:flex; align-items:center; justify-content:center; margin-bottom:10px; text-decoration:none; }
  .cpr-rail .cpr-brand svg{ width:20px; height:20px; }
  .cpr-rail .cpr-burger2{ display:none; width:40px; height:40px; border:none; background:none; color:#fff; font-size:1.3rem; cursor:pointer; border-radius:11px; }
  .cpr-rail .cpr-burger2:hover{ background:rgba(255,255,255,.12); }
  .cpr-rail .cpr-areabtn{ width:40px; height:40px; border-radius:11px; display:flex; align-items:center; justify-content:center;
    font-size:1.15rem; cursor:pointer; color:#fff; border:none; background:none; }
  .cpr-rail .cpr-areabtn:hover{ background:rgba(255,255,255,.12); }
  .cpr-rail .cpr-areabtn.active{ background:var(--cpr-blue); color:#fff; }
  .cpr-rail .cpr-railsp{ flex:1; }
  .cpr-rail .cpr-raildiv{ width:28px; height:1px; background:rgba(255,255,255,.16); margin:3px 0; }
  .cpr-rail .cpr-avatar{ width:38px; height:38px; border:none; cursor:pointer; border-radius:50%; background:var(--cpr-red); color:#fff; font-family:'Nunito'; font-weight:900; font-size:.78rem; display:flex; align-items:center; justify-content:center; margin-bottom:14px; }
  .cpr-rail .cpr-avatar:hover{ box-shadow:0 0 0 3px rgba(220,40,46,.28); }
  .cpr-usermenu{ position:fixed; left:calc(var(--cpr-rail-w) + 8px); bottom:12px; width:206px; background:#fff; border:1px solid #E0E2EA; border-radius:12px; box-shadow:0 16px 38px rgba(45,45,59,.24); z-index:1003; padding:6px; display:none; font-family:'Nunito Sans',sans-serif; }
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
  .cpr-pane{ position:fixed; top:0; left:var(--cpr-rail-w); bottom:0; width:var(--cpr-pane-w);
    background:#fff; border-right:1.5px solid #E0E2EA; z-index:1000; overflow-y:auto; display:flex; flex-direction:column; transition:transform .2s ease; }
  .cpr-pane a{ text-decoration:none; }
  .cpr-pane-hd{ display:flex; align-items:center; gap:9px; padding:16px 18px 12px; font-family:'Nunito',sans-serif; font-weight:900; font-size:1.05rem; letter-spacing:-.3px; color:var(--cpr-blue-dark); }
  .cpr-pane-hd .cpr-wm-mark{ width:26px; height:26px; border-radius:7px; background:var(--cpr-red); display:flex; align-items:center; justify-content:center; }
  .cpr-pane-hd .cpr-wm-mark svg{ width:15px; height:15px; }
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

  /* push page content clear of shell */
  @media(min-width:860px){
    body{ margin-left:var(--cpr-nav-w) !important; }
    body.cpr-nav-collapsed{ margin-left:var(--cpr-rail-w) !important; }
    body.cpr-nav-collapsed .cpr-pane{ transform:translateX(-100%); }
  }

  /* mobile — rail stays visible, pane slides */
  .cpr-scrim{ display:none; position:fixed; inset:0; background:rgba(45,45,59,.45); z-index:999; }
  .cpr-scrim.show{ display:block; }
  @media(max-width:859px){
    .cpr-rail .cpr-burger2{ display:flex; align-items:center; justify-content:center; }
    .cpr-rail .cpr-collapse{ display:none; }              /* burger handles mobile */
    .cpr-pane{ transform:translateX(-100%); transition:transform .22s ease; }
    .cpr-pane.open{ transform:translateX(0); }
    body{ margin-left:var(--cpr-rail-w) !important; }
  }
  `;

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  var MARK = '<svg viewBox="0 0 24 24"><path fill="#fff" d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/></svg>';

  // white line icons for the rail area buttons
  var RAIL_ICONS = {
    home:  'M3 10.6 12 3l9 7.6M5.5 9.2V20h13V9.2',
    tools: 'M14.6 6.4a3.8 3.8 0 0 0-5 4.9L3.5 17.4V20.5H6.6l6.1-6.1a3.8 3.8 0 0 0 4.9-5l-2.4 2.4-2-2 2.4-2.4Z',
    lock:  'M6.5 10.5V7.5a5.5 5.5 0 0 1 11 0v3M5 10.5h14v9.5H5zM12 14.5v2.5'
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

  function privilegedHtml(){
    var r = rank();
    if (r < RANK.admin){
      if (NAV_NAME){   // signed in, but this account has no admin tools
        return ''
          + '<div class="cpr-grp">Admin &amp; Owner</div>'
          + '<div class="cpr-lock">'
          +   '<div class="hd"><span class="pad">🔒</span> No admin tools</div>'
          +   '<p>Signed in as '+esc(NAV_NAME)+'. Your account doesn\'t have owner or manager tools.</p>'
          +   '<button class="cpr-btn red" data-act="lock">Sign out</button>'
          + '</div>';
      }
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
    var name = NAV_NAME;
    var roleLabel = (currentRole()==='owner') ? 'Owner' : 'Admin';
    var links = PRIVILEGED.filter(function(t){ return r >= RANK[t.minRole]; })
      .map(function(t){ return linkHtml(t, t.minRole==='owner' ? 'Owner' : 'Admin'); }).join('');
    var gear = (currentRole()==='owner')
      ? '<div class="cpr-gear" data-act="settings"><span>⚙️</span> Settings</div>' : '';
    return ''
      + '<div class="cpr-grp" style="padding-bottom:6px">Admin &amp; Owner</div>'
      + '<div class="cpr-unlocked-hd"><span class="cpr-pill"><span class="dot"></span> '+esc(roleLabel)+(name?(' · '+esc(name)):'')+'</span>'
      +   '<button class="cpr-lockbtn" data-act="lock">Lock</button></div>'
      + links + '<div class="cpr-spacer"></div>' + gear;
  }

  // build the contents of the collapsed-rail hover flyout for an area
  function flyoutLinksHtml(area){
    if (area === 'ops'){
      return '<div class="cpr-fly-hd">Operations</div>'
        + OPERATIONS.map(function(t){ return linkHtml(t); }).join('');
    }
    // admin area
    var r = rank();
    if (r < RANK.admin){
      return '<div class="cpr-fly-hd">Admin &amp; Owner</div>'
        + '<div class="cpr-fly-lock"><span class="pad">🔒</span><div>Owner &amp; manager tools are locked. Unlock to access them.</div></div>'
        + '<div style="padding:2px 12px 8px"><button class="cpr-btn red" data-act="flyout-unlock">Unlock</button></div>';
    }
    var links = PRIVILEGED.filter(function(t){ return r >= RANK[t.minRole]; })
      .map(function(t){ return linkHtml(t, t.minRole==='owner' ? 'Owner' : 'Admin'); }).join('');
    var gear = (currentRole()==='owner')
      ? '<a class="cpr-link" href="settings.html"><span class="ic">⚙️</span> Settings</a>' : '';
    return '<div class="cpr-fly-hd">Admin &amp; Owner</div>' + links + gear;
  }

  // myRepairTools wordmark for the white menu pane (dark text + red), inlined
  // with a tight viewBox so it sits flush-left and crisp.
  function navLogo(){
    return '<svg viewBox="0 0 308 64" width="150" height="31" style="display:block" xmlns="http://www.w3.org/2000/svg" fill="none" role="img" aria-label="myRepairTools">'
      + '<path d="M30 18 18 32l12 14M44 18l12 14-12 14" stroke="#DC282E" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"></path>'
      + '<text x="74" y="44" font-family="\'Nunito\',sans-serif" font-size="30" font-weight="800"><tspan fill="#2D2D3B">myRepair</tspan><tspan fill="#DC282E">Tools</tspan></text>'
      + '</svg>';
  }
  function paneInner(area){
    var hd = '<div class="cpr-pane-hd">' + navLogo() + '</div>';
    if (area === 'admin'){
      return hd + '<div data-priv>' + privilegedHtml() + '</div>'
        + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
    }
    var ops = OPERATIONS.map(function(t){ return linkHtml(t); }).join('');
    return hd
      + '<div class="cpr-grp">Operations</div>'
      + ops
      + '<div class="cpr-spacer"></div><div class="cpr-foot">Internal tools · CPR Oregon</div>';
  }

  var rail, pane, scrim, top, usermenu;
  function setArea(area){
    ACTIVE_AREA = area;
    rail.querySelectorAll('.cpr-areabtn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-area')===area); });
    pane.innerHTML = paneInner(area);
    wirePriv();
  }

  function renderPriv(){
    if (ACTIVE_AREA === 'admin' && pane){ pane.innerHTML = paneInner('admin'); wirePriv(); }
    broadcastRole();
    updateAvatar();
    // top bar role pill
    if (top){ var rp = top.querySelector('[data-roleslot]'); if (rp) rp.innerHTML = roleSlotHtml(); wireTop(); }
  }
  function roleText(){ var r = currentRole(); return r === 'owner' ? 'Owner' : (rank() >= RANK.admin ? 'Admin' : (r ? 'Team Member' : 'Not signed in')); }
  function updateAvatar(){
    var av = rail && rail.querySelector('.cpr-avatar');
    if (av) av.textContent = avatarInitials();
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

  function roleSlotHtml(){
    var role = currentRole();
    if (!role) return '';
    var label = (role==='owner') ? 'Owner' : 'Admin';
    return '<span class="cpr-tb-role"><span class="dot"></span>'+esc(label)+(NAV_NAME?(' · '+esc(NAV_NAME)):'')+'</span>';
  }

  function wireTop(){
    if (!top) return;
    var lock = top.querySelector('[data-tbact="lock"]');
    if (lock) lock.onclick = function(){ doSignOut(); };
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
    pane.innerHTML = paneInner(ACTIVE_AREA);
    document.body.insertBefore(pane, document.body.firstChild);

    // icon rail
    rail = document.createElement('nav'); rail.className = 'cpr-rail';
    rail.innerHTML = ''
      + '<button class="cpr-burger2" aria-label="Menu">☰</button>'
      + '<a class="cpr-areabtn'+(ON_HOME?' active':'')+'" href="'+esc(HOME)+'" title="Home">'+railIcon('home')+'</a>'
      + '<span class="cpr-raildiv"></span>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='ops'?' active':'')+'" data-area="ops" title="Operations">'+railIcon('tools')+'</button>'
      + '<button class="cpr-areabtn'+(ACTIVE_AREA==='admin'?' active':'')+'" data-area="admin" title="Admin & Owner">'+railIcon('lock')+'</button>'
      + '<span class="cpr-railsp"></span>'
      + '<button class="cpr-collapse" aria-label="Collapse menu" title="Collapse menu">'+chevron('left')+'</button>'
      + '<button class="cpr-avatar" title="Account" aria-label="Account">'+avatarInitials()+'</button>';
    document.body.insertBefore(rail, document.body.firstChild);

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

    // ── account menu (avatar) : Switch user / Sign out ──────────────────
    usermenu = document.createElement('div'); usermenu.className = 'cpr-usermenu';
    usermenu.innerHTML = ''
      + '<div class="who"><div class="nm" data-um-name>Signed in</div><div class="rl" data-um-role></div></div>'
      + '<div class="umdiv"></div>'
      + '<button data-um="switch"><span class="umic">⇄</span> Switch user</button>'
      + '<button class="danger" data-um="signout"><span class="umic">⏏</span> Sign out</button>';
    document.body.appendChild(usermenu);
    usermenu.querySelector('[data-um="switch"]').onclick = function(){ usermenu.classList.remove('show'); doSwitchUser(); };
    usermenu.querySelector('[data-um="signout"]').onclick = function(){ usermenu.classList.remove('show'); doSignOut(); };
    var avBtn = rail.querySelector('.cpr-avatar');
    if (avBtn) avBtn.onclick = function(e){ e.stopPropagation(); updateAvatar(); usermenu.classList.toggle('show'); };
    document.addEventListener('click', function(e){
      if (usermenu.classList.contains('show') && !usermenu.contains(e.target) && !(avBtn && avBtn.contains(e.target))) usermenu.classList.remove('show');
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
      if (area !== 'ops' && area !== 'admin') return;
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
    function closeMenu(){ pane.classList.remove('open'); scrim.classList.remove('show'); }
    burger.onclick = function(){ var open = pane.classList.toggle('open'); scrim.classList.toggle('show', open); };
    scrim.onclick = closeMenu;
    window.addEventListener('resize', function(){ flyout.classList.remove('show'); if (window.innerWidth >= 860){ closeMenu(); } });

    // single sign-on: pick up the shared session, and react when it changes
    // here, in another tab, or on another page (login / logout / refresh).
    loadSB().then(function(sb){ if (sb && sb.auth && sb.auth.onAuthStateChange){ sb.auth.onAuthStateChange(function(){ refreshRole(); }); } });
    window.addEventListener('storage', function(e){ if (e.key && e.key.indexOf('-auth-token') >= 0) refreshRole(); });

    broadcastRole();
    refreshRole();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectNav);
  else injectNav();
})();
