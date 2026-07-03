/*
    RepairQ workflow tools — shared utilities (myRepairTools)

    Ported from the MyCPRTools extension (another CPR franchisee's toolkit,
    absorbed into myRepairTools v2.2.0). Loaded on every RepairQ page ahead
    of the workflow tools (Update Assignee, Parts Gate, Popup Blocker,
    Clock Guard). axios was replaced with plain fetch.
*/

// ─── Settings (Options → RepairQ workflow tools) ─────────────

/**
 * Resolve one tool's on/off setting from the synced `mcpr` object.
 * Missing key → the tool's default (safe tools ON, aggressive tools OFF).
 */
function mcprSetting(key, def) {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.get(['mcpr']).then((res) => {
                const m = (res && res.mcpr) || {};
                resolve(m[key] === undefined ? def : !!m[key]);
            }).catch(() => resolve(def));
        } catch (e) { resolve(def); }
    });
}

/** The full mcpr settings object (for non-boolean values like clockTime). */
function mcprSettings() {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.get(['mcpr']).then((res) => {
                resolve((res && res.mcpr) || {});
            }).catch(() => resolve({}));
        } catch (e) { resolve({}); }
    });
}

// ─── DOM Helpers ────────────────────────────────────────────

/**
 * Wait for an element matching `selector` to appear in the DOM.
 * Resolves with the element once found, or null after `timeout` ms.
 */
function mcprWaitForElement(selector, timeout = 5000, root = document) {
    return new Promise((resolve) => {
        const existing = root.querySelector(selector);
        if (existing) return resolve(existing);

        const observer = new MutationObserver(() => {
            const el = root.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });
        observer.observe(root.body || root, { childList: true, subtree: true });

        setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeout);
    });
}

/**
 * Check if a modal element is currently visible on screen.
 * RepairQ hides modals with display:none, aria-hidden=true, and/or class 'hide'.
 */
function mcprIsModalVisible(el) {
    if (!el) return false;
    if (el.classList.contains('hide')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (window.getComputedStyle(el).display === 'none') return false;
    return true;
}

/**
 * Get the text content of an element, trimmed and lowercased.
 */
function mcprText(el) {
    return (el?.textContent || '').trim().toLowerCase();
}

// ─── HTTP (same-origin RepairQ calls) ────────────────────────

/** POST url-encoded params, return the response body text. */
async function mcprPostForm(url, params, headers) {
    const resp = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign(
            { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            headers || {}
        ),
        body: new URLSearchParams(params).toString(),
    });
    return resp.text();
}

/** GET a page, return the response body text. */
async function mcprGetText(url) {
    const resp = await fetch(url, { credentials: 'same-origin' });
    return resp.text();
}

// ─── RepairQ Page Info ───────────────────────────────────────

/**
 * Pull commonly needed info from the current RepairQ ticket page.
 * Returns null if not on a ticket page.
 */
async function mcprGetTicketInfo() {
    try {
        if (!window.location.href.includes('cpr.repairq.io/ticket/')) return null;

        const CSRF_TOKEN = document.getElementsByName('YII_CSRF_TOKEN')[0]?.value || null;
        const CURRENT_USER = document.getElementById('user_dropdown')?.innerText.trim() || null;

        // Location
        const location_name = document.querySelector(
            '#summary > div:nth-child(2) > div.location.tooltip-toggle > span'
        )?.innerText || null;
        const location_selector = document.getElementById('location') ||
            document.getElementById('filter_location');
        let LOCATION_NUMBER = location_selector?.value || null;
        if (!LOCATION_NUMBER && location_selector?.tagName === 'SELECT') {
            LOCATION_NUMBER = Array.from(location_selector.options)
                .find(o => o.text === location_name)?.value || null;
        }

        // Ticket ID
        const TICKET_ID = document.querySelector(
            '#ticket > div:nth-child(3) > div > div > div.span4 > h2 > span'
        )?.innerText.replace('#', '').trim() || null;

        // Ticket type
        const ticket_type_string = document.querySelector(
            '#ticket > div:nth-child(3) > div > div > div.span4 > h2'
        )?.innerText || '';
        let TICKET_TYPE = 'UNKNOWN';
        if (ticket_type_string.toLowerCase().includes('claim')) TICKET_TYPE = 'CLAIM';
        else if (ticket_type_string.toLowerCase().includes('repair')) TICKET_TYPE = 'REPAIR';
        else if (ticket_type_string.toLowerCase().includes('sale')) TICKET_TYPE = 'SALE';

        // Ticket status
        const statusElem = document.querySelector('#summary > div:nth-child(2) > span');
        const TICKET_STATUS = statusElem?.innerText.trim() || 'Unknown';

        // Assignee number — from config first, then fallback to dynamic lookup
        let ASSIGNEE_NUMBER = (typeof MCPR_EMPLOYEES !== 'undefined')
            ? (MCPR_EMPLOYEES[CURRENT_USER] || null)
            : null;

        // Dynamic fallback: find a recent repair ticket at this location and
        // read the current user's ID out of its assignee dropdown.
        if (!ASSIGNEE_NUMBER && CSRF_TOKEN && LOCATION_NUMBER) {
            try {
                const queueHtml = await mcprPostForm('https://cpr.repairq.io/ticket', [
                    ['YII_CSRF_TOKEN', CSRF_TOKEN],
                    ['filter-options', '1'],
                    ['filter[full_history]', '0'],
                    ['filter[location][]', '' + LOCATION_NUMBER],
                    ['filter[type][]', 'repair'],
                    ['filter[date_range]', '90day'],
                    ['is_apply', 'true']
                ]);
                const parser = new DOMParser();
                const queuePage = parser.parseFromString(queueHtml, 'text/html');
                const recentTicket = queuePage.querySelector(
                    '#mainModelList > tbody > tr:nth-child(1) > td:nth-child(1) > a'
                )?.innerText;
                if (recentTicket) {
                    const ticketHtml = await mcprGetText('https://cpr.repairq.io/ticket/' + recentTicket);
                    const ticketPage = parser.parseFromString(ticketHtml, 'text/html');
                    const assigneeOpts = ticketPage.querySelector('#TicketForm_assignee');
                    ASSIGNEE_NUMBER = Array.from(assigneeOpts?.options || [])
                        .find(o => o.text === CURRENT_USER)?.value || null;
                }
            } catch (e) {
                console.warn('[myRepairTools] Dynamic assignee lookup failed:', e);
            }
        }

        return {
            CSRF_TOKEN,
            CURRENT_USER,
            LOCATION_NUMBER,
            TICKET_ID,
            TICKET_TYPE,
            TICKET_STATUS,
            ASSIGNEE_NUMBER,
        };

    } catch (err) {
        console.error('[myRepairTools] mcprGetTicketInfo error:', err);
        return null;
    }
}

/**
 * Returns true if the current ticket page is a claim ticket.
 */
function mcprIsClaim() {
    // View page: check the h2 in the ticket header
    const h2 = document.querySelector(
        '#ticket > div:nth-child(3) > div > div > div.span4 > h2'
    );
    if (h2?.innerText.toLowerCase().includes('claim')) return true;
    // Edit page: check the body class
    const bodyClass = document.body.className || '';
    if (bodyClass.includes('c-ticket') && bodyClass.includes('claim')) return true;
    // Also check the URL
    return window.location.href.toLowerCase().includes('claim');
}

/**
 * Returns true if we are on a ticket view page (not edit, not list).
 */
function mcprIsTicketViewPage() {
    const url = window.location.href;
    return url.includes('cpr.repairq.io/ticket/') &&
           !url.includes('/edit') &&
           !url.includes('/add') &&
           /\/ticket\/\d+/.test(url);
}

// ─── MutationObserver Helper ─────────────────────────────────

/**
 * Watch the entire body for DOM changes and call `callback` when
 * any mutation occurs. Returns the observer so you can disconnect it.
 */
function mcprWatchDOM(callback) {
    const observer = new MutationObserver(callback);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'aria-hidden', 'class', 'disabled'] });
    return observer;
}
