/*
    RingCentral Message Center (myRepairTools) — a full-height drawer inside
    RepairQ, so staff manage texts, missed calls and voicemail without leaving
    the ticket screen.

    v2 UI ("2a — RepairQ Native, refined"). What changed vs v1 (drop-down):
      - full-height right-side drawer docked under the black bar
      - dark #2D2D3B header: RC logo + title/store, and a compose (pencil)
        icon button on the right that opens the New Text form
      - NO ✕ — the drawer closes when you click anywhere outside it
        (the top-bar button still toggles it)
      - SVG tab icons (inbox / calls / voicemail); inbox tab carries the
        unread-count pill
      - roomier list rows with initials avatars
      - pill compose field with round ✨ and round send icon buttons
    All data flow, polling, notifications, ticket lookup and AI logic is
    unchanged from v1.

    Tabs:
      Inbox     — SMS conversations for THIS store's line → open a thread →
                  reply, with a ✨ "Help me write" AI polish/draft button.
      Calls     — recent calls, missed ones flagged, one-tap "Text back".
      Voicemail — voicemails with RingCentral transcripts.

    All data rides the store's own RingCentral line (resolved from the RepairQ
    location in the header) through bg.js → the `messaging` edge function. The
    RingCentral creds never touch the browser. AI help runs through the
    `ai-compose` function (the Anthropic key stays server-side too).

    Toggle: Options → RingCentral SMS (storage.sync sms.panel, default ON).
*/

(function () {
    'use strict';
    if (window.self !== window.top) return;              // not in iframes
    if (document.getElementById('mrt-rc-btn')) return;   // once
    // never on print pages — the fallback button would print on the invoice
    if (/\/ticket\/print/i.test(location.pathname)) return;

    var S = { open: false, tab: 'inbox', store: '', thread: null, loading: false };

    /* ---------------- icons (stroke SVG, currentColor) ---------------- */
    function icon(inner, size) {
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
    }
    var I = {
        chat: icon('<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.35 8.5 8.5 0 0 1-3.9-.95L3 20l1.1-4.05A8.38 8.38 0 0 1 3.5 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/>', 15),
        phone: icon('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>', 15),
        vm: icon('<circle cx="5.5" cy="11.5" r="3.5"/><circle cx="18.5" cy="11.5" r="3.5"/><line x1="5.5" y1="15" x2="18.5" y2="15"/>', 15),
        pencil: icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>', 15),
        back: icon('<polyline points="15 18 9 12 15 6"/>', 15),
        send: icon('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>', 13),
        arrIn: icon('<line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/>', 14),
        arrOut: icon('<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>', 14),
        play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
        spark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.1 5.6 5.6 2.1-5.6 2.1L12 17.9l-2.1-5.6-5.6-2.1 5.6-2.1L12 2.5z"/></svg>',
    };

    /* ---------------- helpers ---------------- */
    // The LOGGED-IN store = the top-bar location switcher, present on every
    // page. NOT .location.tooltip-toggle — that's a TICKET's own location
    // (differs from where you're working, and is absent on list pages).
    function storeName() {
        var sel = document.getElementById('location');
        if (sel && sel.tagName === 'SELECT' && sel.selectedIndex >= 0) {
            var o = sel.options[sel.selectedIndex];
            if (o && o.textContent.trim()) return o.textContent.trim();
        }
        var menu = document.querySelector('.location-menu.dropdown > a.dropdown-toggle');
        if (menu) { var txt = menu.textContent.replace(/\s+/g, ' ').trim(); if (txt) return txt; }
        var t = document.querySelector('.location.tooltip-toggle span');
        return (t && t.textContent.trim()) || '';
    }
    // RepairQ locked (idle timeout) or logged out — hide our UI then.
    function isLocked() {
        try {
            if (/\/site\/login/.test(location.pathname)) return true;
            if (document.body && document.body.classList.contains('session-timeout-overlay-active')) return true;
        } catch (e) {}
        return false;
    }
    function techName() {
        var el = document.getElementById('user_dropdown'); if (!el) return '';
        var raw = el.textContent.replace(/\s+/g, ' ').trim(), m = raw.match(/^([^,]+),\s*(.+)$/);
        return m ? (m[2] + ' ' + m[1]).trim() : raw;
    }
    function digits(s) { return (s || '').replace(/\D/g, ''); }
    function pretty(n) {
        var d = digits(n); if (d.length === 11 && d[0] === '1') d = d.slice(1);
        return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : (n || '');
    }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    // "Dana Whitfield" → "DW"; bare numbers → "#"
    function initials(name) {
        var t = (name || '').trim();
        if (!t || /\d{3}/.test(t)) return '#';
        var parts = t.split(/\s+/);
        var a = (parts[0] || '').charAt(0), b = (parts.length > 1 ? parts[parts.length - 1] : '').charAt(0);
        return (a + b).toUpperCase() || '#';
    }
    function ago(iso) {
        if (!iso) return '';
        var t = new Date(iso).getTime(), s = Math.max(0, (Date.now() - t) / 1000);
        if (s < 60) return 'now';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        if (s < 86400) return Math.floor(s / 3600) + 'h';
        if (s < 604800) return Math.floor(s / 86400) + 'd';
        return new Date(iso).toLocaleDateString();
    }
    function fn(action, payload) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ type: 'sms:' + action, payload: payload || {} }, function (r) {
                    res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
                });
            } catch (e) { res({ ok: false, error: String(e && e.message || e) }); }
        });
    }
    function ai(payload) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ type: 'ai:compose', payload: payload || {} }, function (r) {
                    res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
                });
            } catch (e) { res({ ok: false, error: String(e && e.message || e) }); }
        });
    }

    /* ---------------- shell ---------------- */
    var panel;
    function q(sel) { return panel ? panel.querySelector(sel) : null; }

    // Force our black-bar link to match a real sibling's computed box, then
    // size the icon to that box's inner height so it centers exactly. Robust
    // to RepairQ centering via padding OR line-height, and doesn't depend on
    // RepairQ's CSS cascading to our element.
    function alignToNav(bar) {
        try {
            var sib = bar.querySelector('li:not(.mrt-rc-nav) > a');
            var a = document.getElementById('mrt-rc-btn');
            var svg = a && a.querySelector('svg.mrt-rc-logo');
            if (!sib || !a || !svg) return;
            var cs = getComputedStyle(sib);
            a.style.display = cs.display === 'inline' ? 'inline-block' : cs.display;
            a.style.boxSizing = cs.boxSizing;
            a.style.paddingTop = cs.paddingTop;
            a.style.paddingBottom = cs.paddingBottom;
            // symmetric horizontal padding (the neighbor link's is tuned for text and
            // asymmetric); the CSS flex-centers the icon inside this box regardless.
            var px = Math.max(parseFloat(cs.paddingLeft) || 0, parseFloat(cs.paddingRight) || 0) + 'px';
            a.style.paddingLeft = px;
            a.style.paddingRight = px;
            a.style.lineHeight = cs.lineHeight;
            a.style.height = cs.height;
            a.style.verticalAlign = cs.verticalAlign || 'middle';
            var pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0;
            var inner = (sib.clientHeight || parseFloat(cs.height) || 38) - pt - pb;
            var sz = Math.max(20, Math.min(30, Math.round(inner * 1.4)));
            svg.setAttribute('width', sz); svg.setAttribute('height', sz);
            svg.style.verticalAlign = 'middle';
            var li = a.parentElement;
            var wrap = a.querySelector('.mrt-rc-iconwrap');
            [a, li, wrap].forEach(function (el) {
                if (!el || !el.style) return;
                el.style.setProperty('background', 'transparent', 'important');
                el.style.setProperty('background-image', 'none', 'important');
                el.style.setProperty('box-shadow', 'none', 'important');
                el.style.setProperty('border', 'none', 'important');
                el.style.setProperty('border-radius', '0', 'important');
                el.style.setProperty('outline', 'none', 'important');
            });
        } catch (e) {}
    }

    // RingCentral brand mark — orange rounded square + white phone.
    var RC_LOGO =
        '<svg class="mrt-rc-logo" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
          '<rect width="24" height="24" rx="5" fill="#FF7A00"/>' +
          '<g transform="translate(4.5 4.5) scale(0.62)">' +
            '<path fill="#fff" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>' +
          '</g>' +
        '</svg>';
    var RC_LOGO_HD = RC_LOGO.replace('width="24" height="24" viewBox', 'width="30" height="30" viewBox')
                            .replace('class="mrt-rc-logo"', 'class="mrt-rc-hdlogo"');

    function build() {
        // Icon-only, up in RepairQ's black top bar (left of English), matching
        // the native workstation-menu items.
        var bar = document.querySelector('ul.nav.pull-right.workstation-menu');
        if (bar) {
            var li = document.createElement('li');
            li.id = 'mrt-rc-nav'; li.className = 'mrt-rc-nav';
            li.innerHTML = '<a href="#" id="mrt-rc-btn" class="mrt-rc-btn" title="Message Center — texts, calls, voicemail">' +
                '<span class="mrt-rc-iconwrap">' + RC_LOGO +
                '<span class="mrt-rc-dot" id="mrt-rc-dot" style="display:none"></span></span></a>';
            var ourUl = document.createElement('ul');
            ourUl.id = 'mrt-rc-navlist';
            ourUl.className = 'nav pull-right';   // borrow RepairQ's own layout
            ourUl.style.setProperty('background', 'transparent', 'important');
            ourUl.style.setProperty('box-shadow', 'none', 'important');
            ourUl.style.setProperty('border', 'none', 'important');
            ourUl.style.setProperty('margin-right', '8px', 'important');
            ourUl.appendChild(li);
            bar.parentNode.insertBefore(ourUl, bar.nextSibling);
            alignToNav(bar);
        } else {
            // fallback: the toolbar row, with a label
            var btn = document.createElement('a');
            btn.id = 'mrt-rc-btn'; btn.className = 'mrt-rc-btn btn btn-small innav'; btn.href = '#';
            btn.innerHTML = RC_LOGO + ' <span>Messages</span> <span class="mrt-rc-dot" id="mrt-rc-dot" style="display:none"></span>';
            btn.title = 'Message Center — texts, calls, voicemail';
            var navSpot = document.getElementById('globalSearches');
            var form = navSpot && navSpot.querySelector('#quickSearch');
            if (form) form.insertBefore(btn, form.firstChild);
            else if (navSpot && navSpot.parentElement) navSpot.parentElement.insertBefore(btn, navSpot);
            else document.body.appendChild(btn);
        }
        document.getElementById('mrt-rc-btn').addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });

        panel = document.createElement('div');
        panel.id = 'mrt-rc-panel'; panel.className = 'mrt-rc-panel';
        panel.innerHTML =
            '<div class="mrt-rc-hd">' +
              RC_LOGO_HD +
              '<span class="mrt-rc-hd-txt">' +
                '<span class="mrt-rc-title">Message Center</span>' +
                '<span class="mrt-rc-store" id="mrt-rc-store"></span>' +
              '</span>' +
              '<button class="mrt-rc-newbtn" id="mrt-rc-new" title="New text">' + I.pencil + '</button>' +
            '</div>' +
            '<div class="mrt-rc-tabs">' +
              '<button data-t="inbox" class="on">' + I.chat + ' Inbox<i class="mrt-rc-tabdot" id="mrt-rc-tabdot" style="display:none"></i></button>' +
              '<button data-t="calls">' + I.phone + ' Calls</button>' +
              '<button data-t="vm">' + I.vm + ' Voicemail</button>' +
            '</div>' +
            '<div class="mrt-rc-body" id="mrt-rc-body"></div>';
        document.body.appendChild(panel);

        q('#mrt-rc-new').addEventListener('click', function () {
            S.tab = 'inbox'; S.thread = null;
            panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-t') === 'inbox'); });
            renderCompose();
        });
        panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (b) {
            b.addEventListener('click', function () {
                S.tab = b.getAttribute('data-t'); S.thread = null;
                panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
                render();
            });
        });

        // No ✕ — clicking anywhere OUTSIDE the drawer closes it. Clicks on the
        // top-bar button (toggle) and the 💬 chips (openTextTo) are exempt.
        document.addEventListener('click', function (e) {
            if (!S.open) return;
            var t = e.target;
            if (panel.contains(t)) return;
            if (t.closest && t.closest('#mrt-rc-btn, #mrt-rc-navlist, .mrt-rc-num-btn')) return;
            close();
        }, true);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) close(); });
    }

    /* ---------------- render ---------------- */
    function body(html) { var el = q('#mrt-rc-body'); if (el) el.innerHTML = html; }
    function spinner(label) { body('<div class="mrt-rc-load">' + esc(label || 'Loading…') + '</div>'); }

    function render() {
        var st = q('#mrt-rc-store'); if (st) st.textContent = S.store || '(no store)';
        if (!S.store) { body('<div class="mrt-rc-empty">No store detected on this RepairQ page.</div>'); return; }
        if (S.tab === 'inbox') return S.thread ? renderThread() : renderInbox();
        if (S.tab === 'calls') return renderCalls();
        if (S.tab === 'vm') return renderVoicemail();
    }

    /* --- inbox: conversation list --- */
    function renderInbox() {
        spinner('Loading conversations…');
        fn('conversations', { store: S.store, days: 30 }).then(function (r) {
            if (!r || !r.ok) { body('<div class="mrt-rc-err">' + esc((r && r.error) || 'Could not load conversations') + '</div>'); return; }
            var list = r.conversations || [];
            updateDot(list.reduce(function (a, c) { return a + (c.unread || 0); }, 0));
            if (!list.length) {
                body('<div class="mrt-rc-empty">No text conversations in the last 30 days.<br><br>Tap the pencil up top to start one.</div>');
                return;
            }
            body('<div class="mrt-rc-list">' + list.map(function (c) {
                var who = c.name || pretty(c.number);
                return '<div class="mrt-rc-conv" data-num="' + esc(c.number) + '" data-name="' + esc(c.name || '') + '">' +
                    '<span class="mrt-rc-ava">' + esc(initials(c.name)) + '</span>' +
                    '<span class="mrt-rc-conv-main">' +
                      '<span class="mrt-rc-conv-top">' +
                        (c.unread ? '<span class="mrt-rc-udot"></span>' : '') +
                        '<span class="mrt-rc-who">' + esc(who) + '</span>' +
                        '<span class="mrt-rc-when">' + esc(ago(c.last_time)) + '</span>' +
                      '</span>' +
                      '<span class="mrt-rc-prevrow">' +
                        '<span class="mrt-rc-prev">' + (c.last_dir === 'out' ? '<span class="mrt-rc-you">You: </span>' : '') + esc((c.last_text || '').slice(0, 64)) + '</span>' +
                        (c.unread ? '<span class="mrt-rc-badge">' + c.unread + '</span>' : '') +
                      '</span>' +
                    '</span>' +
                '</div>';
            }).join('') + '</div>');
            panel.querySelectorAll('.mrt-rc-conv').forEach(function (el) {
                el.addEventListener('click', function () {
                    S.thread = { number: el.getAttribute('data-num'), name: el.getAttribute('data-name') };
                    renderThread();
                });
            });
        });
    }

    /* --- inbox: start a brand-new text --- */
    function renderCompose(prefillNum, prefillName) {
        var pn = typeof prefillNum === 'string' ? prefillNum : '';
        body('<div class="mrt-rc-thead"><button class="mrt-rc-back" id="mrt-rc-cback">' + I.back + 'Inbox</button>' +
             '<span class="mrt-rc-who">New Text</span></div>' +
             '<div class="mrt-rc-newform">' +
               '<label>To — customer number</label>' +
               '<input type="tel" id="mrt-rc-newnum" placeholder="541-555-0100" autocomplete="off" value="' + esc(pretty(pn)) + '">' +
               '<label>Name <span class="opt">(optional)</span></label>' +
               '<input type="text" id="mrt-rc-newname" placeholder="Customer name" autocomplete="off" value="' + esc(prefillName || '') + '">' +
               '<button class="mrt-rc-send" id="mrt-rc-newgo">Start Conversation</button>' +
               '<div class="mrt-rc-cstatus" id="mrt-rc-newerr"></div>' +
             '</div>');
        q('#mrt-rc-cback').addEventListener('click', function () { renderInbox(); });
        function go() {
            var d = digits((q('#mrt-rc-newnum') || {}).value || '');
            if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
            if (d.length !== 10) { var e = q('#mrt-rc-newerr'); if (e) e.innerHTML = '<span class="err">Enter a 10-digit number</span>'; return; }
            S.thread = { number: d, name: ((q('#mrt-rc-newname') || {}).value || '').trim() };
            renderThread();
        }
        q('#mrt-rc-newgo').addEventListener('click', go);
        q('#mrt-rc-newnum').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        var inp = q('#mrt-rc-newnum'); if (inp) { inp.focus(); if (pn) q('#mrt-rc-newgo').focus(); }
    }

    // Open the panel straight into a thread with this number (the 💬 buttons
    // next to customer phone numbers on ticket pages land here).
    function openTextTo(number, name) {
        if (!panel) return;
        S.tab = 'inbox';
        panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-t') === 'inbox'); });
        var d = digits(number || '');
        if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
        if (!S.open) open();
        if (d.length === 10) { S.thread = { number: d, name: name || '' }; renderThread(); }
        else renderCompose(number || '', name || '');
    }

    /* --- inbox: one thread + compose --- */
    function renderThread() {
        var t = S.thread;
        body('<div class="mrt-rc-thead"><button class="mrt-rc-back" id="mrt-rc-back">' + I.back + 'Inbox</button>' +
             '<span class="mrt-rc-who">' + esc(t.name || pretty(t.number)) + '</span>' +
             '<span class="mrt-rc-tnum">' + esc(pretty(t.number)) + '</span></div>' +
             '<div class="mrt-rc-msgs" id="mrt-rc-msgs"><div class="mrt-rc-load">Loading…</div></div>' +
             '<div class="mrt-rc-tix" id="mrt-rc-tix"></div>' +
             '<div class="mrt-rc-compose">' +
               '<div class="mrt-rc-pill">' +
                 '<textarea id="mrt-rc-text" rows="1" placeholder="Text ' + esc(pretty(t.number)) + '…"></textarea>' +
                 '<button class="mrt-rc-ai" id="mrt-rc-ai" title="Help me write this">' + I.spark + '</button>' +
                 '<button class="mrt-rc-send ic" id="mrt-rc-send" title="Send">' + I.send + '</button>' +
               '</div>' +
               '<div class="mrt-rc-cstatus" id="mrt-rc-cstatus"></div>' +
             '</div>');
        q('#mrt-rc-back').addEventListener('click', function () { S.thread = null; renderInbox(); });
        q('#mrt-rc-send').addEventListener('click', sendThread);
        q('#mrt-rc-ai').addEventListener('click', openAiMenu);
        // grow the pill with the text (up to the CSS max-height)
        var taEl = q('#mrt-rc-text');
        if (taEl) taEl.addEventListener('input', function () { taEl.style.height = 'auto'; taEl.style.height = Math.min(taEl.scrollHeight, 96) + 'px'; });
        loadMsgs();
        loadCustomerTickets(t.number);
        var ta = q('#mrt-rc-text'); if (ta && S.pendingDraft) { ta.value = S.pendingDraft; S.pendingDraft = null; ta.dispatchEvent(new Event('input')); cstatus('ok', '✨ Drafted — edit or Send'); }
    }
    function loadMsgs() {
        fn('thread', { store: S.store, number: S.thread.number, days: 60 }).then(function (r) {
            var box = q('#mrt-rc-msgs'); if (!box) return;
            if (!r || !r.ok) { box.innerHTML = '<div class="mrt-rc-err">' + esc((r && r.error) || 'Could not load messages') + '</div>'; return; }
            var msgs = r.messages || [];
            box.innerHTML = msgs.length ? msgs.map(function (m) {
                return '<div class="mrt-rc-bubble ' + (m.dir === 'out' ? 'out' : 'in') + '">' + esc(m.text) +
                    '<span class="mrt-rc-btime">' + esc(ago(m.time)) + '</span></div>';
            }).join('') : '<div class="mrt-rc-empty">No messages yet — say hi.</div>';
            box.scrollTop = box.scrollHeight;
            // Opening a thread = reading it. Flip it to Read in RingCentral
            // (Edit Messages scope) so the badge clears here AND in RC's apps.
            fn('thread_read', { store: S.store, number: S.thread.number }).then(function (m) {
                if (m && m.ok && m.marked) pollUnread();
            });
        });
    }
    function cstatus(kind, msg) { var el = q('#mrt-rc-cstatus'); if (el) el.innerHTML = msg ? '<span class="' + kind + '">' + esc(msg) + '</span>' : ''; }
    function sendThread() {
        var ta = q('#mrt-rc-text'); var text = (ta.value || '').trim();
        if (!text) { cstatus('err', 'Type a message first'); return; }
        var btn = q('#mrt-rc-send'); btn.disabled = true; cstatus('wait', 'Sending…');
        fn('send', { to: S.thread.number, body: text, store: S.store, agent_name: techName() }).then(function (r) {
            btn.disabled = false;
            if (!r || !r.ok) { cstatus('err', (r && r.error) || 'Send failed'); return; }
            ta.value = ''; ta.style.height = 'auto'; cstatus('ok', '✓ Sent'); setTimeout(function () { cstatus('', ''); }, 1500);
            loadMsgs();
        });
    }

    /* --- customer's RepairQ tickets (lead / open / last closed) ------------
       We're on cpr.repairq.io, so we can hit RepairQ same-origin. Search the
       customer by their phone number, parse the returned ticket rows, classify
       them, and show the useful ones hyperlinked right under the conversation. */
    var CLOSED_RE = /closed|picked ?up|complete|fulfilled|cancel|delivered|no ?show|abandoned/i;
    var LEAD_RE   = /lead|quote|estimate|new claim/i;

    // RepairQ's per-page CSRF token (the quick-search form carries it).
    function rqCsrf() {
        var el = document.querySelector('input[name="YII_CSRF_TOKEN"]');
        return el ? el.value : '';
    }

    // Hop 1: phone → matching customer IDs.
    function findCustomerIds(number) {
        var q10 = digits(number).slice(-10);
        if (q10.length < 10) return Promise.resolve([]);
        var endpoints = ['/customers', '/customers/leads'];
        var queries = [q10, pretty(q10)];
        var jobs = [];
        endpoints.forEach(function (ep) {
            queries.forEach(function (qv) {
                var body = new URLSearchParams();
                body.set('YII_CSRF_TOKEN', rqCsrf());
                body.set('filter[quickQuery]', qv);
                jobs.push(fetch(ep, {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
                    body: body.toString(),
                }).then(function (r) { return r.text(); }).catch(function () { return ''; }));
            });
        });
        return Promise.all(jobs).then(function (htmls) {
            var ids = [], seen = {};
            htmls.forEach(function (html) {
                if (!html) return;
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var scope = doc.getElementById('mainModelList') || doc;
                scope.querySelectorAll('a[href*="/customers/"]').forEach(function (a) {
                    var m = (a.getAttribute('href') || '').match(/\/customers\/(\d+)\b/);
                    if (m && !seen[m[1]]) { seen[m[1]] = 1; ids.push(m[1]); }
                });
            });
            return ids.slice(0, 5);          // cap — usually 1
        }).catch(function () { return []; });
    }

    // Primary lookup: RepairQ's ticket grid quick-search matches customer name
    // AND phone, so one POST to /ticket returns the tickets directly.
    function parseTicketGrid(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var scope = doc.getElementById('mainModelList') || doc;
        var out = [];
        scope.querySelectorAll('tr[data-id]').forEach(function (tr) {
            var no = tr.getAttribute('data-id');
            if (!/^\d+$/.test(no)) return;
            var cols = {};
            tr.querySelectorAll('td[data-column]').forEach(function (td) {
                cols[(td.getAttribute('data-column') || '').toLowerCase()] = td.textContent.replace(/\s+/g, ' ').trim();
            });
            if (!Object.keys(cols).length) return;
            function pick(re) { for (var k in cols) if (re.test(k) && cols[k]) return cols[k]; return ''; }
            var devA = tr.querySelector('td[data-column="items"] a[data-content], td[data-column="items"] a[data-original-title]');
            out.push({
                no: no, href: '/ticket/' + no,
                device: (devA && (devA.getAttribute('data-content') || devA.getAttribute('data-original-title'))) || cols.items || pick(/device|model|item/),
                status: cols.status || pick(/status|bucket|state/),
                date: cols.est || pick(/\best\b|due|date/),
            });
        });
        return out;
    }

    function ticketGridSearch(number) {
        var d10 = digits(number).slice(-10);
        if (d10.length < 10) return Promise.resolve([]);
        var queries = [d10, pretty(d10)];
        var jobs = queries.map(function (qv) {
            var body = new URLSearchParams();
            body.set('YII_CSRF_TOKEN', rqCsrf());
            body.set('filter[quickQuery]', qv);
            body.set('filter[full_history]', '1');   // include closed/older tickets
            return fetch('/ticket', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
                body: body.toString(),
            }).then(function (r) { return r.text(); })
              .then(function (html) { return parseTicketGrid(html); })
              .catch(function () { return []; });
        });
        return Promise.all(jobs).then(function (lists) {
            var seen = {}, all = [];
            lists.forEach(function (l) { l.forEach(function (t) { if (!seen[t.no]) { seen[t.no] = 1; all.push(t); } }); });
            return all;
        });
    }

    // Hop 2: customer ID → their tickets (profile page #tickets table).
    function ticketsForCustomer(id) {
        return fetch('/customers/' + id, { credentials: 'same-origin' })
            .then(function (r) { return r.text(); }).then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var scope = doc.getElementById('tickets') || doc;
                var out = [];
                scope.querySelectorAll('tr[data-id]').forEach(function (tr) {
                    var no = tr.getAttribute('data-id');
                    if (!/^\d+$/.test(no)) return;
                    var tds = tr.querySelectorAll('td');
                    function cell(n) { return tds[n] ? tds[n].textContent.replace(/\s+/g, ' ').trim() : ''; }
                    var devA = tds[2] && tds[2].querySelector('a[data-content], a[data-original-title]');
                    out.push({
                        no: no, href: '/ticket/' + no,
                        location: cell(1),
                        device: (devA && (devA.getAttribute('data-content') || devA.getAttribute('data-original-title'))) || cell(2),
                        status: cell(3),
                        date: cell(7),
                    });
                });
                return out;
            }).catch(function () { return []; });
    }

    // phone → tickets. Grid first; fall back to contacts → profile → tickets.
    function searchCustomerTickets(number) {
        return ticketGridSearch(number).then(function (tix) {
            if (tix.length) return tix;
            return findCustomerIds(number).then(function (ids) {
                if (!ids.length) return [];
                return Promise.all(ids.map(ticketsForCustomer)).then(function (lists) {
                    var seen = {}, all = [];
                    lists.forEach(function (l) { l.forEach(function (t) { if (!seen[t.no]) { seen[t.no] = 1; all.push(t); } }); });
                    return all;
                });
            });
        }).catch(function () { return []; });
    }

    function loadCustomerTickets(number) {
        var box = q('#mrt-rc-tix'); if (!box) return;
        box.innerHTML = '<div class="mrt-rc-tixhd">Their RepairQ tickets <span class="mrt-rc-tixsp">…</span></div>';
        var dbg = false;
        try { dbg = !!localStorage.getItem('mrtRcDebug'); } catch (e) {}
        if (dbg) {
            ticketGridSearch(number).then(function (g) { console.log('[MRT] ticketGridSearch(' + number + ') →', g.length, g); });
            findCustomerIds(number).then(function (ids) { console.log('[MRT] findCustomerIds(' + number + ') →', ids); });
        }
        searchCustomerTickets(number).then(function (tix) {
            if (!q('#mrt-rc-tix')) return;                       // thread changed
            if (dbg) console.log('[MRT] searchCustomerTickets(' + number + ') →', tix.length, tix);
            if (!tix.length) { box.innerHTML = '<div class="mrt-rc-tixhd">No RepairQ tickets found for this number</div>'; return; }
            var leads = [], open = [], closed = [];
            tix.forEach(function (t) {
                if (LEAD_RE.test(t.status)) leads.push(t);
                else if (CLOSED_RE.test(t.status)) closed.push(t);
                else open.push(t);
            });
            var byNoDesc = function (a, b) { return Number(b.no) - Number(a.no); };
            leads.sort(byNoDesc); open.sort(byNoDesc); closed.sort(byNoDesc);
            var rows = [];
            function row(kind, cls, t) {
                // just the ticket number + its group tag — no device/status description
                return '<a class="mrt-rc-tix-row" href="' + esc(t.href) + '" target="_blank" rel="noopener">' +
                    '<span class="mrt-rc-tix-tag ' + cls + '">' + kind + '</span>' +
                    '<span class="mrt-rc-tix-no">#' + esc(t.no) + '</span></a>';
            }
            leads.slice(0, 3).forEach(function (t) { rows.push(row('lead', 'lead', t)); });
            open.slice(0, 6).forEach(function (t) { rows.push(row('open', 'open', t)); });
            if (closed[0]) rows.push(row('last closed', 'last', closed[0]));
            box.innerHTML = '<div class="mrt-rc-tixhd">Their RepairQ tickets</div>' + rows.join('');
        });
    }

    /* --- ✨ menu: polish, or a guided scenario --- */
    var templatesCache = null;
    function loadTemplates(cb) {
        if (templatesCache) { cb(templatesCache); return; }
        ai({ action: 'templates' }).then(function (r) { templatesCache = (r && r.ok && r.templates) || []; cb(templatesCache); });
    }
    function openAiMenu() {
        var ex = q('#mrt-rc-aimenu'); if (ex) { ex.remove(); return; }
        loadTemplates(function (tpls) {
            var menu = document.createElement('div'); menu.id = 'mrt-rc-aimenu'; menu.className = 'mrt-rc-aimenu';
            var hasText = ((q('#mrt-rc-text') || {}).value || '').trim();
            var html = '';
            if (hasText) html += '<button data-act="polish">✨ Polish what I typed</button>';
            html += '<div class="mrt-rc-aihd">Guided write</div>';
            html += tpls.map(function (t) {
                return '<button data-tpl="' + t.id + '" data-name="' + esc(t.name) + '">' + esc((t.icon || '✍️') + ' ' + t.name) + '</button>';
            }).join('') || '<div class="mrt-rc-aihd" style="opacity:.6">No scenarios yet</div>';
            menu.innerHTML = html;
            q('.mrt-rc-compose').appendChild(menu);
            menu.querySelectorAll('button').forEach(function (b) {
                b.addEventListener('click', function () {
                    menu.remove();
                    if (b.getAttribute('data-act') === 'polish') { aiPolish(); return; }
                    openGuided(b.getAttribute('data-tpl'), b.getAttribute('data-name'));
                });
            });
        });
    }
    function aiPolish() {
        var ta = q('#mrt-rc-text'); var text = (ta.value || '').trim();
        if (!text) { cstatus('err', 'Type a rough note first'); return; }
        cstatus('wait', '✨ Writing…');
        var mode = text.split(/\s+/).length <= 4 ? 'draft' : 'polish';
        ai({ mode: mode, text: text, customer_name: (S.thread && S.thread.name) || '', store: S.store }).then(function (r) {
            if (!r || !r.ok) { cstatus('err', (r && r.error) || 'AI unavailable'); return; }
            ta.value = r.message || text; ta.dispatchEvent(new Event('input'));
            cstatus('ok', '✨ Rewritten — edit or Send'); setTimeout(function () { cstatus('', ''); }, 2200);
        });
    }

    // Guided: pick a scenario → answer questions (base + AI follow-ups) → compose.
    function openGuided(id, name) {
        var note = ((q('#mrt-rc-text') || {}).value || '').trim();
        body('<div class="mrt-rc-load">✨ Preparing questions…</div>');
        ai({ action: 'guided_questions', scenario_id: Number(id), note: note, customer_name: (S.thread && S.thread.name) || '' }).then(function (r) {
            if (!r || !r.ok) { renderThread(); setTimeout(function () { cstatus('err', (r && r.error) || 'Could not load'); }, 60); return; }
            var qs = r.questions || [];
            var h = '<div class="mrt-rc-thead"><button class="mrt-rc-back" id="mrt-rc-gback">' + I.back + 'Back</button><span class="mrt-rc-who">' + esc(name) + '</span></div>' +
                '<div class="mrt-rc-gform">';
            qs.forEach(function (qq) {
                h += '<div class="mrt-rc-gq"><label>' + esc(qq.label) +
                    (qq.optional ? ' <span class="opt">(optional)</span>' : '') +
                    (qq.ai ? ' <span class="aitag" title="AI suggested">✨</span>' : '') + '</label>';
                if (qq.type === 'choice') {
                    h += '<div class="mrt-rc-gchoices" data-key="' + esc(qq.key) + '">' +
                        (qq.options || []).map(function (o) { return '<button type="button" class="mrt-rc-gchip" data-val="' + esc(o) + '">' + esc(o) + '</button>'; }).join('') + '</div>';
                } else {
                    h += '<input type="text" class="mrt-rc-gin" data-key="' + esc(qq.key) + '" placeholder="' + esc(qq.placeholder || '') + '">';
                }
                h += '</div>';
            });
            h += '</div><div class="mrt-rc-compose"><button class="mrt-rc-send mrt-rc-gwide" id="mrt-rc-gwrite">' + I.spark + ' Write the message</button><div class="mrt-rc-cstatus mrt-rc-gstatus" id="mrt-rc-gstatus"></div></div>';
            body(h);
            panel.querySelectorAll('.mrt-rc-gchoices').forEach(function (grp) {
                grp.querySelectorAll('.mrt-rc-gchip').forEach(function (chip) {
                    chip.addEventListener('click', function () {
                        grp.querySelectorAll('.mrt-rc-gchip').forEach(function (c) { c.classList.remove('on'); });
                        chip.classList.add('on'); grp.setAttribute('data-val', chip.getAttribute('data-val'));
                    });
                });
            });
            q('#mrt-rc-gback').addEventListener('click', function () { renderThread(); });
            q('#mrt-rc-gwrite').addEventListener('click', function () { submitGuided(id); });
        });
    }
    function submitGuided(id) {
        var answers = {};
        panel.querySelectorAll('.mrt-rc-gin').forEach(function (i) { if (i.value.trim()) answers[i.getAttribute('data-key')] = i.value.trim(); });
        panel.querySelectorAll('.mrt-rc-gchoices').forEach(function (g) { var v = g.getAttribute('data-val'); if (v) answers[g.getAttribute('data-key')] = v; });
        var gs = q('#mrt-rc-gstatus'); var btn = q('#mrt-rc-gwrite'); if (btn) btn.disabled = true;
        if (gs) gs.innerHTML = '<span class="wait">✨ Writing…</span>';
        ai({ action: 'guided_compose', scenario_id: Number(id), answers: answers, customer_name: (S.thread && S.thread.name) || '', store: S.store }).then(function (r) {
            if (!r || !r.ok) { if (btn) btn.disabled = false; if (gs) gs.innerHTML = '<span class="err">' + esc((r && r.error) || 'Failed') + '</span>'; return; }
            S.pendingDraft = r.message || '';
            renderThread();   // rebuilds the compose box; renderThread drops pendingDraft into the textarea
        });
    }

    /* --- calls --- */
    function renderCalls() {
        spinner('Loading calls…');
        fn('calls', { store: S.store, days: 14 }).then(function (r) {
            if (!r || !r.ok) {
                var hint = r && r.scope_hint ? '<div class="mrt-rc-hint">Setup: ' + esc(r.scope_hint) + '.</div>' : '';
                body('<div class="mrt-rc-err">' + esc((r && r.error) || 'Could not load calls') + '</div>' + hint); return;
            }
            var list = r.calls || [];
            if (!list.length) { body('<div class="mrt-rc-empty">No calls in the last 14 days.</div>'); return; }
            body('<div class="mrt-rc-list">' + list.map(function (c) {
                var icCls = c.missed ? ' bad' : (c.dir === 'in' ? ' in' : '');
                return '<div class="mrt-rc-call' + (c.missed ? ' missed' : '') + '" data-num="' + esc(c.number) + '" data-name="' + esc(c.name || '') + '">' +
                    '<span class="mrt-rc-callic' + icCls + '">' + (c.dir === 'in' ? I.arrIn : I.arrOut) + '</span>' +
                    '<span class="mrt-rc-conv-main">' +
                      '<span class="mrt-rc-conv-top">' +
                        '<span class="mrt-rc-who">' + esc(c.name || pretty(c.number)) + '</span>' +
                        '<span class="mrt-rc-when">' + esc(ago(c.time)) + '</span>' +
                      '</span>' +
                      '<span class="mrt-rc-prevrow">' +
                        '<span class="mrt-rc-res' + (c.missed ? ' bad' : '') + '">' + esc(c.result || '') + '</span>' +
                        '<span class="mrt-rc-num">· ' + esc(pretty(c.number)) + '</span>' +
                        '<button class="mrt-rc-txt" data-num="' + esc(c.number) + '" data-name="' + esc(c.name || '') + '">Text back</button>' +
                      '</span>' +
                    '</span>' +
                '</div>';
            }).join('') + '</div>');
            panel.querySelectorAll('.mrt-rc-txt').forEach(function (b) {
                b.addEventListener('click', function (e) {
                    e.stopPropagation();
                    S.tab = 'inbox';
                    panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-t') === 'inbox'); });
                    S.thread = { number: b.getAttribute('data-num'), name: b.getAttribute('data-name') };
                    renderThread();
                });
            });
        });
    }

    /* --- voicemail --- */
    function renderVoicemail() {
        spinner('Loading voicemail…');
        fn('voicemails', { store: S.store, days: 30 }).then(function (r) {
            if (!r || !r.ok) { body('<div class="mrt-rc-err">' + esc((r && r.error) || 'Could not load voicemail') + '</div>'); return; }
            var list = r.voicemails || [];
            if (!list.length) { body('<div class="mrt-rc-empty">No voicemail in the last 30 days.</div>'); return; }
            body('<div class="mrt-rc-list">' + list.map(function (v) {
                var tr = v.transcript ? esc(v.transcript)
                    : (v.transcription_status && /progress|pending/i.test(v.transcription_status) ? '<i>Transcribing…</i>' : '<i>No transcript</i>');
                return '<div class="mrt-rc-vm' + (v.read ? '' : ' unread') + '" data-num="' + esc(v.from) + '" data-name="' + esc(v.name || '') + '">' +
                    '<span class="mrt-rc-ava">' + esc(initials(v.name)) + '</span>' +
                    '<span class="mrt-rc-conv-main">' +
                      '<span class="mrt-rc-conv-top">' +
                        (v.read ? '' : '<span class="mrt-rc-udot" style="background:#DC282E"></span>') +
                        '<span class="mrt-rc-who">' + esc(v.name || pretty(v.from)) + '</span>' +
                        '<span class="mrt-rc-when">' + esc(ago(v.time)) + '</span>' +
                      '</span>' +
                      '<span class="mrt-rc-prevrow">' +
                        '<span class="mrt-rc-num">' + esc(pretty(v.from)) + '</span>' +
                        '<button class="mrt-rc-txt" data-num="' + esc(v.from) + '" data-name="' + esc(v.name || '') + '">Text back</button>' +
                      '</span>' +
                    '</span>' +
                    '<div class="mrt-rc-vmtext">' + tr + '</div>' +
                '</div>';
            }).join('') + '</div>');
            panel.querySelectorAll('.mrt-rc-txt').forEach(function (b) {
                b.addEventListener('click', function (e) {
                    e.stopPropagation();
                    S.tab = 'inbox';
                    panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-t') === 'inbox'); });
                    S.thread = { number: b.getAttribute('data-num'), name: b.getAttribute('data-name') };
                    renderThread();
                });
            });
        });
    }

    /* --- unread dot on the button + inbox tab pill --- */
    function updateDot(n) {
        var d = document.getElementById('mrt-rc-dot');
        if (d) {
            if (n > 0) { d.textContent = n > 9 ? '9+' : String(n); d.style.display = ''; }
            else d.style.display = 'none';
        }
        var t = q('#mrt-rc-tabdot');
        if (t) {
            if (n > 0) { t.textContent = n > 9 ? '9+' : String(n); t.style.display = ''; }
            else t.style.display = 'none';
        }
    }
    // Desktop notifications for new inbound texts + new missed calls. State
    // is shared across RepairQ tabs via storage.local so we notify once, and
    // the FIRST poll only seeds "seen" (no flood of old items on load).
    var SEEN_KEY = 'mrt_rc_seen';
    function getSeen() {
        return new Promise(function (res) {
            try { chrome.storage.local.get([SEEN_KEY]).then(function (r) { res((r && r[SEEN_KEY]) || null); }).catch(function () { res(null); }); }
            catch (e) { res(null); }
        });
    }
    function setSeen(s) { try { chrome.storage.local.set((function () { var o = {}; o[SEEN_KEY] = s; return o; })()); } catch (e) {} }
    function notify(title, message) {
        try { chrome.runtime.sendMessage({ type: 'notify:show', payload: { title: title, message: message } }); } catch (e) {}
    }

    function pollUnread() {
        if (!S.store) return;
        getSeen().then(function (seen) {
            var seeded = !!(seen && seen.seeded);
            var smsTimes = (seen && seen.sms) || {};   // { number: lastNotifiedISO }
            var callIds = (seen && seen.calls) || [];   // notified missed-call ids

            fn('conversations', { store: S.store, days: 14 }).then(function (r) {
                if (!r || !r.ok) return;
                var convs = r.conversations || [];
                updateDot(convs.reduce(function (a, c) { return a + (c.unread || 0); }, 0));
                convs.forEach(function (c) {
                    if (c.last_dir !== 'in' || !c.unread) return;
                    var prev = smsTimes[c.number];
                    if (seeded && (!prev || String(c.last_time) > String(prev))) {
                        notify('New text — ' + (c.name || pretty(c.number)), (c.last_text || '').slice(0, 120));
                    }
                    smsTimes[c.number] = c.last_time;
                });

                // missed calls (silently skips until ReadCallLog scope is added)
                fn('calls', { store: S.store, days: 3 }).then(function (cr) {
                    var newCallIds = callIds.slice();
                    if (cr && cr.ok) {
                        (cr.calls || []).forEach(function (c) {
                            if (!c.missed) return;
                            if (newCallIds.indexOf(c.id) > -1) return;
                            if (seeded) notify('Missed call — ' + (c.name || pretty(c.number)), 'Tap the Phone panel to text them back');
                            newCallIds.push(c.id);
                        });
                    }
                    setSeen({ seeded: true, sms: smsTimes, calls: newCallIds.slice(-200) });
                });
            });
        });
    }

    /* ---------------- open/close ---------------- */
    function open() {
        S.open = true; S.store = storeName();
        panel.classList.add('show');
        document.getElementById('mrt-rc-btn').classList.add('open');
        render();
    }
    function close() {
        S.open = false;
        panel.classList.remove('show');
        var b = document.getElementById('mrt-rc-btn'); if (b) b.classList.remove('open');
    }
    function toggle() { S.open ? close() : open(); }

    function applyLockState() {
        var li = document.getElementById('mrt-rc-nav') || document.getElementById('mrt-rc-btn');
        if (!li) return;
        if (isLocked()) { li.style.display = 'none'; if (S.open) close(); }
        else li.style.display = '';
    }

    /* ---- 💬 buttons next to customer phone numbers on ticket pages ---- */
    var PHONE_RE = /(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}|\b\d{10}\b)/;
    function customerName() {
        var dts = document.querySelectorAll('dt');
        for (var i = 0; i < dts.length; i++) {
            if (/^customer name/i.test(dts[i].textContent.trim())) {
                var dd = dts[i].nextElementSibling;
                if (dd && dd.tagName === 'DD') return dd.textContent.replace(/\s+/g, ' ').trim();
            }
        }
        var a = document.querySelector('.block-content a[href*="/customers/"]');
        return a ? a.textContent.replace(/\s+/g, ' ').trim() : '';
    }
    function injectTextButtons() {
        if (!/\/ticket\//.test(location.pathname) || /\/ticket\/print/i.test(location.pathname)) return;
        var zones = [];
        document.querySelectorAll('dt').forEach(function (dt) {
            if (/contact number/i.test(dt.textContent)) {
                var dd = dt.nextElementSibling;
                if (dd && dd.tagName === 'DD') zones.push(dd);
            }
        });
        document.querySelectorAll('.block-content').forEach(function (bc) {
            if (bc.querySelector('a[href*="/customers/"]')) zones.push(bc);
        });
        zones.forEach(function (zone) {
            if (zone.getAttribute('data-mrt-rc-txt')) return;
            zone.setAttribute('data-mrt-rc-txt', '1');
            var walker = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT, null);
            var hits = [];
            var n;
            while ((n = walker.nextNode())) {
                if (n.parentElement && n.parentElement.closest('#mrt-rc-panel, script, style, input, select, textarea, button')) continue;
                if (PHONE_RE.test(n.nodeValue)) hits.push(n);
            }
            hits.forEach(function (node) {
                var m = node.nodeValue.match(PHONE_RE);
                if (!m) return;
                var num = digits(m[1]);
                if (num.length === 11 && num.charAt(0) === '1') num = num.slice(1);
                if (num.length !== 10) return;
                var idx = node.nodeValue.indexOf(m[1]) + m[1].length;
                var after = node.splitText(idx);
                var btn = document.createElement('a');
                btn.href = '#'; btn.className = 'mrt-rc-num-btn'; btn.title = 'Text this number';
                btn.textContent = '💬';
                btn.setAttribute('data-num', num);
                btn.addEventListener('click', function (e) {
                    e.preventDefault(); e.stopPropagation();
                    openTextTo(num, customerName());
                });
                after.parentNode.insertBefore(btn, after);
            });
        });
    }

    function start() {
        build();
        S.store = storeName();
        applyLockState();
        // re-align once more after fonts/layout settle
        setTimeout(function () { var bar = document.querySelector('ul.nav.pull-right.workstation-menu'); if (bar) alignToNav(bar); }, 800);
        try { new MutationObserver(applyLockState).observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
        pollUnread();
        setInterval(pollUnread, 120000);   // refresh the unread badge every 2 min
        injectTextButtons();
        try {
            new MutationObserver(function () {
                clearTimeout(injectTextButtons._t);
                injectTextButtons._t = setTimeout(injectTextButtons, 500);
            }).observe(document.body, { childList: true, subtree: true });
        } catch (e) { /* best effort */ }
    }
    try {
        chrome.storage.sync.get(['sms']).then(function (res) {
            var s = (res && res.sms) || {};
            if (s.panel === false) return;
            if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
        }).catch(start);
    } catch (e) { start(); }
})();
