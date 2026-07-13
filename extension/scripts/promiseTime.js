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

    /* ---- ticket-type rules (Options → Ticket-Type Rules; storage.sync tt) ---- */
    var TT = null;   // loaded config; defaults below reproduce shipped behavior
    // RepairQ embeds the authoritative type in its inline page JSON
    // ("ticketType":"repair" | "sale" | "claim" | "trade" | …). Read that first;
    // fall back to the title/heuristic. Cached once a real value is found.
    var _rqType = '';
    function rqTicketType() {
        if (_rqType) return _rqType;
        try {
            var s = document.getElementsByTagName('script');
            for (var i = 0; i < s.length; i++) {
                var m = (s[i].textContent || '').match(/ticketType["']?\s*[:=]\s*["'](\w+)["']/i);
                if (m) { _rqType = m[1].toLowerCase(); break; }
            }
        } catch (e) {}
        return _rqType;
    }
    function mrtTicketType() {
        var rq = rqTicketType();
        if (rq) {
            if (/refurb/.test(rq)) return 'refurbish';
            if (/trade/.test(rq)) return 'tradein';
            if (/claim/.test(rq)) return 'claim';
            if (/sale/.test(rq)) return 'sale';
            if (/repair/.test(rq)) return 'repair';
        }
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


    var SNAP_KEY = 'mrt_queue_snapshot';
    var SNAP_TTL = 5 * 60 * 1000;   // refresh when older than 5 min
    var INCLUDE = /(ready\s*for\s*repair|ready-for-repair|diagnos|in\s*repair|in\s*progress|new|open|approved)/i;
    var EXCLUDE = /(waiting|pending\s*notification|pickup|picked\s*up|repaired\b|closed|complete|invoic|quote|cancel|abandon|shipped|void)/i;

    var cfg = { minsPer: 45, open: '10:00', close: '19:00', clock: true, promise: true };
    var snapshot = null, gateSkipped = false;

    // RepairQ locked (idle-timeout overlay) or on the login page — our UI
    // must not sit on top of the lock/login screen.
    function isLockedOut() {
        try {
            if (/\/site\/login/.test(location.pathname)) return true;
            if (document.body && document.body.classList.contains('session-timeout-overlay-active')) return true;
        } catch (e) {}
        return false;
    }

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

    /* ---------------- store hours (from RepairQ's own page) ---------------- */
    // RepairQ embeds the store's per-day hours in the ticket page's
    // $.app.page.init({... location:{ monday_start, monday_end, … } …}). We
    // parse them from the inline script (content scripts can read it), cache
    // per store name, and use today's real hours — Sat closes early, Sun may
    // be closed. Falls back to the Options default when unavailable.

    var HRS_KEY = 'mrt_store_hours';
    var storeHoursCache = {};                                    // { storeName: {days:{0..6:{open,close}|null}, when} }

    function hm(str, dflt) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
        return m ? { h: +m[1], m: +m[2] } : dflt;
    }

    function currentStore() {
        var t = document.querySelector('.location.tooltip-toggle span, #location option:checked, #filter_location option:checked');
        var name = t && t.textContent.replace(/\s+/g, ' ').trim();
        return name || '';
    }

    function readStoreHoursFromPage() {
        var scripts = document.querySelectorAll('script:not([src])');
        var src = '';
        for (var i = 0; i < scripts.length; i++) {
            if (scripts[i].textContent.indexOf('app.page.init') > -1) { src = scripts[i].textContent; break; }
        }
        if (!src) for (var j = 0; j < scripts.length; j++) {
            if (scripts[j].textContent.indexOf('monday_start') > -1) { src = scripts[j].textContent; break; }
        }
        if (!src) return null;
        var map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
        var days = {}, found = 0;
        for (var name in map) {
            var s = new RegExp('"' + name + '_start":\\s*(?:"([^"]*)"|null)').exec(src);
            var e = new RegExp('"' + name + '_end":\\s*(?:"([^"]*)"|null)').exec(src);
            if (!s || !e) continue;
            found++;
            days[map[name]] = (s[1] && e[1]) ? { open: s[1], close: e[1] } : null;   // null = closed
        }
        if (found < 5) return null;
        var sn = /"short_name":"([^"]*)"/.exec(src);
        var rec = { days: days, when: Date.now() };
        var store = (sn && sn[1]) || currentStore() || 'default';
        storeHoursCache[store] = rec;
        try { chrome.storage.local.set({ [HRS_KEY]: storeHoursCache }); } catch (e) {}
        return rec;
    }

    // today-or-given-date hours for the current store, else the Options default
    function dayHours(date) {
        var store = currentStore();
        var rec = (store && storeHoursCache[store]) || storeHoursCache['default'];
        if (rec && rec.days) {
            var d = rec.days[date.getDay()];
            if (d === null) return null;                          // closed that day
            if (d) return { open: hm(d.open), close: hm(d.close) };
        }
        return { open: hm(cfg.open, { h: 10, m: 0 }), close: hm(cfg.close, { h: 19, m: 0 }) };
    }

    // advance t to the next moment we'd actually promise a pickup: at least an
    // hour after opening (never right at open — the overnight queue comes
    // first) and ≥30 min before close.
    function rollIntoHours(t) {
        t = new Date(t);
        for (var g = 0; g < 14; g++) {
            var dh = dayHours(t);
            if (dh && dh.open && dh.close) {
                var earliest = new Date(t); earliest.setHours(dh.open.h + 1, dh.open.m, 0, 0);   // open + 1h
                var cut = new Date(t); cut.setHours(dh.close.h, dh.close.m - 30, 0, 0);
                if (earliest <= cut) {                            // this day has a usable window
                    if (t < earliest) return earliest;            // before open+1h → open+1h
                    if (t <= cut) return t;                       // within the window → good
                }
            }
            // closed day / no window / past close → next day at midnight; the
            // loop then returns that day's open+1h
            t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0);
        }
        return t;
    }

    function suggest(workable, now, effMins) {
        now = now || new Date();
        var per = effMins || (snapshot && snapshot.effMins) || cfg.minsPer;
        var lead = Math.max(90, (workable + 1) * per);           // this ticket joins the line
        var t = new Date(now.getTime() + lead * 60000);
        t.setSeconds(0, 0);
        t.setMinutes(Math.ceil(t.getMinutes() / 30) * 30);       // round UP to :00/:30
        return rollIntoHours(t);                                 // clamp into real store hours
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
        '#mrtPtGate .custom{margin-top:14px;border-top:1px solid #EEF0F4;padding-top:12px}' +
        '#mrtPtGate .custom label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#8A8FA3;margin-bottom:6px;font-family:"Nunito",sans-serif}' +
        '#mrtPtGate .crow{display:flex;gap:8px}' +
        '#mrtPtGate .cin{flex:1;min-width:0;border:1.5px solid #E0E2EA;border-radius:9px;padding:9px 11px;font-size:13px;color:#2D2D3B;font-family:inherit}' +
        '#mrtPtGate .cin:focus{outline:none;border-color:#4FB0E3}' +
        '#mrtPtGate .cgo{border:1.5px solid #4FB0E3;background:#4FB0E3;color:#fff;border-radius:9px;padding:0 16px;font-weight:800;cursor:pointer;font-family:"Nunito",sans-serif;font-size:13px}' +
        '#mrtPtGate .cgo:hover{filter:brightness(1.05)}' +
        '#mrtPtGate .cerr{color:#DC282E;font-size:11.5px;font-weight:700;margin-top:5px;min-height:1em}' +
        '#mrtPtGate .skip{display:block;margin-top:14px;font-size:12px;color:#B9BDCB;background:none;border:none;cursor:pointer;text-decoration:underline}';
        document.head.appendChild(s);
    }

    function placeChip() {
        if (isLockedOut()) { var old = document.querySelector('.mrt-pt-chip'); if (old) old.remove(); return; }
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
                chip.innerHTML = '✅ <span>Promised for <b>' + fmtWhen(t) + '</b></span>';
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
        var today = dayHours(now);                          // null if closed today
        var minFuture = now.getTime() + 5 * 60000;          // must be at least a few min out
        var closeToday = today ? (function () { var c = new Date(now); c.setHours(today.close.h, today.close.m, 0, 0); return c; })()
                               : new Date(now.getTime() - 1);   // closed today → no same-day presets
        var eod = new Date(closeToday);                     // "by end of today" = closing time
        // next open day: roll a time past today's close forward into hours
        var tomRaw = new Date(now); tomRaw.setDate(tomRaw.getDate() + 1); tomRaw.setHours(0, 0, 0, 0);
        var tom = rollIntoHours(tomRaw);
        var plus2 = new Date(Math.ceil((now.getTime() + 2 * 3600000) / 1800000) * 1800000);
        var plus4 = new Date(Math.ceil((now.getTime() + 4 * 3600000) / 1800000) * 1800000);
        var clock = function (t) {
            var h = t.getHours() % 12 || 12, m = ('0' + t.getMinutes()).slice(-2);
            return h + ':' + m + ' ' + (t.getHours() >= 12 ? 'PM' : 'AM');
        };
        // a same-day preset only shows if it lands in the future AND before we close
        var fits = function (t) { return t.getTime() > minFuture && t <= closeToday; };
        var presets = [ mk('⭐ ' + fmtWhen(sug) + ' (suggested)', sug) ];
        if (fits(plus2)) presets.push(mk('+2 hrs · ' + clock(plus2), plus2));
        if (fits(plus4)) presets.push(mk('+4 hrs · ' + clock(plus4), plus4));
        if (fits(eod))   presets.push(mk('End of day · ' + clock(eod), eod));
        // "tomorrow" may actually be the next OPEN day (skips a closed Sunday)
        var tomLbl = fmtWhen(tom);
        presets.push(mk((tomLbl.indexOf('tomorrow') === 0 ? 'Tomorrow ' + clock(tom) : 'Next: ' + tomLbl), tom));
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
        // custom — pick any date & time yourself if none of the presets fit
        var pad = function (n) { return ('0' + n).slice(-2); };
        var localStr = function (x) { return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + 'T' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
        var cwrap = document.createElement('div'); cwrap.className = 'custom';
        cwrap.innerHTML = '<label>Or set a custom time</label>' +
            '<div class="crow"><input type="datetime-local" class="cin"><button type="button" class="cgo">Use</button></div>' +
            '<div class="cerr"></div>';
        ov.querySelector('.card').insertBefore(cwrap, ov.querySelector('.skip'));
        var cin = cwrap.querySelector('.cin'), cerr = cwrap.querySelector('.cerr');
        cin.value = localStr(sug);                              // default to the suggested time
        cin.min = localStr(new Date());
        cwrap.querySelector('.cgo').addEventListener('click', function () {
            var v = cin.value; if (!v) { cerr.textContent = 'Pick a date & time.'; return; }
            var t = new Date(v);
            if (isNaN(t.getTime())) { cerr.textContent = 'That time didn’t read right.'; return; }
            if (t.getTime() < Date.now() - 60000) { cerr.textContent = 'That time is in the past.'; return; }
            ov.remove(); onPick(t);
        });
        cin.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); cwrap.querySelector('.cgo').click(); } });

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
               '<span class="mrt-pt-pill-sub"> · ' + snapshot.workable + ' in queue · ~' +
               Math.round(snapshot.effMins || cfg.minsPer) + ' min</span>';
    }

    function placePill() {
        if (document.querySelector('.mrt-pt-pill')) return;

        // Lives in the breadcrumb/toolbar row's empty middle, left of the
        // What's Next button (same slot whatsNext.js uses) — the fixed
        // top-nav overlay covered RepairQ's Settings menu. Fixed-center
        // stays as the fallback when that row isn't on the page.
        pill = document.createElement('div');
        pill.className = 'mrt-pt-pill';
        pill.title = 'Recommended pickup time for a repair dropped off right now — live from the workable queue and the last 90 minutes of completions';
        var navSpot = document.getElementById('globalSearches');
        var form = navSpot && navSpot.querySelector('#quickSearch');
        if (form) {
            pill.classList.add('mrt-pt-inrow');
            form.insertBefore(pill, form.firstChild);
        } else if (navSpot && navSpot.parentElement) {
            pill.classList.add('mrt-pt-inrow');
            navSpot.parentElement.insertBefore(pill, navSpot);
        } else {
            document.body.appendChild(pill);
        }

        function tick() {
            if (!document.querySelector('.mrt-pt-pill')) return;
            if (isLockedOut()) { pill.style.display = 'none'; return; }   // hide over lock/login
            var html = pillText();
            if (html) { pill.innerHTML = html; pill.style.display = ''; }
            else pill.style.display = 'none';
        }
        getSnapshot().then(tick);
        setInterval(tick, 60000);                       // the clock keeps walking
        // re-evaluate the instant RepairQ locks or unlocks (body class toggles)
        try { new MutationObserver(tick).observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
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
        '.mrt-pt-pill{position:fixed;top:9px;left:50%;transform:translateX(-50%);z-index:2147483300;' +
          'padding:6px 15px;background:#1F1F2A;color:#fff;border:1px solid rgba(255,255,255,.14);' +
          'border-radius:999px;font-family:"Nunito","Segoe UI",sans-serif;font-weight:800;font-size:12.5px;' +
          'line-height:1.2;box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:nowrap;pointer-events:none}' +
        '.mrt-pt-pill b{color:#7FD4A0}' +
        '.mrt-pt-pill .mrt-pt-pill-sub{font-weight:700;color:#B9BDCB}' +
        // in the toolbar row: flow inline with the What's Next button
        '.mrt-pt-pill.mrt-pt-inrow{position:static;transform:none;display:inline-block;' +
          'vertical-align:middle;margin:0 10px 0 0;box-shadow:none}' +
        '@media (max-width:1100px){.mrt-pt-pill{display:none}}';   // hide on tight widths so it never collides
        document.head.appendChild(s);
    }

    /* ---------------- boot ---------------- */

    function start() {
        // never on print pages — the clock pill would print on the invoice/label
        if (/\/ticket\/print/i.test(location.pathname)) return;
        // load cached store hours, then read fresh from this page if it carries them
        try {
            chrome.storage.local.get([HRS_KEY]).then(function (r) {
                if (r && r[HRS_KEY]) storeHoursCache = r[HRS_KEY];
                readStoreHoursFromPage();
            }).catch(function () { readStoreHoursFromPage(); });
        } catch (e) { readStoreHoursFromPage(); }

        // every RepairQ tab keeps the snapshot warm
        getSnapshot();
        setInterval(function () { refreshSnapshot().catch(function () {}); }, SNAP_TTL);

        // the pickup-time clock pill — its own toggle (wn.clock, default ON);
        // skip the returns page (KBB panel lives there)
        if (cfg.clock !== false && !/rmaTracking/i.test(location.pathname)) {
            injectPillStyles();
            placePill();
        }

        // advisor UI only where the ESTIMATE box lives. A "promised-by" pickup
        // time only makes sense on repairs (incl. claims) — never on sales /
        // trade-ins / refurbs — so hard-limit to those regardless of the grid.
        var tkt = mrtTicketType();
        if (cfg.promise !== false && (tkt === 'repair' || tkt === 'claim') && ttAllows('promise') && /\/ticket\/(repair|add|edit)/.test(location.pathname)) {
            injectStyles();
            placeChip();
            new MutationObserver(placeChip).observe(document.body, { childList: true, subtree: true });
            armGate();
        }
    }

    try {
        chrome.storage.sync.get(['wn', 'tt']).then(function (res) {
            var wn = (res && res.wn) || {};
            TT = (res && res.tt) || null;
            if (wn.promise !== undefined) cfg.promise = wn.promise;
            if (wn.clock !== undefined) cfg.clock = wn.clock;
            if (wn.minsPer > 0) cfg.minsPer = Number(wn.minsPer);
            if (wn.open) cfg.open = wn.open;
            if (wn.close) cfg.close = wn.close;
            // both the advisor and the ticker off → nothing for this script to do
            if (cfg.promise === false && cfg.clock === false) return;
            if (document.body) start();
            else document.addEventListener('DOMContentLoaded', start);
        }).catch(function () { if (document.body) start(); });
    } catch (e) { /* not in an extension context */ }
})();
