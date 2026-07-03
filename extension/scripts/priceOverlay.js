/*
    Price Overlay (myRepairTools)

    Runs on: mobilesentrix.com, cpr.parts

    Puts the customer quote right on the supplier catalog: for every product
    tile it reads the part price and shows what we'd charge —

        Repair  = part + $100 labor, fee-loaded, CPR-rounded
        Add-on  = tiered markup (2× / 1.5× / +$25), fee-loaded

    The math is copied from the Price Calculator popup (popup/popup.js) —
    keep the two in sync if pricing rules ever change. The add-on figure is
    a standalone approximation: on a real ticket the calculator spreads the
    rounding remainder across lines, so pennies can differ.

    Toggle: Options → RepairQ workflow tools (storage.sync mcpr.priceOverlay,
    default ON).
*/

(function () {
    'use strict';

    var STRIP_CLASS = 'mrt-price-strip';
    var CC_FEE = 1.0186, ROYALTY = 1.058;

    /* ---------- pricing (mirror of popup/popup.js) ---------- */

    function cprRound(n) {
        if (n <= 0) return 0;
        var lower = Math.floor(n / 5) * 5 - 0.01;
        if (lower >= n) lower -= 5;
        var upper = lower + 5;
        return (n - lower < upper - n) ? lower : upper;
    }

    function applyMarkup(cost) {
        if (cost <= 0)  return 0;
        if (cost <= 20) return Math.max(cost * 2, 20);
        if (cost < 50)  return Math.max(cost * 1.5, 40);
        return Math.max(cost + 25, 73.50);
    }

    function repairPrice(cost) {
        return cprRound((cost + 100) * CC_FEE * ROYALTY);
    }

    function addonPrice(cost) {
        return applyMarkup(cost) * CC_FEE * ROYALTY;
    }

    function fmt(n) {
        return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /* ---------- tile price extraction (defensive) ---------- */

    function parsePrice(text) {
        var m = String(text || '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
        return m ? parseFloat(m[1]) : 0;
    }

    function tilePrice(item) {
        // sale price wins when present
        var sp = item.querySelector('.special-price .price');
        if (sp) {
            var v = parsePrice(sp.textContent);
            if (v > 0) return v;
        }
        // any .price that isn't the crossed-out old price
        var cands = item.querySelectorAll('.price-box .price, .price');
        for (var i = 0; i < cands.length; i++) {
            if (cands[i].closest && cands[i].closest('.old-price')) continue;
            var p = parsePrice(cands[i].textContent);
            if (p > 0) return p;
        }
        // Magento 2 keeps the number in a data attribute
        var da = item.querySelector('[data-price-amount]');
        if (da) {
            var d = parseFloat(da.getAttribute('data-price-amount'));
            if (d > 0) return d;
        }
        return 0;
    }

    /* ---------- overlay ---------- */

    function stripFor(cost) {
        var strip = document.createElement('div');
        strip.className = STRIP_CLASS;
        strip.title = 'What we’d charge for a ' + fmt(cost) + ' part — Price Calculator rules';

        Object.assign(strip.style, {
            display:        'flex',
            /* margin-top:auto pins the strip to the card's bottom cluster
               (flex-column cards), so a 1-line vs 2-line title no longer
               moves it; in non-flex layouts it behaves like margin-top:0 */
            margin:         'auto 0 10px',
            padding:        '5px 6px',
            background:     '#2D2D3B',
            color:          '#fff',
            borderRadius:   '7px',
            lineHeight:     '1.25',
            textAlign:      'center',
        });

        // Fixed two-column, label-over-price layout — identical at every
        // tile width (never collapses to one line or wraps unevenly)
        function col(icon, label, price) {
            return '<span style="flex:1 1 0;min-width:0;display:flex;flex-direction:column">' +
                '<span style="font-size:10.5px;color:#B9BDCB;white-space:nowrap">' + icon + ' ' + label + '</span>' +
                '<span style="font-size:12.5px;font-weight:bold;white-space:nowrap">' + price + '</span>' +
            '</span>';
        }
        strip.innerHTML =
            col('🔧', 'Repair', fmt(repairPrice(cost))) +
            col('➕', 'Add-on', fmt(addonPrice(cost)));
        return strip;
    }

    function addPriceStrips() {
        document.querySelectorAll('li.item').forEach(function (item) {
            if (item.querySelector('.' + STRIP_CLASS)) return;

            var cost = tilePrice(item);
            if (!(cost > 0)) return;   // no readable price — stay silent

            // Sit the strip right under the price/qty block when there is
            // one, else at the end of the tile
            var anchor = item.querySelector('div.price-qty-block, .price-box');
            if (anchor && anchor.parentElement) {
                anchor.parentElement.insertBefore(stripFor(cost), anchor.nextSibling);
            } else {
                item.appendChild(stripFor(cost));
            }
        });
    }

    function start() {
        addPriceStrips();

        // Same re-run hooks as Stock Badges: the infinite-scroll loader...
        var listingLoader = document.querySelector('#listingloader');
        if (listingLoader) {
            new MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i++) {
                    if (mutations[i].type === 'attributes' && mutations[i].attributeName === 'style') {
                        addPriceStrips();
                    }
                }
            }).observe(listingLoader, { attributes: true, attributeFilter: ['style'] });
        }

        // ...and any li.item injected anywhere
        new MutationObserver(addPriceStrips).observe(document.body, { childList: true, subtree: true });
    }

    // Standalone gate (mcprUtils.js is not loaded on supplier sites)
    try {
        chrome.storage.sync.get(['mcpr']).then(function (res) {
            var m = (res && res.mcpr) || {};
            if (m.priceOverlay === false) return;
            start();
        }).catch(start);
    } catch (e) { start(); }
})();
