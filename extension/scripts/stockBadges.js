/*
    Stock Badges (myRepairTools)

    Runs on: mobilesentrix.com, cpr.parts

    Both supplier sites carry the on-hand quantity in a hidden
    input.productqty inside each product tile — techs had to view source to
    see it. This paints the number as a colored badge on the tile:
    red = out of stock, orange = 1-2 left, green = plenty.

    Ported from the MyCPRTools extension. Toggle: Options → RepairQ workflow
    tools (storage.sync mcpr.stockBadges, default ON).
*/

(function () {
    'use strict';

    var BADGE_CLASS = 'mrt-stock-badge';

    function getStockValue(itemEl) {
        try {
            // cpr.parts and MobileSentrix both keep the qty in input.productqty
            var input = itemEl.querySelector('input.productqty');
            return (input && input.value != null) ? input.value : '0';
        } catch (e) {
            return '0';
        }
    }

    function getBadgeColor(qty) {
        var n = parseInt(qty, 10);
        if (isNaN(n) || n === 0) return '#e74c3c'; // red
        if (n <= 2)              return '#e67e22'; // orange
        return '#27ae60';                          // green
    }

    // Cart drawer / checkout reuse li.item — a "0" badge over cart rows is
    // noise (their thumbnails carry no stock data). Catalog tiles never sit
    // inside a cart-ish ancestor, so walk up and bail.
    function inCartUi(el) {
        for (var n = el; n && n !== document.body; n = n.parentElement) {
            var s = ((typeof n.className === 'string' ? n.className : '') + ' ' + (n.id || '')).toLowerCase();
            if (s.indexOf('cart') > -1 || s.indexOf('checkout') > -1) return true;
        }
        return false;
    }

    function addStockBadges() {
        if (/checkout|cart/i.test(location.pathname)) return;
        document.querySelectorAll('li.item').forEach(function (item) {
            if (item.querySelector('.' + BADGE_CLASS)) return;
            if (inCartUi(item)) return;

            var qty = getStockValue(item);
            var badge = document.createElement('span');
            badge.className = BADGE_CLASS;
            badge.textContent = qty;

            Object.assign(badge.style, {
                position:        'absolute',
                top:             '5px',
                right:           '5px',
                backgroundColor: getBadgeColor(qty),
                color:           'white',
                fontSize:        '12px',
                padding:         '4px 7px',
                borderRadius:    '50%',
                fontWeight:      'bold',
                zIndex:          '10',
                display:         'inline-block',
                lineHeight:      '1',
                textAlign:       'center',
                minWidth:        '20px',
                pointerEvents:   'none',
            });

            if (window.getComputedStyle(item).position === 'static') {
                item.style.position = 'relative';
            }

            item.appendChild(badge);
        });
    }

    function start() {
        addStockBadges();

        // Re-run as new items load via infinite scroll — the sites toggle
        // #listingloader's style when a batch of tiles lands
        var listingLoader = document.querySelector('#listingloader');
        if (listingLoader) {
            new MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i++) {
                    if (mutations[i].type === 'attributes' && mutations[i].attributeName === 'style') {
                        addStockBadges();
                    }
                }
            }).observe(listingLoader, { attributes: true, attributeFilter: ['style'] });
        }

        // Also catch any li.item injected anywhere. Debounced — a heavy Magento
        // page fires a flood of subtree mutations during load, and running a
        // full rescan on each one (×3 supplier scripts) locks the main thread
        // ("page unresponsive"). Coalesce a burst into one rescan.
        var sbT = null;
        function scheduleSB() { if (sbT) return; sbT = setTimeout(function () { sbT = null; addStockBadges(); }, 500); }
        new MutationObserver(scheduleSB).observe(document.body, { childList: true, subtree: true });
    }

    // Standalone gate (mcprUtils.js is not loaded on supplier sites)
    try {
        chrome.storage.sync.get(['mcpr']).then(function (res) {
            var m = (res && res.mcpr) || {};
            if (m.stockBadges === false) return;
            start();
        }).catch(start);
    } catch (e) { start(); }
})();
