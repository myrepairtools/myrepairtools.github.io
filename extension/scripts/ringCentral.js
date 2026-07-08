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
    function storeName() {
        var t = document.querySelector('.location.tooltip-toggle span');
        return (t && t.textContent.trim()) || '';
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

    function build() {
        var btn = document.createElement('a');
        btn.id = 'mrt-rc-btn'; btn.className = 'mrt-rc-btn btn btn-small innav'; btn.href = '#';
        btn.innerHTML = '<i class="icon-phone"></i> <span>Phone</span> <span class="mrt-rc-dot" id="mrt-rc-dot" style="display:none"></span>';
        btn.title = 'RingCentral — texts, calls, voicemail';
        btn.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
        var navSpot = document.getElementById('globalSearches');
        var form = navSpot && navSpot.querySelector('#quickSearch');
        if (form) form.insertBefore(btn, form.firstChild);
        else if (navSpot && navSpot.parentElement) navSpot.parentElement.insertBefore(btn, navSpot);
        else document.body.appendChild(btn);

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
        q('#mrt-rc-ai').addEventListener('click', aiHelp);
        loadMsgs();
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
    function aiHelp() {
        var ta = q('#mrt-rc-text'); var text = (ta.value || '').trim();
        if (!text) { cstatus('err', 'Type a rough note first, then ✨'); return; }
        var btn = q('#mrt-rc-ai'); btn.disabled = true; cstatus('wait', '✨ Writing…');
        var mode = text.split(/\s+/).length <= 4 ? 'draft' : 'polish';
        ai({ mode: mode, text: text, customer_name: (S.thread && S.thread.name) || '', store: S.store }).then(function (r) {
            btn.disabled = false;
            if (!r || !r.ok) { cstatus('err', (r && r.error) || 'AI unavailable'); return; }
            ta.value = r.message || text; cstatus('ok', '✨ Rewritten — edit or Send'); setTimeout(function () { cstatus('', ''); }, 2200);
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
    function pollUnread() {
        if (!S.store) return;
        fn('conversations', { store: S.store, days: 14 }).then(function (r) {
            if (r && r.ok) updateDot((r.conversations || []).reduce(function (a, c) { return a + (c.unread || 0); }, 0));
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

    function start() {
        build();
        S.store = storeName();
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
