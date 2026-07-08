/*
    LCD Buyback send-display label (myRepairTools)

    On /ticket/printLabel/<ticket>: ask bg.js whether this ticket has displays
    in the LCD Buyback Log. For each one, append a Dymo 30334 (2-1/4" x 1-1/4")
    "send label" page after the regular ticket label, so the same print job
    spits out label(s) the tech sticks on the pulled display before it goes in
    the buyback box:

        STORE                          [ GOOD ]
        ─────────────────────────────────────
        Apple iPhone 17 Pro Max
        Ticket #16147720 · 07/02/26
        [QR = ticket number]   POST-REMOVAL ☐ GOOD ☐ BAD

    The QR encodes the ticket number — the display's serial — and is what gets
    scanned into the Audit modal on lcd-buyback.html when the recycler visits.

    bg.js holds the page's auto-print (print gate) until we dispatch
    'mrtPrintReady'; a 4s safety net over there means printing is never
    blocked even if we die. Needs scripts/qrcode.js loaded first.
*/
(function () {
    'use strict';

    function releasePrint() {
        document.dispatchEvent(new CustomEvent('mrtPrintReady'));
    }

    function getTicketId() {
        var m = location.pathname.match(/printLabel\/(\d+)/);
        return m ? m[1] : null;
    }

    function msg(m) {
        return new Promise(function (resolve) {
            try {
                chrome.runtime.sendMessage(m, function (res) {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(res || null);
                });
            } catch (e) { resolve(null); }
        });
    }

    function fmtDate(iso) {
        var d = iso ? new Date(iso) : new Date();
        if (isNaN(d)) d = new Date();
        var mm = ('0' + (d.getMonth() + 1)).slice(-2),
            dd = ('0' + d.getDate()).slice(-2),
            yy = String(d.getFullYear()).slice(-2);
        return mm + '/' + dd + '/' + yy;
    }

    function shortStore(s) {
        return String(s || '').replace(/^CPR\s+/i, '').replace(/\s+OR$/i, '').trim().toUpperCase();
    }

    function qrSvg(text) {
        try {
            var qr = qrcode(0, 'M');
            qr.addData(String(text));
            qr.make();
            return qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
        } catch (e) { return ''; }
    }

    function buildLabel(row, ticket) {
        var el = document.createElement('div');
        el.className = 'mrt-send-label';
        el.innerHTML =
            '<div class="msl-top">' +
              '<span class="msl-store"></span>' +
              '<span class="msl-grade"></span>' +
            '</div>' +
            '<div class="msl-model"></div>' +
            '<div class="msl-ticket"></div>' +
            '<div class="msl-row">' +
              '<span class="msl-qr">' + qrSvg(ticket) + '</span>' +
              '<span class="msl-post">POST-REMOVAL' +
                '<span class="msl-chk"><span class="msl-box"></span>GOOD</span>' +
                '<span class="msl-chk"><span class="msl-box"></span>BAD</span>' +
              '</span>' +
            '</div>';
        el.querySelector('.msl-store').textContent = shortStore(row.store);
        el.querySelector('.msl-grade').textContent = String(row.status || '').toUpperCase();
        el.querySelector('.msl-model').textContent = row.model || '';
        el.querySelector('.msl-ticket').textContent = 'Ticket #' + ticket + ' · ' + fmtDate(row.captured_at);
        return el;
    }

    function injectStyles() {
        var st = document.createElement('style');
        st.textContent =
            '.mrt-send-label{page-break-before:always;width:2.25in;height:1.2in;overflow:hidden;' +
              'box-sizing:border-box;padding:0.05in 0.08in 0 0.08in;font-family:"Segoe UI",Arial,sans-serif;color:#000;text-align:left}' +
            '.msl-top{display:flex;align-items:center;justify-content:space-between;' +
              'border-bottom:2.5px solid #000;padding-bottom:1px;margin-bottom:2px}' +
            '.msl-store{font-size:12pt;font-weight:800;letter-spacing:.02em}' +
            '.msl-grade{font-size:9pt;font-weight:800;border:2px solid #000;border-radius:99px;padding:0 7px;line-height:1.35}' +
            '.msl-model{font-size:10pt;font-weight:800;line-height:1.1;white-space:nowrap}' +
            '.msl-ticket{font-size:8pt;color:#222;margin:1px 0 2px}' +
            '.msl-row{display:flex;align-items:center;gap:8px}' +
            '.msl-qr svg{width:0.52in;height:0.52in;display:block}' +
            '.msl-post{font-size:7pt;font-weight:800;display:flex;align-items:center;gap:4px;letter-spacing:.02em;white-space:nowrap}' +
            '.msl-chk{display:inline-flex;align-items:center;gap:2px}' +
            '.msl-box{display:inline-block;width:9px;height:9px;border:1.5px solid #000}' +
            '@media screen{.mrt-send-label{border:1px dashed #999;margin:8px auto}}';
        document.head.appendChild(st);
    }

    function run() {
        var ticket = getTicketId();
        if (!ticket) { releasePrint(); return; }

        msg({ type: 'lcd:get', ticket: ticket }).then(function (res) {
            var rows = (res && res.ok && res.rows) || [];
            // good-only tracking: bad displays are graded for the stats but
            // aren't box inventory — no send-display label for them
            rows = rows.filter(function (r) { return String(r.status).toLowerCase() === 'good'; });
            if (!rows.length) { releasePrint(); return; }

            var receipt = document.getElementsByClassName('print-receipt')[0];
            var host = receipt ? receipt.parentNode : document.body;
            injectStyles();
            rows.forEach(function (row) {
                var label = buildLabel(row, ticket);
                if (receipt) host.insertBefore(label, receipt.nextSibling);
                else host.appendChild(label);
                msg({ type: 'lcd:printed', payload: { ticket_no: ticket, item_key: row.item_key || '' } });
            });
            releasePrint();
        }).catch(releasePrint);
    }

    function start() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run);
        } else {
            run();
        }
    }

    // Kill switch: Options → LCD Buyback master toggle.
    chrome.storage.sync.get(['lcd']).then(function (res) {
        if (res && res.lcd && res.lcd.enabled === false) { releasePrint(); return; }
        start();
    }).catch(start);
})();
