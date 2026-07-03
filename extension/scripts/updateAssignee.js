/*
    Update Assignee (myRepairTools)

    Runs on: cpr.repairq.io/ticket/<id> (view pages only)

    One button — "Update Assignee" — that assigns the ticket to the signed-in
    tech via RepairQ's own AJAX endpoint, instead of the edit-page dropdown
    dance. The tech's assignee ID is resolved dynamically (a recent ticket's
    assignee dropdown is scraped for the matching name), so there is no
    roster to maintain; MCPR_EMPLOYEES in mcprConfig.js is an optional
    override for anyone the lookup misses.

    Ported from the MyCPRTools extension. Toggle: Options → RepairQ workflow
    tools (storage.sync mcpr.updateAssignee, default ON).
*/

(function () {
    'use strict';

    if (!mcprIsTicketViewPage()) return;

    mcprSetting('updateAssignee', true).then(function (on) {
        if (!on) return;
        mcprWaitForElement('#ticket').then(function () {
            try {
                injectButton();
            } catch (e) {
                console.warn('[myRepairTools] Update Assignee inject error:', e);
            }
        });
    });

    // ─── Inject Button ───────────────────────────────────────────

    function injectButton() {
        // Strict URL guard — only run on /ticket/12345 numeric view pages
        const url = window.location.href;
        if (!/cpr\.repairq\.io\/ticket\/\d+($|[?#])/.test(url)) return;

        if (document.getElementById('mrt-update-assignee')) return;

        const btn = document.createElement('a');
        btn.className = 'btn btn-new btn-primary';
        btn.id = 'mrt-update-assignee';
        btn.textContent = 'Update Assignee';
        btn.href = '#';

        // Try to find the existing properties form area first
        const existingPropertiesForm = document.querySelector(
            '.properties .properties-form.ticket-properties'
        );

        if (existingPropertiesForm) {
            existingPropertiesForm.prepend(btn);
        } else {
            // Fall back: inject into the span8 header area
            const span8 = document.querySelector(
                '#ticket > div:nth-child(3) > div > div > div.span8'
            );
            if (!span8) return; // Not ready yet — bail silently

            const wrapper = document.createElement('div');
            wrapper.innerHTML = '<div class="properties"><div class="properties-form ticket-properties control form-inline"></div></div>';
            wrapper.querySelector('.properties-form').appendChild(btn);
            span8.prepend(wrapper);
        }

        btn.addEventListener('click', handleUpdateClick);
    }

    // ─── Click Handler ───────────────────────────────────────────

    async function handleUpdateClick(e) {
        e.preventDefault();

        const btn = document.getElementById('mrt-update-assignee');
        if (!btn) return;

        btn.textContent = 'Updating...';
        btn.style.opacity = '0.7';
        btn.style.pointerEvents = 'none';

        try {
            const info = await mcprGetTicketInfo();

            if (!info) {
                alert('[myRepairTools] Could not read ticket info. Try refreshing.');
                resetButton();
                return;
            }

            if (!info.ASSIGNEE_NUMBER) {
                alert(
                    '[myRepairTools] Could not resolve an assignee ID for "' + info.CURRENT_USER + '".\n\n' +
                    'Try again from a repair ticket at your store, or tell a manager.'
                );
                resetButton();
                return;
            }

            if (!info.CSRF_TOKEN) {
                alert('[myRepairTools] Could not find CSRF token. Try refreshing.');
                resetButton();
                return;
            }

            await mcprPostForm(
                'https://cpr.repairq.io/ajax/ticket/updateTicketProperties',
                {
                    YII_CSRF_TOKEN: info.CSRF_TOKEN,
                    ticketId:       info.TICKET_ID,
                    assignee_id:    info.ASSIGNEE_NUMBER,
                    status:         info.TICKET_STATUS.toLowerCase().replace(/\s+/g, '_'),
                },
                {
                    'accept':           'application/json, text/javascript, */*; q=0.01',
                    'x-requested-with': 'XMLHttpRequest',
                }
            );

            window.location.reload();

        } catch (err) {
            console.error('[myRepairTools] Update Assignee error:', err);
            alert('[myRepairTools] Update failed. Check the console for details.');
            resetButton();
        }
    }

    function resetButton() {
        const btn = document.getElementById('mrt-update-assignee');
        if (!btn) return;
        btn.textContent = 'Update Assignee';
        btn.style.opacity = '';
        btn.style.pointerEvents = '';
    }

})();
