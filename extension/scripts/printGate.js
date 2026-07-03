/*
    Print Gate (myRepairTools) — runs in the page's MAIN world.

    The label page auto-prints ~100ms after it loads. The LCD buyback answer has to be
    fetched first, which is slightly slower than that, so we hold window.print
    until lcdLabel.js says it's ready (a DOM event), then let it fire
    exactly once. A 4s safety net guarantees printing is never blocked.

    This lives in its own file (declared with "world":"MAIN" in the manifest)
    instead of being injected inline, because RepairQ's Content Security Policy
    blocks inline page scripts. Declared content scripts are exempt from it.
*/
(function () {
    if (window.__mrtGateInstalled) return;
    window.__mrtGateInstalled = true;

    var realPrint = window.print.bind(window);
    var ready = false, pending = false, done = false;

    // While not ready, swallow the page's auto-print and remember it was wanted.
    window.print = function () { if (ready) { realPrint(); } else { pending = true; } };

    function release() {
        if (done) return;
        done = true;
        ready = true;
        window.print = realPrint;        // restore for the page + manual reprint button
        if (pending) { realPrint(); }    // page tried to print while held -> print now
        // if it hadn't tried yet, its own upcoming print() fires once, normally
    }

    document.addEventListener('mrtPrintReady', release);
    document.addEventListener('oledPrintReady', release);
    setTimeout(release, 4000);           // safety: never block printing for long
})();
