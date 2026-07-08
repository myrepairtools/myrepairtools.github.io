/*
    RingCentral panel (myRepairTools) — a drop-down phone/messaging console
    inside RepairQ, so staff manage texts, missed calls and voicemail without
    leaving the ticket screen. Mirrors the Square backup-register pop-down in
    MRT: a top-bar button toggles a persistent panel (closes on ✕ or the
    button, never on outside clicks).

    Tabs:
      💬 Inbox     — SMS conversations for THIS store's line → open a thread →
                     reply, with a ✨ "Help me write" AI polish/draft button.
      📞 Calls     — recent calls, missed ones flagged, one-tap "Text back".
      🎙 Voicemail — voicemails with RingCentral transcripts.

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

    var S = { open: false, tab: 'inbox', store: '', thread: null, loading: false };

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

    // RingCentral brand mark — orange rounded square + white phone (the
    // recognizable RC logo, same idea as the Square logo on the MRT rail).
    var RC_LOGO =
        '<svg class="mrt-rc-logo" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">' +
          '<rect width="24" height="24" rx="5" fill="#FF7A00"/>' +
          '<g transform="translate(4.5 4.5) scale(0.62)">' +
            '<path fill="#fff" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>' +
          '</g>' +
        '</svg>';

    function build() {
        // Icon-only, up in RepairQ's black top bar (left of English), matching
        // the native workstation-menu items.
        var bar = document.querySelector('ul.nav.pull-right.workstation-menu');
        if (bar) {
            var li = document.createElement('li');
            li.id = 'mrt-rc-nav'; li.className = 'mrt-rc-nav';
            li.innerHTML = '<a href="#" id="mrt-rc-btn" class="mrt-rc-btn" title="RingCentral — texts, calls, voicemail">' +
                RC_LOGO + '<span class="mrt-rc-dot" id="mrt-rc-dot" style="display:none"></span></a>';
            bar.insertBefore(li, bar.firstChild);
        } else {
            // fallback: the toolbar row, with a label
            var btn = document.createElement('a');
            btn.id = 'mrt-rc-btn'; btn.className = 'mrt-rc-btn btn btn-small innav'; btn.href = '#';
            btn.innerHTML = RC_LOGO + ' <span>Phone</span> <span class="mrt-rc-dot" id="mrt-rc-dot" style="display:none"></span>';
            btn.title = 'RingCentral — texts, calls, voicemail';
            var navSpot = document.getElementById('globalSearches');
            var form = navSpot && navSpot.querySelector('#quickSearch');
            if (form) form.insertBefore(btn, form.firstChild);
            else if (navSpot && navSpot.parentElement) navSpot.parentElement.insertBefore(btn, navSpot);
            else document.body.appendChild(btn);
        }
        document.getElementById('mrt-rc-btn').addEventListener('click', function (e) { e.preventDefault(); toggle(); });

        panel = document.createElement('div');
        panel.id = 'mrt-rc-panel'; panel.className = 'mrt-rc-panel';
        panel.innerHTML =
            '<div class="mrt-rc-hd">' +
              '<span class="mrt-rc-title">RingCentral</span>' +
              '<span class="mrt-rc-store" id="mrt-rc-store"></span>' +
              '<button class="mrt-rc-x" id="mrt-rc-x" title="Close">✕</button>' +
            '</div>' +
            '<div class="mrt-rc-tabs">' +
              '<button data-t="inbox" class="on">💬 Inbox</button>' +
              '<button data-t="calls">📞 Calls</button>' +
              '<button data-t="vm">🎙 Voicemail</button>' +
            '</div>' +
            '<div class="mrt-rc-body" id="mrt-rc-body"></div>';
        document.body.appendChild(panel);

        q('#mrt-rc-x').addEventListener('click', close);
        panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (b) {
            b.addEventListener('click', function () {
                S.tab = b.getAttribute('data-t'); S.thread = null;
                panel.querySelectorAll('.mrt-rc-tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
                render();
            });
        });
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
            if (!list.length) { body('<div class="mrt-rc-empty">No text conversations in the last 30 days.</div>'); return; }
            body('<div class="mrt-rc-list">' + list.map(function (c) {
                return '<div class="mrt-rc-conv' + (c.unread ? ' unread' : '') + '" data-num="' + esc(c.number) + '" data-name="' + esc(c.name || '') + '">' +
                    '<div class="mrt-rc-conv-top"><span class="mrt-rc-who">' + esc(c.name || pretty(c.number)) + '</span>' +
                    '<span class="mrt-rc-when">' + esc(ago(c.last_time)) + (c.unread ? ' <b class="mrt-rc-badge">' + c.unread + '</b>' : '') + '</span></div>' +
                    '<div class="mrt-rc-prev">' + (c.last_dir === 'out' ? '<span class="mrt-rc-you">You: </span>' : '') + esc((c.last_text || '').slice(0, 64)) + '</div>' +
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

    /* --- inbox: one thread + compose --- */
    function renderThread() {
        var t = S.thread;
        body('<div class="mrt-rc-thead"><button class="mrt-rc-back" id="mrt-rc-back">‹ Inbox</button>' +
             '<span class="mrt-rc-who">' + esc(t.name || pretty(t.number)) + '</span>' +
             '<span class="mrt-rc-tnum">' + esc(pretty(t.number)) + '</span></div>' +
             '<div class="mrt-rc-msgs" id="mrt-rc-msgs"><div class="mrt-rc-load">Loading…</div></div>' +
             '<div class="mrt-rc-compose">' +
               '<textarea id="mrt-rc-text" rows="2" placeholder="Text ' + esc(pretty(t.number)) + '…"></textarea>' +
               '<div class="mrt-rc-cbar">' +
                 '<button class="mrt-rc-ai" id="mrt-rc-ai" title="Help me write this">✨ Help me write</button>' +
                 '<button class="mrt-rc-send" id="mrt-rc-send">Send</button>' +
               '</div>' +
               '<div class="mrt-rc-cstatus" id="mrt-rc-cstatus"></div>' +
             '</div>');
        q('#mrt-rc-back').addEventListener('click', function () { S.thread = null; renderInbox(); });
        q('#mrt-rc-send').addEventListener('click', sendThread);
        q('#mrt-rc-ai').addEventListener('click', openAiMenu);
        loadMsgs();
        var ta = q('#mrt-rc-text'); if (ta && S.pendingDraft) { ta.value = S.pendingDraft; S.pendingDraft = null; cstatus('ok', '✨ Drafted — edit or Send'); }
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
            ta.value = ''; cstatus('ok', '✓ Sent'); setTimeout(function () { cstatus('', ''); }, 1500);
            loadMsgs();
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
            ta.value = r.message || text; cstatus('ok', '✨ Rewritten — edit or Send'); setTimeout(function () { cstatus('', ''); }, 2200);
        });
    }

    // Guided: pick a scenario → answer questions (base + AI follow-ups) → compose.
    function openGuided(id, name) {
        var note = ((q('#mrt-rc-text') || {}).value || '').trim();
        body('<div class="mrt-rc-load">✨ Preparing questions…</div>');
        ai({ action: 'guided_questions', scenario_id: Number(id), note: note, customer_name: (S.thread && S.thread.name) || '' }).then(function (r) {
            if (!r || !r.ok) { renderThread(); setTimeout(function () { cstatus('err', (r && r.error) || 'Could not load'); }, 60); return; }
            var qs = r.questions || [];
            var h = '<div class="mrt-rc-thead"><button class="mrt-rc-back" id="mrt-rc-gback">‹ Back</button><span class="mrt-rc-who">' + esc(name) + '</span></div>' +
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
            h += '</div><div class="mrt-rc-compose"><button class="mrt-rc-send" id="mrt-rc-gwrite" style="width:100%">✨ Write the message</button><div class="mrt-rc-cstatus" id="mrt-rc-gstatus"></div></div>';
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
                var arrow = c.dir === 'in' ? '↙' : '↗';
                return '<div class="mrt-rc-call' + (c.missed ? ' missed' : '') + '" data-num="' + esc(c.number) + '" data-name="' + esc(c.name || '') + '">' +
                    '<div class="mrt-rc-conv-top"><span class="mrt-rc-who">' + esc(arrow + ' ' + (c.name || pretty(c.number))) + '</span>' +
                    '<span class="mrt-rc-when">' + esc(ago(c.time)) + '</span></div>' +
                    '<div class="mrt-rc-prev"><span class="mrt-rc-res' + (c.missed ? ' bad' : '') + '">' + esc(c.result || '') + '</span>' +
                    ' · ' + esc(pretty(c.number)) + '<button class="mrt-rc-txt" data-num="' + esc(c.number) + '" data-name="' + esc(c.name || '') + '">Text back</button></div>' +
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
                    '<div class="mrt-rc-conv-top"><span class="mrt-rc-who">' + esc(v.name || pretty(v.from)) + '</span>' +
                    '<span class="mrt-rc-when">' + esc(ago(v.time)) + '</span></div>' +
                    '<div class="mrt-rc-vmtext">' + tr + '</div>' +
                    '<div class="mrt-rc-prev">' + esc(pretty(v.from)) + '<button class="mrt-rc-txt" data-num="' + esc(v.from) + '" data-name="' + esc(v.name || '') + '">Text back</button></div>' +
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

    /* --- unread dot on the button --- */
    function updateDot(n) {
        var d = document.getElementById('mrt-rc-dot'); if (!d) return;
        if (n > 0) { d.textContent = n > 9 ? '9+' : String(n); d.style.display = ''; }
        else d.style.display = 'none';
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
    function start() {
        build();
        S.store = storeName();
        applyLockState();
        try { new MutationObserver(applyLockState).observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
        pollUnread();
        setInterval(pollUnread, 120000);   // refresh the unread badge every 2 min
    }
    try {
        chrome.storage.sync.get(['sms']).then(function (res) {
            var s = (res && res.sms) || {};
            if (s.panel === false) return;
            if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
        }).catch(start);
    } catch (e) { start(); }
})();
