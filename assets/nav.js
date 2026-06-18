/* ===========================================================================
 * CPR myrepairtools.github.io — Shared Navigation Shell (v2)
 * Three-part shell: icon rail (areas) + menu pane (tools) + static red top bar.
 * Drop into any page with: <script src="assets/nav.js"></script>
 * Auth/lock/idle/role logic preserved from v1.
 * ========================================================================= */
(function () {
  'use strict';
  if (window.self !== window.top) return;   // skip inside iframes

  var NAV_AUTH = {
    url: 'https://script.google.com/macros/s/AKfycbz-QLDZVZZPeHzs1ScSkx9cs59bbi2NS6k8f_rf7avFWW07Mx8wlS96XrC1yE8z2fCj/exec',
    token: 'a3f1c8e90b2d4f6a8c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d',
    idleMinutes: 15
  };
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

  var RANK = { none:0, employee:1, admin:2, owner:3 };
  var AUTH_KEY = 'cprNavAuth';
  var IDLE_MS = NAV_AUTH.idleMinutes * 60 * 1000;

  var currentFile = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var ON_HOME = (currentFile === '' || currentFile === 'index.html' ||
                 currentFile === 'operations.html' || currentFile === 'admin.html');

  // ── AUTH STATE (unchanged) ───────────────────────────────────────────
  function readAuth(){
    try {
      var raw = localStorage.getItem(AUTH_KEY); if (!raw) return null;
      var a = JSON.parse(raw);
      if (!a || !a.role) return null;
      if (Date.now() - (a.last || 0) > IDLE_MS) { localStorage.removeItem(AUTH_KEY); return null; }
      return a;
    } catch(_) { return null; }
  }
  function writeAuth(role, name){ try { localStorage.setItem(AUTH_KEY, JSON.stringify({ role:role, name:name||'', last:Date.now() })); } catch(_){} }
  function touchAuth(){ var a = readAuth(); if (a) writeAuth(a.role, a.name); }
  function clearAuth(){ try { localStorage.removeItem(AUTH_KEY); } catch(_){} }
  function currentRole(){ var a = readAuth(); return a ? a.role : null; }
  function rank(){ return RANK[currentRole()] || 0; }
  function broadcastRole(){
    window.CPRNavRole = currentRole();
    try { window.dispatchEvent(new CustomEvent('cprnav:auth', { detail:{ role:window.CPRNavRole } })); } catch(_){}
  }

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
  .cpr-rail .cpr-avatar{ width:38px; height:38px; border-radius:50%; background:var(--cpr-red); color:#fff; font-weight:900; font-size:.82rem; display:flex; align-items:center; justify-content:center; margin-bottom:14px; }

  /* menu pane */
  .cpr-pane{ position:fixed; top:0; left:var(--cpr-rail-w); bottom:0; width:var(--cpr-pane-w);
    background:#fff; border-right:1.5px solid #E0E2EA; z-index:1000; overflow-y:auto; display:flex; flex-direction:column; }
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
  @media(min-width:860px){ body{ margin-left:var(--cpr-nav-w) !important; } }

  /* mobile — rail stays visible, pane slides */
  .cpr-scrim{ display:none; position:fixed; inset:0; background:rgba(45,45,59,.45); z-index:999; }
  .cpr-scrim.show{ display:block; }
  @media(max-width:859px){
    .cpr-rail .cpr-burger2{ display:flex; align-items:center; justify-content:center; }
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
      return ''
        + '<div class="cpr-grp">Admin &amp; Owner</div>'
        + '<div class="cpr-lock">'
        +   '<div class="hd"><span class="pad">🔒</span> Locked tools</div>'
        +   '<p>Owner &amp; manager tools are hidden. Enter your passcode to unlock them on this device.</p>'
        +   '<button class="cpr-btn red" data-act="show-pass">Unlock</button>'
        +   '<div class="cpr-passwrap" data-pass>'
        +     '<input type="password" inputmode="numeric" placeholder="Passcode" data-passinput>'
        +     '<div style="height:8px"></div>'
        +     '<button class="cpr-btn red" data-act="do-unlock">Unlock settings</button>'
        +     '<div class="cpr-err" data-err>That passcode doesn\'t have admin access.</div>'
        +   '</div>'
        + '</div>';
    }
    var name = (readAuth() && readAuth().name) || '';
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

  function paneInner(area){
    var hd = '<div class="cpr-pane-hd">CPR Tools</div>';
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

  var rail, pane, scrim, top;
  function setArea(area){
    ACTIVE_AREA = area;
    rail.querySelectorAll('.cpr-areabtn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-area')===area); });
    pane.innerHTML = paneInner(area);
    wirePriv();
  }

  function renderPriv(){
    if (ACTIVE_AREA === 'admin' && pane){ pane.innerHTML = paneInner('admin'); wirePriv(); }
    broadcastRole();
    // top bar role pill
    if (top){ var rp = top.querySelector('[data-roleslot]'); if (rp) rp.innerHTML = roleSlotHtml(); wireTop(); }
  }

  function wirePriv(){
    if (!pane) return;
    pane.querySelectorAll('[data-act]').forEach(function(el){
      var act = el.getAttribute('data-act');
      el.onclick = function(e){
        if (act === 'show-pass'){ var w = pane.querySelector('[data-pass]'); if (w){ w.classList.add('show'); var i = w.querySelector('[data-passinput]'); if (i) i.focus(); } }
        else if (act === 'do-unlock'){ doUnlock(); }
        else if (act === 'lock'){ clearAuth(); renderPriv(); }
        else if (act === 'settings'){ e.preventDefault(); alert('Global settings will live here. Tool-specific settings stay inside each tool.'); }
      };
    });
    var input = pane.querySelector('[data-passinput]');
    if (input) input.onkeydown = function(e){ if (e.key === 'Enter') doUnlock(); };
  }

  function doUnlock(){
    var input = pane.querySelector('[data-passinput]');
    var err = pane.querySelector('[data-err]');
    var btn = pane.querySelector('[data-act="do-unlock"]');
    var code = input ? input.value.trim() : '';
    if (!code) return;
    if (err) err.classList.remove('show');
    if (btn){ btn.disabled = true; btn.textContent = 'Checking…'; }
    var u = NAV_AUTH.url + '?action=verify&code=' + encodeURIComponent(code) + '&token=' + encodeURIComponent(NAV_AUTH.token);
    fetch(u).then(function(r){ return r.json(); }).then(function(d){
      if (d && d.ok && (d.role === 'admin' || d.role === 'owner')){
        writeAuth(d.role, d.name); renderPriv();
      } else {
        if (err){ err.textContent = 'That passcode doesn\'t have admin access.'; err.classList.add('show'); }
        if (btn){ btn.disabled = false; btn.textContent = 'Unlock settings'; }
      }
    }).catch(function(){
      if (err){ err.textContent = 'Could not reach the server. Try again.'; err.classList.add('show'); }
      if (btn){ btn.disabled = false; btn.textContent = 'Unlock settings'; }
    });
  }

  function roleSlotHtml(){
    var role = currentRole();
    if (!role) return '';
    var name = (readAuth() && readAuth().name) || '';
    var label = (role==='owner') ? 'Owner' : 'Admin';
    return '<span class="cpr-tb-role"><span class="dot"></span>'+esc(label)+(name?(' · '+esc(name)):'')+'</span>';
  }

  function wireTop(){
    if (!top) return;
    var lock = top.querySelector('[data-tbact="lock"]');
    if (lock) lock.onclick = function(){ clearAuth(); renderPriv(); };
  }

  function avatarInitials(){
    var name = (readAuth() && readAuth().name) || '';
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
      + '<div class="cpr-avatar">'+avatarInitials()+'</div>';
    document.body.insertBefore(rail, document.body.firstChild);

    rail.querySelectorAll('.cpr-areabtn').forEach(function(b){
      b.onclick = function(){ setArea(b.getAttribute('data-area')); if (window.innerWidth < 860){ pane.classList.add('open'); scrim.classList.add('show'); } };
    });

    wirePriv();

    var burger = rail.querySelector('.cpr-burger2');
    function closeMenu(){ pane.classList.remove('open'); scrim.classList.remove('show'); }
    burger.onclick = function(){ var open = pane.classList.toggle('open'); scrim.classList.toggle('show', open); };
    scrim.onclick = closeMenu;
    window.addEventListener('resize', function(){ if (window.innerWidth >= 860){ closeMenu(); } });

    ['click','keydown','mousemove','touchstart','scroll'].forEach(function(ev){
      window.addEventListener(ev, throttle(touchAuth, 5000), { passive:true });
    });
    setInterval(function(){ if (currentRole() && !readAuth()){ renderPriv(); } }, 30000);
    window.addEventListener('storage', function(e){ if (e.key === AUTH_KEY) renderPriv(); });

    broadcastRole();
  }

  function throttle(fn, ms){ var last = 0; return function(){ var now = Date.now(); if (now - last > ms){ last = now; fn(); } }; }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectNav);
  else injectNav();
})();
