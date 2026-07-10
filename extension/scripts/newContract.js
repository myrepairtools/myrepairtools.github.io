/*
    New Contract (myRepairTools) — a native-styled button in RepairQ's ticket
    Transactions bar (view + edit) that opens the MRT contract-creation flow
    right inside RepairQ, pre-filled from the ticket. No trip back to MRT.

    The button sits left of the "Credit: Request Payment" group and mirrors
    RepairQ's own button, colors inverted. Clicking it opens a full-screen
    overlay that iframes contracts.html in embed mode (?embed=1); we scrape the
    ticket's customer/device/store and postMessage it in so step 1 is filled.

    Auth rides the myrepairtools.com Supabase session (sign in once per browser,
    same as the assistant overlay). Toggle: Options → Workflow tools → New Contract.
*/
(function () {
    'use strict';
    if (window.self !== window.top) return;
    if (!/\/ticket\/(view|edit)\//i.test(location.pathname)) return;

    var CONTRACT_URL = 'https://myrepairtools.com/contracts.html?embed=1';
    var overlay = null, iframe = null, ctx = null;

    try {
        chrome.storage.sync.get(['mcpr']).then(function (r) {
            var mcpr = (r && r.mcpr) || {};
            if (mcpr.newContract === false) return;   // default ON
            start();
        }).catch(start);
    } catch (e) { /* not in an extension context */ }

    function start() {
        if (document.body) inject();
        new MutationObserver(inject).observe(document.documentElement, { childList: true, subtree: true });
    }

    /* ---- inject the button into the Transactions bar ---- */
    function inject() {
        if (document.getElementById('mrt-new-contract')) return;
        var rp = document.getElementById('BtnRequestPayment');
        if (!rp || !rp.parentElement) return;
        var bar = rp.parentElement;                 // .form-inline holding "Credit:" + Request Payment
        var a = document.createElement('a');
        a.id = 'mrt-new-contract';
        a.className = 'transaction-buttons btn mrt-nc-btn';
        a.href = '#';
        a.innerHTML = '<i class="icon-file"></i> New Contract';
        a.addEventListener('click', function (e) { e.preventDefault(); openOverlay(); });
        bar.insertBefore(a, bar.firstChild);        // left of the whole Credit group
    }

    /* ---- scrape ticket context for the pre-fill ---- */
    function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    function scrape() {
        var c = {};
        var m = location.pathname.match(/\/ticket\/(?:view|edit)\/(\d+)/);
        if (m) c.ticket = m[1];                     // RepairQ ticket #

        // edit page: customer fields are form inputs
        var fn = document.getElementById('Customer_first_name');
        var ln = document.getElementById('Customer_last_name');
        if (fn && fn.value) c.name = (fn.value + ' ' + ((ln && ln.value) || '')).trim();
        var em = document.getElementById('Customer_email');
        if (em && em.value) c.email = em.value.trim();
        var ph = document.getElementById('Customer_pri_phone') || document.getElementById('Customer_alt_phone');
        if (ph && ph.value) c.phone = ph.value.trim();

        // view page: the customer summary is a <dl>
        if (!c.name || !c.phone || !c.email) {
            document.querySelectorAll('dt').forEach(function (dt) {
                var label = txt(dt).toLowerCase(), dd = dt.nextElementSibling;
                if (!dd) return;
                var val = txt(dd);
                if (!c.name && /customer name|^name$/.test(label)) c.name = val;
                if (!c.phone && /(contact number|phone|mobile|cell)/.test(label)) c.phone = (val.split(/[,/|]/)[0] || '').trim();
                if (!c.email && /email/.test(label) && val.indexOf('@') > -1) c.email = val;
            });
        }
        if (!c.email) { var ml = document.querySelector('a[href^="mailto:"]'); if (ml) c.email = ml.getAttribute('href').replace(/^mailto:/i, '').split('?')[0].trim(); }

        // device — the ticket's device name
        var dev = document.querySelector('.device-name');
        if (dev) c.device = txt(dev);

        // store — the top-bar location switcher
        var loc = document.querySelector('.location.tooltip-toggle span');
        if (loc) c.store = txt(loc);
        return c;
    }

    /* ---- the overlay iframe ---- */
    function openOverlay() {
        ctx = scrape();
        if (overlay) { overlay.style.display = 'flex'; postCtx(); return; }
        overlay = document.createElement('div');
        overlay.className = 'mrt-nc-ov';
        overlay.innerHTML =
            '<div class="mrt-nc-panel">' +
              '<div class="mrt-nc-hd"><span>📄 New Contract' +
                (ctx && ctx.ticket ? ' · ticket ' + ctx.ticket : '') +
              '</span><button class="mrt-nc-x" title="Close">✕</button></div>' +
              '<div class="mrt-nc-frame"></div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.querySelector('.mrt-nc-x').onclick = closeOverlay;
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlay(); });
        iframe = document.createElement('iframe');
        iframe.className = 'mrt-nc-iframe';
        iframe.title = 'New Contract';
        iframe.src = CONTRACT_URL;
        iframe.addEventListener('load', postCtx);
        overlay.querySelector('.mrt-nc-frame').appendChild(iframe);
    }
    function postCtx() {
        if (!iframe || !iframe.contentWindow || !ctx) return;
        try { iframe.contentWindow.postMessage({ type: 'mrt-contract-ctx', ctx: ctx }, '*'); } catch (e) { /* iframe gone */ }
    }
    function closeOverlay() { if (overlay) overlay.style.display = 'none'; }

    // the embed page signals when it's ready — (re)send context then, reliably
    window.addEventListener('message', function (ev) {
        if (ev && ev.data && ev.data.type === 'mrt-contract-ready') postCtx();
    });

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && overlay.style.display !== 'none') closeOverlay(); });
})();
