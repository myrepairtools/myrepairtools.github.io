/*
    CPR Assistant overlay (myRepairTools)

    Puts the company AI assistant INSIDE RepairQ: a ✨ button that slides up an
    iframe of myrepairtools.com/assistant.html (which hosts the same chat
    widget the MRT site uses — Knowledge Base answers with citations, customer
    replies, panic logs). Auth rides the MRT origin's Supabase session, so a
    tech who has signed into myRepairTools once on this browser is signed in
    here too.

    When the panel opens we scrape light context from the RepairQ page —
    ticket #, store, tech, device line items — and postMessage it into the
    iframe, so "how do I fix this?" already knows what "this" is.
*/
(function () {
    'use strict';

    // Canonical custom domain. The old github.io URL now 301s here and can land
    // on http://, which HTTPS RepairQ blocks as mixed content → blank iframe.
    var EMBED_URL = 'https://myrepairtools.com/assistant.html';
    var panel = null, iframe = null, fab = null, loaded = false;

    /* ---------- context scraping (best effort, all optional) ---------- */

    function ticketNo() {
        var m = location.pathname.match(/\/ticket\/(?:view|edit|printLabel|printInvoice)\/(\d+)/);
        return m ? m[1] : null;
    }
    function techName() {
        var el = document.getElementById('user_dropdown');
        if (!el) return '';
        var raw = el.textContent.replace(/\s+/g, ' ').trim();
        var m = raw.match(/^([^,]+),\s*(.+)$/);
        return m ? (m[2] + ' ' + m[1]).trim() : raw;
    }
    function storeName() {
        var t = document.querySelector('.location.tooltip-toggle span');
        if (t && t.textContent.trim()) return t.textContent.trim();
        var pin = document.querySelector('.icon-map-marker');
        if (pin && pin.parentElement) return pin.parentElement.textContent.replace(/\s+/g, ' ').trim();
        return '';
    }
    function ticketItems() {
        var names = [];
        document.querySelectorAll('tr.ticket-item-row td.catalog-item-col').forEach(function (cell) {
            var clone = cell.cloneNode(true);
            clone.querySelectorAll('.modal, a, em, input, select, script').forEach(function (n) { n.remove(); });
            var t = clone.textContent.replace(/\s+/g, ' ').trim();
            if (t) names.push(t);
        });
        return names.slice(0, 4);
    }
    function buildContext() {
        var bits = [];
        var tn = ticketNo();     if (tn) bits.push('ticket #' + tn);
        var st = storeName();    if (st) bits.push(st);
        var tech = techName();   if (tech) bits.push('tech: ' + tech);
        var items = ticketItems();
        if (items.length) bits.push('items: ' + items.join('; '));
        else {
            var path = location.pathname.replace(/^\//, '');
            if (path && path !== 'ticket') bits.push('page: ' + path.split('?')[0]);
        }
        return bits.join(' · ');
    }
    function sendContext() {
        if (!iframe || !loaded) return;
        var ctx = buildContext();
        if (!ctx) return;
        try { iframe.contentWindow.postMessage({ type: 'cpr-ctx', text: ctx }, '*'); } catch (e) { /* iframe gone */ }
    }

    /* ---------- UI ---------- */

    function build() {
        fab = document.createElement('button');
        fab.className = 'mrt-ai-fab';
        fab.title = 'CPR Assistant — ask the Knowledge Base';
        fab.setAttribute('aria-label', 'Open CPR Assistant');
        fab.textContent = '✨';
        fab.addEventListener('click', toggle);
        document.body.appendChild(fab);

        panel = document.createElement('div');
        panel.className = 'mrt-ai-panel';
        panel.innerHTML =
            '<div class="mrt-ai-hd">' +
              '<span class="mrt-ai-logo">✨ CPR Assistant</span>' +
              '<span class="mrt-ai-sub">answers from the Knowledge Base</span>' +
              '<button class="mrt-ai-x" title="Close" aria-label="Close">✕</button>' +
            '</div>' +
            '<div class="mrt-ai-frame"></div>';
        panel.querySelector('.mrt-ai-x').addEventListener('click', close);
        document.body.appendChild(panel);

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && panel.classList.contains('open')) close();
        });
    }

    function ensureIframe() {
        if (iframe) return;
        iframe = document.createElement('iframe');
        iframe.className = 'mrt-ai-iframe';
        iframe.title = 'CPR Assistant';
        iframe.src = EMBED_URL;
        iframe.addEventListener('load', function () { loaded = true; sendContext(); });
        panel.querySelector('.mrt-ai-frame').appendChild(iframe);
    }

    function open() {
        ensureIframe();
        panel.classList.add('open');
        fab.classList.add('hide');
        sendContext();               // refresh context on every open (page may have changed)
    }
    function close() {
        panel.classList.remove('open');
        fab.classList.remove('hide');
    }
    function toggle() { panel.classList.contains('open') ? close() : open(); }

    /* ---------- boot (Options → AI Assistant toggle) ---------- */

    // Never on print pages (printLabel / printInvoice / any /ticket/print*):
    // a fixed FAB there prints on top of the label or invoice.
    if (/\/ticket\/print/i.test(location.pathname)) return;
    // …and never on the login screen — nobody is signed in to assist.
    if (/\/site\/login/i.test(location.pathname)) return;

    function start() {
        if (document.body && document.body.classList.contains('login')) return;
        if (document.body) build();
        else document.addEventListener('DOMContentLoaded', build);
    }
    try {
        chrome.storage.sync.get(['ai']).then(function (res) {
            if (res && res.ai && res.ai.enabled === false) return;
            start();
        }).catch(start);
    } catch (e) { start(); }
})();
