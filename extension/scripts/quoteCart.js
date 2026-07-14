/*
    Quote Builder cart (myRepairTools)

    Runs on: mobilesentrix.com, cpr.parts

    A real-time quote cart for a multi-part repair. Each catalog tile gets a
    "＋ Quote" button; picked parts collect into a floating cart (top-right,
    fixed so it follows the page) that totals what we'd charge the customer as
    you shop:

        - the priciest part in the cart is billed as the Repair (part + $100
          labor, fee-loaded, CPR-rounded) — the tech can re-pick which line is
          the Repair with the ☆
        - every other part is an Add-on (tiered markup, fee-loaded)
        - Total updates live; 📋 copies the quote

    Prices come from the supplier page; the model (franchise vs CAP) comes from
    Options (mcpr.priceModel). Pricing math mirrors priceOverlay.js /
    popup/popup.js — keep the three in sync. Cart state persists in
    chrome.storage.local so it survives navigating between product pages.

    Toggle: Options → MobileSentrix Tools (storage.sync mcpr.quoteCart, default ON).
*/

(function () {
    'use strict';

    var STORE_KEY = 'mrt_quote_cart';
    var BTN_CLASS = 'mrt-qc-btn';
    var CC_FEE = 1.0186, ROYALTY = 1.058;   // ROYALTY→1 for CAP (set at boot)

    /* ---------- pricing (mirror of priceOverlay.js / popup.js) ---------- */

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
    function capRoundUp(n) {
        if (n <= 0) return 0;
        return Math.ceil((n + 0.01) / 5) * 5 - 0.01;
    }
    function repairPrice(cost) {
        var loaded = (cost + 100) * CC_FEE * ROYALTY;
        return ROYALTY === 1 ? capRoundUp(loaded) : cprRound(loaded);
    }
    function addonPrice(cost) {
        return applyMarkup(cost) * CC_FEE * ROYALTY;
    }
    function fmt(n) {
        return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    /* ---------- tile extraction ---------- */

    function parsePrice(text) {
        var m = String(text || '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
        return m ? parseFloat(m[1]) : 0;
    }
    function tilePrice(item) {
        var sp = item.querySelector('.special-price .price');
        if (sp) { var v = parsePrice(sp.textContent); if (v > 0) return v; }
        var cands = item.querySelectorAll('.price-box .price, .price');
        for (var i = 0; i < cands.length; i++) {
            if (cands[i].closest && cands[i].closest('.old-price')) continue;
            var p = parsePrice(cands[i].textContent);
            if (p > 0) return p;
        }
        var da = item.querySelector('[data-price-amount]');
        if (da) { var d = parseFloat(da.getAttribute('data-price-amount')); if (d > 0) return d; }
        return 0;
    }
    function tileName(item) {
        var el = item.querySelector('.product-item-link, .product-item-name a, .product-name a, h2 a, .name a, .product-item-name, .product-name');
        var t = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        if (t) return t;
        var img = item.querySelector('img[alt]');
        return img ? img.getAttribute('alt').replace(/\s+/g, ' ').trim() : 'Part';
    }
    function tileKey(item, name, cost) {
        var a = item.querySelector('a[href]');
        var href = a ? (a.getAttribute('href') || '') : '';
        var sku = item.getAttribute('data-product-id') ||
                  (item.querySelector('[data-product-id]') && item.querySelector('[data-product-id]').getAttribute('data-product-id')) ||
                  (href.match(/\/([^\/?#]+)(?:\.html)?(?:[?#]|$)/) || [])[1] || '';
        return (sku || name).toLowerCase() + '|' + cost;
    }
    function inCartUi(el) {
        for (var n = el; n && n !== document.body; n = n.parentElement) {
            var s = ((typeof n.className === 'string' ? n.className : '') + ' ' + (n.id || '')).toLowerCase();
            if (s.indexOf('cart') > -1 || s.indexOf('checkout') > -1) return true;
        }
        return false;
    }

    /* ---------- state (chrome.storage.local) ---------- */

    var STATE = { items: [], primary: null, collapsed: false };

    function loadState() {
        return new Promise(function (res) {
            try {
                chrome.storage.local.get([STORE_KEY], function (r) {
                    var s = r && r[STORE_KEY];
                    if (s && Array.isArray(s.items)) STATE = { items: s.items, primary: s.primary || null, collapsed: !!s.collapsed };
                    res();
                });
            } catch (e) { res(); }
        });
    }
    function saveState() {
        try { chrome.storage.local.set({ [STORE_KEY]: STATE }); } catch (e) {}
    }
    function hasItem(key) { return STATE.items.some(function (i) { return i.key === key; }); }
    function addItem(it) { if (!hasItem(it.key)) { STATE.items.push(it); saveState(); render(); } }
    function removeItem(key) {
        STATE.items = STATE.items.filter(function (i) { return i.key !== key; });
        if (STATE.primary === key) STATE.primary = null;
        saveState(); render();
    }
    function clearCart() { STATE.items = []; STATE.primary = null; saveState(); render(); }

    function primaryKey() {
        if (!STATE.items.length) return null;
        if (STATE.primary && hasItem(STATE.primary)) return STATE.primary;
        // default: priciest part is the Repair
        return STATE.items.reduce(function (best, i) {
            return (!best || i.cost > best.cost) ? i : best;
        }, null).key;
    }

    /* ---------- per-tile "＋ Quote" button ---------- */

    function addButtons() {
        if (/checkout|cart/i.test(location.pathname)) return;
        document.querySelectorAll('li.item').forEach(function (item) {
            if (inCartUi(item)) return;
            // Cheap early-out: a tile we've already tagged just needs its state
            // refreshed — skip the (relatively costly) name/price/key recompute.
            var existing = item.querySelector('.' + BTN_CLASS);
            if (existing) { reflectBtn(existing, existing.getAttribute('data-key')); return; }

            var cost = tilePrice(item);
            if (!(cost > 0)) return;
            var name = tileName(item);
            var key = tileKey(item, name, cost);

            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = BTN_CLASS;
            btn.setAttribute('data-key', key);
            Object.assign(btn.style, {
                display: 'block', width: '100%', margin: '6px 0 10px', padding: '5px 8px',
                border: '1px solid #4FB0E3', borderRadius: '7px', background: '#fff',
                color: '#2D2D3B', font: '600 12px/1.2 "Nunito Sans", system-ui, sans-serif',
                cursor: 'pointer', textAlign: 'center',
            });
            btn.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                if (hasItem(key)) removeItem(key);
                else addItem({ key: key, name: name, cost: cost });
                reflectBtn(btn, key);
            });
            reflectBtn(btn, key);

            var anchor = item.querySelector('div.price-qty-block, .price-box');
            if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(btn, anchor.nextSibling);
            else item.appendChild(btn);
        });
    }
    function reflectBtn(btn, key) {
        var inC = hasItem(key);
        btn.textContent = inC ? '✓ In quote' : '＋ Quote';
        btn.style.background = inC ? '#4FB0E3' : '#fff';
        btn.style.color = inC ? '#fff' : '#2D2D3B';
    }
    function reflectAllButtons() {
        document.querySelectorAll('.' + BTN_CLASS).forEach(function (b) { reflectBtn(b, b.getAttribute('data-key')); });
    }

    /* ---------- floating cart ---------- */

    function cartEl() {
        var el = document.getElementById('mrt-qc');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'mrt-qc';
        Object.assign(el.style, {
            position: 'fixed', top: '90px', right: '16px', width: '270px', zIndex: '2147483000',
            background: '#fff', border: '1px solid #B9BDCB', borderRadius: '12px',
            boxShadow: '0 10px 30px rgba(45,45,59,.22)', font: '13px/1.35 "Nunito Sans", system-ui, sans-serif',
            color: '#2D2D3B', overflow: 'hidden',
        });
        document.body.appendChild(el);
        return el;
    }

    function quoteText() {
        var pk = primaryKey();
        var lines = ['Quote — ' + STATE.items.length + ' part' + (STATE.items.length === 1 ? '' : 's')];
        var total = 0;
        STATE.items.forEach(function (i) {
            var isP = i.key === pk;
            var price = isP ? repairPrice(i.cost) : addonPrice(i.cost);
            total += price;
            lines.push((isP ? 'Repair: ' : 'Add-on: ') + i.name + ' — ' + fmt(price));
        });
        lines.push('Total: ' + fmt(total));
        return lines.join('\n');
    }

    function render() {
        reflectAllButtons();
        var host = cartEl();
        if (!STATE.items.length) { host.style.display = 'none'; host.innerHTML = ''; return; }
        host.style.display = 'block';

        var pk = primaryKey();
        var total = 0;
        var rows = STATE.items.map(function (i) {
            var isP = i.key === pk;
            var price = isP ? repairPrice(i.cost) : addonPrice(i.cost);
            total += price;
            return '<div class="mrt-qc-row" style="display:flex;align-items:flex-start;gap:6px;padding:7px 10px;border-top:1px solid #F3F2F2">' +
                '<button type="button" class="mrt-qc-star" data-key="' + esc(i.key) + '" title="' + (isP ? 'This part is the Repair' : 'Make this the Repair') + '" ' +
                    'style="border:none;background:none;cursor:pointer;font-size:14px;line-height:1.1;padding:0;color:' + (isP ? '#DC282E' : '#B9BDCB') + '">' + (isP ? '★' : '☆') + '</button>' +
                '<div style="flex:1 1 0;min-width:0">' +
                    '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(i.name) + '">' + esc(i.name) + '</div>' +
                    '<div style="font-size:11px;color:#8A8F9E">' + (isP ? 'Repair' : 'Add-on') + ' · part ' + fmt(i.cost) + '</div>' +
                '</div>' +
                '<div style="font-weight:700;white-space:nowrap">' + fmt(price) + '</div>' +
                '<button type="button" class="mrt-qc-x" data-key="' + esc(i.key) + '" title="Remove" ' +
                    'style="border:none;background:none;cursor:pointer;color:#B9BDCB;font-size:15px;line-height:1;padding:0 0 0 2px">×</button>' +
            '</div>';
        }).join('');

        var collapsed = STATE.collapsed;
        host.innerHTML =
            '<div class="mrt-qc-hd" style="display:flex;align-items:center;gap:8px;padding:9px 10px;background:#2D2D3B;color:#fff;cursor:pointer">' +
                '<span style="font-weight:800;letter-spacing:.02em">🧾 Quote</span>' +
                '<span style="background:#4FB0E3;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700">' + STATE.items.length + '</span>' +
                '<span style="flex:1"></span>' +
                '<span class="mrt-qc-caret" style="font-size:12px;opacity:.85">' + (collapsed ? '▸' : '▾') + '</span>' +
            '</div>' +
            (collapsed ? '' :
                '<div>' + rows + '</div>' +
                '<div style="display:flex;align-items:center;gap:8px;padding:9px 10px;border-top:2px solid #2D2D3B">' +
                    '<span style="font-weight:800">Total</span>' +
                    '<span style="flex:1"></span>' +
                    '<span style="font-weight:800;font-size:15px">' + fmt(total) + '</span>' +
                '</div>' +
                '<div style="display:flex;gap:6px;padding:0 10px 10px">' +
                    '<button type="button" class="mrt-qc-copy" style="flex:1;padding:6px;border:1px solid #4FB0E3;border-radius:7px;background:#4FB0E3;color:#fff;font-weight:700;cursor:pointer">📋 Copy</button>' +
                    '<button type="button" class="mrt-qc-clear" style="padding:6px 10px;border:1px solid #B9BDCB;border-radius:7px;background:#fff;color:#2D2D3B;font-weight:700;cursor:pointer">Clear</button>' +
                '</div>');

        host.querySelector('.mrt-qc-hd').addEventListener('click', function () {
            STATE.collapsed = !STATE.collapsed; saveState(); render();
        });
        host.querySelectorAll('.mrt-qc-x').forEach(function (b) {
            b.addEventListener('click', function (e) { e.stopPropagation(); removeItem(b.getAttribute('data-key')); });
        });
        host.querySelectorAll('.mrt-qc-star').forEach(function (b) {
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                STATE.primary = b.getAttribute('data-key'); saveState(); render();
            });
        });
        var copy = host.querySelector('.mrt-qc-copy');
        if (copy) copy.addEventListener('click', function () {
            var txt = quoteText();
            try {
                navigator.clipboard.writeText(txt).then(function () { flash(copy, '✓ Copied'); }, function () { legacyCopy(txt); flash(copy, '✓ Copied'); });
            } catch (e) { legacyCopy(txt); flash(copy, '✓ Copied'); }
        });
        var clr = host.querySelector('.mrt-qc-clear');
        if (clr) clr.addEventListener('click', clearCart);
    }
    function flash(btn, txt) {
        var old = btn.textContent; btn.textContent = txt;
        setTimeout(function () { btn.textContent = old; }, 1200);
    }
    function legacyCopy(txt) {
        var ta = document.createElement('textarea'); ta.value = txt;
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
        ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
    }

    /* ---------- lifecycle ---------- */

    function start() {
        addButtons();
        render();

        var listingLoader = document.querySelector('#listingloader');
        if (listingLoader) {
            new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    if (muts[i].type === 'attributes' && muts[i].attributeName === 'style') addButtons();
                }
            }).observe(listingLoader, { attributes: true, attributeFilter: ['style'] });
        }
        // Debounced: cpr.parts/Magento fire thousands of subtree mutations
        // during load (and our own inserts add more), so running a full
        // querySelectorAll rescan on every mutation locks the main thread
        // ("page unresponsive"). Coalesce a burst into one rescan.
        var scanT = null;
        function scheduleScan() { if (scanT) return; scanT = setTimeout(function () { scanT = null; addButtons(); }, 500); }
        new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });

        // keep in sync when another tab edits the cart
        try {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area === 'local' && changes[STORE_KEY]) {
                    var s = changes[STORE_KEY].newValue;
                    STATE = (s && Array.isArray(s.items)) ? { items: s.items, primary: s.primary || null, collapsed: !!s.collapsed } : { items: [], primary: null, collapsed: false };
                    render();
                }
            });
        } catch (e) {}
    }

    try {
        chrome.storage.sync.get(['mcpr']).then(function (res) {
            var m = (res && res.mcpr) || {};
            if (m.quoteCart === false) return;
            if (m.priceModel === 'cap') ROYALTY = 1;
            loadState().then(start);
        }).catch(function () { loadState().then(start); });
    } catch (e) { loadState().then(start); }
})();
