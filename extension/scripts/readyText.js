/*
    Ready-for-Pickup text (myRepairTools)

    Runs on: cpr.repairq.io ticket edit / repair pages.

    Clicking RepairQ's "Ready for Pickup" status button pops a small chooser
    right off the button:

        Send "ready for pickup" text to:
          📱 SMS 541-…      (Customer[sms_phone], if set)
          📞 Primary 541-…  (Customer[pri_phone])
          📞 Alt 541-…      (Customer[alt_phone], if set)
          Don't send SMS

    Pick a number → the ready-for-pickup text goes out from the store line
    (logged with the tech's name + ticket #), then the status change
    proceeds. "Don't send" just proceeds. Numbers are read straight from the
    ticket's own customer fields — no profile lookup.

    Toggle: Options → RingCentral SMS (storage.sync sms.readyText, default ON).
*/

(function () {
    'use strict';

    var BTN_SEL = 'a.save-ticket.ready_for_pickup, #Btnready_for_pickup, a.save-ticket[action="ready_for_pickup"]';
    var bypass = false;   // set true to let our re-fired click through

    function val(id) { var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
    function digits(s) { return (s || '').replace(/\D/g, ''); }
    function pretty(n) {
        var d = digits(n);
        if (d.length === 11 && d[0] === '1') d = d.slice(1);
        return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : n;
    }

    // Read a value out of RepairQ's read-only <dl> customer summary by its
    // <dt> label ("Contact Number:", "Contact Method:", "Customer Name:").
    function ddFor(label) {
        var dts = document.querySelectorAll('dt');
        for (var i = 0; i < dts.length; i++) {
            var t = dts[i].textContent.replace(/\s+/g, ' ').trim().toLowerCase();
            if (t.indexOf(label.toLowerCase()) === 0) {
                var dd = dts[i].nextElementSibling;
                if (dd && dd.tagName === 'DD') return dd;
            }
        }
        return null;
    }

    function summaryPhones() {
        var dd = ddFor('contact number');
        if (!dd) return [];
        // the <dd> may hold several numbers separated by <br>
        return dd.innerHTML.split(/<br\s*\/?>/i)
            .map(function (s) { return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(); })
            .filter(function (x) { return digits(x).length >= 10; });
    }

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function customerEmail() {
        var dd = ddFor('email address');
        if (dd) { var t = dd.textContent.trim(); if (/@/.test(t)) return t; }
        var el = document.getElementById('Customer_email');
        if (el && /@/.test(el.value || '')) return el.value.trim();
        var a = document.querySelector('a[href^="mailto:"]');
        if (a) return a.getAttribute('href').replace(/^mailto:/, '').trim();
        return '';
    }

    function customer() {
        var phones = summaryPhones();
        // fallback: the Edit-Customer form inputs, if that form is open
        if (!phones.length) {
            [val('Customer_pri_phone'), val('Customer_alt_phone'), val('Customer_sms_phone')].forEach(function (p) {
                if (digits(p).length >= 10 && phones.indexOf(p) === -1) phones.push(p);
            });
        }
        // de-dup by digits
        var seen = {}, uniq = [];
        phones.forEach(function (p) { var d = digits(p); if (!seen[d]) { seen[d] = 1; uniq.push(p); } });

        var nameDd = ddFor('customer name');
        var name = nameDd ? nameDd.textContent.replace(/\s+/g, ' ').trim()
                          : (val('Customer_first_name') + ' ' + val('Customer_last_name')).trim();
        var methodDd = ddFor('contact method');
        return {
            first: (name.split(/\s+/)[0] || ''),
            phones: uniq,
            method: methodDd ? methodDd.textContent.replace(/\s+/g, ' ').trim() : '',
        };
    }

    function ticketNo() {
        // view pages are /ticket/<id> — no /view/ segment (bit us once: the
        // note write and sms_log ticket_no silently no-oped on view pages)
        var m = location.pathname.match(/\/ticket\/(?:edit\/|view\/)?(\d+)\b/);
        if (m) return m[1];
        var h = document.querySelector('#ticket h2 span, .ticket-number, [data-ticket-id]');
        var t = h && (h.getAttribute('data-ticket-id') || h.textContent);
        var mm = t && t.match(/(\d{5,})/);
        return mm ? mm[1] : '';
    }

    function device() {
        // repair line name, trimmed down to just the device model — cut off at
        // the repair-type keyword so "iPhone 17 Pro Max Screen Repair (OLED)…"
        // becomes "iPhone 17 Pro Max"
        var cell = document.querySelector('tr.ticket-item-row td.catalog-item-col, .repair-device .catalog-item');
        var raw = '';
        if (cell) {
            var clone = cell.cloneNode(true);
            clone.querySelectorAll('em, a, div, select, input').forEach(function (n) { n.remove(); });
            raw = clone.textContent.replace(/\s+/g, ' ').trim();
        }
        if (!raw) return '';
        var cut = raw.split(/\b(?:screen|battery|charging|back\s*glass|lcd|oled|camera|glass|board)?\s*(?:repair|replacement)\b/i)[0].trim();
        cut = cut.replace(/^Apple\s+|^Samsung\s+|^Google\s+/i, '').trim();   // drop the brand prefix, friendlier
        return (cut.length >= 3 && cut.length <= 34) ? cut : '';
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

    function defaultMessage(c) {
        var name = c.first ? c.first : 'there';
        var dev = device();
        var subj = dev ? 'your ' + dev + ' is' : 'your repair is';
        return 'Hi ' + name + ', ' + subj + ' ready for pickup at ' + storeName() +
               '! Come by during business hours — see you soon.';
    }

    /* ---------------- popup ---------------- */

    function closePopup() {
        var p = document.getElementById('mrt-rfp-pop');
        if (p) p.remove();
        document.removeEventListener('click', outsideClose, true);
    }
    function outsideClose(e) {
        var p = document.getElementById('mrt-rfp-pop');
        if (p && !p.contains(e.target)) closePopup();
    }

    function proceed(btn) {
        bypass = true;
        closePopup();
        btn.click();                 // re-fire the real status change
        setTimeout(function () { bypass = false; }, 1500);
    }

    // The manual chooser (no saved follow-up, or the tech skipped at
    // check-in): every way to reach the customer this ticket knows about —
    // text either number, call either number, email, or nothing.
    function popup(btn) {
        closePopup();
        var c = customer();
        var email = customerEmail();
        var tag = function (i) { return i === 0 ? 'Primary' : 'Alt'; };

        var rows = '';
        c.phones.forEach(function (num, i) {
            rows += '<button class="mrt-rfp-row" data-act="text" data-num="' + digits(num) + '">' +
                    '<b>Text</b>' + pretty(num) + '<span class="mrt-rfp-tag">' + tag(i) + '</span></button>';
        });
        c.phones.forEach(function (num, i) {
            rows += '<button class="mrt-rfp-row" data-act="call" data-num="' + digits(num) + '">' +
                    '<b>Call</b>' + pretty(num) + '<span class="mrt-rfp-tag">' + tag(i) + '</span></button>';
        });
        if (email) {
            rows += '<button class="mrt-rfp-row" data-act="email" data-email="' + esc(email) + '">' +
                    '<b>Email</b><span class="mrt-rfp-em">' + esc(email) + '</span></button>';
        }
        if (!rows) rows = '<div class="mrt-rfp-none">No contact info on this ticket</div>';

        var pop = document.createElement('div');
        pop.id = 'mrt-rfp-pop';
        pop.className = 'mrt-rfp-pop';
        pop.innerHTML =
            '<div class="mrt-rfp-hd"><h4>Ready For Pickup</h4></div>' +
            '<div class="mrt-rfp-body">' +
              '<div class="mrt-rfp-q">How should we let the customer know?</div>' +
              (c.method ? '<div class="mrt-rfp-note">Ticket contact method: ' + esc(c.method) + '</div>' : '') +
              rows +
            '</div>' +
            '<button class="mrt-rfp-skip">Don’t Send Anything — Just Change Status</button>';

        // anchor above the button
        var r = btn.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 320)) + 'px';
        pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
        document.body.appendChild(pop);
        setTimeout(function () { document.addEventListener('click', outsideClose, true); }, 0);

        pop.querySelectorAll('.mrt-rfp-row').forEach(function (b) {
            b.addEventListener('click', function () {
                var act = b.getAttribute('data-act');
                if (act === 'text') {
                    var num = b.getAttribute('data-num');
                    b.innerHTML = 'Sending…'; b.disabled = true;
                    var payload = {
                        to: num, body: defaultMessage(c), ticket_no: ticketNo(), store: storeName(),
                        template_key: 'ready_for_pickup', agent_name: techName(),
                    };
                    sendSms(payload, function (res) {
                        if (res && res.ok) {
                            b.innerHTML = '✓ Sent';
                            writeNote('📣 Ready-for-pickup text sent to ' + pretty(num) + ' — myRepairTools (' + (techName() || 'staff') + ')');
                        }
                        else { b.innerHTML = ((res && res.error) || 'Failed') + ' — proceeding'; }
                        setTimeout(function () { proceed(btn); }, res && res.ok ? 550 : 1400);
                    });
                } else if (act === 'call') {
                    infoToast('Call the customer: <b>' + pretty(b.getAttribute('data-num')) + '</b>', 4200);
                    proceed(btn);
                } else if (act === 'email') {
                    var em = b.getAttribute('data-email') || '';
                    try { navigator.clipboard.writeText(em); } catch (e) {}
                    infoToast('Email the customer: <b>' + esc(em) + '</b> (copied)', 4200);
                    proceed(btn);
                }
            });
        });
        pop.querySelector('.mrt-rfp-skip').addEventListener('click', function () { proceed(btn); });
    }

    function sendSms(payload, cb) {
        try {
            chrome.runtime.sendMessage({ type: 'sms:send', payload: payload }, function (res) {
                cb(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
            });
        } catch (e) { cb({ ok: false, error: String(e && e.message || e) }); }
    }

    // Every automated send gets logged on the ticket itself (Kade's rule) —
    // the note is the record techs actually read. keepalive lets the write
    // survive the page turn that follows the status change.
    function writeNote(text) {
        var csrf = (document.getElementsByName('YII_CSRF_TOKEN')[0] || {}).value;
        var id = ticketNo();
        if (!csrf || !id) return;
        var body = new URLSearchParams({
            YII_CSRF_TOKEN: csrf, ticketId: id, note: text, print: '0', important: '0',
        });
        fetch('/ajax/ticketNote/save', {
            method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
            body: body.toString(),
        }).catch(function () { /* log only */ });
    }

    function fn(action, payload) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ type: 'sms:' + action, payload: payload }, function (r) {
                    res(chrome.runtime.lastError ? { ok: false } : r);
                });
            } catch (e) { res({ ok: false }); }
        });
    }

    /* ---------------- saved follow-up preference ---------------- */

    // A quick, self-dismissing toast (used for call/email/return, where we
    // don't send an SMS but want to remind the tech what the customer picked).
    function infoToast(html, ms) {
        var t = document.createElement('div');
        t.id = 'mrt-rfp-toast'; t.className = 'mrt-rfp-toast';
        t.innerHTML = html;
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, ms || 2600);
    }

    // Auto-send the ready text to the number the customer gave at check-in,
    // with a 5-second undo window before it actually goes out.
    function autoSend(btn, contact) {
        var c = customer();
        var first = (contact.contact_name && contact.contact_name.trim().split(/\s+/)[0]) || c.first;
        var num = digits(contact.contact_number);
        if (num.length < 10) { popup(btn); return; }   // saved number looks bad — let them pick
        var body = defaultMessage({ first: first });

        var cancelled = false, timer;
        var toast = document.createElement('div');
        toast.id = 'mrt-rfp-toast'; toast.className = 'mrt-rfp-toast';
        toast.innerHTML =
            '<span class="mrt-rfp-toast-msg">Texting <b>' + pretty(num) + '</b>…</span>' +
            '<button class="mrt-rfp-undo">Undo</button>';
        document.body.appendChild(toast);
        var msg = toast.querySelector('.mrt-rfp-toast-msg');
        var undo = toast.querySelector('.mrt-rfp-undo');

        function commit() {
            if (cancelled) return;
            msg.textContent = 'Sending…';
            if (undo) undo.remove();
            sendSms({ to: num, body: body, ticket_no: ticketNo(), store: storeName(), template_key: 'ready_for_pickup', agent_name: techName() }, function (res) {
                var ok = res && res.ok;
                msg.textContent = ok ? '✓ Text sent' : '⚠ ' + ((res && res.error) || 'failed');
                if (ok) writeNote('📣 Ready-for-pickup text auto-sent to ' + pretty(num) + ' (saved follow-up) — myRepairTools (' + (techName() || 'staff') + ')');
                setTimeout(function () { toast.remove(); proceed(btn); }, ok ? 650 : 1500);
            });
        }
        undo.addEventListener('click', function () {
            cancelled = true; clearTimeout(timer);
            msg.textContent = 'Text canceled'; undo.remove();
            setTimeout(function () { toast.remove(); proceed(btn); }, 700);
        });
        timer = setTimeout(commit, 5000);
    }

    /* ---------------- intercept ---------------- */

    function onClick(e) {
        if (bypass) return;
        var btn = e.target.closest && e.target.closest(BTN_SEL);
        if (!btn) return;
        e.preventDefault();
        e.stopImmediatePropagation();

        var t = ticketNo();
        if (!t) { popup(btn); return; }
        // Check the follow-up preference captured at check-in.
        fn('contact_get', { ticket_no: t }).then(function (r) {
            var ct = r && r.contact;
            if (ct && ct.method === 'skip') { popup(btn); return; }   // skipped at check-in — manual chooser
            if (ct && ct.method === 'text') { autoSend(btn, ct); return; }
            if (ct && ct.method === 'call') {
                infoToast('Customer asked for a <b>call</b> — ' + pretty(ct.contact_number || ''), 3600);
                proceed(btn); return;
            }
            if (ct && ct.method === 'email') {
                infoToast('Customer prefers <b>email</b> — <b>' + esc(ct.contact_email || '') + '</b>', 3600);
                proceed(btn); return;
            }
            if (ct && ct.method === 'return') {
                infoToast('Customer will <b>return</b> — no message sent', 2800);
                proceed(btn); return;
            }
            popup(btn);   // no saved preference — the manual chooser
        });
    }

    function start() {
        document.addEventListener('click', onClick, true);   // capture, ahead of RepairQ
    }

    try {
        chrome.storage.sync.get(['sms']).then(function (res) {
            var s = (res && res.sms) || {};
            if (s.readyText === false) return;
            if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
        }).catch(start);
    } catch (e) { start(); }
})();
