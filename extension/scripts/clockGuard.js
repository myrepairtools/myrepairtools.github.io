/*
    Clock Guard (myRepairTools)

    Runs on: cpr.repairq.io/*

    Blocks clocking in before the allowed time (early clock-ins pad payroll).
    The earliest-allowed time is set in Options (default 9:40 AM — five
    minutes before a 9:45 shift); the message quotes the shift start.

    Ported from the MyCPRTools extension. Toggle: Options → RepairQ workflow
    tools (storage.sync mcpr.clockGuard, default OFF — turn it on per store
    policy; mcpr.clockTime is "HH:MM" 24h).
*/

(function () {
    'use strict';

    var allowedHour = 9, allowedMinute = 40;

    function blockedMessage() {
        var d = new Date(); d.setHours(allowedHour, allowedMinute + 5, 0, 0);
        var h = d.getHours() % 12 || 12, m = ('0' + d.getMinutes()).slice(-2);
        var ap = d.getHours() >= 12 ? 'PM' : 'AM';
        return 'Your scheduled shift starts at ' + h + ':' + m + ' ' + ap + '.\n\n' +
               'Please clock in when your shift starts.';
    }

    /**
     * True if it is currently at or after the allowed clock-in time
     * in the user's LOCAL timezone.
     */
    function isClockInAllowed() {
        var now = new Date();
        return (
            now.getHours() > allowedHour ||
            (now.getHours() === allowedHour && now.getMinutes() >= allowedMinute)
        );
    }

    /**
     * Intercept the clock-in form submission inside #timeClock.
     */
    function attachClockGuard(modal) {
        var submitBtn = modal.querySelector('button[type="submit"]');
        if (!submitBtn || submitBtn.dataset.mrtGuarded) return;

        submitBtn.dataset.mrtGuarded = 'true';

        submitBtn.addEventListener('click', function (e) {
            // We intercept BEFORE the PIN is submitted, so early arrivals are
            // blocked regardless of in/out state. Past the allowed time,
            // everything goes through.
            if (isClockInAllowed()) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            alert(blockedMessage());
        }, true); // capture phase so we fire before RepairQ's own handlers
    }

    /**
     * Also intercept the tracker-button click that opens the clock modal,
     * showing the message before the modal even opens.
     */
    function interceptTrackerButton() {
        var btn = document.querySelector('a.tracker-button');
        if (!btn || btn.dataset.mrtGuarded) return;
        btn.dataset.mrtGuarded = 'true';

        btn.addEventListener('click', function (e) {
            if (isClockInAllowed()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            alert(blockedMessage());
        }, true);
    }

    // ─── Init ────────────────────────────────────────────────────

    mcprSettings().then(function (m) {
        if (m.clockGuard !== true) return;   // default OFF

        var t = /^(\d{1,2}):(\d{2})$/.exec(m.clockTime || '');
        if (t) { allowedHour = Number(t[1]); allowedMinute = Number(t[2]); }

        mcprWaitForElement('a.tracker-button').then(function (btn) {
            if (btn) interceptTrackerButton();
        });

        mcprWatchDOM(function () {
            interceptTrackerButton();
            var modal = document.getElementById('timeClock');
            if (modal && mcprIsModalVisible(modal)) {
                attachClockGuard(modal);
            }
        });
    });
})();
