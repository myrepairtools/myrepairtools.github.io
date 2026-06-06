/* ===========================================================================
 * CPR site-gate.js — site-wide front-door password.
 * ---------------------------------------------------------------------------
 * Put on EVERY page (operations AND admin), as early as possible:
 *   <script src="assets/site-gate.js"></script>
 *
 * - Asks for one shared site password the first time someone visits on a
 *   device. On success it sets a localStorage flag that persists FOREVER
 *   (until the browser data is cleared or the password is changed).
 * - The password is verified by the CPR Auth service and is never stored in
 *   this file or in the browser — only a "unlocked" flag is cached.
 * - This is a deterrent against casual/random access on public hosting, not
 *   hardened security. Admin tools keep their own per-person gate on top.
 *
 * To change the password: edit the `sitePassword` row in the CPR Auth sheet's
 * Config tab. Changing it forces everyone to re-enter on their next visit.
 * ========================================================================= */
(function () {
  'use strict';

  // Don't gate inside an iframe (e.g., embedded in RepairQ)
  if (window.self !== window.top) return;

  var AUTH_URL  = 'https://script.google.com/macros/s/AKfycbwdMg4UB4W8tsRqAK9a5qJZpkcw6-8fVy926WRZwsyf3-KYHNRN0R7q4GtA7PjpXkNYRQ/exec';
  var API_TOKEN = '1b22aae72481896270d294fd8ef8e6319b55002edcd8e90b5348407b0f0caad5';
  var KEY = 'cpr_site_unlocked';

  function unlocked(){ try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function markUnlocked(){ try { localStorage.setItem(KEY, '1'); } catch (e) {} }

  var overlay = null;
  function buildOverlay(){
    var o = document.createElement('div');
    o.id = 'cpr-site-gate';
    o.innerHTML =
      '<div class="csg-box">' +
        '<div class="csg-ic">&#128272;</div>' +
        '<div class="csg-title">CPR Tools</div>' +
        '<div class="csg-sub">Enter the access password</div>' +
        '<input id="csg-pw" type="password" autocomplete="off" placeholder="Password" />' +
        '<button id="csg-go" type="button">Enter</button>' +
        '<div class="csg-err" id="csg-err"></div>' +
      '</div>';
    var css = document.createElement('style');
    css.textContent =
      '#cpr-site-gate{position:fixed;inset:0;background:#2D2D3B;z-index:2147483600;display:flex;align-items:center;justify-content:center;font-family:Nunito,system-ui,sans-serif}' +
      '#cpr-site-gate .csg-box{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:34px 38px;width:100%;max-width:340px;text-align:center}' +
      '#cpr-site-gate .csg-ic{font-size:30px;margin-bottom:14px}' +
      '#cpr-site-gate .csg-title{font-weight:900;font-size:19px;color:#fff;margin-bottom:4px}' +
      '#cpr-site-gate .csg-sub{font-size:12px;color:rgba(255,255,255,.45);font-weight:600;margin-bottom:22px}' +
      '#cpr-site-gate input{width:100%;background:rgba(255,255,255,.08);border:1.5px solid rgba(255,255,255,.16);border-radius:8px;padding:13px 14px;font-size:16px;color:#fff;margin-bottom:12px;font-family:inherit}' +
      '#cpr-site-gate input:focus{outline:none;border-color:#DC282E}' +
      '#cpr-site-gate button{width:100%;background:#DC282E;border:none;border-radius:8px;padding:13px;font-weight:800;font-size:15px;color:#fff;cursor:pointer;font-family:inherit}' +
      '#cpr-site-gate button:hover{background:#F15F5E}' +
      '#cpr-site-gate .csg-err{color:#ef4444;font-size:12px;font-weight:700;min-height:16px;margin-top:10px}';
    document.head.appendChild(css);
    document.body.appendChild(o);

    var input = o.querySelector('#csg-pw');
    var go = o.querySelector('#csg-go');
    var err = o.querySelector('#csg-err');
    function attempt(){
      var pw = input.value;
      if (!pw) return;
      go.disabled = true; err.textContent = 'Checking…';
      fetch(AUTH_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
        body: JSON.stringify({ action:'siteLogin', token:API_TOKEN, password:pw }) })
        .then(function(r){ return r.json(); })
        .then(function(res){
          go.disabled = false;
          if (res && res.ok){ markUnlocked(); removeOverlay(); }
          else { input.value=''; err.textContent = (res && res.error) || 'Incorrect password'; setTimeout(function(){ err.textContent=''; }, 2200); }
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

  function init(){ if (!unlocked()) showOverlay(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
