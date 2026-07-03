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
