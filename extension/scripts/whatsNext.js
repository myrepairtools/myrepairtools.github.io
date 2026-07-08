/*
    What's Next? — the McDonald's order board (myRepairTools)

    A 🍔 button in RepairQ. Hit it and the system answers the only question
    that matters: "what should I work on right now?"

    How: fetch RepairQ's own open-ticket list (same-origin — the session is
    already there), parse the rows, keep only workable tickets, and rank them:

        1. EXPRESS / RUSH anywhere on the row  → front of the line
        2. OVERDUE (due time already passed)   → most overdue first
        3. everything else                     → due soonest first
        4. no due time                         → back of the line

    Workable = status looks like ready-for-repair / diagnose / in progress.
    Never suggested: waiting (parts/customer), ready for pickup, closed,
    invoiced, quotes.

    The card shows NEXT UP with Open / Skip; "board" expands the top of the
    queue with urgency colors — put a tab of it on the shop TV if you like.

    The parser is deliberately defensive (columns discovered via data-column
    attributes, dates via regex) because RepairQ's markup shifts between
    views. If the queue ever comes back empty on a page you KNOW has tickets,
    save the ticket list page as HTML and send it to Claude to tune.
*/
(function () {
    'use strict';

    var LIST_URL = '/ticket';           // RepairQ's ticket list (the tech's default view)
    var MAX_PAGES = 5;                  // follow "next page" links this many times, tops
    var INCLUDE = /(ready\s*for\s*repair|ready-for-repair|diagnos|in\s*repair|in\s*progress|new|open|approved)/i;
    var EXCLUDE = /(waiting|pending\s*notification|pickup|picked\s*up|repaired\b|closed|complete|invoic|quote|cancel|abandon|shipped|void)/i;
    var EXPRESS = /(express|rush)/i;

    var overlay = null, queue = [], skipped = {}, boardMode = false, lastFetch = 0;

    /* ---------------- parsing ---------------- */

    function parseDue(text) {
        // "7/3/26 2:30 PM", "07/03/2026", "Jul 3 2:30pm" — best effort
        var t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t) return null;
        var d = null;
        var m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
        if (m) {
            var y = Number(m[3]); if (y < 100) y += 2000;
            d = new Date(y, Number(m[1]) - 1, Number(m[2]));
        } else {
            var md = t.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})/i);
            if (md) {
                var months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
                var now = new Date();
                d = new Date(now.getFullYear(), months[md[1].slice(0,3).toLowerCase()], Number(md[2]));
            }
        }
        if (!d || isNaN(d)) return null;
        var tm = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
        if (tm) {
            var h = Number(tm[1]), min = Number(tm[2]);
            var ap = (tm[3] || '').toLowerCase();
            if (ap === 'pm' && h < 12) h += 12;
            if (ap === 'am' && h === 12) h = 0;
            d.setHours(h, min, 0, 0);
        } else {
            d.setHours(23, 59, 0, 0);   // date-only due = end of that day
        }
        return d;
    }

    function parseRow(tr) {
        var cols = {};
        tr.querySelectorAll('td[data-column]').forEach(function (td) {
            cols[td.getAttribute('data-column').toLowerCase()] = td.textContent.replace(/\s+/g, ' ').trim();
        });
        // ticket number: the row's data-id, else the id column / any ticket link
        var link = tr.querySelector('td[data-column="id"] a[href], a[href*="/ticket/view/"], a[href*="/ticket/edit/"]');
        var no = tr.getAttribute('data-id') || '';
        if (!/^\d+$/.test(no)) {
            var m = link && (link.getAttribute('href') || '').match(/\/ticket\/(?:view\/|edit\/)?(\d+)\b/);
            if (!m) return null;
            no = m[1];
        }
        if (!Object.keys(cols).length) return null;   // not a ticket-list row
        var t = { no: no, cols: cols, text: tr.textContent.replace(/\s+/g, ' ').trim() };
        t.href = link ? link.getAttribute('href') : ('/ticket/' + no);
        function pick(re) {
            for (var k in t.cols) if (re.test(k) && t.cols[k]) return t.cols[k];
            return '';
        }
        var due = t.cols.est || pick(/\best\b|due/);
        t.due     = parseDue(due === '-' ? '' : due);
        t.status  = t.cols.status || pick(/status|bucket|state/) || '';
        t.device  = t.cols.items || pick(/device|model|item/) || '';
        t.customer= t.cols.customer || pick(/client/) || '';
        t.assignee= t.cols.assignee || pick(/assign|tech|owner/) || '';
        t.express = EXPRESS.test(t.text);
        return t;
    }

    function workable(t) {
        var s = t.status || t.text;
        if (EXCLUDE.test(t.status)) return false;
        if (t.status && INCLUDE.test(t.status)) return true;
        // status column missing/unknown: fall back to row text, err to exclude
        return !EXCLUDE.test(s) && INCLUDE.test(s);
    }

    function rank(a, b) {
        var now = Date.now();
        function tier(t) {
            if (t.express) return 0;
            if (t.due && t.due.getTime() < now) return 1;
            if (t.due) return 2;
            return 3;
        }
        var ta = tier(a), tb = tier(b);
        if (ta !== tb) return ta - tb;
        if (a.due && b.due) return a.due - b.due;
        return Number(a.no) - Number(b.no);
    }

    function fetchPage(url, rows, depth) {
        return fetch(url, { credentials: 'same-origin' })
            .then(function (r) { return r.text(); })
            .then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var scope = doc.getElementById('mainModelList') || doc;
                scope.querySelectorAll('tr').forEach(function (tr) {
                    var t = parseRow(tr);
                    if (t && workable(t)) rows.push(t);
                });
                // "Items 1 - 20 of 27" → follow the pager's next link for the rest
                var next = doc.querySelector('#gridPagination .next:not(.disabled) a[href]');
                if (next && depth < MAX_PAGES) return fetchPage(next.getAttribute('href'), rows, depth + 1);
                return rows;
            });
    }

    function fetchQueue() {
        return fetchPage(LIST_URL, [], 1).then(function (rows) {
            // de-dup (a ticket can render twice across sections/pages)
            var seen = {}, out = [];
            rows.forEach(function (t) { if (!seen[t.no]) { seen[t.no] = 1; out.push(t); } });
            out.sort(rank);
            queue = out; lastFetch = Date.now();
            return out;
        });
    }

    /* ---------------- UI ---------------- */

    function fmtDue(t) {
        if (!t.due) return 'no due time';
        var diff = Math.round((t.due.getTime() - Date.now()) / 60000);
        var hh = t.due.getHours() % 12 || 12, mm = ('0' + t.due.getMinutes()).slice(-2);
        var ap = t.due.getHours() >= 12 ? 'PM' : 'AM';
        var clock = hh + ':' + mm + ' ' + ap;
        if (diff < -1440) return 'OVERDUE since ' + t.due.toLocaleDateString();
        if (diff < 0) return 'OVERDUE by ' + Math.abs(diff >= -60 ? diff : Math.round(diff / 60)) + (diff >= -60 ? ' min' : ' hr') + ' (' + clock + ')';
        if (diff < 60) return 'due in ' + diff + ' min (' + clock + ')';
        if (diff < 1440) return 'due ' + clock;
        return 'due ' + t.due.toLocaleDateString();
    }
    function urgency(t) {
        if (t.express) return 'express';
        if (!t.due) return 'nodue';
        if (t.due.getTime() < Date.now()) return 'overdue';
        if (t.due.getTime() - Date.now() < 3600000) return 'soon';
        return 'ok';
    }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function card(t, big) {
        var u = urgency(t);
        return '<div class="mrt-wn-card ' + u + (big ? ' big' : '') + '" data-open="' + esc(t.href) + '">' +
            '<div class="l">' +
              '<div class="no">#' + esc(t.no) + (t.express ? ' <span class="xp">EXPRESS</span>' : '') + '</div>' +
              '<div class="dv">' + esc(t.device || t.customer || '') + '</div>' +
              (t.status ? '<div class="st">' + esc(t.status) + '</div>' : '') +
            '</div>' +
            '<div class="r ' + u + '">' + esc(fmtDue(t)) + '</div>' +
        '</div>';
    }

    function visibleQueue() {
        return queue.filter(function (t) { return !skipped[t.no]; });
    }

    function render() {
        var box = overlay.querySelector('.mrt-wn-body');
        var q = visibleQueue();
        if (!q.length) {
            box.innerHTML = '<div class="mrt-wn-empty">🎉 Nothing in the workable queue' +
                (Object.keys(skipped).length ? ' (you skipped ' + Object.keys(skipped).length + ')' : '') +
                '.<br><span>Either you\'re caught up, or the parser needs tuning for this view — tell a manager.</span></div>';
            return;
        }
        var noDue = q.filter(function (t) { return !t.due; }).length;
        var noDueLine = noDue
            ? '<div class="mrt-wn-nodue">⚠ ' + noDue + ' workable ticket' + (noDue > 1 ? 's have' : ' has') +
              ' no promise time — set one on the ticket\'s ESTIMATE box</div>'
            : '';
        if (boardMode) {
            box.innerHTML = noDueLine + '<div class="mrt-wn-boardlist">' + q.slice(0, 12).map(function (t, i) {
                return '<div class="row"><span class="rank">' + (i + 1) + '</span>' + card(t) + '</div>';
            }).join('') + '</div>';
        } else {
            var next = q[0];
            box.innerHTML =
                noDueLine +
                '<div class="mrt-wn-nextlbl">NEXT UP</div>' + card(next, true) +
                '<div class="mrt-wn-actions">' +
                  '<button class="go" data-go="' + esc(next.href) + '">Open ticket #' + esc(next.no) + ' →</button>' +
                  '<button class="skip" data-skip="' + next.no + '">Skip → next</button>' +
                '</div>' +
                (q.length > 1 ? '<div class="mrt-wn-updeck">on deck: ' + q.slice(1, 4).map(function (t) {
                    return '#' + esc(t.no);
                }).join(' · ') + (q.length > 4 ? ' · +' + (q.length - 4) + ' more' : '') + '</div>' : '');
        }
        box.querySelectorAll('[data-go]').forEach(function (b) {
            b.addEventListener('click', function () { location.href = b.getAttribute('data-go'); });
        });
        box.querySelectorAll('[data-skip]').forEach(function (b) {
            b.addEventListener('click', function () { skipped[b.getAttribute('data-skip')] = 1; render(); });
        });
        box.querySelectorAll('.mrt-wn-card[data-open]').forEach(function (c) {
            c.addEventListener('click', function (e) {
                if (e.target.closest('button')) return;
                location.href = c.getAttribute('data-open');
            });
        });
    }

    function open() {
        overlay.classList.add('open');
        var box = overlay.querySelector('.mrt-wn-body');
        box.innerHTML = '<div class="mrt-wn-empty">Checking the queue…</div>';
        skipped = {};
        fetchQueue().then(render).catch(function () {
            box.innerHTML = '<div class="mrt-wn-empty">Couldn\'t read the ticket list. Try from the Tickets page.</div>';
        });
    }
    function close() { overlay.classList.remove('open'); }

    function build() {
        // launcher: sit just left of the Tickets search group, styled as a
        // native RepairQ btn (Bootstrap 2 + FontAwesome 3, like its
        // neighbors); float as our own pill only if the header isn't there
        var btn = document.createElement('a');
        btn.className = 'mrt-wn-btn';
        btn.href = '#';
        btn.innerHTML = '<i class="icon-list-ol"></i> <span class="mrt-wn-btnlbl">What’s next?</span>';
        btn.title = 'What should I work on right now?';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            overlay.classList.contains('open') ? close() : open();
        });
        var navSpot = document.getElementById('globalSearches');
        var form = navSpot && navSpot.querySelector('#quickSearch');
        if (form) {
            btn.classList.add('innav', 'btn', 'btn-small');
            form.insertBefore(btn, form.firstChild);
        } else if (navSpot && navSpot.parentElement) {
            btn.classList.add('innav', 'btn', 'btn-small');
            navSpot.parentElement.insertBefore(btn, navSpot);
        } else {
            document.body.appendChild(btn);
        }

        overlay = document.createElement('div');
        overlay.className = 'mrt-wn-overlay';
        overlay.innerHTML =
            '<div class="mrt-wn-panel">' +
              '<div class="mrt-wn-hd"><i class="icon-list-ol"></i>&nbsp;What’s next?' +
                '<button class="bd" title="Order board view">📺 board</button>' +
                '<button class="rf" title="Refresh">↻</button>' +
                '<button class="x" title="Close">✕</button>' +
              '</div>' +
              '<div class="mrt-wn-body"></div>' +
            '</div>';
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        overlay.querySelector('.x').addEventListener('click', close);
        overlay.querySelector('.rf').addEventListener('click', open);
        overlay.querySelector('.bd').addEventListener('click', function () {
            boardMode = !boardMode;
            this.classList.toggle('on', boardMode);
            render();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && overlay.classList.contains('open')) close();
        });
        document.body.appendChild(overlay);
    }

    // Never on the login / lock screen — with no header to dock into, the
    // button floats as a pill right on top of RepairQ's sign-in form.
    function isLoginPage() {
        try {
            if (/\/site\/login/i.test(location.pathname)) return true;
            if (document.body && document.body.classList.contains('login')) return true;
        } catch (e) {}
        return false;
    }

    function start() {
        if (isLoginPage()) return;
        if (document.body) build();
        else document.addEventListener('DOMContentLoaded', build);
    }
    try {
        chrome.storage.sync.get(['wn']).then(function (res) {
            if (res && res.wn && res.wn.enabled === false) return;
            start();
        }).catch(start);
    } catch (e) { start(); }
})();
