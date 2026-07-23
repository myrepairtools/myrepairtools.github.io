/*
    myRepairTools — background service worker.

    Two jobs:

    1. Print gate: the RepairQ label page auto-prints ~100ms after load, in a
       brand-new tab. The LCD send-display label has to be fetched + injected
       first, so the moment a printLabel tab starts loading we inject a gate
       into the page's MAIN world (injectImmediately = document_start timing)
       that holds window.print until lcdLabel.js dispatches 'mrtPrintReady'
       (legacy 'oledPrintReady' still honored). A 4s safety net guarantees
       printing is never blocked. (Carried over from RQ Mods' oledBg.js.)

    2. LCD Buyback API proxy: content scripts message here instead of fetching
       Supabase directly, so page CSP/CORS can never interfere. The lcd-buyback
       edge function authenticates with the shared LCD secret (deterrent-level,
       same convention as the rest of the MRT stack).

    3. Signature injector (mcpr:signature, for the Popup Blocker's T&C flow):
       jSignature keeps its stroke data in jQuery data on the page, which a
       content script can't touch — executeScript in the MAIN world can.
       Injects one straight-line stroke and fills the hidden signature input.
       (Ported from the MyCPRTools extension.)
*/

var LCD_FN = 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/lcd-buyback';
var LCD_SECRET = '77a715da8c43ebc3bf59b5f41ac9f7c80a71c6063be4530a';

// Supabase anon key (public — same one committed across the site) for the
// messaging function gateway. RingCentral creds stay server-side only.
var SB_FN = 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1';
var SB_REST = 'https://xuvsehrevxackuhmbmry.supabase.co/rest/v1';
var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

/* ---------------- print gate ---------------- */

// Serialized and run in the PAGE's MAIN world.
function printGate() {
    if (window.__mrtGateInstalled) return;
    window.__mrtGateInstalled = true;

    var realPrint = window.print.bind(window);
    var ready = false, pending = false, done = false;

    window.print = function () { if (ready) { realPrint(); } else { pending = true; } };

    function release() {
        if (done) return;
        done = true;
        ready = true;
        window.print = realPrint;        // restore for the page + manual reprint
        if (pending) { realPrint(); }    // page tried to print while held -> now
    }

    document.addEventListener('mrtPrintReady', release);
    document.addEventListener('oledPrintReady', release);
    setTimeout(release, 4000);           // safety: never block printing for long
    console.log('[MRT] print gate installed');
}

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
    if (info.status !== 'loading') return;
    var url = (tab && tab.url) || '';
    if (!/^https:\/\/cpr\.repairq\.io\/ticket\/printLabel\/\d+/.test(url)) return;
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        injectImmediately: true,
        func: printGate
    }).catch(function () { /* tab gone / not injectable */ });
});

/* ---------------- LCD Buyback API ---------------- */

function lcdFetch(action, opts) {
    var url = LCD_FN + '?action=' + action + (opts.query || '');
    return fetch(url, {
        method: opts.body ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            'x-cpr-secret': LCD_SECRET
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) { return r.json(); });
}

/* ---------------- messaging (RingCentral SMS) proxy ---------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('sms:') !== 0) return;
    var action = msg.type.slice(4);            // sms:send -> send, sms:unread -> unread
    fetch(SB_FN + '/messaging', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + SB_ANON,
            'apikey': SB_ANON
        },
        body: JSON.stringify(Object.assign({ action: action }, msg.payload || {}))
    }).then(function (r) { return r.json(); })
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true; // async
});

/* ---------------- RepairQ ticket-note write (background path) ---------------- */
// The ticket-note write must survive the page turn that follows a status
// change, so the SERVICE WORKER owns the whole outcome — the page that asked
// for it may already be navigating by the time anything resolves:
//   1) direct SW fetch (host permission → no CORS; session cookies when
//      Chrome sends them for extension requests)
//   2) if that fails, wait for the sender tab to finish (re)loading and run
//      the write FROM the fresh page via chrome.scripting — page context,
//      cookies + fresh CSRF guaranteed, and nothing navigating anymore
//   3) if both fail, the SW itself files a kind:'debug' row on
//      extension_issues so the failure is never invisible
// Content scripts message {type:'note:save', payload:{ticketId, note, csrf}}.

function noteWaitForTab(tabId, timeoutMs) {
    return new Promise(function (resolve) {
        var done = false;
        var onUp = function (id, info) { if (id === tabId && info.status === 'complete') settle(); };
        var finish = function () {
            if (done) return; done = true;
            try { chrome.tabs.onUpdated.removeListener(onUp); } catch (e) { /* gone */ }
            resolve();
        };
        // small settle delay so the new document's forms (CSRF input) exist
        var settle = function () { setTimeout(finish, 700); };
        chrome.tabs.get(tabId, function (tab) {
            if (chrome.runtime.lastError || !tab) { finish(); return; }
            chrome.tabs.onUpdated.addListener(onUp);
            if (tab.status === 'complete') settle();
        });
        setTimeout(finish, timeoutMs);
    });
}

// A real ticketNote/save returns JSON {"success":true,"note":{"id":…}}. An
// UNAUTHENTICATED request (the SW direct path — Chrome doesn't attach RepairQ's
// session cookie to extension-initiated fetches) bounces to a login page whose
// HTML can loosely contain "success":true and false-match a substring test. So
// require real proof: parse JSON and confirm a saved note object with an id.
function noteSaved(status, bodyText) {
    if (!(status >= 200 && status < 300)) return false;
    try {
        var d = JSON.parse(bodyText);
        return !!(d && d.success === true && d.note && d.note.id);
    } catch (e) { return false; }   // HTML (login/redirect) → not a save
}

// runs INSIDE the RepairQ page (chrome.scripting) — plain page-world fetch
function notePageWrite(ticketId, note) {
    var el = document.getElementsByName('YII_CSRF_TOKEN')[0];
    var csrf = el && el.value;
    if (!csrf) return Promise.resolve({ ok: false, error: 'no csrf on page' });
    return fetch('/ajax/ticketNote/save', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        body: new URLSearchParams({ YII_CSRF_TOKEN: csrf, ticketId: ticketId, note: note, print: '0', important: '0' }).toString(),
    }).then(function (r) {
        return r.text().then(function (t) {
            var ok = false;
            try { var d = JSON.parse(t); ok = !!(d && d.success === true && d.note && d.note.id); } catch (e) { ok = false; }
            return { ok: ok, status: r.status, body: String(t).slice(0, 180) };
        });
    }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'note:save') return;
    var p = msg.payload || {};
    var text = String(p.note == null ? '' : p.note)
        .replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim();   // RepairQ MySQL is 3-byte utf8 — emoji truncate the note to blank
    if (!text || !p.ticketId || !p.csrf) { sendResponse({ ok: false, error: 'missing note/ticketId/csrf' }); return true; }
    var tabId = sender && sender.tab && sender.tab.id;
    var ticketId = String(p.ticketId);

    var direct = function () {
        return fetch('https://cpr.repairq.io/ajax/ticketNote/save', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
            body: new URLSearchParams({ YII_CSRF_TOKEN: p.csrf, ticketId: ticketId, note: text, print: '0', important: '0' }).toString(),
        }).then(function (r) {
            return r.text().then(function (t) {
                return { ok: noteSaved(r.status, t), status: r.status, body: String(t).slice(0, 180) };
            });
        }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    };

    var inTab = function () {
        if (!tabId) return Promise.resolve({ ok: false, error: 'no sender tab' });
        return noteWaitForTab(tabId, 15000).then(function () {
            return chrome.scripting.executeScript({
                target: { tabId: tabId }, func: notePageWrite, args: [ticketId, text],
            }).then(function (res) {
                return (res && res[0] && res[0].result) || { ok: false, error: 'no executeScript result' };
            });
        }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    };

    var debugRow = function (detail) {
        fetch(SB_FN + '/report-issue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON },
            body: JSON.stringify({
                kind: 'debug', message: 'bg note:save: ' + detail,
                ticket_no: ticketId, ext_version: chrome.runtime.getManifest().version,
            }),
        }).catch(function () { /* diagnostics only */ });
    };

    var respond = function (r) { try { sendResponse(r); } catch (e) { /* page gone — fine */ } };

    direct().then(function (r1) {
        if (r1.ok) { respond({ ok: true, path: 'direct' }); return; }
        inTab().then(function (r2) {
            if (r2.ok) { respond({ ok: true, path: 'tab' }); return; }
            // one more chance: the first in-tab try can be killed by the very
            // navigation we're dodging — wait out the reload and try again
            inTab().then(function (r3) {
                if (r3.ok) { respond({ ok: true, path: 'tab2' }); return; }
                debugRow('direct=' + JSON.stringify(r1) + ' tab=' + JSON.stringify(r2) + ' tab2=' + JSON.stringify(r3));
                respond({ ok: false, direct: r1, tab: r3 });
            });
        });
    });
    return true; // async
});

/* ---------------- report an extension issue ---------------- */
// Techs file glitches from a link in RepairQ. The report-issue edge function
// logs the row to extension_issues AND texts the owner so it surfaces right away.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'issue:report') return;
    fetch(SB_FN + '/report-issue', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SB_ANON,
            'Authorization': 'Bearer ' + SB_ANON
        },
        body: JSON.stringify(msg.payload || {})
    }).then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
      .then(function (x) { sendResponse(x.r.ok && x.d && x.d.ok ? { ok: true } : { ok: false, status: x.r.status, error: x.d && x.d.error }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true; // async
});

/* ---------------- desktop notifications (new SMS / missed calls) ---------------- */
// Content scripts can't call chrome.notifications; they message here.

chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'notify:show') return;
    var p = msg.payload || {};
    try {
        chrome.notifications.create('mrt-rc-' + Date.now(), {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('images/mrt128.png'),
            title: p.title || 'myRepairTools',
            message: p.message || '',
            priority: 2
        });
    } catch (e) { /* notifications unavailable */ }
    // no async response
});

/* ---------------- AI compose (help write texts) proxy ---------------- */
// ai:compose → the ai-compose edge function (ANTHROPIC_API_KEY stays server-side).

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('ai:') !== 0) return;
    var action = msg.type.slice(3);            // ai:compose -> compose
    var slug = action === 'compose' ? 'ai-compose' : null;
    if (!slug) return;
    fetch(SB_FN + '/' + slug, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + SB_ANON,
            'apikey': SB_ANON
        },
        body: JSON.stringify(msg.payload || {})
    }).then(function (r) { return r.json(); })
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true; // async
});

/* ---------------- Sickw blacklist-check proxy ---------------- */
// sickw:check / sickw:balance -> the sickw-check edge function (the Sickw API
// key stays server-side; same anon-key gateway pattern as ai:).

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('sickw:') !== 0) return;
    var action = msg.type.slice(6);            // sickw:check -> check
    fetch(SB_FN + '/sickw-check', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + SB_ANON,
            'apikey': SB_ANON
        },
        body: JSON.stringify(Object.assign({ action: action }, msg.payload || {}))
    }).then(function (r) { return r.json(); })
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true; // async
});

/* ---------------- voice call (Twilio) proxy ---------------- */
// call:place / call:status → the twilio-call edge function (Twilio creds
// stay server-side; same anon-key gateway pattern as sms:).

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('call:') !== 0) return;
    var action = msg.type.slice(5);            // call:place -> call, call:status -> status
    if (action === 'place') action = 'call';
    fetch(SB_FN + '/twilio-call', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + SB_ANON,
            'apikey': SB_ANON
        },
        body: JSON.stringify(Object.assign({ action: action }, msg.payload || {}))
    }).then(function (r) { return r.json(); })
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true; // async
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('lcd:') !== 0) return;

    var p;
    if (msg.type === 'lcd:capture')      p = lcdFetch('capture', { body: msg.payload });
    else if (msg.type === 'lcd:get')     p = lcdFetch('get', { query: '&ticket=' + encodeURIComponent(msg.ticket || '') });
    else if (msg.type === 'lcd:printed') p = lcdFetch('printed', { body: msg.payload });
    else return;

    p.then(sendResponse)
     .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true; // async sendResponse
});

/* ---------------- signature injector (Popup Blocker) ---------------- */

// Serialized and run in the PAGE's MAIN world — has jQuery + jSignature.
function injectSignature() {
    try {
        var canvas = document.querySelector('#modal-signature .jSignature');
        if (!canvas) return { success: false, reason: 'canvas not found' };

        // A simple horizontal line stroke in jSignature's internal format
        var fakeStroke = [{
            x: [100, 130, 160, 190, 220, 250, 280, 310],
            y: [120, 120, 120, 120, 120, 120, 120, 120]
        }];

        $(canvas).data('jSignature.data', fakeStroke);

        // Read it back — jSignature encodes the strokes to base30
        var sigData = $(canvas).jSignature('getData', 'base30');

        var hiddenInput = document.querySelector('#modal-signature .signature-data');
        if (hiddenInput && sigData && sigData[1]) {
            hiddenInput.value = sigData[0] + ',' + sigData[1];
            return { success: true };
        }
        return { success: false, reason: 'empty sigData' };
    } catch (e) {
        return { success: false, reason: e.message };
    }
}

/* ---------------- Promised-on setter (Promise-Time Advisor) ---------------- */

// Runs in the PAGE's MAIN world: uses RepairQ's own jQuery datepicker so its
// change handlers fire and populate the estimate-time dropdown, then picks
// the closest not-earlier slot to the requested time.
function setEstimate(dateStr, timeText) {
    try {
        var $ = window.jQuery || window.$;
        var d = document.getElementById('TicketForm_repair_estimated_day_local');
        if (!d) return { ok: false, reason: 'no estimate field' };

        var p = dateStr.split('/');                       // M/D/YYYY
        var dt = new Date(+p[2], +p[0] - 1, +p[1]);

        // Fill the DATE only, through RepairQ's own datepicker so it manages
        // its own hidden submit field + format. We deliberately do NOT set the
        // hidden field or force a time-<select> value — RepairQ's time widget
        // re-parses those and rendered "NaN:ll am" when we did. Instead we ask
        // the datepicker to populate the time list (onSelect) and leave the
        // tech to pick the slot (the toast tells them which). Once we have a
        // captured populated dropdown we can select it cleanly too.
        var viaPicker = false;
        try {
            if ($ && $.fn && $.fn.datepicker && $(d).data('datepicker')) {
                $(d).datepicker('setDate', dt);
                viaPicker = true;
                var inst = $(d).data('datepicker');
                var onSel = $(d).datepicker('option', 'onSelect');
                if (typeof onSel === 'function') onSel.call(d, d.value, inst);   // build the time list
            }
        } catch (e) { /* fall through to native set */ }

        if (!viaPicker) {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (setter && setter.set) setter.set.call(d, dateStr); else d.value = dateStr;
            d.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // The time list is a plain <select> of "10:15 am" options (15-min
        // steps) that onSelect just populated. Pick the nearest not-earlier
        // slot by its TEXT and set selectedIndex (clean for a native select —
        // no hidden-field poking, which is what corrupted it before).
        function toMins(s) {
            var m = /(\d{1,2}):(\d{2})\s*(a|p)\.?m/i.exec(s || '');
            if (!m) return -1;
            var h = +m[1] % 12; if (/p/i.test(m[3])) h += 12;
            return h * 60 + (+m[2]);
        }
        var want = toMins(timeText), tries = 0;
        (function pick() {
            var sel = document.querySelector('select[name="TicketForm[repair_estimated_time]"]');
            if (sel && sel.options.length > 1) {
                var best = -1, bestM = 1e9;
                for (var i = 0; i < sel.options.length; i++) {
                    var mm = toMins(sel.options[i].text);
                    if (mm >= 0 && mm >= want && mm < bestM) { bestM = mm; best = i; }
                }
                if (best < 0) {   // past the last slot → latest valid option
                    for (var j = sel.options.length - 1; j >= 0; j--) { if (toMins(sel.options[j].text) >= 0) { best = j; break; } }
                }
                if (best >= 0) {
                    sel.selectedIndex = best;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    if ($) { try { $(sel).trigger('change'); } catch (e) {} }
                }
                return;
            }
            if (++tries < 20) setTimeout(pick, 150);
        })();
        return { ok: true, value: d.value };
    } catch (e) {
        return { ok: false, reason: String(e && e.message || e) };
    }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'mrt:setEstimate' || !sender.tab) return;
    chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        world: 'MAIN',
        func: setEstimate,
        args: [String(msg.dateStr || ''), String(msg.timeText || '')]
    }).then(function (r) { sendResponse({ result: r && r[0] && r[0].result }); })
      .catch(function (err) { sendResponse({ error: String(err && err.message || err) }); });
    return true;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'mcpr:signature' || !sender.tab) return;
    chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        world: 'MAIN',
        func: injectSignature
    }).then(function (results) {
        sendResponse({ result: results && results[0] && results[0].result });
    }).catch(function (err) {
        sendResponse({ error: String(err && err.message || err) });
    });
    return true; // async sendResponse
});

/* ── Label Resizer: grab the active tab's PDF and open the 4×6 tool ──────────
   The popup menu sends label:grab with the tab's URL. The click that opened
   the popup grants activeTab, so this fetch can read the PDF the tab is
   showing. The bytes ride to label/label.html via chrome.storage.session
   (never touch disk); anything unfetchable just opens the tool's drop zone. */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'label:grab') return;
    (async function () {
        var stash = { name: msg.title || 'label', b64: null, kind: null };
        // Downloaded PDFs opened from disk are file:// tabs — Chrome only lets
        // the extension read those when "Allow access to file URLs" is on.
        if (/^file:/.test(msg.url || '')) {
            var fileOk = await new Promise(function (res) {
                try { chrome.extension.isAllowedFileSchemeAccess(res); } catch (e) { res(false); }
            });
            if (!fileOk) stash.file_blocked = true;
        }
        try {
            if (!stash.file_blocked && /^(https?|file):/.test(msg.url || '')) {
                // credentials:'include' — vendor label URLs often sit behind the
                // session cookie the tab is signed in with; an 8s abort keeps a
                // dead URL from hanging the popup.
                var ctrl = new AbortController();
                var tt = setTimeout(function () { ctrl.abort(); }, 8000);
                var r = await fetch(msg.url, { credentials: 'include', signal: ctrl.signal });
                clearTimeout(tt);
                var ct = (r.headers.get('content-type') || '').toLowerCase();
                var buf = await r.arrayBuffer();
                var h = new Uint8Array(buf.slice(0, 4));
                var isPdf = h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46; /* %PDF */
                if (isPdf || /pdf|image\//.test(ct)) {
                    var u8 = new Uint8Array(buf), b = '';
                    for (var i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
                    stash.b64 = btoa(b);
                    stash.kind = (isPdf || /pdf/.test(ct)) ? 'pdf' : 'img';
                }
            }
        } catch (e) { /* fall through to the screenshot fallback */ }
        if (!stash.b64) {
            // Couldn't read the document itself — screenshot the visible tab
            // (activeTab grants this) so the label on screen is still usable.
            try {
                var shot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
                if (shot && shot.indexOf('data:image/') === 0) {
                    stash.b64 = shot.split(',')[1];
                    stash.kind = 'img';
                    stash.captured = true;
                }
            } catch (e) { /* tool opens with its drop zone */ }
        }
        try { await chrome.storage.session.set({ mrt_label_stash: stash }); } catch (e) { }
        chrome.tabs.create({ url: chrome.runtime.getURL('label/label.html') });
        sendResponse({ ok: true });
    })();
    return true; // async sendResponse
});
