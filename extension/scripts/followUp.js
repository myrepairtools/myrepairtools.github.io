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
        { v: 'text',   label: 'Text' },
        { v: 'call',   label: 'Call' },
        { v: 'email',  label: 'Email' },
        { v: 'return', label: 'Customer to Return' },
    ];

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

    /* --- write the ticket-note backup (best effort) --- */
    function writeNote(text) {
        var csrf = (document.getElementsByName('YII_CSRF_TOKEN')[0] || {}).value;
        var id = ticketNo();
        if (!csrf || !id) return;
        var body = new URLSearchParams({
            YII_CSRF_TOKEN: csrf, ticketId: id, note: text, print: '0', important: '0',
        });
        fetch('/ajax/ticketNote/save', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
            body: body.toString(),
        }).catch(function () { /* backup only */ });
    }

    function methodLabel(v) { var m = METHODS.filter(function (x) { return x.v === v; })[0]; return m ? m.label : v; }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    /* ---------------- modal ---------------- */

    var current = null;   // last-known contact for this ticket

    function openModal(existing) {
        closeModal();
        var phones = suggestedPhones();
        var pick = (existing && existing.method !== 'skip') ? existing : {};
        var method = pick.method || (phones.length ? 'text' : 'text');
        var number = pick.contact_number || (phones[0] && phones[0].num) || '';
        var name = pick.contact_name || customerFirst();
        var email = pick.contact_email || suggestedEmail();

        var ov = document.createElement('div'); ov.id = 'mrt-fu-modal';
        ov.innerHTML =
            '<div class="mrt-fu-card">' +
              '<div class="mrt-fu-hd"><h4>Follow Up</h4><span class="mrt-fu-hdsub">saved to this ticket only</span></div>' +
              '<div class="mrt-fu-body">' +
                '<div class="mrt-fu-q">How should we let the customer know their repair is ready?</div>' +
                '<div class="mrt-fu-methods">' + METHODS.map(function (m) {
                    return '<button type="button" class="mrt-fu-m' + (m.v === method ? ' on' : '') + '" data-m="' + m.v + '">' + m.label + '</button>';
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
            fn('contact_set', payload);
            // permanent backup note
            var who = payload.name || 'customer';
            var how = m === 'email' ? 'EMAIL → ' + payload.email
                    : m === 'return' ? 'CUSTOMER TO RETURN'
                    : (m.toUpperCase() + ' → ' + pretty(payload.number));
            writeNote('📣 Follow-up: ' + how + (payload.name ? ' (' + who + ')' : '') + ' — set by ' + (techName() || 'staff'));
            markPrompted();
            renderChip();
            closeModal();
        });
        ov.querySelector('.mrt-fu-skip').addEventListener('click', function () {
            // remember the skip ON THE TICKET so it never re-asks anywhere
            if (!current) {
                current = { method: 'skip' };
                fn('contact_set', { ticket_no: ticketNo(), store: storeName(), method: 'skip', agent_name: techName() });
                renderChip();
            }
            markPrompted(); closeModal();
        });
        ov.addEventListener('click', function (e) { if (e.target === ov) { markPrompted(); closeModal(); } });
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

    var CHECKIN_KEY = 'mrt_fu_checkin';   // set on the create page; the NEXT
                                          // ticket page in this tab may auto-pop
    function boot() {
        var t = ticketNo();
        if (!t) {
            // ticket-create pages (/ticket/repair|claim|add): no number yet.
            // Flag the check-in so the post-save landing page (a VIEW page,
            // which normally never auto-pops) asks exactly once.
            if (/\/ticket\/(repair|claim|add)/.test(location.pathname)) {
                try { sessionStorage.setItem(CHECKIN_KEY, String(Date.now())); } catch (e) {}
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
                if (!ddFor('contact number') && !customerBlock() && tries++ < 20) { setTimeout(whenSummaryReady, 300); return; }
                renderChip();
                // auto-pop = check-in only: the EDIT page, or the first ticket
                // page after a create (the post-save landing is a VIEW page,
                // flagged from the create page). All other view loads are
                // button-only via the sidebar block.
                var isEdit = /\/ticket\/edit\//.test(location.pathname);
                var fresh = false;
                try {
                    var ts = Number(sessionStorage.getItem(CHECKIN_KEY) || 0);
                    fresh = ts > 0 && (Date.now() - ts) < 10 * 60000;
                    if (fresh) sessionStorage.removeItem(CHECKIN_KEY);   // consume — one pop only
                } catch (e) {}
                if ((isEdit || fresh) && !current && !wasPrompted() && !isClosedPage()) openModal(null);
                keepBlockAlive();
            })();
        });
    }

    // RepairQ re-renders the customer summary in place (Edit Customer →
    // save swaps the <dl>), which silently takes our card with it. Watch
    // for the card going missing and re-render once the summary is back;
    // renderChip() no-ops while the edit form has the <dl> torn down.
    var keepTimer = null;
    function keepBlockAlive() {
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
        chrome.storage.sync.get(['sms']).then(function (res) {
            var s = (res && res.sms) || {};
            if (s.followUp === false) return;
            start();
        }).catch(start);
    } catch (e) { start(); }
})();
