/*
    Parts Gate (myRepairTools)

    Runs on: cpr.repairq.io/ticket/<id> and /ticket/edit/<id>

    Intercepts ticket close / status-change clicks and refuses to close a
    ticket whose repair labor items have no matching part bundled — the #1
    source of inventory drift. Rules:

      - every top-level "Repair - X" labor line needs a bundled "Part - X"
      - labor names matching MCPR_LABOR_EXCLUSION_KEYWORDS (diagnostic,
        unlock, …) are exempt
      - a ticket note containing "no part needed" exempts the whole ticket
      - claims using a panel screen ("without frame") also need front AND
        back adhesive bundled

    Ported from the MyCPRTools extension; config lives in mcprConfig.js.
    Toggle: Options → RepairQ workflow tools (storage.sync mcpr.partsGate,
    default ON).
*/

(function () {
    'use strict';

    // Runs on view + edit pages, where the status buttons live
    const _pgUrl = window.location.href;
    if (!_pgUrl.includes('cpr.repairq.io/ticket/') || !/\/ticket\/(edit\/)?\d+/.test(_pgUrl)) return;

    function log(msg, ...args) {
        console.log('[MRT-PartsGate]', msg, ...args);
    }
    function warn(msg, ...args) {
        console.warn('[MRT-PartsGate]', msg, ...args);
    }

    // ─── Ticket Item Parser ──────────────────────────────────────

    function parseTicketItems() {
        // Ticket items are in the DOM table:
        //   tr.ticket-item-row.parent-item  — top-level labor/sale items
        //   tr.ticket-item-row.bundled-item — parts bundled to the parent above
        const items = [];
        const rows = document.querySelectorAll('tr.ticket-item-row');

        if (rows.length === 0) {
            warn('No tr.ticket-item-row elements found in DOM');
            return [];
        }

        let lastParentId = null;

        rows.forEach((row, idx) => {
            const isBundled = row.classList.contains('bundled-item');
            const itemId = idx; // Row index as stable ID

            // Type from <em> tag: "Repair - Phone:" → "Repair - Phone"
            const emEl = row.querySelector('td.catalog-item-col em');
            const typeName = emEl
                ? emEl.textContent.replace(/:+$/, '').trim()
                : '';

            // Item name: catalog-item-col text minus the <em>/link/detail children
            const catalogCell = row.querySelector('td.catalog-item-col');
            let name = '';
            if (catalogCell) {
                const clone = catalogCell.cloneNode(true);
                clone.querySelectorAll('em, a, div').forEach(el => el.remove());
                name = clone.textContent.trim();
            }

            if (!isBundled) {
                lastParentId = itemId;
            }

            items.push({
                id:        itemId,
                name:      name,
                typeName:  typeName,
                parentId:  isBundled ? lastParentId : null,
                isBundled: isBundled,
            });
        });

        return items;
    }

    function parseTicketNotes() {
        // Notes render inside div.div-content-ticket > p (the note list
        // appears twice — inline and in the modal — so deduplicate).
        const noteEls = document.querySelectorAll('div.div-content-ticket p');
        const notes = Array.from(noteEls)
            .map(el => el.textContent.trim().toLowerCase())
            .filter(t => t.length > 0);
        return [...new Set(notes)];
    }

    // ─── Validation Logic ────────────────────────────────────────

    function getCategory(typeName) {
        const lower = typeName.toLowerCase();
        const dashIdx = lower.indexOf(' - ');
        if (dashIdx === -1) return null;
        return lower.slice(dashIdx + 3).trim();
    }

    function isExcludedLaborItem(name) {
        const lower = name.toLowerCase();
        return MCPR_LABOR_EXCLUSION_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    }

    function validateTicketItems() {
        const items = parseTicketItems();
        const notes = parseTicketNotes();
        const isClaim = mcprIsClaim();
        const errors = [];

        // Ticket-level override via note
        const noPartNoteOverride = notes.some(note =>
            note.includes(MCPR_NO_PART_NOTE_PHRASE.toLowerCase())
        );
        if (noPartNoteOverride) {
            log('Override note found — skipping validation');
            return { valid: true, errors: [] };
        }

        const laborItems = items.filter(item =>
            item.typeName.toLowerCase().startsWith(MCPR_REPAIR_PREFIX) && !item.isBundled
        );
        const bundledParts = items.filter(item =>
            item.typeName.toLowerCase().startsWith(MCPR_PART_PREFIX) && item.isBundled
        );

        for (const labor of laborItems) {
            if (isExcludedLaborItem(labor.name)) {
                continue;
            }

            const laborCategory = getCategory(labor.typeName);
            const attachedParts = bundledParts.filter(p => p.parentId === labor.id);

            if (attachedParts.length === 0) {
                errors.push(
                    `"${labor.name}" has no part bundled to it.\n` +
                    `Please save the ticket first, then either attach the correct part or add a note saying "no part needed".`
                );
                continue;
            }

            const hasMatchingPart = attachedParts.some(p => getCategory(p.typeName) === laborCategory);
            if (!hasMatchingPart) {
                const partTypes = attachedParts.map(p => p.typeName).join(', ');
                errors.push(
                    `"${labor.name}" requires a "Part - ${capitalize(laborCategory)}" but only has: ${partTypes}.\n` +
                    `Please correct the bundled part before closing this ticket.`
                );
            }

            if (isClaim) {
                const hasPanelScreen = attachedParts.some(p =>
                    p.name.toLowerCase().includes(MCPR_PANEL_TRIGGER_PHRASE.toLowerCase())
                );
                if (hasPanelScreen) {
                    const partNames = attachedParts.map(p => p.name.toLowerCase());
                    const hasFrontAdhesive = partNames.some(n => n.includes('front') && n.includes('adhesive'));
                    const hasBackAdhesive  = partNames.some(n => n.includes('back') && (n.includes('adhesive') || n.includes('tape')));
                    if (!hasFrontAdhesive || !hasBackAdhesive) {
                        const missing = [];
                        if (!hasFrontAdhesive) missing.push('front adhesive');
                        if (!hasBackAdhesive)  missing.push('back adhesive/tape');
                        errors.push(
                            `"${labor.name}" uses a panel screen (without frame) but is missing: ${missing.join(' and ')}.\n` +
                            `Both front and back adhesives must be bundled for claim screen repairs.`
                        );
                    }
                }
            }
        }

        return { valid: errors.length === 0, errors };
    }

    function capitalize(str) {
        return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
    }

    function showPartsGateError(errors) {
        const message =
            '⚠️ Cannot close this ticket yet!\n\n' +
            errors.join('\n\n') +
            '\n\nSave the ticket first, then fix the issue(s) above before closing.';
        alert(message);
    }

    // ─── Closing Status Detection ────────────────────────────────

    function isClosingStatus(statusValue) {
        const closingStatuses = ['closed', 'waiting_for_payment', 'void'];
        return closingStatuses.includes((statusValue || '').toLowerCase());
    }

    // ─── Button Intercept ────────────────────────────────────────

    function interceptButton(btn, getStatusFn) {
        if (btn.dataset.mrtPartsGate) return;
        btn.dataset.mrtPartsGate = 'true';

        btn.addEventListener('click', function (e) {
            const statusValue = getStatusFn();

            if (!isClosingStatus(statusValue)) return;

            const result = validateTicketItems();
            if (!result.valid) {
                e.preventDefault();
                e.stopImmediatePropagation();
                showPartsGateError(result.errors);
            }
        }, true); // capture phase — fires before RepairQ's handlers
    }

    function interceptStatusButtons() {
        // Direct status buttons in the navigation bar: a.save-ticket carries
        // the target status in its "action" attribute (e.g. action="closed")
        document.querySelectorAll('a.save-ticket').forEach(btn => {
            interceptButton(btn, () => btn.getAttribute('action') || '');
        });

        // Claim-specific apply button
        document.querySelectorAll('a.claim-apply').forEach(btn => {
            interceptButton(btn, () => 'closed');
        });

        // Claim device returned
        document.querySelectorAll('a.trigger-claim-device-returned').forEach(btn => {
            interceptButton(btn, () => 'waiting_for_payment');
        });
    }

    // ─── Init ────────────────────────────────────────────────────

    mcprSetting('partsGate', true).then(function (on) {
        if (!on) return;
        log('Parts gate initializing on:', window.location.href);

        mcprWaitForElement('#ticket').then(() => {
            interceptStatusButtons();
        });

        // Re-apply as modals open dynamically
        mcprWatchDOM(() => {
            interceptStatusButtons();
        });
    });
})();
