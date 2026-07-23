/*
    Hyla Auto-Offer (myRepairTools)

    Runs on: buy.hylamobile.com (Assurant / Hyla stock list)

    Clicking "Offer" on a stock-list item opens the cart modal with the
    offer price defaulted to the full list price. Hyla reliably accepts
    ~5% under list, so this pre-fills the offer at 95% of the list price,
    rounded UP to the next whole dollar (e.g. $143 list → $136 offer).

    Only a FRESH offer is filled — the modal's default equals the list
    price only when no offer exists yet, and we double-check the input
    against the "Price: $N" shown in the modal. Re-opening an offer
    already in the cart keeps whatever price was offered. The site's
    +/- steppers still work on top of the filled value.

    Toggle + percent live in Options → Hyla Stock List
    (storage.sync hyla { offerFill: true, pct: 95 }).
*/

(function () {
    'use strict';

    var cfg = { offerFill: true, pct: 95 };

    function loadCfg(cb) {
        try {
            chrome.storage.sync.get(['hyla'], function (r) {
                var h = (r && r.hyla) || {};
                cfg.offerFill = h.offerFill !== false;
                var p = Number(h.pct);
                cfg.pct = (p >= 50 && p <= 100) ? p : 95;
                if (cb) cb();
            });
        } catch (e) { if (cb) cb(); }
    }

    function parsePrice(text) {
        var m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(text || '');
        return m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
    }

    // The offer input lives in the cart modal body (.cart-item), which also
    // shows "Price: $143" in a .px-item-price-container — read it there.
    function listPriceFor(input) {
        var scope = input.closest('.cart-item') || input.closest('.modal-content');
        if (!scope) return NaN;
        var els = scope.querySelectorAll('.px-item-price-container');
        for (var i = 0; i < els.length; i++) {
            var p = parsePrice(els[i].textContent);
            if (!isNaN(p) && p > 0) return p;
        }
        return NaN;
    }

    function addNote(input, list, offer) {
        var host = input.closest('.offer-price-inputs-with-increment') || input.parentElement;
        if (!host || host.querySelector('.mrt-offer-note')) return;
        var n = document.createElement('div');
        n.className = 'mrt-offer-note';
        n.textContent = '✨ ' + cfg.pct + '% of $' + list + ' → $' + offer;
        n.title = 'Auto-Offer (myRepairTools) — adjust with the +/- buttons if needed';
        n.style.cssText = 'font-size:11px;font-weight:600;color:#0070B9;margin-top:3px;white-space:nowrap;';
        host.appendChild(n);
    }

    function fill(input) {
        if (input.getAttribute('data-mrt-offer')) return;
        input.setAttribute('data-mrt-offer', '1');

        var list = listPriceFor(input);
        if (isNaN(list)) return;

        // An offer already in the cart re-opens with the previously offered
        // price; only a fresh offer's default still equals the list price.
        var current = parseFloat(input.value);
        if (isNaN(current) || Math.round(current) !== Math.round(list)) return;

        var offer = Math.ceil(list * (cfg.pct / 100));
        if (offer >= list || offer < 1) return;

        input.value = String(offer);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        addNote(input, list, offer);
    }

    function scan() {
        if (!cfg.offerFill) return;
        document.querySelectorAll('input[name="offer-price"]').forEach(fill);
    }

    // The modal is re-rendered on every open — debounce the observer so a
    // burst of mutations triggers one pass.
    var timer = null;
    function schedule() { clearTimeout(timer); timer = setTimeout(scan, 150); }

    loadCfg(function () {
        scan();
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    });

    try {
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area === 'sync' && ch.hyla) loadCfg();
        });
    } catch (e) { /* storage unavailable — defaults stand */ }
})();
