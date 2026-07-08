/* assets/square-pay.js — the Square virtual terminal pop-down (backup register).
 *
 * Lazy-loaded by nav.js when the Square rail button is first clicked. A
 * PERSISTENT panel (menu-bar-app style): it never closes on outside clicks —
 * only the ✕ closes it (with a confirm when a payment is mid-flight or the
 * form is dirty), so half-typed amounts survive stray clicks.
 *
 * Modes (tabs):
 *   Terminal — push the charge to the store's Square Terminal (card-present)
 *   Link     — create a Square payment link, text it from the store's own
 *              RingCentral line (messaging function) or copy it
 *   Keyed    — manually entered card via Square Web Payments SDK; the tab
 *              stays disabled until the SQUARE_APP_ID secret is set
 *
 * Store: defaults to the signed-in tech's store; a picker appears first when
 * they're authorized at multiple stores (window.CPRNavStaff from nav.js).
 * Backend: the square-pay edge function (Square creds stay server-side).
 */
(function () {
  'use strict';
  if (window.CPRSquarePay) return;

  var SB_URL = 'https://xuvsehrevxackuhmbmry.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var FN = SB_URL + '/functions/v1/square-pay';
  var MSG_FN = SB_URL + '/functions/v1/messaging';
  var DRAFT_KEY = 'cprSqDraft';
  var STORE_KEY = 'cprSqStore';   // localStorage — counter PCs live at one store
  function cachedStore() { try { return localStorage.getItem(STORE_KEY) || null; } catch (e) { return null; } }
  function cacheStore(st) { try { st ? localStorage.setItem(STORE_KEY, st) : localStorage.removeItem(STORE_KEY); } catch (e) {} }

  var S = {
    open: false, store: null, tab: 'terminal',
    devices: null, deviceId: null, config: null,
    active: null,           // { id, mode } payment in flight (polling)
    pollTimer: null, card: null, cardLocation: null,
  };

  function token() {
    try {
      var raw = localStorage.getItem('sb-xuvsehrevxackuhmbmry-auth-token');
      var o = JSON.parse(raw || '{}');
      return o.access_token || (o.currentSession && o.currentSession.access_token) || null;
    } catch (e) { return null; }
  }
  function call(action, payload) {
    var t = token();
    return fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (t || ANON), 'apikey': ANON },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }
  function sms(payload) {
    var t = token();
    return fetch(MSG_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (t || ANON), 'apikey': ANON },
      body: JSON.stringify(Object.assign({ action: 'send' }, payload)),
    }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function stores() {
    var st = window.CPRNavStaff || {};
    var out = [];
    if (st.home_store) out.push(st.home_store);
    (st.authorized_stores || []).forEach(function (s) { if (out.indexOf(s) < 0) out.push(s); });
    // owners run every store — always give them the full list (and the switcher)
    if (window.CPRNavRole === 'owner' && window.CPRLocations) {
      window.CPRLocations.names().forEach(function (s) {
        if (!out.some(function (x) { return window.CPRLocations.normalize(x) === window.CPRLocations.normalize(s); })) out.push(s);
      });
    }
    if (window.CPRLocations) out = window.CPRLocations.sort(out);
    return out;
  }

  // Where the SCHEDULE says this person is today — used as the DEFAULT store
  // for multi-store staff (a default, not a gate: the header pill still
  // switches to any authorized store for unscheduled coverage days).
  function scheduledStoreToday() {
    var st = window.CPRNavStaff || {};
    var t = token();
    if (!st.id || !t) return Promise.resolve(null);
    var dow = String(new Date().getDay());
    return fetch(SB_URL + '/rest/v1/staff_schedule?staff_id=eq.' + st.id + '&select=store,shifts', {
      headers: { 'apikey': ANON, 'Authorization': 'Bearer ' + t },
    }).then(function (r) { return r.json(); }).then(function (rows) {
      var hits = (Array.isArray(rows) ? rows : []).filter(function (row) {
        var v = (row.shifts || {})[dow];
        return v != null && v !== false && v !== '';
      }).map(function (row) { return row.store; });
      return hits.length === 1 ? hits[0] : null;    // none or ambiguous → fall through
    }).catch(function () { return null; });
  }
  function shortStore(s) { return window.CPRLocations ? window.CPRLocations.display(s) : String(s || '').replace('CPR ', ''); }
  function dollars(cents) { return '$' + (cents / 100).toFixed(2); }
  function amountCents() {
    var v = parseFloat(String((q('#sqAmount') || {}).value || '').replace(/[$,]/g, ''));
    return isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
  }
  function q(sel) { var p = document.getElementById('cprSqPanel'); return p ? p.querySelector(sel) : null; }

  /* ---------------- styles ---------------- */
  var css = document.createElement('style');
  css.textContent = '\
#cprSqPanel{position:fixed;top:56px;right:10px;width:380px;max-width:calc(100vw - 20px);z-index:99990;\
background:#fff;border:1px solid #E0E2EA;border-radius:16px;box-shadow:0 22px 60px rgba(45,45,59,.4);\
font-family:"Nunito Sans","Segoe UI",sans-serif;color:#2D2D3B;display:none;overflow:hidden}\
#cprSqPanel.show{display:block;animation:cprSqPop .15s ease-out}\
@keyframes cprSqPop{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}\
#cprSqPanel .hd{display:flex;align-items:center;gap:9px;background:#2D2D3B;color:#fff;padding:11px 14px}\
#cprSqPanel .hd b{font-family:Nunito,sans-serif;font-weight:800;font-size:.92rem}\
#cprSqPanel .hd .st{font-family:Nunito,sans-serif;font-weight:800;font-size:.66rem;background:rgba(255,255,255,.14);\
border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:3px 10px;cursor:pointer;color:#fff}\
#cprSqPanel .hd .x{margin-left:auto;background:none;border:none;color:#fff;font-size:1rem;cursor:pointer;opacity:.8;padding:2px 6px}\
#cprSqPanel .hd .x:hover{opacity:1}\
#cprSqPanel .tabs{display:flex;border-bottom:1px solid #E0E2EA}\
#cprSqPanel .tabs button{flex:1;border:none;background:#F7F7F9;padding:10px 4px;cursor:pointer;\
font-family:Nunito,sans-serif;font-weight:800;font-size:.76rem;color:#8A8FA3}\
#cprSqPanel .tabs button.on{background:#fff;color:#2D2D3B;box-shadow:inset 0 -2px 0 #DC282E}\
#cprSqPanel .tabs button:disabled{opacity:.45;cursor:default}\
#cprSqPanel .bd{padding:14px 16px 16px;max-height:min(560px,calc(100vh - 130px));overflow-y:auto}\
#cprSqPanel label{display:block;margin-bottom:10px}\
#cprSqPanel label span{display:block;font-family:Nunito,sans-serif;font-weight:800;font-size:.64rem;\
text-transform:uppercase;letter-spacing:.4px;color:#8A8FA3;margin-bottom:4px}\
#cprSqPanel input,#cprSqPanel textarea{width:100%;box-sizing:border-box;border:1.5px solid #E0E2EA;border-radius:10px;\
padding:9px 11px;font-family:"Nunito Sans",sans-serif;font-weight:700;font-size:.92rem;color:#2D2D3B;outline:none}\
#cprSqPanel input:focus,#cprSqPanel textarea:focus{border-color:#4FB0E3}\
#cprSqPanel #sqAmount{font-size:1.35rem;font-family:Nunito,sans-serif;font-weight:900;text-align:center}\
#cprSqPanel .dev{display:flex;align-items:center;gap:8px;border:1.5px solid #E0E2EA;border-radius:10px;\
padding:9px 11px;margin-bottom:7px;cursor:pointer;font-weight:700;font-size:.85rem}\
#cprSqPanel .dev.on{border-color:#4FB0E3;background:#EAF6FD}\
#cprSqPanel .go{width:100%;border:none;border-radius:11px;padding:12px;cursor:pointer;background:#DC282E;color:#fff;\
font-family:Nunito,sans-serif;font-weight:800;font-size:.95rem;margin-top:4px}\
#cprSqPanel .go:hover{background:#c31f24}#cprSqPanel .go:disabled{opacity:.5;cursor:default}\
#cprSqPanel .alt2{width:100%;border:1.5px solid #E0E2EA;background:#fff;border-radius:11px;padding:10px;cursor:pointer;\
font-family:Nunito,sans-serif;font-weight:800;font-size:.85rem;color:#2D2D3B;margin-top:8px}\
#cprSqPanel .status{border-radius:12px;padding:14px;text-align:center;font-family:Nunito,sans-serif;font-weight:800;margin-top:4px}\
#cprSqPanel .status.wait{background:#FBF1DC;color:#7A5B10}\
#cprSqPanel .status.ok{background:#E9F6EE;color:#1E9E5B}\
#cprSqPanel .status.err{background:#FBE9E9;color:#DC282E}\
#cprSqPanel .hint{font-size:.74rem;color:#8A8FA3;font-weight:700;margin-top:8px;line-height:1.4}\
#cprSqPanel .pickstore button{display:block;width:100%;text-align:left;border:1.5px solid #E0E2EA;background:#fff;\
border-radius:11px;padding:12px 14px;margin-bottom:8px;cursor:pointer;font-family:Nunito,sans-serif;font-weight:800;font-size:.92rem}\
#cprSqPanel .pickstore button:hover{border-color:#4FB0E3;background:#EAF6FD}\
#cprSqPanel .recent{border-top:1px solid #F0F1F4;margin-top:14px;padding-top:10px}\
#cprSqPanel .recent .r{display:flex;gap:8px;font-size:.76rem;font-weight:700;color:#6B6F80;padding:4px 0}\
#cprSqPanel .recent .r b{color:#2D2D3B}\
#cprSqPanel .recent .r .st2{margin-left:auto;font-family:Nunito,sans-serif;font-weight:800;font-size:.62rem;text-transform:uppercase}\
#cprSqCard{border:1.5px solid #E0E2EA;border-radius:10px;padding:10px;margin-bottom:10px}';
  document.head.appendChild(css);

  /* ---------------- panel skeleton ---------------- */
  var panel = document.createElement('div');
  panel.id = 'cprSqPanel';
  document.body.appendChild(panel);

  function draftLoad() { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}'); } catch (e) { return {}; } }
  function draftSave() {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        amount: (q('#sqAmount') || {}).value || '', ticket: (q('#sqTicket') || {}).value || '',
        note: (q('#sqNote') || {}).value || '', phone: (q('#sqPhone') || {}).value || '',
        name: (q('#sqName') || {}).value || '', store: S.store, tab: S.tab,
      }));
    } catch (e) { }
  }
  function dirty() {
    return !!(S.active || amountCents() > 0 || ((q('#sqTicket') || {}).value || '').trim());
  }

  function render() {
    var d = draftLoad();
    if (!S.store) {
      var opts = stores();
      if (opts.length === 1) S.store = opts[0];
      else { var cs = cachedStore(); if (cs && opts.indexOf(cs) > -1) S.store = cs; }
    }
    var hd = '<div class="hd"><b>Square · Backup Register</b>'
      + (S.store ? '<button class="st" id="sqStore" title="Switch store">' + esc(shortStore(S.store)) + ' ▾</button>' : '')
      + '<button class="x" id="sqClose" title="Close">✕</button></div>';

    if (!S.store) {
      panel.innerHTML = hd + '<div class="bd"><div style="font-family:Nunito,sans-serif;font-weight:800;margin-bottom:10px">Taking a payment for…</div>'
        + '<div class="pickstore">' + stores().map(function (s) { return '<button data-s="' + esc(s) + '">' + esc(shortStore(s)) + '</button>'; }).join('') + '</div></div>';
      wireCommon();
      panel.querySelectorAll('.pickstore button').forEach(function (b) {
        b.addEventListener('click', function () { S.store = b.getAttribute('data-s'); cacheStore(S.store); S.devices = null; render(); });
      });
      return;
    }

    var keyedReady = S.config && S.config.keyed_ready;
    panel.innerHTML = hd
      + '<div class="tabs">'
      + '<button data-tab="terminal" class="' + (S.tab === 'terminal' ? 'on' : '') + '">🖥 To Terminal</button>'
      + '<button data-tab="link" class="' + (S.tab === 'link' ? 'on' : '') + '">🔗 Payment Link</button>'
      + '<button data-tab="keyed" class="' + (S.tab === 'keyed' ? 'on' : '') + '" ' + (keyedReady ? '' : 'title="Needs the SQUARE_APP_ID secret — see hint inside"') + '>⌨ Key in Card</button>'
      + '</div><div class="bd">'
      + '<label><span>Amount</span><input id="sqAmount" inputmode="decimal" placeholder="$0.00" value="' + esc(d.amount || '') + '"></label>'
      + '<div style="display:flex;gap:10px"><label style="flex:1"><span>RepairQ ticket #</span><input id="sqTicket" placeholder="optional" value="' + esc(d.ticket || '') + '"></label>'
      + '<label style="flex:1"><span>Customer name</span><input id="sqName" placeholder="optional" value="' + esc(d.name || '') + '"></label></div>'
      + '<label><span>Note</span><input id="sqNote" placeholder="what’s this for?" value="' + esc(d.note || '') + '"></label>'
      + '<div id="sqMode"></div>'
      + '<div id="sqStatus"></div>'
      + '<div class="recent" id="sqRecent"></div>'
      + '</div>';
    wireCommon();
    panel.querySelectorAll('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () { S.tab = b.getAttribute('data-tab'); draftSave(); render(); });
    });
    ['sqAmount', 'sqTicket', 'sqName', 'sqNote'].forEach(function (id) {
      var el = q('#' + id); if (el) el.addEventListener('input', draftSave);
    });
    renderMode(d);
    renderRecent();
  }

  function wireCommon() {
    var x = q('#sqClose');
    if (x) x.addEventListener('click', function () {
      if (dirty() && !confirm('Close the Square panel? An amount is entered' + (S.active ? ' and a payment is in flight' : '') + '.')) return;
      close();
    });
    var st = q('#sqStore');
    if (st && stores().length > 1) st.addEventListener('click', function () {
      if (S.active) { alert('Finish or cancel the payment in flight first.'); return; }
      S.store = null; S.devices = null; S.deviceId = null;
      cacheStore(null); draftSave();
      render();
    });
  }

  /* ---------------- mode bodies ---------------- */
  function renderMode(d) {
    var m = q('#sqMode'); if (!m) return;
    if (S.tab === 'terminal') {
      m.innerHTML = '<div id="sqDevs" class="hint">Finding this store’s terminals…</div>'
        + '<button class="go" id="sqSend" disabled>Send to terminal</button>'
        + '<div class="hint">The charge pops up on the wedge — customer taps like a normal sale (card-present rates).</div>';
      q('#sqSend').addEventListener('click', terminalSend);
      loadDevices();
    } else if (S.tab === 'link') {
      m.innerHTML = '<label><span>Customer cell (to text the link)</span><input id="sqPhone" inputmode="tel" placeholder="541-555-0100" value="' + esc(d.phone || '') + '"></label>'
        + '<button class="go" id="sqLink">Create link' + ((d.phone || '').trim() ? ' & text it' : '') + '</button>'
        + '<div class="hint">The link is texted from ' + esc(shortStore(S.store)) + '’s own number. Leave the cell blank to just copy the link.</div>';
      var ph = q('#sqPhone'); ph.addEventListener('input', function () { draftSave(); q('#sqLink').textContent = ph.value.trim() ? 'Create link & text it' : 'Create link'; });
      q('#sqLink').addEventListener('click', linkCreate);
    } else {
      if (!(S.config && S.config.keyed_ready)) {
        m.innerHTML = '<div class="status wait">Keyed entry isn’t switched on yet</div>'
          + '<div class="hint">One-time setup: developer.squareup.com → our app → copy the <b>Application ID</b> → add it in Supabase as the <b>SQUARE_APP_ID</b> secret. This tab lights up on its own after that. (Keyed cards bill at Square’s card-not-present rate.)</div>';
      } else {
        m.innerHTML = '<div id="cprSqCard"></div><button class="go" id="sqCharge" disabled>Charge card</button>'
          + '<div class="hint">Card fields are Square’s own (we never see the number). Card-not-present rate applies — counter customers should use the terminal.</div>';
        mountCard();
      }
    }
  }

  /* ---------------- terminal flow ---------------- */
  function loadDevices() {
    if (S.devices) { paintDevices(); return; }
    call('devices', { store: S.store }).then(function (r) {
      if (!r.ok) { var el = q('#sqDevs'); if (el) el.innerHTML = '<div class="status err">' + esc(r.error || 'Could not list terminals') + '</div>'; return; }
      S.devices = r.devices || [];
      if (S.devices.length && !S.deviceId) S.deviceId = S.devices[0].device_id;
      S.cardLocation = r.location_id || null;
      paintDevices();
    });
  }
  function paintDevices() {
    var el = q('#sqDevs'); if (!el) return;
    if (!S.devices.length) { el.innerHTML = '<div class="status err">No Square Terminals found for ' + esc(shortStore(S.store)) + '</div>'; return; }
    el.innerHTML = S.devices.map(function (dv) {
      return '<div class="dev' + (dv.device_id === S.deviceId ? ' on' : '') + '" data-d="' + esc(dv.device_id) + '">🖥 ' + esc(dv.name) + '</div>';
    }).join('');
    el.querySelectorAll('.dev').forEach(function (o) {
      o.addEventListener('click', function () { S.deviceId = o.getAttribute('data-d'); paintDevices(); });
    });
    var send = q('#sqSend'); if (send) send.disabled = false;
  }
  function terminalSend() {
    var amt = amountCents();
    if (!amt) { status('err', 'Enter an amount first'); return; }
    if (!S.deviceId) { status('err', 'Pick a terminal'); return; }
    var btn = q('#sqSend'); btn.disabled = true;
    status('wait', 'Sending ' + dollars(amt) + ' to the terminal…');
    call('terminal_create', {
      store: S.store, amount_cents: amt, device_id: S.deviceId,
      device_name: (S.devices.find(function (x) { return x.device_id === S.deviceId; }) || {}).name,
      ticket_no: (q('#sqTicket') || {}).value, note: (q('#sqNote') || {}).value,
    }).then(function (r) {
      if (!r.ok) { btn.disabled = false; status('err', r.error || 'Send failed'); return; }
      S.active = { id: r.id, mode: 'terminal' };
      status('wait', '💳 On the terminal — waiting for the customer… <button class="alt2" id="sqCancel">Cancel on terminal</button>');
      var c = q('#sqCancel'); if (c) c.addEventListener('click', terminalCancel);
      poll();
    });
  }
  function terminalCancel() {
    if (!S.active) return;
    call('terminal_cancel', { id: S.active.id }).then(function () { stopPoll(); S.active = null; status('err', 'Canceled'); var b = q('#sqSend'); if (b) b.disabled = false; });
  }
  function poll() {
    stopPoll();
    S.pollTimer = setInterval(function () {
      if (!S.active) { stopPoll(); return; }
      call(S.active.mode === 'terminal' ? 'terminal_status' : 'link_status', { id: S.active.id }).then(function (r) {
        if (!r.ok) return;
        if (S.active && S.active.mode === 'terminal') {
          if (r.status === 'completed') { done('✅ Paid — ' + dollars(amountCents() || 0)); }
          else if (r.status === 'canceled') { stopPoll(); S.active = null; status('err', 'Canceled on the terminal' + (r.cancel_reason ? ' (' + esc(r.cancel_reason) + ')' : '')); var b = q('#sqSend'); if (b) b.disabled = false; }
        } else if (S.active && r.paid) { done('✅ Link paid'); }
      });
    }, 3000);
  }
  function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }
  function done(msg) {
    stopPoll(); S.active = null;
    status('ok', msg + ' <button class="alt2" id="sqAgain">Start another payment</button>');
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { }
    var a = q('#sqAgain'); if (a) a.addEventListener('click', function () { ['sqAmount', 'sqTicket', 'sqName', 'sqNote'].forEach(function (id) { var el = q('#' + id); if (el) el.value = ''; }); status('', ''); var b = q('#sqSend'); if (b) b.disabled = false; renderRecent(true); });
    renderRecent(true);
  }
  function status(kind, html) {
    var el = q('#sqStatus'); if (!el) return;
    el.innerHTML = html ? '<div class="status ' + kind + '">' + html + '</div>' : '';
  }

  /* ---------------- link flow ---------------- */
  function linkCreate() {
    var amt = amountCents();
    if (!amt) { status('err', 'Enter an amount first'); return; }
    var phone = ((q('#sqPhone') || {}).value || '').trim();
    var btn = q('#sqLink'); btn.disabled = true;
    status('wait', 'Creating the payment link…');
    call('link_create', {
      store: S.store, amount_cents: amt, ticket_no: (q('#sqTicket') || {}).value,
      note: (q('#sqNote') || {}).value, customer_name: (q('#sqName') || {}).value, customer_phone: phone || null,
    }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { status('err', r.error || 'Could not create the link'); return; }
      S.active = { id: r.id, mode: 'link' };
      var copyBtn = '<button class="alt2" id="sqCopy">Copy link</button>';
      if (phone) {
        var name = ((q('#sqName') || {}).value || '').trim().split(/\s+/)[0];
        var body = 'Hi' + (name ? ' ' + name : '') + ', here’s your secure payment link from ' + shortStore(S.store) + ' for ' + dollars(amt) + ': ' + r.url;
        sms({ to: phone, body: body, store: S.store, ticket_no: (q('#sqTicket') || {}).value, agent_name: window.CPRNavName || '' }).then(function (sr) {
          if (sr && sr.ok) status('ok', '🔗 Link texted to ' + esc(phone) + ' — watching for payment…' + copyBtn);
          else status('err', 'Link created but the text failed: ' + esc((sr && sr.error) || '') + copyBtn);
          wireCopy(r.url); poll();
        });
      } else {
        status('ok', '🔗 Link ready — watching for payment…' + copyBtn);
        wireCopy(r.url); poll();
      }
    });
  }
  function wireCopy(url) {
    var c = q('#sqCopy');
    if (c) c.addEventListener('click', function () { navigator.clipboard.writeText(url).then(function () { c.textContent = 'Copied ✓'; }); });
  }

  /* ---------------- keyed flow (Web Payments SDK) ---------------- */
  function mountCard() {
    function boot() {
      if (!S.cardLocation) {
        call('devices', { store: S.store }).then(function (r) { S.cardLocation = r.location_id || null; if (S.cardLocation) boot(); else status('err', 'No Square location for this store'); });
        return;
      }
      window.Square.payments(S.config.app_id, S.cardLocation).card().then(function (card) {
        S.card = card;
        return card.attach('#cprSqCard');
      }).then(function () {
        var b = q('#sqCharge'); if (b) { b.disabled = false; b.addEventListener('click', keyedCharge); }
      }).catch(function (e) { status('err', 'Card form failed: ' + esc(String(e && e.message || e))); });
    }
    if (window.Square) { boot(); return; }
    var s = document.createElement('script');
    s.src = 'https://web.squarecdn.com/v1/square.js';
    s.onload = boot;
    s.onerror = function () { status('err', 'Could not load Square’s card form'); };
    document.head.appendChild(s);
  }
  function keyedCharge() {
    var amt = amountCents();
    if (!amt) { status('err', 'Enter an amount first'); return; }
    var b = q('#sqCharge'); b.disabled = true;
    status('wait', 'Charging ' + dollars(amt) + '…');
    S.card.tokenize().then(function (res) {
      if (res.status !== 'OK') { b.disabled = false; status('err', 'Card not accepted'); return; }
      call('keyed_charge', {
        store: S.store, amount_cents: amt, source_id: res.token,
        ticket_no: (q('#sqTicket') || {}).value, note: (q('#sqNote') || {}).value,
        customer_name: (q('#sqName') || {}).value,
      }).then(function (r) {
        b.disabled = false;
        if (!r.ok) { status('err', r.error || 'Charge failed'); return; }
        done('✅ Charged ' + dollars(amt) + (r.receipt_url ? ' · <a href="' + esc(r.receipt_url) + '" target="_blank" style="color:inherit">receipt</a>' : ''));
      });
    });
  }

  /* ---------------- recent ---------------- */
  function renderRecent(force) {
    var el = q('#sqRecent'); if (!el) return;
    call('recent', { store: S.store }).then(function (r) {
      if (!r.ok || !(r.rows || []).length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div style="font-family:Nunito,sans-serif;font-weight:800;font-size:.66rem;text-transform:uppercase;letter-spacing:.4px;color:#8A8FA3;margin-bottom:4px">Recent</div>'
        + r.rows.slice(0, 5).map(function (p) {
          var col = p.status === 'completed' ? '#1E9E5B' : (p.status === 'failed' || p.status === 'canceled') ? '#DC282E' : '#C98A00';
          return '<div class="r"><b>' + dollars(p.amount_cents) + '</b>'
            + '<span>' + esc(p.mode) + (p.ticket_no ? ' · #' + esc(p.ticket_no) : '') + '</span>'
            + '<span class="st2" style="color:' + col + '">' + esc(p.status) + '</span></div>';
        }).join('');
    });
  }

  /* ---------------- open/close ---------------- */
  function open() {
    S.open = true;
    // re-check config on EVERY open — a freshly added SQUARE_APP_ID lights up
    // the keyed tab without needing a page refresh
    call('config').then(function (r) {
      var was = S.config && S.config.keyed_ready;
      S.config = r || {};
      if (S.open && S.config.keyed_ready !== was) render();
    });
    panel.classList.add('show');
    var b = document.querySelector('.cpr-tb-sq'); if (b) b.classList.add('open');
    // multi-store default: this tab's earlier pick > today's schedule > picker
    var opts = stores(), d = draftLoad();
    if (!S.store && opts.length > 1 && !(cachedStore() && opts.indexOf(cachedStore()) > -1)) {
      scheduledStoreToday().then(function (st) {
        if (S.store || !S.open || !st) return;
        var norm = window.CPRLocations ? window.CPRLocations.normalize : function (x) { return x; };
        var hit = opts.filter(function (o) { return norm(o) === norm(st); })[0];
        if (hit) { S.store = hit; render(); }
      });
    }
    render();
  }
  function close() {
    S.open = false; stopPoll();
    panel.classList.remove('show');
    var b = document.querySelector('.cpr-tb-sq'); if (b) b.classList.remove('open');
  }
  function toggle() { S.open ? close() : open(); }
  // deliberately NO outside-click dismissal — the panel is persistent by design

  window.CPRSquarePay = { open: open, close: close, toggle: toggle };
})();
