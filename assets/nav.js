/* ===========================================================================
 * CPR myrepairtools.github.io — Shared Side Navigation
 * ---------------------------------------------------------------------------
 * Drop into any tool page with:  <script src="assets/nav.js"></script>
 * (the data-section attribute from the old top nav is no longer needed.)
 *
 * Desktop/tablet (>=860px): a pinned left rail. Operations tools are always
 * visible. Admin & Owner tools are hidden until someone unlocks with a
 * passcode; the passcode is verified by the nav-auth proxy, which returns a
 * role (admin / owner). Admin sees admin-level tools; owner sees everything.
 * The unlock rides across pages/tabs (localStorage) and auto-relocks after
 * IDLE minutes of inactivity. A manual Lock button is always available.
 *
 * Mobile (<860px): a top bar + hamburger that opens the same list as a drawer
 * (unchanged behavior from the old nav).
 *
 * IMPORTANT: revealing a link is NOT granting access. Every sensitive tool
 * still re-checks the passcode against CPR Auth in its own backend. The nav
 * reveal is convenience + tidiness only.
 *
 * Pages should NOT include their own <header> — the rail replaces it. Inside
 * an iframe (RepairQ embed) the nav is skipped entirely.
 * ========================================================================= */
(function () {
  'use strict';

  if (window.self !== window.top) return;   // skip inside iframes

  // ──────────────────────────────────────────────────────────────────────
  // CONFIG
  // ──────────────────────────────────────────────────────────────────────
  var NAV_AUTH = {
    // ↓↓↓ paste the /exec URL from deploying nav-auth.gs here ↓↓↓
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
  // minRole: 'admin' = managers + owner; 'owner' = owner only.
  var PRIVILEGED = [
    { label:'Cash Admin',       url:'cash-admin.html',            icon:'💰', minRole:'admin' },
    { label:'Employee Records', url:'employee-records.html',      icon:'📁', minRole:'admin' },
    { label:'Claim Ledger',     url:'claim-ledger.html',          icon:'📊', minRole:'owner' },
    { label:'Commission',       url:'commission-calculator.html', icon:'🧾', minRole:'owner' },
    { label:'Profit First',     url:'profit-first.html',          icon:'🏦', minRole:'owner' },
    { label:'Staff Management', url:'staff-management.html',                 icon:'👥', minRole:'owner' }
  ];

  var RANK = { none:0, employee:1, admin:2, owner:3 };
  var AUTH_KEY = 'cprNavAuth';
  var IDLE_MS = NAV_AUTH.idleMinutes * 60 * 1000;

  var currentFile = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var ON_HOME = (currentFile === '' || currentFile === 'index.html' ||
                 currentFile === 'operations.html' || currentFile === 'admin.html');

  // ──────────────────────────────────────────────────────────────────────
  // AUTH STATE (localStorage; rides across pages/tabs; idle-relocks)
  // ──────────────────────────────────────────────────────────────────────
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

  // ──────────────────────────────────────────────────────────────────────
  // STYLES
  // ──────────────────────────────────────────────────────────────────────
  var css = `
  :root{ --cpr-nav-w:248px; }
  .cpr-rail,.cpr-rail *{ box-sizing:border-box; }
  .cpr-rail{ position:fixed; top:0; left:0; bottom:0; width:var(--cpr-nav-w);
    background:#fff; border-right:1.5px solid #E0E2EA; z-index:1000;
    display:flex; flex-direction:column; overflow-y:auto;
    font-family:'Nunito','Nunito Sans',sans-serif; }
  .cpr-rail a{ text-decoration:none; }
  .cpr-brand{ display:block; padding:18px 18px 4px; }
  .cpr-logo{ width:158px; max-width:100%; height:auto; display:block; }
  .cpr-eyebrow{ font-family:'Nunito',sans-serif; font-weight:800; font-size:.56rem; letter-spacing:.9px; text-transform:uppercase; color:#B9BDCB; padding:2px 18px 10px; }
  .cpr-fallback{ display:flex; align-items:center; gap:10px; }
  .cpr-mark{ width:36px; height:36px; border-radius:9px; background:#DC282E; flex:none;
    display:flex; align-items:center; justify-content:center; }
  .cpr-mark svg{ width:20px; height:20px; }
  .cpr-wm{ font-family:'Nunito',sans-serif; font-weight:900; font-size:1rem; color:#2D2D3B; letter-spacing:-.3px; line-height:1; }
  .cpr-wm small{ display:block; font-weight:700; font-size:.58rem; letter-spacing:.5px; color:#B9BDCB; text-transform:uppercase; margin-top:3px; }

  .cpr-grp{ font-family:'Nunito',sans-serif; font-weight:800; font-size:.6rem; text-transform:uppercase;
    letter-spacing:.9px; color:#B9BDCB; padding:14px 18px 6px; }
  .cpr-link{ display:flex; align-items:center; gap:11px; padding:9px 18px;
    font-family:'Nunito',sans-serif; font-weight:700; font-size:.88rem; color:#4E4E50;
    border-left:3px solid transparent; cursor:pointer; }
  .cpr-link .ic{ width:21px; text-align:center; font-size:1rem; flex:none; }
  .cpr-link .ic img{ width:18px; height:18px; object-fit:contain; display:block; margin:0 auto; }
  .cpr-link:hover{ background:#F3F2F2; color:#2D2D3B; }
  .cpr-link.active{ background:#EAF6FD; border-left-color:#4FB0E3; color:#2D2D3B; font-weight:800; }
  .cpr-link .tag{ margin-left:auto; font-family:'Nunito',sans-serif; font-weight:800; font-size:.5rem;
    letter-spacing:.4px; text-transform:uppercase; color:#B9BDCB; border:1px solid #E0E2EA; border-radius:5px; padding:1px 5px; }
  .cpr-link .tag.owner{ color:#DC282E; border-color:#F6C9CA; background:#FFF1F1; }

  .cpr-div{ height:1px; background:#E0E2EA; margin:10px 16px; }

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

  .cpr-spacer{ flex:1; }
  .cpr-gear{ display:flex; align-items:center; gap:10px; padding:11px 18px; margin:6px 0; cursor:pointer;
    font-family:'Nunito',sans-serif; font-weight:700; font-size:.84rem; color:#4E4E50; border-top:1px solid #E0E2EA; }
  .cpr-gear:hover{ background:#F3F2F2; color:#2D2D3B; }
  .cpr-foot{ padding:10px 18px 16px; font-size:.58rem; color:#B9BDCB; }

  /* push page content right on desktop to clear the rail */
  @media(min-width:860px){ body{ margin-left:var(--cpr-nav-w) !important; } }

  /* mobile top bar + drawer */
  .cpr-top{ display:none; position:sticky; top:0; background:#fff; border-bottom:1.5px solid #E0E2EA;
    padding:11px 14px; align-items:center; gap:11px; z-index:1001; }
  .cpr-burger{ font-size:1.4rem; background:none; border:none; cursor:pointer; color:#2D2D3B; line-height:1; padding:4px; }
  .cpr-scrim{ display:none; position:fixed; inset:0; background:rgba(45,45,59,.45); z-index:999; }
  .cpr-scrim.show{ display:block; }
  @media(max-width:859px){
    .cpr-rail{ transform:translateX(-100%); transition:transform .22s ease; width:280px; }
    .cpr-rail.open{ transform:translateX(0); }
    .cpr-top{ display:flex; }
  }
  `;

  // ──────────────────────────────────────────────────────────────────────
  // HTML BUILD
  // ──────────────────────────────────────────────────────────────────────
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  var MARK = '<svg viewBox="0 0 24 24"><path fill="#fff" d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/></svg>';

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
      // locked card
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
    // unlocked
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
      + links
      + '<div class="cpr-spacer"></div>'
      + gear;
  }

  function railInner(){
    var ops = OPERATIONS.map(function(t){ return linkHtml(t); }).join('');
    var homeActive = ON_HOME ? ' active' : '';
    return ''
      + '<a class="cpr-brand" href="'+esc(HOME)+'">'
      +   '<img class="cpr-logo" src="assets/images/CPRLogo_NoAssurant_Black.svg" alt="CPR Cell Phone Repair" onerror="this.style.display=\'none\';var f=this.parentNode.querySelector(\'.cpr-fallback\');if(f)f.style.display=\'flex\'">'
      +   '<span class="cpr-fallback" style="display:none"><span class="cpr-mark">'+MARK+'</span><span class="cpr-wm">CPR Tools<small>Oregon</small></span></span>'
      + '</a>'
      + '<div class="cpr-eyebrow">Internal Tools · Oregon</div>'
      + '<a class="cpr-link'+homeActive+'" href="'+esc(HOME)+'"><span class="ic">🏠</span> Home</a>'
      + '<div class="cpr-grp">Operations</div>'
      + ops
      + '<div class="cpr-div"></div>'
      + '<div data-priv>' + privilegedHtml() + '</div>'
      + '<div class="cpr-foot">Internal tools · CPR Oregon</div>';
  }

  // ──────────────────────────────────────────────────────────────────────
  // RENDER + WIRE
  // ──────────────────────────────────────────────────────────────────────
  var rail, scrim;
  function renderPriv(){
    var holder = rail && rail.querySelector('[data-priv]');
    if (holder){ holder.innerHTML = privilegedHtml(); wirePriv(); }
    broadcastRole();
  }

  function wirePriv(){
    if (!rail) return;
    rail.querySelectorAll('[data-act]').forEach(function(el){
      var act = el.getAttribute('data-act');
      el.onclick = function(e){
        if (act === 'show-pass'){ var w = rail.querySelector('[data-pass]'); if (w){ w.classList.add('show'); var i = w.querySelector('[data-passinput]'); if (i) i.focus(); } }
        else if (act === 'do-unlock'){ doUnlock(); }
        else if (act === 'lock'){ clearAuth(); renderPriv(); }
        else if (act === 'settings'){ e.preventDefault(); alert('Global settings will live here. Tool-specific settings stay inside each tool (look for the gear in that tool\'s header).'); }
      };
    });
    var input = rail.querySelector('[data-passinput]');
    if (input) input.onkeydown = function(e){ if (e.key === 'Enter') doUnlock(); };
  }

  function doUnlock(){
    var input = rail.querySelector('[data-passinput]');
    var err = rail.querySelector('[data-err]');
    var btn = rail.querySelector('[data-act="do-unlock"]');
    var code = input ? input.value.trim() : '';
    if (!code) return;
    if (err) err.classList.remove('show');
    if (!NAV_AUTH.url || NAV_AUTH.url.indexOf('PASTE_') === 0){
      if (err){ err.textContent = 'Admin unlock isn\'t set up yet.'; err.classList.add('show'); }
      return;
    }
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

  function injectNav(){
    var styleEl = document.createElement('style'); styleEl.textContent = css; document.head.appendChild(styleEl);

    // mobile top bar
    var top = document.createElement('div'); top.className = 'cpr-top';
    top.innerHTML = '<button class="cpr-burger" aria-label="Menu">☰</button>'
      + '<img src="assets/images/CPRLogo_NoAssurant_Black.svg" alt="CPR" style="height:24px;width:auto;display:block" onerror="this.style.display=\'none\';if(this.nextElementSibling)this.nextElementSibling.style.display=\'inline\'">'
      + '<span class="cpr-wm" style="display:none;font-size:.95rem">CPR Tools</span>';
    document.body.insertBefore(top, document.body.firstChild);

    scrim = document.createElement('div'); scrim.className = 'cpr-scrim';
    document.body.insertBefore(scrim, document.body.firstChild);

    rail = document.createElement('nav'); rail.className = 'cpr-rail'; rail.innerHTML = railInner();
    document.body.insertBefore(rail, document.body.firstChild);

    // wire operations/home links don't need handlers (plain <a>); wire privileged + mobile
    wirePriv();
    var burger = top.querySelector('.cpr-burger');
    function toggle(){ rail.classList.toggle('open'); scrim.classList.toggle('show'); }
    burger.onclick = toggle; scrim.onclick = toggle;
    window.addEventListener('resize', function(){ if (window.innerWidth >= 860){ rail.classList.remove('open'); scrim.classList.remove('show'); } });

    // idle relock + activity tracking
    ['click','keydown','mousemove','touchstart','scroll'].forEach(function(ev){
      window.addEventListener(ev, throttle(touchAuth, 5000), { passive:true });
    });
    setInterval(function(){ if (currentRole() && !readAuth()){ renderPriv(); } }, 30000);
    // cross-tab: lock in one tab relocks others
    window.addEventListener('storage', function(e){ if (e.key === AUTH_KEY) renderPriv(); });

    broadcastRole();
  }

  function throttle(fn, ms){ var last = 0; return function(){ var now = Date.now(); if (now - last > ms){ last = now; fn(); } }; }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectNav);
  else injectNav();
})();
