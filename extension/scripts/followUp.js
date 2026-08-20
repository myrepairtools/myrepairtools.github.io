/*
    Check-in follow-up capture (myRepairTools)

    Runs on: cpr.repairq.io/ticket/* (view + edit pages).

    At check-in we record how the customer wants to hear their repair is
    ready, and the contact info FOR THIS VISIT (not the customer profile —
    it may be a different phone/person each time). Stored per-ticket in
    Supabase `ticket_contacts` + written to a RepairQ ticket note as a
    permanent backup; the Supabase row is deleted when the ticket closes.

    Flow:
      - New ticket → right after the first save the ticket page loads; if no
        follow-up is set yet we pop the capture modal (once per ticket).
      - A "📞 Follow-up: …" chip sits by the customer summary on every visit,
        so a tech can change it later (number changed, switched to a call).
      - Ready-for-Pickup (readyText.js) reads the saved method: text →
        auto-send; call → (Twilio, later); email/return → skip.

    Toggle: Options → RingCentral SMS (storage.sync sms.followUp, default ON).
*/

(function () {
    'use strict';

    var METHODS = [
        { v: 'text',   label: 'Text',  req: 'sendSms' },
        { v: 'call',   label: 'Call',  req: 'sendCall' },
        { v: 'email',  label: 'Email', req: 'sendEmail' },
        { v: 'return', label: 'Customer to Return' },   // no channel needed
    ];
    // Channel automation (Options → RingCentral SMS). ON = the extension handles
    // it automatically (auto-text / auto-call at Ready-for-Pickup); OFF = still
    // offered here, just handled manually by the tech. SMS defaults on; call/email off.
    var CH = { sendSms: true, sendCall: false, sendEmail: false };
    // Every method is always offered now; the toggle only changes auto vs manual.
    function enabledMethods() { return METHODS.slice(); }
    // small "automated" / "manual" tag under a method (channels only; return has none)
    function methodMode(m) { return m.req ? (CH[m.req] ? 'automated' : 'manual') : ''; }

    function digits(s) { return (s || '').replace(/\D/g, ''); }
    function pretty(n) {
        var d = digits(n); if (d.length === 11 && d[0] === '1') d = d.slice(1);
        return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : (n || '');
    }
    function ticketNo() {
        var m = location.pathname.match(/\/ticket\/(?:edit\/|view\/)?(\d+)\b/);
        return m ? m[1] : '';
    }
    function isClosedPage() {
        var s = document.querySelector('#summary > div:nth-child(2) > span, #summary .status');
        var t = (s ? s.textContent : document.body.textContent).toLowerCase();
        // only used to avoid auto-popping on finished tickets
        return /\b(closed|invoiced|void|picked up)\b/.test((s && s.textContent || '').toLowerCase());
    }
    // A freshly-created ticket shows status "New"/"New Claim" — the first status
    // label in the summary block. Used to auto-pop the follow-up modal right after
    // check-in regardless of which create URL RepairQ used.
    function isNewStatus() {
        var el = document.querySelector('#summary .block-content span.fullsize.label, #summary .block-content span.label');
        var s = el ? el.textContent.replace(/\s+/g, ' ').trim().toLowerCase() : '';
        return s === 'new' || s === 'new claim';
    }

    /* --- scrape the ticket's own numbers/email for suggestions --- */
    function ddFor(label) {
        var dts = document.querySelectorAll('dt');
        for (var i = 0; i < dts.length; i++) {
            if (dts[i].textContent.replace(/\s+/g, ' ').trim().toLowerCase().indexOf(label.toLowerCase()) === 0) {
                var dd = dts[i].nextElementSibling;
                if (dd && dd.tagName === 'DD') return dd;
            }
        }
        return null;
    }
    function suggestedPhones() {
        var out = [], dd = ddFor('contact number');
        if (dd) dd.innerHTML.split(/<br\s*\/?>/i).forEach(function (s) {
            var v = s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
            if (digits(v).length >= 10) out.push(v);
        });
        ['Customer_pri_phone', 'Customer_alt_phone', 'Customer_sms_phone'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && digits(el.value).length >= 10 && out.indexOf(el.value) === -1) out.push(el.value);
        });
        // view-page sidebar: no <dt> labels — pull phone-shaped strings out of
        // the Customer block's text instead
        if (!out.length) {
            var cb = customerBlock();
            var m = cb ? (cb.textContent.match(/\(?\d{3}\)?[\s.-]?\d{3}[-.\s]?\d{4}/g) || []) : [];
            m.forEach(function (v) { if (digits(v).length >= 10) out.push(v); });
        }
        var seen = {}, uniq = [];
        out.forEach(function (p) { var d = digits(p); if (!seen[d]) { seen[d] = 1; uniq.push(p); } });
        return uniq.map(function (p, i) { return { num: p, tag: i === 0 ? 'Primary' : 'Alt' }; });
    }
    function suggestedEmail() {
        var dd = ddFor('email address'); if (dd) { var t = dd.textContent.trim(); if (/@/.test(t)) return t; }
        var el = document.getElementById('Customer_email'); if (el && el.value) return el.value;
        var cb = customerBlock();
        if (cb) {
            var a = cb.querySelector('a[href^="mailto:"]');
            if (a) return a.getAttribute('href').replace(/^mailto:/, '').trim();
            var m = cb.textContent.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
            if (m) return m[0];
        }
        return '';
    }
    /* RepairQ's own customer id, off the /customers/<id> link that BOTH the
       check-in form (once a customer is chosen) and the ticket sidebar carry.
       This is the only stable identity available on both sides of the stash.
       A phone number is not: the whole documented purpose of the stash is to
       capture the contact for THIS VISIT, which may be a number that isn't on
       the customer's record at all. Returns '' when no customer is on the page,
       which callers must treat as "cannot identify", never as "no match". */
    function customerId() {
        try {
            var sel = 'a[href*="/customers/"]';
            var cb = customerBlock();
            var cust = document.querySelector('#customer');
            var a = (cb && cb.querySelector(sel))
                 || (cust && cust.querySelector(sel))
                 || document.querySelector('.block-content ' + sel);
            var m = a && (a.getAttribute('href') || '').match(/\/customers\/(\d+)/);
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }

    function customerFirst() {
        var dd = ddFor('customer name'); var n = dd ? dd.textContent.trim()
            : ((document.getElementById('Customer_first_name') || {}).value || '');
        if (!n) {
            // view-page sidebar: the customer is a /customers/ link, "Last, First"
            var cb = customerBlock();
            var a = cb ? cb.querySelector('a[href*="/customers/"]') : null;
            if (a) {
                var t = a.textContent.replace(/\s+/g, ' ').trim();
                n = t.indexOf(',') > -1 ? t.split(',')[1].trim() : t;
            }
        }
        return (n.split(/\s+/)[0] || '');
    }
    function storeName() {
        var t = document.querySelector('.location.tooltip-toggle span'); return (t && t.textContent.trim()) || '';
    }
    function techName() {
        var el = document.getElementById('user_dropdown'); if (!el) return '';
        var raw = el.textContent.replace(/\s+/g, ' ').trim(), m = raw.match(/^([^,]+),\s*(.+)$/);
        return m ? (m[2] + ' ' + m[1]).trim() : raw;
    }

    /* --- backend via bg.js → messaging function --- */
    function fn(action, payload) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ type: 'sms:' + action, payload: payload }, function (r) {
                    res(chrome.runtime.lastError ? { ok: false } : r);
                });
            } catch (e) { res({ ok: false }); }
        });
    }

    function fuToast(text, isErr) {
        try {
            var t = document.createElement('div');
            t.className = 'mrt-fu-toast' + (isErr ? ' err' : '');
            t.textContent = text;
            document.body.appendChild(t);
            setTimeout(function () { t.classList.add('show'); }, 20);
            setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, isErr ? 6000 : 2600);
        } catch (e) { /* cosmetic */ }
    }

    /* A save that didn't save must SAY so. contact_set was fire-and-forget:
       the chip rendered "saved", the modal closed, and a forbidden or a DB
       error left no preference on the ticket and no trace anywhere — so at
       pickup readyText logged 'pref: none' and showed the manual chooser
       instead of texting. Half of staff report #3106. The RepairQ backup note
       is still written either way, so the answer is never wholly lost. */
    function contactSet(payload, what) {
        return fn('contact_set', payload).then(function (r) {
            if (r && r.ok) return true;
            var why = (r && r.error) || 'no response';
            noteDebug('contact_set failed (' + (what || payload.method) + '): ' + why);
            current = null;
            try { renderChip(); } catch (e) {}
            fuToast('⚠ Follow-up NOT saved — ' + why + '. The ticket note was still written.', true);
            return false;
        });
    }

    /* a note that never gets written must leave a trace — silent failures are
       how this went unnoticed until someone read the ticket */
    function noteDebug(detail) {
        try {
            chrome.runtime.sendMessage({
                type: 'issue:report',
                payload: {
                    kind: 'debug', message: 'followUp note: ' + detail,
                    ticket_no: ticketNo() || '', url: location.href,
                    ext_version: (chrome.runtime.getManifest() || {}).version || '',
                },
            }, function () { void chrome.runtime.lastError; });
        } catch (e) { /* diagnostics only */ }
    }

    /* --- write the ticket-note backup (best effort) --- */
    function writeNote(text) {
        // RepairQ's DB is 3-byte MySQL utf8: a 4-byte char (most emoji) silently
        // truncates the note from that char on — a leading emoji stores a BLANK
        // note, and blank notes block the ticket from saving. Strip them.
        text = String(text == null ? '' : text).replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim();
        if (!text) return;   // never POST a blank note (RepairQ rejects it → global "save the ticket" error modal)
        // CSRF lives in a hidden input on most RepairQ pages, but not all of
        // them — look wider, and if it still isn't here, hand the write to
        // bg.js anyway: its in-tab path reads the token from the page itself.
        // (Bailing silently here is why notes went missing with nothing logged.)
        var cookieTok = '';
        // document.cookie throws in sandboxed/opaque documents — never let the
        // lookup itself be what stops the note from being written
        try { cookieTok = (String(document.cookie).match(/(?:^|;\s*)YII_CSRF_TOKEN=([^;]+)/) || [])[1] || ''; } catch (e) { cookieTok = ''; }
        var csrf = (document.getElementsByName('YII_CSRF_TOKEN')[0] || {}).value
            || (document.querySelector('input[name="YII_CSRF_TOKEN"]') || {}).value
            || (document.querySelector('meta[name="csrf-token"]') || {}).content
            || cookieTok
            || '';
        try { csrf = csrf ? decodeURIComponent(csrf) : ''; } catch (e) { /* raw value */ }
        var id = ticketNo();
        if (!id) { noteDebug('no ticket id'); return; }
        // bg.js path first — the service worker outlives any page turn, so the
        // write can't be killed by navigation; page fetch stays as fallback
        var pageFetch = function () {
            if (!csrf) { noteDebug('no csrf in page and bg path failed'); return; }
            fetch('/ajax/ticketNote/save', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
                body: new URLSearchParams({ YII_CSRF_TOKEN: csrf, ticketId: id, note: text, print: '0', important: '0' }).toString(),
            }).catch(function () { /* backup only */ });
        };
        try {
            chrome.runtime.sendMessage({ type: 'note:save', payload: { ticketId: id, note: text, csrf: csrf } }, function (res) {
                if (chrome.runtime.lastError || !(res && res.ok)) pageFetch();
            });
        } catch (e) { pageFetch(); }
    }

    function methodLabel(v) { var m = METHODS.filter(function (x) { return x.v === v; })[0]; return m ? m.label : v; }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    /* ---------------- modal ---------------- */

    var current = null;   // last-known contact for this ticket

    function openModal(existing) {
        closeModal();
        var phones = suggestedPhones();
        var pick = (existing && existing.method !== 'skip') ? existing : {};
        var avail = enabledMethods();
        // default to the saved method (if its channel is still on), else the first enabled one.
        var method = (pick.method && avail.some(function (m) { return m.v === pick.method; }))
            ? pick.method : (avail[0] ? avail[0].v : 'return');
        var number = pick.contact_number || (phones[0] && phones[0].num) || '';
        var name = pick.contact_name || customerFirst();
        var email = pick.contact_email || suggestedEmail();

        var ov = document.createElement('div'); ov.id = 'mrt-fu-modal';
        ov.innerHTML =
            '<div class="mrt-fu-card">' +
              '<div class="mrt-fu-hd"><h4>Follow Up</h4><span class="mrt-fu-hdsub">saved to this ticket only</span><button type="button" class="mrt-fu-x" title="Close" aria-label="Close">✕</button></div>' +
              '<div class="mrt-fu-body">' +
                '<div class="mrt-fu-q">How should we let the customer know their repair is ready?</div>' +
                '<div class="mrt-fu-methods">' + enabledMethods().map(function (m) {
                    var mode = methodMode(m);
                    return '<button type="button" class="mrt-fu-m' + (m.v === method ? ' on' : '') + '" data-m="' + m.v + '">' + m.label +
                        (mode ? '<span class="mrt-fu-mmode ' + mode + '">' + mode + '</span>' : '') + '</button>';
                }).join('') + '</div>' +
                '<div class="mrt-fu-field mrt-fu-numwrap">' +
                  '<label>Contact number</label>' +
                  '<input type="text" class="mrt-fu-num" placeholder="Type a number…" autocomplete="off" value="' + esc(pretty(number)) + '" data-raw="' + esc(digits(number)) + '">' +
                  '<div class="mrt-fu-suggest"></div>' +
                '</div>' +
                '<div class="mrt-fu-field mrt-fu-emailwrap" style="display:none">' +
                  '<label>Email</label><input type="email" class="mrt-fu-email" value="' + esc(email) + '">' +
                '</div>' +
                '<div class="mrt-fu-field mrt-fu-namewrap">' +
                  '<label>Name (who to reach)</label><input type="text" class="mrt-fu-name" value="' + esc(name) + '">' +
                '</div>' +
              '</div>' +
              '<div class="mrt-fu-ft">' +
                '<button type="button" class="mrt-fu-skip">Skip</button>' +
                '<button type="button" class="mrt-fu-save">Save Follow Up</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(ov);

        var numInput = ov.querySelector('.mrt-fu-num');
        var suggest = ov.querySelector('.mrt-fu-suggest');
        var sel = { method: method };

        function applyMethod(m) {
            sel.method = m;
            ov.querySelectorAll('.mrt-fu-m').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-m') === m); });
            ov.querySelector('.mrt-fu-numwrap').style.display = (m === 'text' || m === 'call') ? '' : 'none';
            ov.querySelector('.mrt-fu-emailwrap').style.display = (m === 'email') ? '' : 'none';
            ov.querySelector('.mrt-fu-namewrap').style.display = (m === 'return') ? 'none' : '';
        }
        applyMethod(method);
        ov.querySelectorAll('.mrt-fu-m').forEach(function (b) {
            b.addEventListener('click', function () { applyMethod(b.getAttribute('data-m')); });
        });

        // number combobox: focus → drop Primary/Alt suggestions.
        // Re-scan the page NOW — the modal can auto-open before RepairQ has
        // rendered the customer summary, so the list computed at open may be
        // empty even though the numbers are on screen by the time the tech
        // clicks into the field.
        function showSuggest() {
            var fresh = suggestedPhones();
            if (fresh.length) phones = fresh;
            if (!phones.length) { suggest.classList.remove('open'); return; }
            suggest.innerHTML = phones.map(function (p) {
                return '<div class="mrt-fu-opt" data-num="' + digits(p.num) + '"><b>' + p.tag + '</b> ' + pretty(p.num) + '</div>';
            }).join('');
            suggest.classList.add('open');
            suggest.querySelectorAll('.mrt-fu-opt').forEach(function (o) {
                o.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    numInput.value = pretty(o.getAttribute('data-num'));
                    numInput.setAttribute('data-raw', o.getAttribute('data-num'));
                    suggest.classList.remove('open');
                });
            });
        }
        numInput.addEventListener('focus', showSuggest);
        numInput.addEventListener('input', function () { numInput.setAttribute('data-raw', digits(numInput.value)); });
        numInput.addEventListener('blur', function () { setTimeout(function () { suggest.classList.remove('open'); }, 150); });

        ov.querySelector('.mrt-fu-save').addEventListener('click', function () {
            var m = sel.method;
            var payload = {
                ticket_no: ticketNo(), store: storeName(), method: m,
                name: ov.querySelector('.mrt-fu-name').value.trim(),
                number: (m === 'text' || m === 'call') ? (numInput.getAttribute('data-raw') || digits(numInput.value)) : '',
                email: (m === 'email') ? ov.querySelector('.mrt-fu-email').value.trim() : '',
                agent_name: techName(),
            };
            current = { method: m, contact_number: payload.number, contact_name: payload.name, contact_email: payload.email };
            if (!payload.ticket_no) {
                // check-in/create page — no ticket number yet. Stash the choice;
                // boot() flushes it (Supabase + note) when the saved ticket loads.
                // Show the chip right away: with no confirmation here, techs
                // couldn't tell the answer had been captured at all.
                pendingSet(payload);
                markCreatePopped();
                renderChip();
                keepBlockAlive();
                closeModal();
                return;
            }
            pendingClear();   // an on-ticket answer supersedes any check-in stash
            contactSet(payload, 'save');
            // permanent backup note
            var who = payload.name || 'customer';
            var how = m === 'email' ? 'EMAIL → ' + payload.email
                    : m === 'return' ? 'CUSTOMER TO RETURN'
                    : (m.toUpperCase() + ' → ' + pretty(payload.number));
            writeNote('Follow-up: ' + how + (payload.name ? ' (' + who + ')' : '') + ' — set by ' + (techName() || 'staff'));
            markPrompted();
            renderChip();
            closeModal();
        });
        ov.querySelector('.mrt-fu-skip').addEventListener('click', function () {
            if (!ticketNo()) {
                // check-in page: stash the skip so the saved ticket doesn't re-ask
                pendingSet({ method: 'skip' });
                markCreatePopped();
                current = { method: 'skip' };
                renderChip();          // leaves a "Set follow up" card to change their mind
                keepBlockAlive();
                closeModal();
                return;
            }
            // remember the skip ON THE TICKET so it never re-asks anywhere
            if (!current) {
                current = { method: 'skip' };
                pendingClear();
                contactSet({ ticket_no: ticketNo(), store: storeName(), method: 'skip', agent_name: techName() }, 'skip');
                renderChip();
            }
            markPrompted(); closeModal();
        });
        // No backdrop-click close: a stray tap outside used to dismiss a
        // half-filled follow-up. Only a selection (Save/Skip) or the ✕ closes.
        // The ✕ dismisses without recording, but marks prompted so it doesn't re-nag.
        ov.querySelector('.mrt-fu-x').addEventListener('click', function () { markPrompted(); closeModal(); });
    }
    function closeModal() { var m = document.getElementById('mrt-fu-modal'); if (m) m.remove(); }

    /* ---------------- sidebar block (Summary / Customer / Follow Up) ---------------- */

    // Find the sidebar "Customer" widget: RepairQ sections are
    // .block > .head > h2 + .block-content. We insert our own .block right
    // after it so the header bar and spacing inherit RepairQ's styling.
    // The ticket-view sidebar is INJECTED by RepairQ's JS after load, as
    // sibling pairs:  <div class="sub-head"><h2>Customer</h2></div>
    //                 <div class="block-content"> …link + phones… </div>
    // (confirmed from a saved copy of the real page). Older/edit layouts use
    // .block wrappers instead. Both finders demand a sidebar-sized container
    // that really holds the customer — a bare "Customer" heading in the main
    // column once anchored the block page-wide.
    function phoneish(el) {
        return !!el.querySelector('a[href*="/customers/"]') ||
               /\(?\d{3}\)?[\s.-]?\d{3}[-.\s]?\d{4}/.test(el.textContent || '');
    }
    function customerAnchor() {
        // 1) sub-head + sibling block-content (the real ticket-view sidebar)
        var subs = document.querySelectorAll('.sub-head h2, .sub-head h3');
        for (var i = 0; i < subs.length; i++) {
            var t = subs[i].textContent.replace(/\s+/g, ' ').trim();
            if (!/^customer\b/i.test(t) || /billing/i.test(t)) continue;
            var hd = subs[i].closest('.sub-head');
            if (!hd || (hd.offsetWidth || 0) > 480) continue;
            var bc = hd.nextElementSibling;
            while (bc && !/\bblock-content\b/.test(bc.className || '')) bc = bc.nextElementSibling;
            if (!bc || !phoneish(bc)) continue;
            return { mode: 'subhead', content: bc, insertAfter: bc };
        }
        // 2) .block/.widget wrapper layouts
        var heads = document.querySelectorAll('.head h2, .head h3, .head h4');
        for (var j = 0; j < heads.length; j++) {
            var t2 = heads[j].textContent.replace(/\s+/g, ' ').trim();
            if (!/^customer\b/i.test(t2) || /billing/i.test(t2)) continue;
            var b = heads[j].closest('.block') || heads[j].closest('.widget');
            if (!b || (b.offsetWidth || 0) > 480 || !phoneish(b)) continue;
            return { mode: 'block', content: b, insertAfter: b };
        }
        return null;
    }
    // scrape source for suggestions (the customer section's content element)
    function customerBlock() { var a = customerAnchor(); return a ? a.content : null; }

    function savedLine() {
        if (!(current && current.method !== 'skip')) return '';
        return current.method === 'email' ? 'Email · ' + esc(current.contact_email || '—')
             : current.method === 'return' ? 'Customer to Return'
             : (current.method === 'call' ? 'Call' : 'Text') + ' · ' + esc(pretty(current.contact_number || ''));
    }

    function renderChip() {   // kept name — called from boot/save paths
        document.querySelectorAll('.mrt-fu-block').forEach(function (n) { n.remove(); });

        var anchor = customerAnchor();
        if (!anchor) {
            // Edit pages have no sidebar Customer widget. Float a compact
            // card into the empty space RIGHT of the customer <dl>, inside
            // the same Customer & Billing panel (owner-picked spot) — never
            // a full-width block below it.
            var dd = ddFor('contact number');
            var dl = dd ? dd.closest('dl') : null;
            if (!dl || !dl.parentElement) return;   // nowhere safe — render nothing
            var line = savedLine();
            var body = line
                ? '<div class="mrt-fu-line">' + line + '</div>'
                  + (current.contact_name ? '<div class="mrt-fu-sub2">for ' + esc(current.contact_name) + '</div>' : '')
                  + (current.set_by_name ? '<div class="mrt-fu-sub2">set by ' + esc(current.set_by_name) + '</div>' : '')
                  + '<button type="button" class="mrt-fu-editbtn2">Edit follow up</button>'
                : '<div class="mrt-fu-sub2">No follow-up preference saved for this visit.</div>'
                  + '<button type="button" class="mrt-fu-editbtn2">Set follow up</button>';
            var card = document.createElement('div');
            card.className = 'mrt-fu-block mrt-fu-editcard';
            card.innerHTML = '<div class="mrt-fu-ehd">Follow Up</div><div class="mrt-fu-ebody">' + body + '</div>';
            card.querySelector('.mrt-fu-editbtn2').addEventListener('click', function () { openModal(current); });
            dl.parentElement.insertBefore(card, dl);   // float:right → sits beside the dl
            return;
        }

        var subhead = anchor.mode === 'subhead';
        var blk = document.createElement('div');
        blk.className = 'mrt-fu-block';
        var body;
        var line2 = savedLine();
        if (line2) {
            body = '<div class="mrt-fu-line">' + line2 + '</div>'
                 + (current.contact_name ? '<div class="mrt-fu-sub2">for ' + esc(current.contact_name) + '</div>' : '')
                 + (current.set_by_name ? '<div class="mrt-fu-sub2">set by ' + esc(current.set_by_name) + '</div>' : '')
                 + '<button type="button" class="btn btn-primary mrt-fu-editbtn">Edit follow up</button>';
        } else {
            body = '<div class="mrt-fu-sub2">No follow-up preference saved for this visit.</div>'
                 + '<button type="button" class="btn btn-primary mrt-fu-editbtn">Set follow up</button>';
        }
        // sub-head layouts: reuse RepairQ's own sub-head/block-content classes
        // so the header bar matches Summary/Customer exactly
        var hcls = subhead ? 'sub-head' : 'head';
        blk.innerHTML =
            '<div class="' + hcls + '"><h2>Follow Up</h2></div>' +
            '<div class="block-content mrt-fu-bc">' + body + '</div>';
        blk.querySelector('.mrt-fu-editbtn').addEventListener('click', function () { openModal(current); });

        anchor.insertAfter.insertAdjacentElement('afterend', blk);
    }

    /* ---------------- lifecycle ---------------- */

    function promptedKey() { return 'mrt_fu_prompted_' + ticketNo(); }
    function markPrompted() { try { localStorage.setItem(promptedKey(), '1'); } catch (e) {} }
    function wasPrompted() { try { return localStorage.getItem(promptedKey()) === '1'; } catch (e) { return false; } }

    function watchClose() {
        // when the ticket is set Closed, drop the per-visit contact row
        document.addEventListener('click', function (e) {
            var btn = e.target.closest && e.target.closest('a.save-ticket');
            if (!btn) return;
            var act = (btn.getAttribute('action') || btn.className || '').toLowerCase();
            if (/closed|void/.test(act)) { var t = ticketNo(); if (t) fn('contact_delete', { ticket_no: t }); }
        }, true);
    }


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

    var CHECKIN_KEY = 'mrt_fu_checkin';   // set on the create page; the NEXT
                                          // ticket page in this tab may auto-pop

    /* --- pending check-in choice (create page has no ticket # to write to) --- */
    // The capture modal now pops the moment a customer is added on the check-in
    // form. There's no ticket number there yet, so the choice is stashed in
    // sessionStorage and flushed onto the real ticket (Supabase row + ticket
    // note) the instant the saved ticket page loads.
    var PENDING_KEY = 'mrt_fu_pending';
    function pendingSet(payload) {
        try {
            // Stamp WHOSE check-in this is at capture time. Identity has to be
            // recorded here — by the time the saved ticket loads, the only thing
            // left to compare against is the page, and the number the tech typed
            // may deliberately not be on that customer's record.
            var p = {}; for (var k in (payload || {})) p[k] = payload[k];
            if (!p.cust) { var c = customerId(); if (c) p.cust = c; }
            sessionStorage.setItem(PENDING_KEY, JSON.stringify({ p: p, ts: Date.now() }));
        } catch (e) {}
    }
    function pendingGet() {
        try {
            var raw = sessionStorage.getItem(PENDING_KEY);
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (!o || !o.ts || (Date.now() - o.ts) > 15 * 60000) { pendingClear(); return null; }
            return o.p || null;
        } catch (e) { return null; }
    }
    function pendingClear() { try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {} }

    /* A stash may only land on ITS OWN customer's ticket. The old rule flushed
       onto whatever New/edit ticket loaded next in the tab, so an abandoned
       check-in put customer A's follow-up on customer B's ticket (issue 3106:
       missing where the tech saved it, present where they didn't). Match the
       stash's own contact data against the ticket page's customer block; a
       stash with nothing to match (return/skip, no number/email) only rides
       the fresh post-save landing. */
    function pendMatchesContact(pend) {
        if (!pend) return false;
        try {
            var pd = digits(pend.number || '');
            if (pd.length >= 10) {
                var pages = suggestedPhones();
                for (var i = 0; i < pages.length; i++) if (digits(pages[i].num).slice(-10) === pd.slice(-10)) return true;
            }
            var pe = String(pend.email || '').trim().toLowerCase();
            if (pe) {
                var cb = customerBlock();
                if (cb && cb.textContent.toLowerCase().indexOf(pe) > -1) return true;
            }
        } catch (e) { /* fall through to no-match */ }
        return false;
    }

    /* Does this stash belong to the customer currently on screen?

       IDENTITY FIRST. When both sides carry RepairQ's customer id that settles
       it outright, in both directions — it lets a hand-typed number through, and
       it still refuses someone else's check-in.

       Matching on contact data alone (2.8.2) got the refusal right and the
       acceptance badly wrong: it compared the stashed number against numbers
       ALREADY on the customer's record, so the moment a tech typed a spouse's
       or a work number — the case this feature exists for — the stash was
       judged to belong to nobody, silently dropped, and the tech got re-asked
       with a blank modal (staff report #592). It survives here only as the
       fallback for a page with no customer link and for stashes written before
       the id was stamped, and it can no longer reject on its own: an unmatched
       number on a genuinely fresh post-save landing is accepted, because we
       could not identify the customer, not because we identified a different
       one. `fresh` is safe in that position precisely because it is only
       consulted when the authoritative test could not run. */
    function pendOwnership(pend, fresh) {
        if (!pend) return false;
        var pageCust = customerId(), pendCust = String(pend.cust || '');
        if (pageCust && pendCust) return pageCust === pendCust;
        var hasContact = !!(digits(pend.number || '').length >= 10 || String(pend.email || '').trim());
        if (hasContact) return pendMatchesContact(pend) || !!fresh;
        return !!fresh;
    }

    function flushPending(pend) {
        pendingClear();
        var m = pend.method;
        var payload = {
            ticket_no: ticketNo(), store: storeName() || pend.store || '', method: m,
            name: pend.name || '', number: pend.number || '', email: pend.email || '',
            agent_name: techName() || pend.agent_name || '',
        };
        current = (m === 'skip') ? { method: 'skip' }
                : { method: m, contact_number: payload.number, contact_name: payload.name, contact_email: payload.email };
        contactSet(payload, 'flush');
        if (m !== 'skip') {
            var who = payload.name || 'customer';
            var how = m === 'email' ? 'EMAIL → ' + payload.email
                    : m === 'return' ? 'CUSTOMER TO RETURN'
                    : (m.toUpperCase() + ' → ' + pretty(payload.number));
            writeNote('Follow-up: ' + how + (payload.name ? ' (' + who + ')' : '') + ' — set by ' + (payload.agent_name || 'staff'));
        }
        markPrompted();
    }

    /* --- check-in customer-added detection (create/check-in form) --- */
    // On /ticket/repair|claim|add there is no ticket number. When the tech picks
    // a customer, RepairQ hides the #customer search box and shows the chosen
    // customer — our signal to pop the follow-up modal right then.
    var createPoppedFlag = false;
    function markCreatePopped() { createPoppedFlag = true; }
    function customerIsSelected() {
        var cust = document.querySelector('#customer');
        if (!cust || cust.offsetParent === null) return false;   // form not ready/visible
        var search = cust.querySelector('.search');
        if (search && search.offsetParent === null) return true; // search box hidden = customer chosen
        if (!search && cust.querySelector('a[href*="/customers/"]')) return true;
        return false;
    }
    function watchCustomerAdd() {
        function tryPop() {
            if (createPoppedFlag) return true;
            if (!customerIsSelected()) return false;
            markCreatePopped();
            // Already captured for THIS customer — don't ask twice. A stash left
            // over from someone else's check-in must not suppress this one's
            // modal, which is how a follow-up went uncaptured entirely (#3106).
            var held = pendingGet();
            if (held && pendOwnership(held, false)) return true;
            // let RepairQ paint the customer's numbers first (modal suggestions)
            setTimeout(function () { if (!document.getElementById('mrt-fu-modal')) openModal(null); }, 500);
            return true;
        }
        if (tryPop()) return;
        var mo = new MutationObserver(function () { if (tryPop()) mo.disconnect(); });
        mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    }

    function boot() {
        if (!ttAllows('followUp')) return;   // this ticket type is opted out
        var t = ticketNo();
        if (!t) {
            // ticket-create pages (/ticket/repair|claim|add): no number yet.
            // Flag the check-in so the post-save landing page (a VIEW page,
            // which normally never auto-pops) asks exactly once, AND watch for
            // the customer being added so we can pop the modal immediately.
            if (/\/ticket\/(repair|claim|add)/.test(location.pathname)) {
                try { sessionStorage.setItem(CHECKIN_KEY, String(Date.now())); } catch (e) {}
                // a choice already captured on this check-in: show it on the
                // customer card so it's visibly saved before the ticket exists
                // Only re-show a stash that belongs to the customer on THIS
                // check-in. The old code restored whatever was in the stash with
                // no ownership test at all, which painted the previous
                // customer's method and number onto the new customer's card AND
                // called markCreatePopped(), so the modal never fired for them —
                // both halves of #3106 from one line. If we can't identify the
                // customer we restore nothing: being asked again is a small
                // annoyance, attaching the wrong person's contact is a defect.
                var pend0 = pendingGet();
                if (pend0 && customerId() && pendOwnership(pend0, false)) {
                    markCreatePopped();
                    current = (pend0.method === 'skip') ? { method: 'skip' }
                            : { method: pend0.method, contact_number: pend0.number, contact_name: pend0.name, contact_email: pend0.email };
                    renderChip();
                    keepBlockAlive();
                }
                watchCustomerAdd();
            }
            return;
        }
        fn('contact_get', { ticket_no: t }).then(function (r) {
            current = (r && r.contact) || null;
            watchClose();
            // Wait for RepairQ to render the customer summary before drawing
            // anything — on slower machines it arrives well after our 600ms,
            // which left the modal with no number suggestions and the chip on
            // a fallback anchor. Cap the wait at ~6s and proceed regardless.
            var tries = 0;
            (function whenSummaryReady() {
                // ALSO wait for the status label: the flush below keys off
                // isNewStatus(), and deciding before the label paints silently
                // dropped check-in follow-ups (the modal then re-popped empty —
                // "it deleted the one I already made").
                var statusReady = !!document.querySelector('#summary .block-content span.fullsize.label, #summary .block-content span.label');
                if ((!statusReady || (!ddFor('contact number') && !customerBlock())) && tries++ < 20) { setTimeout(whenSummaryReady, 300); return; }
                // flush a follow-up choice captured on the numberless check-in
                // page onto this freshly-saved ticket (status "New") — but ONLY
                // when the stash provably belongs to THIS ticket's customer, or
                // this is the immediate post-save landing (fresh flag) with no
                // contact data to compare. A stash that does not match stays put
                // for the ticket it was made for and must not touch this one.
                var isEdit = /\/ticket\/edit\//.test(location.pathname);
                var fresh = false;
                try {
                    var ts = Number(sessionStorage.getItem(CHECKIN_KEY) || 0);
                    fresh = ts > 0 && (Date.now() - ts) < 10 * 60000;
                    if (fresh) sessionStorage.removeItem(CHECKIN_KEY);   // consume — one pop only
                } catch (e) {}
                var pend = !current ? pendingGet() : null;
                if (pend && !pendOwnership(pend, fresh)) pend = null;   // someone else's check-in — leave it alone
                if (pend && (isNewStatus() || isEdit)) { flushPending(pend); pend = null; }
                renderChip();
                // auto-pop = check-in only: the EDIT page, or the first ticket
                // page after a create (the post-save landing is a VIEW page,
                // flagged from the create page). All other view loads are
                // button-only via the sidebar block.
                // A brand-new ticket lands on a VIEW page (/ticket/<id>) with status
                // "New"; the create-page flag doesn't fire for every RepairQ check-in
                // URL, so key off the status too. wasPrompted() keeps it to one pop.
                // safety net: if a check-in answer is still pending (flush was
                // skipped), open the modal PRE-FILLED with it — never blank.
                if ((isEdit || fresh || isNewStatus()) && !current && !wasPrompted() && !isClosedPage())
                    openModal(pend && pend.method !== 'skip'
                        ? { method: pend.method, contact_number: pend.number, contact_name: pend.name, contact_email: pend.email }
                        : null);
                keepBlockAlive();
            })();
        });
    }

    // RepairQ re-renders the customer summary in place (Edit Customer →
    // save swaps the <dl>), which silently takes our card with it. Watch
    // for the card going missing and re-render once the summary is back;
    // renderChip() no-ops while the edit form has the <dl> torn down.
    var keepTimer = null, keepStarted = false;
    function keepBlockAlive() {
        if (keepStarted) return;   // one observer per page — save/boot both call this
        keepStarted = true;
        new MutationObserver(function () {
            if (document.querySelector('.mrt-fu-block')) return;
            clearTimeout(keepTimer);
            keepTimer = setTimeout(function () {
                if (!document.querySelector('.mrt-fu-block')) renderChip();
            }, 400);
        }).observe(document.body, { childList: true, subtree: true });
    }

    function start() {
        if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
    }
    try {
        chrome.storage.sync.get(['sms', 'tt']).then(function (res) {
            var s = (res && res.sms) || {};
            TT = (res && res.tt) || null;
            if (s.followUp === false) return;
            CH.sendSms = s.sendSms !== undefined ? s.sendSms : (s.readyText !== false); // legacy fallback
            CH.sendCall = s.sendCall === true;
            CH.sendEmail = s.sendEmail === true;
            start();
        }).catch(start);
    } catch (e) { start(); }
})();
