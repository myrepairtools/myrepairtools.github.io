/*
 * kiosk.js — shared-device time clock. Lazy-loaded by nav.js when the top-rail clock
 * button is right-clicked / long-pressed. Turns the tab into a full-screen punch station:
 *   PIN pad → identify (cpr-auth login) → clock in/out (qbtime-sync) → auto-reset.
 * Per-punch auth only: it uses the employee's returned token for the single clock call and
 * discards it — it never touches the device's app session. Exit requires a manager PIN.
 *
 * Exposes window.CPRKiosk = { open, close }.
 */
(function (root) {
  'use strict';
  var SB_URL = 'https://xuvsehrevxackuhmbmry.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var AUTH_FN = SB_URL + '/functions/v1/cpr-auth';
  var QBT_FN = SB_URL + '/functions/v1/qbtime-sync';

  function deviceId(){ try { var d = localStorage.getItem('cpr_device_id'); if (!d){ d = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); localStorage.setItem('cpr_device_id', d); } return d; } catch(_){ return 'kiosk'; } }
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function storeName(s){ return (root.CPRLocations && CPRLocations.display) ? CPRLocations.display(s) : String(s||'').replace(/^CPR\s*/,''); }
  function storeColor(s){ try { var x = root.CPRLocations && CPRLocations.find && CPRLocations.find(s); return (x && x.color) || '#4FB0E3'; } catch(_){ return '#4FB0E3'; } }
  function firstName(n){ return String(n||'').trim().split(/\s+/)[0] || 'there'; }
  function fmtClock(d){ var h = d.getHours(), m = d.getMinutes(), ap = h < 12 ? 'AM' : 'PM'; var h12 = h % 12; if (h12 === 0) h12 = 12; return h12 + ':' + ('0'+m).slice(-2) + ' ' + ap; }
  function fmtElapsed(startIso){ var t = new Date(startIso).getTime(); if (isNaN(t)) return ''; var mins = Math.max(0, Math.floor((Date.now()-t)/60000)), h = Math.floor(mins/60), mm = mins%60; return h > 0 ? (h+'h '+mm+'m') : (mm+'m'); }

  function login(pin){
    return fetch(AUTH_FN, { method:'POST', headers:{ 'Content-Type':'application/json', 'apikey':ANON, 'Authorization':'Bearer '+ANON }, body: JSON.stringify({ action:'login', pin: pin, device_id: deviceId() }) })
      .then(function(r){ return r.json().then(function(d){ return { status:r.status, data:d }; }, function(){ return { status:r.status, data:{} }; }); });
  }
  function clock(action, token, body){
    return fetch(QBT_FN + '?action=' + action, { method:'POST', headers:{ 'Content-Type':'application/json', 'apikey':ANON, 'Authorization':'Bearer '+token }, body: JSON.stringify(body||{}) })
      .then(function(r){ return r.json().catch(function(){ return {}; }); });
  }

  var rootEl = null, clockTimer = null, idleTimer = null;

  function styles(){
    if (document.getElementById('cpr-kiosk-css')) return;
    var s = document.createElement('style'); s.id = 'cpr-kiosk-css';
    s.textContent = ''
      + '#cpr-kiosk{position:fixed;inset:0;z-index:2147483000;background:linear-gradient(160deg,#2D2D3B,#1c1c27);color:#fff;font-family:Nunito,system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;-webkit-user-select:none;user-select:none;touch-action:manipulation;}'
      + '#cpr-kiosk .kx-top{position:absolute;top:0;left:0;right:0;height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;}'
      + '#cpr-kiosk .kx-time{font-weight:900;font-size:1rem;color:rgba(255,255,255,.85);letter-spacing:.3px;}'
      + '#cpr-kiosk .kx-exit{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:rgba(255,255,255,.75);font-family:Nunito;font-weight:800;font-size:.72rem;padding:7px 13px;border-radius:999px;cursor:pointer;}'
      + '#cpr-kiosk .kx-card{width:100%;max-width:360px;padding:20px;text-align:center;}'
      + '#cpr-kiosk .kx-h{font-weight:900;font-size:1.5rem;letter-spacing:-.4px;margin:0 0 4px;}'
      + '#cpr-kiosk .kx-sub{font-family:"Nunito Sans",sans-serif;font-weight:700;font-size:.9rem;color:rgba(255,255,255,.6);margin-bottom:20px;}'
      + '#cpr-kiosk .kx-dots{display:flex;gap:12px;justify-content:center;height:20px;margin-bottom:22px;}'
      + '#cpr-kiosk .kx-dots i{width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,.18);transition:.12s;}'
      + '#cpr-kiosk .kx-dots i.on{background:#fff;transform:scale(1.05);}'
      + '#cpr-kiosk .kx-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}'
      + '#cpr-kiosk .kx-key{height:72px;border:none;border-radius:16px;background:rgba(255,255,255,.09);color:#fff;font-family:Nunito;font-weight:800;font-size:1.7rem;cursor:pointer;transition:.1s;}'
      + '#cpr-kiosk .kx-key:active{background:rgba(255,255,255,.22);transform:scale(.97);}'
      + '#cpr-kiosk .kx-key.act{background:var(--kxc,#DC282E);}'
      + '#cpr-kiosk .kx-err{color:#ff9a9a;font-family:Nunito;font-weight:800;font-size:.86rem;min-height:20px;margin-top:14px;}'
      + '#cpr-kiosk .kx-big{width:100%;height:74px;border:none;border-radius:16px;font-family:Nunito;font-weight:900;font-size:1.2rem;cursor:pointer;color:#fff;margin-top:10px;}'
      + '#cpr-kiosk .kx-in{background:#2E9E5B;}#cpr-kiosk .kx-out{background:#DC282E;}'
      + '#cpr-kiosk .kx-ghost{background:none;border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.75);}'
      + '#cpr-kiosk .kx-stores{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:14px;}'
      + '#cpr-kiosk .kx-store{border:1.5px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);color:#fff;font-family:Nunito;font-weight:800;font-size:.9rem;padding:11px 16px;border-radius:12px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;}'
      + '#cpr-kiosk .kx-store.sel{border-color:#4FB0E3;background:rgba(79,176,227,.18);}'
      + '#cpr-kiosk .kx-store .sd{width:10px;height:10px;border-radius:50%;}'
      + '#cpr-kiosk .kx-check{font-size:64px;line-height:1;margin-bottom:10px;}';
    document.head.appendChild(s);
  }

  function mount(html){ if (rootEl) rootEl.innerHTML = topBar() + html; }
  function topBar(){ return '<div class="kx-top"><span class="kx-time" id="kxTime">' + fmtClock(new Date()) + '</span><button class="kx-exit" data-exit>Exit kiosk</button></div>'; }
  function wireCommon(){
    var ex = rootEl.querySelector('[data-exit]'); if (ex) ex.onclick = function(){ showPin({ exit:true }); };
  }
  function resetIdle(ms){ if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(function(){ showPin({}); }, ms || 20000); }

  // ---- PIN pad ---- opts: { exit:true } to gate exit on a manager PIN
  function showPin(opts){
    opts = opts || {}; var pin = '';
    function draw(err){
      var dots = ''; for (var i = 0; i < Math.max(4, pin.length); i++) dots += '<i class="' + (i < pin.length ? 'on' : '') + '"></i>';
      var keys = '';
      ['1','2','3','4','5','6','7','8','9'].forEach(function(n){ keys += '<button class="kx-key" data-k="' + n + '">' + n + '</button>'; });
      keys += '<button class="kx-key" data-k="back">⌫</button><button class="kx-key" data-k="0">0</button><button class="kx-key kx-act act" data-k="ok" style="--kxc:' + (opts.exit ? '#8a909e' : '#2E9E5B') + '">→</button>';
      mount('<div class="kx-card"><div class="kx-h">' + (opts.exit ? 'Manager PIN' : 'Time Clock') + '</div><div class="kx-sub">' + (opts.exit ? 'Enter a manager PIN to exit kiosk' : 'Enter your PIN to clock in or out') + '</div><div class="kx-dots">' + dots + '</div><div class="kx-pad">' + keys + '</div><div class="kx-err">' + esc(err || '') + '</div></div>');
      wireCommon();
      rootEl.querySelectorAll('[data-k]').forEach(function(b){ b.onclick = function(){ var k = b.getAttribute('data-k');
        if (k === 'back') pin = pin.slice(0, -1);
        else if (k === 'ok'){ submit(); return; }
        else if (pin.length < 12) pin += k;
        draw();
      }; });
    }
    function submit(){
      if (pin.length < 3) { draw('Enter your PIN'); return; }
      mount('<div class="kx-card"><div class="kx-h">…</div><div class="kx-sub">Checking</div></div>');
      login(pin).then(function(r){
        if (r.status !== 200 || !r.data.access_token){ pin = ''; draw(r.data && r.data.error === 'invalid' ? 'Wrong PIN, try again' : ((r.data && r.data.error) || 'Login failed')); return; }
        var staff = r.data.staff || {}, token = r.data.access_token;
        if (opts.exit){
          if (['owner','admin','manager'].indexOf(String(staff.role)) > -1){ close(); }
          else { pin = ''; draw('That account can’t exit kiosk'); }
          return;
        }
        showStatus(staff, token);
      }, function(){ pin = ''; draw('Network error'); });
    }
    draw('');
  }

  // ---- identity + clock in/out ----
  function showStatus(staff, token){
    resetIdle(20000);
    mount('<div class="kx-card"><div class="kx-h">Hi, ' + esc(firstName(staff.display_name)) + '</div><div class="kx-sub">Checking your status…</div></div>');
    clock('clock_status', token, {}).then(function(d){
      if (!d || !d.ok){ showPin({}); return; }
      if (d.on_the_clock){ drawOut(staff, token, d); }
      else { drawIn(staff, token); }
    }, function(){ showPin({}); });
  }
  function storesFor(staff){ var set = []; if (staff.home_store) set.push(staff.home_store); (staff.authorized_stores || []).forEach(function(s){ if (set.indexOf(s) < 0) set.push(s); }); return set; }

  function drawIn(staff, token){
    resetIdle(20000);
    var opts = storesFor(staff), sel = opts[0] || staff.home_store || '';
    function draw(){
      var picker = opts.length > 1 ? ('<div class="kx-stores">' + opts.map(function(s){ return '<button class="kx-store ' + (s === sel ? 'sel' : '') + '" data-st="' + esc(s) + '"><span class="sd" style="background:' + esc(storeColor(s)) + '"></span>' + esc(storeName(s)) + '</button>'; }).join('') + '</div>') : '';
      mount('<div class="kx-card"><div class="kx-h">Hi, ' + esc(firstName(staff.display_name)) + '</div><div class="kx-sub">You’re not on the clock' + (opts.length <= 1 && sel ? ' · ' + esc(storeName(sel)) : '') + '</div>' + picker + '<button class="kx-big kx-in" data-in>Clock In' + (opts.length <= 1 && sel ? '' : (sel ? ' · ' + esc(storeName(sel)) : '')) + '</button><button class="kx-big kx-ghost" data-cancel>Not me</button><div class="kx-err"></div></div>');
      wireCommon();
      rootEl.querySelectorAll('[data-st]').forEach(function(b){ b.onclick = function(){ sel = b.getAttribute('data-st'); draw(); resetIdle(20000); }; });
      rootEl.querySelector('[data-cancel]').onclick = function(){ showPin({}); };
      rootEl.querySelector('[data-in]').onclick = function(){ punch('clock_in', token, { store: sel }, staff, 'Clocked in', sel); };
    }
    draw();
  }
  function drawOut(staff, token, status){
    resetIdle(20000);
    var since = status.start ? (' since ' + fmtClock(new Date(status.start))) : '';
    var elapsed = status.start ? (' · ' + fmtElapsed(status.start)) : '';
    mount('<div class="kx-card"><div class="kx-h">Hi, ' + esc(firstName(staff.display_name)) + '</div><div class="kx-sub">On the clock' + esc(since) + esc(elapsed) + '</div><button class="kx-big kx-out" data-out>Clock Out</button><button class="kx-big kx-ghost" data-cancel>Not me</button><div class="kx-err"></div></div>');
    wireCommon();
    rootEl.querySelector('[data-cancel]').onclick = function(){ showPin({}); };
    rootEl.querySelector('[data-out]').onclick = function(){ punch('clock_out', token, {}, staff, 'Clocked out', staff.home_store); };
  }
  function punch(action, token, body, staff, verb, store){
    if (idleTimer) clearTimeout(idleTimer);
    mount('<div class="kx-card"><div class="kx-h">…</div><div class="kx-sub">One sec</div></div>');
    clock(action, token, body).then(function(d){
      if (d && d.ok){ confirm(verb, store); }
      else { var msg = (d && (d.detail || d.error)) || 'Something went wrong'; mount('<div class="kx-card"><div class="kx-check">⚠️</div><div class="kx-h">Couldn’t ' + (action === 'clock_in' ? 'clock in' : 'clock out') + '</div><div class="kx-sub">' + esc(msg) + '</div><button class="kx-big kx-ghost" data-cancel>Back</button></div>'); wireCommon(); rootEl.querySelector('[data-cancel]').onclick = function(){ showPin({}); }; }
    }, function(){ showPin({}); });
  }
  function confirm(verb, store){
    var when = fmtClock(new Date());
    mount('<div class="kx-card"><div class="kx-check">✅</div><div class="kx-h">' + esc(verb) + '</div><div class="kx-sub">' + esc(when) + (store ? ' · ' + esc(storeName(store)) : '') + '</div></div>');
    setTimeout(function(){ showPin({}); }, 3000);
  }

  function open(){
    if (rootEl) return;
    styles();
    rootEl = document.createElement('div'); rootEl.id = 'cpr-kiosk';
    document.body.appendChild(rootEl);
    try { document.documentElement.style.overflow = 'hidden'; } catch(_){}
    showPin({});
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(function(){ var t = document.getElementById('kxTime'); if (t) t.textContent = fmtClock(new Date()); }, 15000);
  }
  function close(){
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (rootEl) { rootEl.remove(); rootEl = null; }
    try { document.documentElement.style.overflow = ''; } catch(_){}
  }

  root.CPRKiosk = { open: open, close: close };
})(typeof window !== 'undefined' ? window : this);
