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
        var $ = window.jQuery;
        var d = document.getElementById('TicketForm_repair_estimated_day_local');
        if (!d) return { ok: false, reason: 'no estimate field' };
        if ($ && $(d).hasClass('hasDatepicker')) {
            $(d).datepicker('setDate', dateStr);
            $(d).trigger('change');
        } else {
            d.value = dateStr;
            d.dispatchEvent(new Event('change', { bubbles: true }));
        }
        function toMins(s) {
            var m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s || '');
            if (!m) return -1;
            var h = +m[1] % 12; if (/pm/i.test(m[3] || '')) h += 12;
            return h * 60 + (+m[2]);
        }
        var want = toMins(timeText), tries = 0;
        (function pick() {
            var sel = document.querySelector('select[name="TicketForm[repair_estimated_time]"]');
            if (sel && sel.options.length) {
                sel.disabled = false;
                var best = null, bestM = 1e9;
                for (var i = 0; i < sel.options.length; i++) {
                    var mm = toMins(sel.options[i].text);
                    if (mm >= want && mm < bestM) { bestM = mm; best = sel.options[i]; }
                }
                if (!best) best = sel.options[sel.options.length - 1];   // past last slot → latest
                sel.value = best.value;
                if ($) $(sel).trigger('change');
                else sel.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
            if (++tries < 20) setTimeout(pick, 150);
        })();
        return { ok: true };
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
