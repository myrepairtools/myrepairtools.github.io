/*  myRepairTools — Blacklist Gate (Sickw IMEI check)
    ==================================================
    Born from selling a blacklisted device: whenever a CELLULAR device lands on
    a RepairQ ticket, a blocking modal forces a Sickw blacklist check before the
    tech moves on. Cellular detection is by the serial itself: phones/tablets
    with a modem carry a 15-digit Luhn-valid IMEI — laptops/consoles/watches
    don't — which matches the "Device - Phone / Device - Tablet" categories
    without needing category data in the row.

    Flow: device row appears → modal (device + IMEI) → Run check ($0.04, Sickw
    WW Blacklist via the sickw-check edge function; key stays server-side;
    results cached 24h) → CLEAN / BLACKLISTED / REVIEW → the verdict is written
    to the ticket notes. Skipping is allowed but writes a shame-note.

    Toggle: Options → Workflow tools (storage.sync mcpr.sickwGate, default ON).
*/

(function () {
    'use strict';

    /* ---- ticket-type rules (Options → Ticket-Type Rules; storage.sync tt) ---- */
    var TT = null;   // loaded config; defaults below reproduce shipped behavior
    function mrtTicketType() {
        var t = document.title + ' ' + (((document.querySelector('#ticket h2, .page-header h2') || {}).textContent) || '') + ' ' + (document.body.className || '');
        if (/refurb/i.test(t)) return 'refurbish';
        if (/trade/i.test(t)) return 'tradein';
        if (/claim/i.test(t) || /\/ticket\/claim/.test(location.pathname)) return 'claim';
        if (/sale/i.test(t) || /\/ticket\/add\b/.test(location.pathname)) return 'sale';
        return 'repair';
    }
    function ttAllows(feature) {
        var DEF = { followUp: { refurbish: false }, promise: { refurbish: false }, ready: { refurbish: false }, blacklist: { refurbish: false } };
        var type = mrtTicketType();
        var cfg = (TT && TT[feature]) || {};
        if (cfg[type] !== undefined) return cfg[type] !== false;
        return (DEF[feature] || {})[type] !== false;
    }


    var DONE_KEY = 'mrtSickwDone';
    var modalOpen = false;
    var queue = [];

    /* ---------------- helpers (readyText/lcdCapture patterns) ---------------- */

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function ticketNo() {
        var m = location.pathname.match(/\/ticket\/(?:edit\/|view\/)?(\d+)\b/);
        if (m) return m[1];
        var h = document.querySelector('#ticket h2 span, .ticket-number, [data-ticket-id]');
        var t = h && (h.getAttribute('data-ticket-id') || h.textContent);
        var mm = t && t.match(/(\d{5,})/);
        return mm ? mm[1] : '';
    }

    function storeName() {
        var t = document.querySelector('.location.tooltip-toggle span');
        return (t && t.textContent.trim()) || 'CPR';
    }

    function techName() {
        var el = document.getElementById('user_dropdown');
        if (!el) return '';
        var raw = el.textContent.replace(/\s+/g, ' ').trim();
        var m = raw.match(/^([^,]+),\s*(.+)$/);
        return m ? (m[2] + ' ' + m[1]).trim() : raw;
    }

    function writeNote(text) {
        // RepairQ's DB is 3-byte MySQL utf8: a 4-byte char (most emoji) silently
        // truncates the note from that char on — a leading emoji stores a BLANK
        // note, and blank notes block the ticket from saving. Strip them.
        text = String(text == null ? '' : text).replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim();
        if (!text) return;   // never POST a blank note (RepairQ rejects it → global "save the ticket" error modal)
        var csrf = (document.getElementsByName('YII_CSRF_TOKEN')[0] || {}).value;
        var id = ticketNo();
        if (!csrf || !id) { stashNote(text); return; }
        var body = new URLSearchParams({
            YII_CSRF_TOKEN: csrf, ticketId: id, note: text, print: '0', important: '0',
        });
        // no keepalive: Chrome CORS-fails keepalive fetches from content
        // scripts (extension-origin attribution) — the note silently vanishes
        fetch('/ajax/ticketNote/save', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
            body: body.toString(),
        }).catch(function () { stashNote(text); /* retry on next page */ });
    }

    // brand-new unsaved ticket: hold notes until a ticket number exists
    function stashNote(text) {
        if (!text || !String(text).trim()) return;
        try {
            var arr = JSON.parse(sessionStorage.getItem('mrtSickwNotes') || '[]');
            arr.push(text);
            sessionStorage.setItem('mrtSickwNotes', JSON.stringify(arr));
        } catch (e) { /* full */ }
    }
    function flushNotes() {
        if (!ticketNo()) return;
        var arr;
        try { arr = JSON.parse(sessionStorage.getItem('mrtSickwNotes') || '[]'); } catch (e) { arr = []; }
        arr = arr.filter(function (t) { return t && String(t).trim(); });   // drop any blank stragglers
        if (!arr.length) { sessionStorage.removeItem('mrtSickwNotes'); return; }
        sessionStorage.removeItem('mrtSickwNotes');
        arr.forEach(writeNote);
    }

    function fn(action, payload) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ type: 'sickw:' + action, payload: payload || {} }, function (r) {
                    res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || { ok: false, error: 'no response' }));
                });
            } catch (e) { res({ ok: false, error: String(e) }); }
        });
    }

    /* ---------------- IMEI detection ---------------- */

    function luhnOk(s) {
        var sum = 0, alt = false;
        for (var i = s.length - 1; i >= 0; i--) {
            var d = s.charCodeAt(i) - 48;
            if (d < 0 || d > 9) return false;
            if (alt) { d *= 2; if (d > 9) d -= 9; }
            sum += d; alt = !alt;
        }
        return sum % 10 === 0;
    }

    function imeiIn(text) {
        var m = text.match(/\b\d{15}\b/g) || [];
        for (var i = 0; i < m.length; i++) if (luhnOk(m[i])) return m[i];
        return '';
    }

    function itemNameFromRow(row) {
        var cell = row.querySelector('td.catalog-item-col') || row.querySelector('td');
        if (!cell) return '';
        var clone = cell.cloneNode(true);
        var kill = clone.querySelectorAll('.modal, a, em, input, select, script');
        for (var i = 0; i < kill.length; i++) kill[i].remove();
        return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    // RepairQ prefixes each ticket item with its item TYPE in italics —
    // "Repair - Phone:", "Device - Phone:", "Accessory - Case:" … Only actual
    // DEVICE items (Device - Phone / Device - Tablet) are sellable cellular
    // hardware. Repair labor lines merely RELATE to the customer's own device
    // (whose IMEI shows in the Relations column) and must never trigger.
    function isSellableDevice(row) {
        var cell = row.querySelector('td.catalog-item-col') || row.querySelector('td');
        var em = cell && cell.querySelector('em');
        var t = em ? em.textContent.replace(/\s+/g, ' ').trim() : '';
        return /^device\s*[-–]\s*(phone|tablet)/i.test(t);
    }

    function readDone() {
        try { return JSON.parse(sessionStorage.getItem(DONE_KEY) || '{}'); } catch (e) { return {}; }
    }
    function markDone(imei) {
        var d = readDone(); d[(ticketNo() || 'new') + '|' + imei] = 1;
        try { sessionStorage.setItem(DONE_KEY, JSON.stringify(d)); } catch (e) { /* full */ }
    }

    function scan() {
        if (!ttAllows('blacklist')) return;   // this ticket type opted out
        flushNotes();
        var done = readDone();
        var rows = document.querySelectorAll('tr.ticket-item-row');
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (row.getAttribute('data-mrt-bl')) continue;
            // item-type gate FIRST: only "Device - Phone" / "Device - Tablet"
            // catalog items — never repair/accessory lines (their row text can
            // carry the customer's device IMEI via the Relations column)
            if (!isSellableDevice(row)) {
                if (row.textContent.trim()) row.setAttribute('data-mrt-bl', '0');
                continue;
            }
            var text = row.textContent.replace(/\s+/g, ' ');
            var imei = imeiIn(text);
            if (!imei) {
                // device rows can gain their serial after save — leave them
                // unmarked so late serials still trigger
                continue;
            }
            row.setAttribute('data-mrt-bl', '1');
            if (done[(ticketNo() || 'new') + '|' + imei]) continue;
            queue.push({ imei: imei, name: itemNameFromRow(row) || 'Device' });
        }
        if (queue.length && !modalOpen) showModal(queue.shift());
    }

    /* ---------------- modal ---------------- */

    function noteFor(status, imei, extra) {
        var who = techName() || 'staff';
        var tail = (extra ? ' — ' + extra : '') + ' — ' + who;
        if (status === 'clean') return '✔ Blacklist check: CLEAN — IMEI ' + imei + ' (Sickw)' + tail;
        if (status === 'blacklisted') return '⛔ Blacklist check: BLACKLISTED — IMEI ' + imei + ' (Sickw) — DO NOT SELL' + tail;
        if (status === 'fmi_on') return '⛔ Blacklist check: iCloud Lock (FMI) ON — IMEI ' + imei + ' (Sickw) — DO NOT SELL' + tail;
        if (status === 'review') return '⚠ Blacklist check: NEEDS REVIEW — IMEI ' + imei + tail;
        return '⚠ Blacklist check SKIPPED — IMEI ' + imei + ' — ' + who;
    }

    function showModal(item) {
        modalOpen = true;
        var ov = document.createElement('div');
        ov.id = 'mrt-bl-overlay';
        ov.innerHTML =
            '<div class="mrt-bl-card">' +
              '<div class="mrt-bl-hd">🛡 Blacklist Check Required</div>' +
              '<div class="mrt-bl-dev">' + esc(item.name) + '</div>' +
              '<div class="mrt-bl-imei">IMEI ' + esc(item.imei) + '</div>' +
              '<div class="mrt-bl-body" id="mrt-bl-body">' +
                '<div class="mrt-bl-q">This device must pass a blacklist check before it leaves the store.</div>' +
                '<button class="mrt-bl-run" id="mrt-bl-run">🔍 Run Blacklist Check</button>' +
              '</div>' +
              '<a class="mrt-bl-skip" id="mrt-bl-skip">Skip — logs a SKIPPED note on the ticket</a>' +
            '</div>';
        document.body.appendChild(ov);

        function close() {
            ov.remove(); modalOpen = false;
            if (queue.length) showModal(queue.shift());
        }

        document.getElementById('mrt-bl-skip').addEventListener('click', function () {
            markDone(item.imei);
            writeNote(noteFor('skip', item.imei));
            close();
        });

        document.getElementById('mrt-bl-run').addEventListener('click', function () {
            var body = document.getElementById('mrt-bl-body');
            body.innerHTML = '<div class="mrt-bl-wait">Checking IMEI against the worldwide blacklist…</div>';
            fn('check', {
                imei: item.imei, device_name: item.name,
                ticket_no: ticketNo() || null, store: storeName(), agent_name: techName(),
            }).then(function (r) {
                if (!r || !r.ok) {
                    body.innerHTML =
                        '<div class="mrt-bl-verdict err">Check failed: ' + esc((r && r.error) || 'network') + '</div>' +
                        '<button class="mrt-bl-run" id="mrt-bl-retry">Try Again</button>';
                    var rb = document.getElementById('mrt-bl-retry');
                    if (rb) rb.addEventListener('click', function () { ov.remove(); modalOpen = false; showModal(item); });
                    return;
                }
                markDone(item.imei);
                var cachedTag = r.cached ? ' <span class="mrt-bl-cached">(checked earlier today)</span>' : '';
                var raw = String(r.result || '').replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '');
                if (r.status === 'clean') {
                    writeNote(noteFor('clean', item.imei, raw.slice(0, 160)));
                    body.innerHTML =
                        '<div class="mrt-bl-verdict clean">✅ CLEAN' + cachedTag + '</div>' +
                        '<div class="mrt-bl-raw">' + esc(raw) + '</div>' +
                        '<button class="mrt-bl-done" id="mrt-bl-done">Done</button>';
                } else if (r.status === 'blacklisted' || r.status === 'fmi_on') {
                    var label = r.status === 'fmi_on' ? '⛔ iCLOUD LOCK (FMI) IS ON — DO NOT SELL' : '⛔ BLACKLISTED — DO NOT SELL';
                    writeNote(noteFor(r.status, item.imei, raw.slice(0, 160)));
                    body.innerHTML =
                        '<div class="mrt-bl-verdict bad">' + label + '</div>' +
                        '<div class="mrt-bl-raw">' + esc(raw) + '</div>' +
                        '<div class="mrt-bl-q">Pull this device off the ticket and quarantine it. A note has been written to the ticket.</div>' +
                        '<button class="mrt-bl-done bad" id="mrt-bl-done">I Understand — Remove the Device</button>';
                } else {
                    writeNote(noteFor('review', item.imei, raw.slice(0, 180)));
                    body.innerHTML =
                        '<div class="mrt-bl-verdict warn">⚠️ NEEDS REVIEW — result was not a clear CLEAN</div>' +
                        '<div class="mrt-bl-raw">' + esc(raw) + '</div>' +
                        '<button class="mrt-bl-done" id="mrt-bl-done">Acknowledge</button>';
                }
                var d = document.getElementById('mrt-bl-done');
                if (d) d.addEventListener('click', close);
            });
        });
    }

    /* ---------------- boot ---------------- */

    function start() {
        if (window.self !== window.top) return;             // not inside embeds
        if (/\/ticket\/print/i.test(location.pathname)) return;
        scan();
        new MutationObserver(function () {
            clearTimeout(start._t);
            start._t = setTimeout(scan, 400);
        }).observe(document.body, { childList: true, subtree: true });
    }

    try {
        chrome.storage.sync.get(['mcpr', 'tt']).then(function (res) {
            var m = (res && res.mcpr) || {};
            TT = (res && res.tt) || null;
            if (m.sickwGate === false) return;
            if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
        }).catch(start);
    } catch (e) { start(); }
})();
