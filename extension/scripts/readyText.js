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


    var BTN_SEL = 'a.save-ticket.ready_for_pickup, #Btnready_for_pickup, a.save-ticket[action="ready_for_pickup"]';
    var bypass = false;   // set true to let our re-fired click through
    // Enabled follow-up channels (Options → RingCentral SMS). SMS on by default;
    // call/email off until those integrations are set up for the store.
    var CH = { sendSms: true, sendCall: false, sendEmail: false };

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

    // The editable template (from MRT Settings → RingCentral) with its short
    // codes, and the store-hours cache the Promise-Time feature parses off the
    // page. Both are preloaded on init so the message renders synchronously at
    // send time; if the template hasn't loaded we fall back to built-in wording.
    var TPL = null;                 // template body string, or null → built-in
    var HRS = null;                 // { store: { days: {0..6:{open,close}|null} } }

    function tplKey() { return 'mrtTpl_ready_for_pickup'; }

    function loadTemplate() {
        var ck = tplKey();
        try {
            chrome.storage.local.get([ck, 'mrt_store_hours']).then(function (r) {
                if (r) { if (r[ck]) TPL = r[ck]; if (r.mrt_store_hours) HRS = r.mrt_store_hours; }
                // refresh the template for this store in the background
                fn('template_get', { key: 'ready_for_pickup', store: storeName() }).then(function (res) {
                    if (res && res.ok && res.body) {
                        TPL = res.body;
                        var o = {}; o[ck] = res.body; try { chrome.storage.local.set(o); } catch (e) {}
                    }
                });
            }).catch(function () {});
        } catch (e) {}
    }

    // "10:00:00" → "10am", "19:30:00" → "7:30pm"
    function fmt12(hhmmss) {
        var m = /^(\d{1,2}):(\d{2})/.exec(hhmmss || ''); if (!m) return '';
        var h = +m[1], mm = +m[2], ap = h < 12 ? 'am' : 'pm', h12 = h % 12 || 12;
        return h12 + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '') + ap;
    }
    // today's store hours as "10am–7pm" (best effort; '' if unknown/closed)
    function hoursToday() {
        var cache = HRS; if (!cache) return '';
        var keys = Object.keys(cache).filter(function (k) { return k !== 'default'; });
        var rec = cache[storeName()] || (keys.length === 1 ? cache[keys[0]] : cache['default']);
        if (!rec || !rec.days) return '';
        var d = rec.days[new Date().getDay()];
        if (d === null) return 'closed today';
        if (!d || !d.open || !d.close) return '';
        var o = fmt12(d.open), c = fmt12(d.close);
        return (o && c) ? (o + '–' + c) : '';
    }

    // Fill the short codes. Unknown/empty values degrade gracefully so the
    // sentence still reads (e.g. {device} → "device", {hours} → "our hours").
    function renderTemplate(tpl, c) {
        var name  = (c && c.first) ? c.first : 'there';
        var dev   = device() || 'device';
        var store = storeName();
        var tech  = techName() || '';
        var hrs   = hoursToday() || 'our business hours';
        return String(tpl)
            .replace(/\{(name|first)\}/gi, name)
            .replace(/\{device\}/gi, dev)
            .replace(/\{(store|location)\}/gi, store)
            .replace(/\{tech\}/gi, tech)
            .replace(/\{hours\}/gi, hrs)
            .replace(/[ \t]{2,}/g, ' ').trim();   // tidy up if a code rendered empty
    }

    function defaultMessage(c) {
        if (TPL) return renderTemplate(TPL, c);
        // built-in fallback — mirrors the seeded default template wording
        var name = c && c.first ? c.first : 'there';
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

    function proceed(btn, noteText) {
        bypass = true;
        closePopup();
        // Record our informational note directly through the ajax endpoint
        // (guarded against blanks). We deliberately DON'T touch RepairQ's own
        // "Add Note" modal: its textarea is Backbone-backed, so a raw value set
        // doesn't reach the model it serializes on submit — clicking that
        // modal's Save posted an EMPTY note ("Note cannot be blank"), which also
        // blocked the status change. CPR stores don't require a note on this
        // transition; if a store ever does, RepairQ pops its modal for the tech
        // to fill by hand. Net: our note lands, the status change goes through.
        var go = function () {
            btn.click();              // re-fire the real status change
            setTimeout(function () { bypass = false; }, 1500);
        };
        if (noteText) {
            // Land the note BEFORE the status change navigates the page away.
            // The bg.js path survives navigation anyway, so the cap firing
            // early doesn't lose the note — this wait just favors the note
            // being visible when the page comes back. Capped so a hung
            // request can never hold the button hostage.
            var done = false;
            var once = function () { if (!done) { done = true; go(); } };
            writeNote(noteText).then(once, once);
            setTimeout(once, 2600);
        } else {
            go();
        }
    }

    // The manual chooser (no saved follow-up, or the tech skipped at
    // check-in): every way to reach the customer this ticket knows about —
    // text either number, call either number, email, or nothing.
    function popup(btn) {
        closePopup();
        var c = customer();
        var email = customerEmail();
        var tag = function (i) { return i === 0 ? 'Primary' : 'Alt'; };

        // Every channel is always offered; the toggle only decides auto vs manual.
        var rows = '';
        c.phones.forEach(function (num, i) {
            rows += '<button class="mrt-rfp-row" data-act="text" data-num="' + digits(num) + '" data-auto="' + (CH.sendSms ? '1' : '') + '">' +
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
        if (!rows) rows = '<div class="mrt-rfp-none">No contact info on this ticket — just changing status</div>';

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
                if (act === 'text' && !b.getAttribute('data-auto')) {
                    // texting is manual for this store — remind, don't auto-send
                    infoToast('Text the customer: <b>' + pretty(b.getAttribute('data-num')) + '</b>', 4200);
                    proceed(btn); return;
                }
                if (act === 'text') {
                    var num = b.getAttribute('data-num');
                    b.innerHTML = 'Sending…'; b.disabled = true;
                    var payload = {
                        to: num, body: defaultMessage(c), ticket_no: ticketNo(), store: storeName(),
                        template_key: 'ready_for_pickup', agent_name: techName(),
                    };
                    sendSms(payload, function (res) {
                        var ok = res && res.ok;
                        b.innerHTML = ok ? '✓ Sent' : (((res && res.error) || 'Failed') + ' — proceeding');
                        var note = ok ? 'Ready-for-pickup text sent to ' + pretty(num) + ' — myRepairTools (' + (techName() || 'staff') + ')' : null;
                        setTimeout(function () { proceed(btn, note); }, ok ? 550 : 1400);
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
    // the note is the record techs actually read. The write goes through
    // bg.js ('note:save'): the service worker outlives the page turn that
    // follows the status change, so navigation can't kill the request the
    // way it killed content-script fetches (why these notes were missing
    // for weeks). Page-context fetch stays as the fallback, and a note that
    // fails BOTH paths files a silent debug row on extension_issues.
    function writeNote(text) {
        // RepairQ's DB is 3-byte MySQL utf8: a 4-byte char (most emoji) silently
        // truncates the note from that char on — a leading emoji stores a BLANK
        // note, and blank notes block the ticket from saving. Strip them.
        text = String(text == null ? '' : text).replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim();
        if (!text) return Promise.resolve();   // never POST a blank note (RepairQ rejects it → global "save the ticket" error modal)
        var csrf = (document.getElementsByName('YII_CSRF_TOKEN')[0] || {}).value;
        var id = ticketNo();
        if (!csrf || !id) { noteDebug('skipped: csrf=' + !!csrf + ' ticket=' + (id || 'none')); return Promise.resolve(); }
        return new Promise(function (resolve) {
            var fallback = function (why) {
                fetch('/ajax/ticketNote/save', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
                    body: new URLSearchParams({ YII_CSRF_TOKEN: csrf, ticketId: id, note: text, print: '0', important: '0' }).toString(),
                }).then(function (r) { return r.text().then(function (t) {
                    if (!(r.ok && /"success"\s*:\s*true/.test(t))) noteDebug('bg: ' + why + ' | page: HTTP ' + r.status + ' ' + String(t).slice(0, 140));
                    resolve();
                }); }).catch(function (e) { noteDebug('bg: ' + why + ' | page: ' + String(e && e.message || e)); resolve(); });
            };
            try {
                chrome.runtime.sendMessage({ type: 'note:save', payload: { ticketId: id, note: text, csrf: csrf } }, function (res) {
                    if (chrome.runtime.lastError) return fallback(chrome.runtime.lastError.message);
                    if (res && res.ok) return resolve();
                    fallback((res && (res.error || ('HTTP ' + res.status + ' ' + (res.body || '')))) || 'no response');
                });
            } catch (e) { fallback(String(e && e.message || e)); }
        });
    }

    // both write paths failed — file a silent debug row so it's diagnosable
    // remotely (report-issue kind:'debug' skips the owner SMS)
    function noteDebug(detail) {
        try {
            chrome.runtime.sendMessage({ type: 'issue:report', payload: {
                kind: 'debug', message: 'readyText writeNote: ' + detail,
                ticket_no: ticketNo(), url: location.href.slice(0, 180),
                store: storeName(), reporter: techName() || null,
                ext_version: (chrome.runtime.getManifest() || {}).version,
            } }, function () { void chrome.runtime.lastError; });
        } catch (e) { /* diagnostics only */ }
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

    // Which line is this — the ticket's Primary or Alt number? Shown in the
    // confirm so the tech sees exactly who we're about to reach.
    function numberTag(num) {
        var d = digits(num);
        var phones = customer().phones.map(digits);
        var idx = phones.indexOf(d);
        if (idx === 0) return 'Primary';
        if (idx > 0)  return 'Alt';
        return '';
    }

    // Fire the automated contact the customer asked for (text or call), then let
    // the status change proceed. Feedback rides a bottom toast — no undo, the tech
    // already confirmed it in the popup.
    function runContact(btn, contact, method) {
        var c = customer();
        var first = (contact.contact_name && contact.contact_name.trim().split(/\s+/)[0]) || c.first;
        var num = digits(contact.contact_number);
        var calling = method === 'call';

        var toast = document.createElement('div');
        toast.id = 'mrt-rfp-toast'; toast.className = 'mrt-rfp-toast';
        toast.innerHTML = '<span class="mrt-rfp-toast-msg">' + (calling ? 'Placing call to' : 'Texting') + ' <b>' + pretty(num) + '</b>…</span>';
        document.body.appendChild(toast);
        var msg = toast.querySelector('.mrt-rfp-toast-msg');

        if (calling) {
            try {
                chrome.runtime.sendMessage({ type: 'call:place', payload: {
                    to: num, store: storeName(), ticket_no: ticketNo(),
                    template_key: 'ready_for_pickup', agent_name: techName(),
                    customer_name: first, device: device(),
                } }, function (res) {
                    var r = chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res;
                    var ok = r && r.ok;
                    msg.textContent = ok ? '✓ Call placed' : '⚠ ' + ((r && r.error) || 'call failed');
                    var note = ok
                        ? 'Automated ready-for-pickup call placed to ' + pretty(num) + ' — myRepairTools (' + (techName() || 'staff') + ')'
                        : 'Ready for pickup — automated call to ' + pretty(num) + ' did not place — myRepairTools (' + (techName() || 'staff') + ')';
                    setTimeout(function () { toast.remove(); proceed(btn, note); }, ok ? 650 : 2200);
                });
            } catch (e) {
                msg.textContent = '⚠ ' + String(e && e.message || e);
                setTimeout(function () { toast.remove(); proceed(btn); }, 2200);
            }
        } else {
            sendSms({ to: num, body: defaultMessage({ first: first }), ticket_no: ticketNo(), store: storeName(), template_key: 'ready_for_pickup', agent_name: techName() }, function (res) {
                var ok = res && res.ok;
                msg.textContent = ok ? '✓ Text sent' : '⚠ ' + ((res && res.error) || 'failed');
                var note = ok
                    ? 'Ready-for-pickup text sent to ' + pretty(num) + ' — myRepairTools (' + (techName() || 'staff') + ')'
                    : 'Ready for pickup — automated text to ' + pretty(num) + ' did not send — myRepairTools (' + (techName() || 'staff') + ')';
                setTimeout(function () { toast.remove(); proceed(btn, note); }, ok ? 650 : 1500);
            });
        }
    }

    // The customer asked for an automated text or call at check-in. Confirm
    // before it runs — two choices, anchored above the Ready-for-Pickup button:
    //   1) Confirm <Call|Text> to <Primary|Alt> <number>  → fires the automation
    //   2) Proceed without automated contact               → just changes status
    function confirmAuto(btn, contact, method) {
        closePopup();
        var num = digits(contact.contact_number);
        if (num.length < 10) { popup(btn); return; }   // saved number looks bad — full chooser
        var verb = method === 'call' ? 'Call' : 'Text';
        var tag  = numberTag(num);
        var who  = (tag ? tag + ' ' : '') + pretty(num);

        var pop = document.createElement('div');
        pop.id = 'mrt-rfp-pop';
        pop.className = 'mrt-rfp-pop';
        pop.innerHTML =
            '<div class="mrt-rfp-hd"><h4>Ready For Pickup</h4></div>' +
            '<div class="mrt-rfp-body">' +
              '<div class="mrt-rfp-q">Customer asked for a ' + (method === 'call' ? 'call' : 'text') + '. Confirm before it goes out:</div>' +
              '<button class="mrt-rfp-row mrt-rfp-confirm">Confirm ' + verb + ' to ' + esc(who) + '</button>' +
            '</div>' +
            '<button class="mrt-rfp-skip">Proceed without automated contact</button>';

        var r = btn.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 320)) + 'px';
        pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
        document.body.appendChild(pop);
        setTimeout(function () { document.addEventListener('click', outsideClose, true); }, 0);

        pop.querySelector('.mrt-rfp-confirm').addEventListener('click', function () {
            closePopup();
            runContact(btn, contact, method);
        });
        pop.querySelector('.mrt-rfp-skip').addEventListener('click', function () { proceed(btn); });
    }

    /* ---------------- intercept ---------------- */

    function onClick(e) {
        if (bypass) return;
        var btn = e.target.closest && e.target.closest(BTN_SEL);
        if (!btn) return;
        e.preventDefault();
        e.stopImmediatePropagation();

        // ticket types opted out in Options → Ticket-Type Rules save natively
        if (!ttAllows('ready')) { proceed(btn); return; }
        var t = ticketNo();
        if (!t) { popup(btn); return; }
        // Check the follow-up preference captured at check-in.
        fn('contact_get', { ticket_no: t }).then(function (r) {
            var ct = r && r.contact;
            if (ct && ct.method === 'skip') { popup(btn); return; }   // skipped at check-in — manual chooser
            if (ct && ct.method === 'text') {
                if (CH.sendSms) { confirmAuto(btn, ct, 'text'); }
                else { infoToast('Customer prefers a <b>text</b> — <b>' + esc(ct.contact_number || '') + '</b> (text manually)', 3600); proceed(btn); }
                return;
            }
            if (ct && ct.method === 'call') {
                if (CH.sendCall) { confirmAuto(btn, ct, 'call'); }
                else { infoToast('Customer prefers a <b>call</b> — <b>' + esc(ct.contact_number || '') + '</b> (call manually)', 3600); proceed(btn); }
                return;
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
        loadTemplate();                                        // preload the editable template + store hours
    }

    try {
        chrome.storage.sync.get(['sms', 'tt']).then(function (res) {
            var s = (res && res.sms) || {};
            TT = (res && res.tt) || null;
            // per-channel gates. SMS defaults on (legacy readyText fallback); call/email off.
            CH.sendSms = s.sendSms !== undefined ? s.sendSms : (s.readyText !== false);
            CH.sendCall = s.sendCall === true;
            CH.sendEmail = s.sendEmail === true;
            // Run the Ready-for-Pickup handler if the follow-up system is on in any form.
            var anyOn = (s.followUp !== false) || CH.sendSms || CH.sendCall || CH.sendEmail;
            if (!anyOn) return;
            if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
        }).catch(start);
    } catch (e) { start(); }
})();
