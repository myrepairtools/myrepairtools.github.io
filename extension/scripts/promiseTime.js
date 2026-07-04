/*
    Promise-Time Advisor (myRepairTools)

    Runs on: cpr.repairq.io/* (snapshot keeper) — UI on ticket create/edit
    pages (/ticket/repair*, /ticket/add, /ticket/edit/*).

    Two jobs:

    1. QUEUE SNAPSHOT — any open RepairQ tab quietly re-fetches the ticket
       list every few minutes (same-origin, same parser rules as What's
       Next) and caches {when, workable, noDue} in chrome.storage.local, so
       the current workload is always known.

    2. ADVISOR + SOFT GATE — on ticket pages with an ESTIMATE box, a chip
       shows the live queue depth and a suggested pickup time:

           suggested = now + (workable_ahead + 1) × minutes-per-repair
                       → rounded UP to the next half hour
                       → rolled to tomorrow morning when it lands too close
                         to closing

       "Use it" writes RepairQ's own "Promised on" date + time fields (via
       the page's jQuery datepicker, MAIN world through bg.js). And if a
       tech hits Save with no promise time set, a gentle modal offers the
       suggestion + presets — with a Skip, so the counter never jams.

    Options (storage.sync `wn` object): wn.promise (default ON),
    wn.minsPer (minutes per repair, default 45), wn.open / wn.close
    (store hours, default 10:00 / 19:00).
*/

(function () {
    'use strict';

    var SNAP_KEY = 'mrt_queue_snapshot';
    var SNAP_TTL = 5 * 60 * 1000;   // refresh when older than 5 min
    var INCLUDE = /(ready\s*for\s*repair|ready-for-repair|diagnos|in\s*repair|in\s*progress|new|open|approved)/i;
    var EXCLUDE = /(waiting|pending\s*notification|pickup|picked\s*up|repaired\b|closed|complete|invoic|quote|cancel|abandon|shipped|void)/i;

    var cfg = { minsPer: 45, open: '10:00', close: '19:00' };
    var snapshot = null, gateSkipped = false;

    /* ---------------- queue snapshot ---------------- */

    function parseCount(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var scope = doc.getElementById('mainModelList') || doc;
        var workable = 0, noDue = 0, ids = [];
        scope.querySelectorAll('tr[data-id]').forEach(function (tr) {
            var cols = {};
            tr.querySelectorAll('td[data-column]').forEach(function (td) {
                cols[td.getAttribute('data-column')] = td.textContent.replace(/\s+/g, ' ').trim();
            });
            var status = cols.status || '';
            if (!status || EXCLUDE.test(status) || !INCLUDE.test(status)) return;
            workable++;
            ids.push(tr.getAttribute('data-id'));
            if (!cols.est || cols.est === '-') noDue++;
        });
        var next = doc.querySelector('#gridPagination .next:not(.disabled) a[href]');
        return { workable: workable, noDue: noDue, ids: ids, next: next ? next.getAttribute('href') : null };
    }

    /*  Live pace: each refresh diffs the workable ticket-id set against the
        previous snapshot. Tickets that LEFT the workable queue = capacity
        freed (finished, or parked waiting) — those departures, over a
        90-minute window, set the observed minutes-per-repair. Bust out three
        screens and the window shows 3 gone → ~30 min pace → new promise
        times pull in (but only by what the remaining queue allows — the
        backlog still has to be chewed through). Quiet spell → pace decays
        back toward the configured default. */
    var PACE_WINDOW = 90 * 60 * 1000;

    function computePace(events, now) {
        var gone = 0;
        events.forEach(function (e) { if (now - e.t <= PACE_WINDOW) gone += e.gone; });
        if (gone < 2) return cfg.minsPer;                       // not enough signal — use the dial
        var pace = (PACE_WINDOW / 60000) / gone;                // window minutes per departure
        return Math.max(10, Math.min(cfg.minsPer * 2, pace));   // clamp to sane bounds
    }

    function refreshSnapshot() {
        var total = { workable: 0, noDue: 0, ids: [] };
        function pageIn(url, depth) {
            return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.text(); })
                .then(function (html) {
                    var p = parseCount(html);
                    total.workable += p.workable; total.noDue += p.noDue;
                    total.ids = total.ids.concat(p.ids);
                    if (p.next && depth < 3) return pageIn(p.next, depth + 1);
                });
        }
        return new Promise(function (res) {
            chrome.storage.local.get([SNAP_KEY]).then(function (r) { res((r && r[SNAP_KEY]) || null); })
                .catch(function () { res(null); });
        }).then(function (prev) {
            return pageIn('/ticket', 1).then(function () {
                var now = Date.now();
                var events = (prev && prev.events || []).filter(function (e) { return now - e.t <= PACE_WINDOW * 2; });
                if (prev && prev.ids && prev.ids.length) {
                    var cur = {}; total.ids.forEach(function (id) { cur[id] = 1; });
                    var gone = prev.ids.filter(function (id) { return !cur[id]; }).length;
                    if (gone > 0) events.push({ t: now, gone: gone });
                }
                snapshot = {
                    when: now, workable: total.workable, noDue: total.noDue,
                    ids: total.ids, events: events, effMins: computePace(events, now)
                };
                try { chrome.storage.local.set({ [SNAP_KEY]: snapshot }); } catch (e) {}
                return snapshot;
            });
        });
    }

    function getSnapshot() {
        return new Promise(function (res) {
            chrome.storage.local.get([SNAP_KEY]).then(function (r) {
                var s = r && r[SNAP_KEY];
                if (s && Date.now() - s.when < SNAP_TTL) { snapshot = s; res(s); }
                else refreshSnapshot().then(res, function () { res(s || null); });
            }).catch(function () { res(null); });
        });
    }

    /* ---------------- suggestion math ---------------- */

    function hm(str, dflt) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
        return m ? { h: +m[1], m: +m[2] } : dflt;
    }

    function suggest(workable, now, effMins) {
        now = now || new Date();
        var per = effMins || (snapshot && snapshot.effMins) || cfg.minsPer;
        var open = hm(cfg.open, { h: 10, m: 0 }), close = hm(cfg.close, { h: 19, m: 0 });
        var lead = Math.max(90, (workable + 1) * per);           // this ticket joins the line
        var t = new Date(now.getTime() + lead * 60000);
        t.setSeconds(0, 0);
        t.setMinutes(Math.ceil(t.getMinutes() / 30) * 30);       // round UP to :00/:30

        // must be promisable ≥30 min before closing, else tomorrow morning
        var cutoff = new Date(t); cutoff.setHours(close.h, close.m - 30, 0, 0);
        if (t > cutoff) {
            t.setDate(t.getDate() + 1);
            t.setHours(open.h + 1, 0, 0, 0);                     // an hour after open — queue carries over
        }
        // never promise before the store is open (big queues can cross midnight)
        var openT = new Date(t); openT.setHours(open.h, open.m, 0, 0);
        if (t < openT) t.setHours(open.h + 1, 0, 0, 0);
        return t;
    }

    function fmtWhen(t) {
        var now = new Date();
        var day = t.toDateString() === now.toDateString() ? 'today'
                : t.toDateString() === new Date(now.getTime() + 86400000).toDateString() ? 'tomorrow'
                : (t.getMonth() + 1) + '/' + t.getDate();
        var h = t.getHours() % 12 || 12, m = ('0' + t.getMinutes()).slice(-2);
        return day + ' ' + h + ':' + m + ' ' + (t.getHours() >= 12 ? 'PM' : 'AM');
    }

    /* ---------------- writing the Promised-on fields ---------------- */

    function estimateDateInput() { return document.getElementById('TicketForm_repair_estimated_day_local'); }
    function hasPromise() {
        var d = estimateDateInput();
        return !!(d && d.value.trim());
    }

    function setPromise(t) {
        var dateStr = (t.getMonth() + 1) + '/' + t.getDate() + '/' + t.getFullYear();
        var h = t.getHours() % 12 || 12, m = ('0' + t.getMinutes()).slice(-2);
        var timeText = h + ':' + m + ' ' + (t.getHours() >= 12 ? 'PM' : 'AM');
        try {
            chrome.runtime.sendMessage({ type: 'mrt:setEstimate', dateStr: dateStr, timeText: timeText }, function () {});
        } catch (e) {}
        // also set the raw input as a belt-and-braces (MAIN world does the real work)
        var d = estimateDateInput();
        if (d && !d.value) { d.value = dateStr; d.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    /* ---------------- UI ---------------- */

    function injectStyles() {
        if (document.getElementById('mrtPtStyles')) return;
        var s = document.createElement('style'); s.id = 'mrtPtStyles';
        s.textContent =
        '.mrt-pt-chip{display:flex;align-items:center;gap:10px;margin:8px 0;padding:9px 12px;' +
          'background:#EAF6FD;border:1.5px solid #CDEAF8;border-radius:10px;' +
          'font-family:"Nunito Sans","Segoe UI",Arial,sans-serif;font-size:12.5px;color:#1E7AA8;font-weight:700}' +
        '.mrt-pt-chip b{font-weight:900}' +
        '.mrt-pt-chip button{margin-left:auto;background:#DC282E;color:#fff;border:none;border-radius:8px;' +
          'padding:6px 12px;font-weight:800;font-size:12px;cursor:pointer;font-family:"Nunito",sans-serif}' +
        '.mrt-pt-chip button:hover{filter:brightness(1.08)}' +
        '#mrtPtGate{position:fixed;inset:0;z-index:2147483590;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(45,45,59,.55);font-family:"Nunito Sans","Segoe UI",Arial,sans-serif}' +
        '#mrtPtGate .card{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);padding:20px 22px;width:400px;max-width:92vw}' +
        '#mrtPtGate h4{margin:0 0 4px;font-size:16px;color:#2D2D3B;font-family:"Nunito",sans-serif}' +
        '#mrtPtGate .sub{font-size:12.5px;color:#8A8FA3;margin-bottom:14px}' +
        '#mrtPtGate .opts{display:flex;flex-wrap:wrap;gap:8px}' +
        '#mrtPtGate .opts button{border:1.5px solid #E0E2EA;background:#fff;color:#2D2D3B;border-radius:9px;' +
          'padding:9px 13px;font-weight:800;font-size:12.5px;cursor:pointer;font-family:"Nunito",sans-serif}' +
        '#mrtPtGate .opts button:hover{border-color:#4FB0E3;background:#EAF6FD}' +
        '#mrtPtGate .opts button.hero{background:#DC282E;border-color:#DC282E;color:#fff}' +
        '#mrtPtGate .skip{display:block;margin-top:14px;font-size:12px;color:#B9BDCB;background:none;border:none;cursor:pointer;text-decoration:underline}';
        document.head.appendChild(s);
    }

    function placeChip() {
        var d = estimateDateInput();
        if (!d) return;                                     // no ESTIMATE box on this page
        if (document.querySelector('.mrt-pt-chip')) return;
        var well = d.closest('.well') || d.parentElement;

        getSnapshot().then(function (s) {
            if (!s) return;
            if (document.querySelector('.mrt-pt-chip')) return;
            var t = suggest(s.workable);
            var chip = document.createElement('div');
            chip.className = 'mrt-pt-chip';
            chip.innerHTML = '📋 <span><b>' + s.workable + '</b> repairs in the queue → tell the customer <b>' +
                fmtWhen(t) + '</b></span><button type="button">Use it</button>';
            chip.querySelector('button').addEventListener('click', function () {
                setPromise(t);
                chip.innerHTML = '✅ <span>Promised for <b>' + fmtWhen(t) + '</b> — double-check the time dropdown</span>';
            });
            well.appendChild(chip);
        });
    }

    /* ---------------- soft gate on Save ---------------- */

    function gateModal(onPick) {
        var s = snapshot || { workable: 0 };
        var sug = suggest(s.workable);
        var mk = function (label, t) { return { label: label, t: t }; };
        var now = new Date();
        var eod = new Date(now); var close = hm(cfg.close, { h: 19, m: 0 }); eod.setHours(close.h, close.m - 60, 0, 0);
        var tom = new Date(now.getTime() + 86400000); var open = hm(cfg.open, { h: 10, m: 0 }); tom.setHours(open.h + 1, 0, 0, 0);
        var presets = [
            mk('⭐ ' + fmtWhen(sug) + ' (suggested)', sug),
            mk('+2 hrs', new Date(Math.ceil((now.getTime() + 2 * 3600000) / 1800000) * 1800000)),
            mk('+4 hrs', new Date(Math.ceil((now.getTime() + 4 * 3600000) / 1800000) * 1800000)),
            mk('End of day', eod),
            mk('Tomorrow ' + ((open.h + 1) % 12 || 12) + ':00', tom),
        ];
        var ov = document.createElement('div'); ov.id = 'mrtPtGate';
        ov.innerHTML = '<div class="card"><h4>⏰ No promise time on this ticket</h4>' +
            '<div class="sub">' + (s.workable ? s.workable + ' repairs already in the queue. ' : '') +
            'When should the customer come back?</div><div class="opts"></div>' +
            '<button class="skip">skip — save without one</button></div>';
        var opts = ov.querySelector('.opts');
        presets.forEach(function (p, i) {
            var b = document.createElement('button'); b.type = 'button';
            b.textContent = p.label; if (i === 0) b.className = 'hero';
            b.addEventListener('click', function () { ov.remove(); onPick(p.t); });
            opts.appendChild(b);
        });
        ov.querySelector('.skip').addEventListener('click', function () { ov.remove(); gateSkipped = true; onPick(null); });
        document.body.appendChild(ov);
    }

    function armGate() {
        document.addEventListener('click', function (e) {
            var btn = e.target.closest && e.target.closest('a.save-ticket');
            if (!btn || gateSkipped) return;
            if (!estimateDateInput()) return;       // page without an ESTIMATE box
            if (hasPromise()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            gateModal(function (t) {
                if (t) setPromise(t);
                gateSkipped = true;   // let the re-fired click through (page navigates on save)
                // brief pause when a time was picked so the MAIN-world write lands first
                setTimeout(function () { btn.click(); }, t ? 700 : 0);
            });
        }, true);   // capture, ahead of RepairQ's handlers
    }

    /* ---------------- the live pickup-time pill ---------------- */
    // Sits in the header spot left of the search bar (where the What's Next
    // button first lived) — a constant clock everyone can see, re-derived
    // from the queue snapshot: finish repairs fast and it pulls in, pile
    // tickets on and it pushes out.

    var pill = null;

    function pillText() {
        if (!snapshot) return '';
        var t = suggest(snapshot.workable, new Date(), snapshot.effMins);
        return '🕐 New repairs by <b>' + fmtWhen(t) + '</b>' +
               '<span class="mrt-pt-pill-sub">' + snapshot.workable + ' in queue · ~' +
               Math.round(snapshot.effMins || cfg.minsPer) + ' min/repair</span>';
    }

    function placePill() {
        var navSpot = document.getElementById('globalSearches');
        if (!navSpot || !navSpot.parentElement) return;
        if (document.querySelector('.mrt-pt-pill')) return;

        pill = document.createElement('span');
        pill.className = 'mrt-pt-pill';
        pill.title = 'Recommended pickup time for a repair dropped off right now — live from the workable queue and the last 90 minutes of completions';
        navSpot.parentElement.insertBefore(pill, navSpot);

        function tick() {
            if (!document.querySelector('.mrt-pt-pill')) return;
            var html = pillText();
            if (html) { pill.innerHTML = html; pill.style.display = ''; }
            else pill.style.display = 'none';
        }
        getSnapshot().then(tick);
        setInterval(tick, 60000);                       // the clock keeps walking
        try {                                           // any tab's refresh updates every tab
            chrome.storage.onChanged.addListener(function (ch, area) {
                if (area === 'local' && ch[SNAP_KEY]) { snapshot = ch[SNAP_KEY].newValue; tick(); }
            });
        } catch (e) {}
    }

    function injectPillStyles() {
        if (document.getElementById('mrtPtPillStyles')) return;
        var s = document.createElement('style'); s.id = 'mrtPtPillStyles';
        s.textContent =
        '.mrt-pt-pill{display:inline-block;vertical-align:middle;margin:4px 12px 0 0;padding:5px 13px;' +
          'background:#2D2D3B;color:#fff;border-radius:999px;font-family:"Nunito","Segoe UI",sans-serif;' +
          'font-weight:800;font-size:12.5px;line-height:1.25;box-shadow:0 2px 8px rgba(45,45,59,.3);white-space:nowrap}' +
        '.mrt-pt-pill b{color:#7FD4A0}' +
        '.mrt-pt-pill .mrt-pt-pill-sub{display:block;font-weight:700;font-size:10px;color:#B9BDCB}';
        document.head.appendChild(s);
    }

    /* ---------------- boot ---------------- */

    function start() {
        // every RepairQ tab keeps the snapshot warm
        getSnapshot();
        setInterval(function () { refreshSnapshot().catch(function () {}); }, SNAP_TTL);

        // the always-on pickup-time clock (skip the returns page — KBB panel lives there)
        if (!/rmaTracking/i.test(location.pathname)) {
            injectPillStyles();
            placePill();
        }

        // advisor UI only where the ESTIMATE box lives
        if (/\/ticket\/(repair|add|edit)/.test(location.pathname)) {
            injectStyles();
            placeChip();
            new MutationObserver(placeChip).observe(document.body, { childList: true, subtree: true });
            armGate();
        }
    }

    try {
        chrome.storage.sync.get(['wn']).then(function (res) {
            var wn = (res && res.wn) || {};
            if (wn.promise === false) return;
            if (wn.minsPer > 0) cfg.minsPer = Number(wn.minsPer);
            if (wn.open) cfg.open = wn.open;
            if (wn.close) cfg.close = wn.close;
            if (document.body) start();
            else document.addEventListener('DOMContentLoaded', start);
        }).catch(function () { if (document.body) start(); });
    } catch (e) { /* not in an extension context */ }
})();
