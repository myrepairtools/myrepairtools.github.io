/*
    LCD Buyback capture (myRepairTools)

    Watches the ticket-item table on RepairQ ticket pages. The moment a screen
    repair for a supported device family (iPhone / Galaxy S / Galaxy Note /
    Pixel — each toggleable in Options) is added as a line item, a modal asks
    the tech whether the display coming OFF the phone is GOOD or BAD, and the
    answer is logged to the MRT LCD Buyback Log (lcd_displays via the
    lcd-buyback edge function, proxied through bg.js).

    Trigger is text-based on the item NAME (device family + "screen repair /
    replacement"), so new models (iPhone 18, S26...) trigger automatically —
    no SKU list to maintain.

    New-ticket flow: on /ticket/repair the ticket number doesn't exist yet, so
    answers are stashed in sessionStorage (per-tab, survives the save
    navigation) and flushed with the ticket number as soon as this script sees
    a /ticket/view|edit/<id> page in the same tab.
*/
(function () {
    'use strict';

    var FAMILIES = [
        { key: 'iphone',     label: 'iPhone',      re: /\biphone\b/i },
        { key: 'galaxys',    label: 'Galaxy S',    re: /galaxy\s*s\s*\d{1,2}\b/i },
        { key: 'galaxynote', label: 'Galaxy Note', re: /galaxy\s*note/i },
        { key: 'galaxyz',    label: 'Galaxy Z',    re: /galaxy\s*z?\s*(fold|flip)/i },
        { key: 'pixel',      label: 'Pixel',       re: /\bpixel\b/i }
    ];
    var SCREEN_RE = /screen\s*(repair|replacement)/i;

    var PENDING_KEY = 'mrt_lcd_pending';   // answers waiting for a ticket number
    var DONE_KEY    = 'mrt_lcd_done';      // item names already asked (this tab)

    var settings = { enabled: true, iphone: true, galaxys: true, galaxynote: true, galaxyz: true, pixel: true };
    var queue = [];          // items waiting for the modal
    var modalOpen = false;
    var EXISTING = {};       // item_keys already logged for THIS ticket (from the
                             // DB + this tab's answers) — the durable "already
                             // asked" memory. sessionStorage alone re-asked after
                             // the new-ticket save renamed the key, and in every
                             // fresh tab/day.

    /* ---------------- page context ---------------- */

    function ticketNo() {
        var m = location.pathname.match(/\/ticket\/(?:view|edit)\/(\d+)/);
        return m ? m[1] : null;
    }

    function techName() {
        var el = document.getElementById('user_dropdown');
        if (!el) return '';
        var raw = el.textContent.replace(/\s+/g, ' ').trim();
        var m = raw.match(/^([^,]+),\s*(.+)$/);          // "Bay, Britt" -> "Britt Bay"
        return m ? (m[2] + ' ' + m[1]).trim() : raw;
    }

    function storeName() {
        var t = document.querySelector('.location.tooltip-toggle span'); // ticket location
        if (t && t.textContent.trim()) return t.textContent.trim();
        var pin = document.querySelector('.icon-map-marker');            // navbar location
        if (pin && pin.parentElement) {
            return pin.parentElement.textContent.replace(/\s+/g, ' ').trim();
        }
        return '';
    }

    /* ---------------- session stores ---------------- */

    function readJson(key, fallback) {
        try { return JSON.parse(sessionStorage.getItem(key)) || fallback; }
        catch (e) { return fallback; }
    }
    function writeJson(key, val) {
        try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* full/blocked */ }
    }

    /* ---------------- item detection ---------------- */

    function itemNameFromRow(row) {
        var cell = row.querySelector('td.catalog-item-col');
        if (!cell) return '';
        var clone = cell.cloneNode(true);
        clone.querySelectorAll('.modal, a, em, input, select, script').forEach(function (n) { n.remove(); });
        return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    function matchFamily(name) {
        if (!SCREEN_RE.test(name)) return null;
        for (var i = 0; i < FAMILIES.length; i++) {
            var f = FAMILIES[i];
            if (settings[f.key] && f.re.test(name)) return f;
        }
        return null;
    }

    function modelFromName(name) {
        var m = name.split(SCREEN_RE)[0];
        return m.replace(/[\s:,-]+$/, '').trim() || name;
    }

    function itemKeyFor(model) {
        return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function scan() {
        if (!settings.enabled) return;
        var done = readJson(DONE_KEY, {});
        var rows = document.querySelectorAll('tr.ticket-item-row');
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (row.getAttribute('data-mrt-lcd')) continue;
            // one pull per REPAIR: the labor line triggers; the auto-bundled
            // part row (.bundled-item) repeats the model + "screen repair" and
            // must never pop a second modal
            if (row.classList.contains('bundled-item')) { row.setAttribute('data-mrt-lcd', '1'); continue; }
            var name = itemNameFromRow(row);
            if (!name) continue;
            row.setAttribute('data-mrt-lcd', '1');
            if (!matchFamily(name)) continue;
            var model = modelFromName(name);
            if (EXISTING[itemKeyFor(model)]) continue;      // already logged for this ticket
            var dedupe = (ticketNo() || 'new') + '|' + name;
            if (done[dedupe]) continue;
            done[dedupe] = 1;
            writeJson(DONE_KEY, done);
            queue.push({ item_name: name, model: model });
        }
        if (queue.length && !modalOpen) showModal(queue.shift());
    }

    /* ---------------- sending ---------------- */

    function send(payload) {
        return new Promise(function (resolve) {
            try {
                chrome.runtime.sendMessage({ type: 'lcd:capture', payload: payload }, function (res) {
                    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
                    else resolve(res || { ok: false, error: 'no response' });
                });
            } catch (e) { resolve({ ok: false, error: String(e) }); }
        });
    }

    function record(answer, item) {
        EXISTING[itemKeyFor(item.model)] = 1;               // never re-ask this pull
        var payload = {
            item_key: itemKeyFor(item.model),
            store: storeName(),
            model: item.model,
            item_name: item.item_name,
            status: answer,
            graded_by: techName()
        };
        var tn = ticketNo();
        if (tn) {
            payload.ticket_no = tn;
            send(payload).then(function (res) {
                toast(res && res.ok
                    ? item.model + ' logged — ' + answer.toUpperCase() + ' display'
                      + (answer === 'bad' ? ' (no label — bad pulls aren’t boxed)' : '')
                    : 'LCD log failed: ' + (res && res.error || 'network'), !(res && res.ok));
            });
        } else {
            var pending = readJson(PENDING_KEY, []);
            pending.push(payload);
            writeJson(PENDING_KEY, pending);
            toast(item.model + ' — ' + answer.toUpperCase() + ' display (logs when the ticket saves)');
        }
    }

    function flushPending() {
        var tn = ticketNo();
        if (!tn) return;
        var pending = readJson(PENDING_KEY, []);
        if (!pending.length) return;
        writeJson(PENDING_KEY, []);
        var okCount = 0, left = pending.length;
        pending.forEach(function (p) {
            p.ticket_no = tn;
            if (!p.store) p.store = storeName();
            send(p).then(function (res) {
                if (res && res.ok) okCount++;
                else { var back = readJson(PENDING_KEY, []); back.push(p); writeJson(PENDING_KEY, back); }
                if (--left === 0 && okCount) {
                    toast(okCount + ' display' + (okCount > 1 ? 's' : '') + ' logged to LCD Buyback — ticket #' + tn);
                }
            });
        });
    }

    /* ---------------- UI ---------------- */

    function toast(msg, isError) {
        var t = document.createElement('div');
        t.className = 'mrt-lcd-toast' + (isError ? ' mrt-lcd-toast-err' : '');
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () { t.classList.add('show'); }, 30);
        setTimeout(function () { t.classList.remove('show'); }, 5200);
        setTimeout(function () { t.remove(); }, 5800);
    }

    function showModal(item) {
        modalOpen = true;
        var wrap = document.createElement('div');
        wrap.className = 'mrt-lcd-overlay';
        wrap.innerHTML =
            '<div class="mrt-lcd-modal" role="dialog" aria-label="LCD Buyback">' +
              '<div class="mrt-lcd-head">' +
                '<span class="mrt-lcd-logo">my<b>Repair</b>Tools</span>' +
                '<span class="mrt-lcd-tag">LCD BUYBACK</span>' +
              '</div>' +
              '<div class="mrt-lcd-model"></div>' +
              '<div class="mrt-lcd-q">Is the display coming <u>off</u> this phone GOOD?<br>' +
                '<span class="mrt-lcd-hint">Good = screen lights up fine, no cracks in the OLED itself (glass-only damage is still GOOD).</span></div>' +
              '<div class="mrt-lcd-btns">' +
                '<button type="button" class="mrt-lcd-good">✓ GOOD</button>' +
                '<button type="button" class="mrt-lcd-bad">✕ BAD</button>' +
              '</div>' +
              '<button type="button" class="mrt-lcd-skip">Not a buyback pull (don’t log)</button>' +
            '</div>';
        wrap.querySelector('.mrt-lcd-model').textContent = item.model;

        function close() {
            wrap.remove();
            modalOpen = false;
            if (queue.length) setTimeout(function () { showModal(queue.shift()); }, 250);
        }
        wrap.querySelector('.mrt-lcd-good').addEventListener('click', function () { record('good', item); close(); });
        wrap.querySelector('.mrt-lcd-bad').addEventListener('click', function () { record('bad', item); close(); });
        wrap.querySelector('.mrt-lcd-skip').addEventListener('click', close);
        document.body.appendChild(wrap);
        wrap.querySelector('.mrt-lcd-good').focus();
    }

    /* ---------------- boot ---------------- */

    // Build the durable "already asked" set BEFORE the first scan: answers
    // stashed in this tab (a just-saved new ticket, not yet flushed) plus
    // everything the DB already has for this ticket number.
    function loadExisting(cb) {
        readJson(PENDING_KEY, []).forEach(function (p) { if (p.item_key) EXISTING[p.item_key] = 1; });
        var tn = ticketNo();
        if (!tn) { cb(); return; }
        try {
            chrome.runtime.sendMessage({ type: 'lcd:get', ticket: tn }, function (res) {
                if (!chrome.runtime.lastError && res && res.ok && res.rows) {
                    res.rows.forEach(function (r) { if (r.item_key) EXISTING[r.item_key] = 1; });
                }
                cb();
            });
        } catch (e) { cb(); }
    }

    function start() {
        loadExisting(function () {
            flushPending();
            scan();
            var pending = false;
            new MutationObserver(function () {
                if (pending) return;
                pending = true;
                setTimeout(function () { pending = false; scan(); }, 350);
            }).observe(document.body, { childList: true, subtree: true });
        });
    }

    chrome.storage.sync.get(['lcd']).then(function (res) {
        if (res && res.lcd) {
            Object.keys(settings).forEach(function (k) {
                if (typeof res.lcd[k] === 'boolean') settings[k] = res.lcd[k];
            });
        }
        if (settings.enabled) start();
    }).catch(start);
})();
