/*
    KBB Returns matcher (myRepairTools)

    Runs on:  cpr.parts /kbbprocessing/*   and   cpr.repairq.io/rmaTracking*

    Apple "Known Bad Board" returns have to be checked off on BOTH the
    Mobile Sentrix (cpr.parts) side and the RepairQ side before you can
    process the return — today a ~1hr manual cross-reference.

    The tool:
      1. You SCAN the return-order numbers (HAL…) off each KBB box into the
         list (one per line — a barcode scanner's Enter key adds a line).
      2. On cpr.parts you hit "Match & check this page": every row whose
         Return order # is in your list gets ticked, AND the tool harvests
         that row's RQ ticket # + KBB serial into the shared batch.
      3. On RepairQ you hit "Match & check this page": each batch item is
         matched to a row by KBB serial (exact, cross-system) — or by ticket #
         for no-serial parts — and ticked.
      Then you process each return manually, as before.

    The batch lives in chrome.storage.local, so it carries across the two
    sites/tabs. Serial is the primary key because it's identical in both
    systems; ticket # is the fallback (the only shared key when a part has
    no serial), consumed one row at a time so multiple no-serial parts on
    one ticket still line up.

    Toggle: Options → RepairQ workflow tools (storage.sync mcpr.kbbReturns,
    default ON).
*/

(function () {
    'use strict';

    var KEY = 'mrt_kbb';
    var host = location.hostname, path = location.pathname;
    var SITE = /cpr\.parts$/.test(host) && /\/kbbprocessing/i.test(path) ? 'cpr'
             : /repairq\.io$/.test(host) && /\/rmaTracking/i.test(path)  ? 'rq'
             : null;
    if (!SITE) return;

    /* ---------------- helpers ---------------- */

    function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
    function normSerial(s) {
        s = (s || '').replace(/\s+/g, ' ').trim();
        // "no serial" sentinels either side may use
        if (/^(-|n\/?a|no ?serial( ?number)?|old ?serial( ?number)?)$/i.test(s)) return '';
        return s.toUpperCase();
    }
    function normRet(s) { return (s || '').replace(/\s+/g, '').toUpperCase(); }

    function loadBatch() {
        return new Promise(function (res) {
            chrome.storage.local.get([KEY]).then(function (r) {
                res((r && r[KEY]) || { items: [] });
            }).catch(function () { res({ items: [] }); });
        });
    }
    function saveBatch(b) { try { chrome.storage.local.set({ [KEY]: b }); } catch (e) {} }
    function findItem(b, ret) { return b.items.find(function (x) { return x.ret === ret; }); }

    function check(box) {
        // Tick via a real click so the site's own selection JS runs; set+dispatch on hidden dupes.
        if (!box) return;
        if (box.offsetParent !== null) { if (!box.checked) box.click(); }
        else if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    /* ---------------- page parsers ---------------- */

    function parseCprRows() {
        var out = [];
        document.querySelectorAll('ul.collapse-comm-row').forEach(function (ul) {
            var box = ul.querySelector('input[name="kbbIDs[]"]');
            var retLi = ul.querySelector('li.return-order');
            var serLi = ul.querySelector('li.kbb-serial');
            var g = ul.querySelector('.g-order');
            var ticket = '';
            if (g) {
                var labels = g.querySelectorAll('label');
                ticket = txt(labels[labels.length - 1]).replace(/[^0-9]/g, '');
            }
            var ret = normRet(txt(retLi).replace(/^Return order #\s*/i, ''));
            var serial = normSerial(txt(serLi).replace(/^KBB Serial\s*/i, ''));
            // No-serial parts: Mobile Sentrix substitutes the RETURN ORDER # into
            // the KBB Serial spot. That's not a serial — blank it so the RepairQ
            // side knows to bridge return order # → ticket # instead.
            if (serial && normRet(serial) === ret) serial = '';
            var sku = txt(ul.querySelector('li.sku')).replace(/^SKU\s*/i, '');
            if (ret) out.push({ ret: ret, ticket: ticket, serial: serial, sku: sku, box: box, checked: box && box.checked });
        });
        return out;
    }

    function parseRqRows() {
        var out = [];
        var table = document.getElementById('mainModelList');
        if (!table) return out;
        table.querySelectorAll('tbody tr').forEach(function (tr) {
            var box = tr.querySelector('input.select-one');
            if (!box) return;
            var rowtext = txt(tr);
            var tk = rowtext.match(/Ticket #\s*(\d+)/);
            var ticket = tk ? tk[1] : '';
            // serial cell: an all-caps alnum token 12-20 chars in its own cell
            var serial = '';
            tr.querySelectorAll('td').forEach(function (td) {
                if (serial) return;
                var s = txt(td);
                if (/^[A-Z0-9]{12,20}$/.test(s)) serial = s;
            });
            out.push({ ticket: ticket, serial: normSerial(serial), box: box, checked: box.checked });
        });
        return out;
    }

    /* ---------------- matchers ---------------- */

    function matchCpr(batch) {
        var rows = parseCprRows(), byRet = {};
        rows.forEach(function (r) { byRet[r.ret] = r; });
        var res = { checked: 0, harvested: 0, missing: [] };
        batch.items.forEach(function (it) {
            var row = byRet[it.ret];
            if (!row) { if (!it.cpr) res.missing.push(it.ret); return; }
            check(row.box);
            it.cpr = true;
            if (row.ticket && !it.ticket) { it.ticket = row.ticket; res.harvested++; }
            if (row.serial && !it.serial) it.serial = row.serial;
            it.sku = it.sku || row.sku;
            res.checked++;
        });
        return res;
    }

    function matchRq(batch) {
        var rows = parseRqRows();
        var used = new Array(rows.length).fill(false);
        var res = { checked: 0, unmatched: [], noData: 0 };

        function claimBy(pred) {
            for (var i = 0; i < rows.length; i++) if (!used[i] && pred(rows[i])) { used[i] = true; return rows[i]; }
            return null;
        }
        // Pass 1: exact serial (strongest, cross-system identical)
        batch.items.forEach(function (it) {
            if (it.rq) return;
            if (!it.ticket && !it.serial) { res.noData++; return; }
            if (!it.serial) return;
            var row = claimBy(function (r) { return r.serial && r.serial === it.serial; });
            if (row) { check(row.box); it.rq = true; res.checked++; }
        });
        // Pass 2: ticket # (no-serial parts, consumed one row per item)
        batch.items.forEach(function (it) {
            if (it.rq) return;
            if (!it.ticket) { if (!it.serial) {} else res.unmatched.push(it.ret); return; }
            var row = claimBy(function (r) { return r.ticket && r.ticket === it.ticket; });
            if (row) { check(row.box); it.rq = true; res.checked++; }
            else res.unmatched.push(it.ret);
        });
        return res;
    }

    /* ---------------- UI ---------------- */

    var panel, listEl, scanEl, batch = { items: [] };

    function counts() {
        var n = batch.items.length,
            c = batch.items.filter(function (x) { return x.cpr; }).length,
            r = batch.items.filter(function (x) { return x.rq; }).length;
        return { n: n, c: c, r: r };
    }

    function renderList() {
        var cc = counts();
        panel.querySelector('.mrt-kbb-count').textContent =
            cc.n + ' scanned · ' + cc.c + ' on cpr.parts · ' + cc.r + ' on RepairQ';
        listEl.innerHTML = batch.items.map(function (it) {
            return '<tr>' +
                '<td class="ret">' + esc(it.ret) + '</td>' +
                '<td>' + (esc(it.ticket) || '<span class="q">?</span>') + '</td>' +
                '<td class="ser">' + (esc(it.serial) || '<span class="q">no‑serial</span>') + '</td>' +
                '<td class="dot ' + (it.cpr ? 'ok' : '') + '">' + (it.cpr ? '✓' : '·') + '</td>' +
                '<td class="dot ' + (it.rq ? 'ok' : '') + '">' + (it.rq ? '✓' : '·') + '</td>' +
                '</tr>';
        }).join('') || '<tr><td colspan="5" class="empty">Scan return-order numbers below…</td></tr>';
    }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function ingestScan() {
        var lines = scanEl.value.split(/[\s,]+/).map(normRet).filter(Boolean);
        var seen = {};
        batch.items.forEach(function (x) { seen[x.ret] = x; });
        lines.forEach(function (ret) {
            if (!seen[ret]) { var it = { ret: ret, ticket: '', serial: '', sku: '', cpr: false, rq: false }; batch.items.push(it); seen[ret] = it; }
        });
        saveBatch(batch); renderList();
    }

    function run() {
        var res, msg;
        if (SITE === 'cpr') {
            res = matchCpr(batch);
            msg = 'Checked ' + res.checked + ' on cpr.parts (harvested ' + res.harvested + ' tickets).' +
                  (res.missing.length ? ' Not on this page: ' + res.missing.length + ' — paginate & run again.' : '');
        } else {
            res = matchRq(batch);
            msg = 'Checked ' + res.checked + ' on RepairQ.' +
                  (res.noData ? ' ' + res.noData + ' need cpr.parts first.' : '') +
                  (res.unmatched.length ? ' Unmatched: ' + res.unmatched.length + ' — paginate & run again.' : '');
        }
        saveBatch(batch); renderList();
        flash(msg);
    }

    function flash(m) {
        var el = panel.querySelector('.mrt-kbb-msg');
        el.textContent = m; el.classList.add('show');
        clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove('show'); }, 6000);
    }

    function build() {
        var btn = document.createElement('button');
        btn.className = 'mrt-kbb-fab';
        btn.textContent = '📦 KBB';
        btn.title = 'KBB Returns matcher';
        document.body.appendChild(btn);

        panel = document.createElement('div');
        panel.className = 'mrt-kbb-panel';
        panel.innerHTML =
            '<div class="mrt-kbb-hd">📦 KBB Returns' +
              '<span class="mrt-kbb-site">' + (SITE === 'cpr' ? 'cpr.parts' : 'RepairQ') + '</span>' +
              '<button class="mrt-kbb-x" title="Close">✕</button>' +
            '</div>' +
            '<div class="mrt-kbb-body">' +
              '<div class="mrt-kbb-count"></div>' +
              '<table class="mrt-kbb-list"><thead><tr><th>Return #</th><th>Ticket</th><th>Serial</th><th>CPR</th><th>RQ</th></tr></thead><tbody></tbody></table>' +
              '<label class="mrt-kbb-lbl">Scan return-order numbers (one per line)</label>' +
              '<textarea class="mrt-kbb-scan" placeholder="HAL5781763&#10;HAL5990273&#10;…" rows="3"></textarea>' +
              '<div class="mrt-kbb-btns">' +
                '<button class="mrt-kbb-run">▶ Match &amp; check this page</button>' +
                '<button class="mrt-kbb-clear" title="Clear the whole batch">Clear</button>' +
              '</div>' +
              '<div class="mrt-kbb-msg"></div>' +
            '</div>';
        document.body.appendChild(panel);

        listEl = panel.querySelector('.mrt-kbb-list tbody');
        scanEl = panel.querySelector('.mrt-kbb-scan');

        btn.addEventListener('click', function () { panel.classList.toggle('open'); });
        panel.querySelector('.mrt-kbb-x').addEventListener('click', function () { panel.classList.remove('open'); });
        scanEl.addEventListener('input', ingestScan);
        scanEl.addEventListener('change', ingestScan);
        panel.querySelector('.mrt-kbb-run').addEventListener('click', run);
        panel.querySelector('.mrt-kbb-clear').addEventListener('click', function () {
            if (!confirm('Clear the whole KBB batch?')) return;
            batch = { items: [] }; scanEl.value = ''; saveBatch(batch); renderList();
        });

        loadBatch().then(function (b) { batch = b; renderList(); });
    }

    function start() {
        // gate on the shared workflow-tools setting; default ON
        chrome.storage.sync.get(['mcpr']).then(function (res) {
            var m = (res && res.mcpr) || {};
            if (m.kbbReturns === false) return;
            if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
        }).catch(function () { if (document.body) build(); });
    }
    start();
})();
