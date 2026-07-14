/*
    Status Override (myRepairTools)

    Runs on: cpr.repairq.io/ticket/<id> (view pages)

    RepairQ removes a ticket's status control once the ticket is closed or the
    business day rolls over — so a ticket accidentally closed, or one that needs
    reopening the next morning, can't be changed from the UI (the "button that
    disappears after midnight"). This injects an always-available status
    dropdown + Apply that writes straight to RepairQ's own endpoint
    (/ajax/ticket/updateTicketProperties) — the same call the native control
    makes — bypassing the artificial gate.

    Brett's original MyCPRTools shipped this as an empty "planned" stub; this is
    the real implementation, mechanism borrowed from his Update Assignee tool.

    Toggle: Options → RepairQ workflow tools (storage.sync mcpr.statusOverride,
    default OFF — it forces status changes RepairQ deliberately restricts).
*/

(function () {
    'use strict';

    // View pages only: /ticket/12345 (numeric), never edit/add/list
    if (!/cpr\.repairq\.io\/ticket\/\d+($|[?#])/.test(location.href)) return;

    // Canonical CPR status list — fallback for when RepairQ's own <select>
    // has already been stripped from the page (the whole point of this tool).
    // Value = what updateTicketProperties expects (label, lowercased, spaced→_).
    var STATUSES = [
        ['new', 'New'],
        ['new_claim', 'New Claim'],
        ['in_diagnosis', 'In Diagnosis'],
        ['ready_for_repair', 'Ready for Repair'],
        ['waiting_for_customer_response', 'Waiting for Customer Response'],
        ['waiting_for_parts', 'Waiting for Parts'],
        ['pending_notification', 'Pending Notification'],
        ['ready_for_pickup', 'Ready for Pickup'],
        ['waiting_for_payment', 'Waiting for Payment'],
        ['closed', 'Closed'],
        ['void', 'Void'],
    ];

    function log(msg, ...args) { console.log('[MRT-StatusOverride]', msg, ...args); }

    function ticketId() { var m = location.pathname.match(/\/ticket\/(\d+)/); return m ? m[1] : ''; }
    function csrf() { var el = document.getElementsByName('YII_CSRF_TOKEN')[0]; return el ? el.value : ''; }

    function currentStatusValue() {
        var el = document.querySelector('#summary .block-content span.fullsize.label, #summary .block-content span.label, #summary > div:nth-child(2) > span');
        var s = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        return s ? s.toLowerCase().replace(/\s+/g, '_') : '';
    }

    // If a real assignee control is still on the page, mirror it into the write
    // so we never accidentally clear the assignee. When it's gone we send
    // status only — updateTicketProperties does a partial update.
    function currentAssignee() {
        var sel = document.querySelector('#TicketForm_assignee, select[name="TicketForm[assignee]"], select[name="assignee_id"], #TicketProperties_assignee_id');
        if (sel && sel.value) return sel.value;
        var hid = document.querySelector('input[name="assignee_id"]');
        return hid && hid.value ? hid.value : '';
    }

    function statusOptions() {
        // Prefer the real select's exact value/label pairs when it's present.
        var sel = document.querySelector('select[name="status"], #TicketProperties_status, select[name="TicketProperties[status]"]');
        if (sel && sel.options && sel.options.length) {
            var opts = Array.from(sel.options)
                .filter(function (o) { return o.value; })
                .map(function (o) { return [o.value, o.textContent.trim()]; });
            if (opts.length) return opts;
        }
        return STATUSES;
    }

    // ─── UI ──────────────────────────────────────────────────────

    function injectControl() {
        if (document.getElementById('mrt-status-override')) return;

        var opts = statusOptions();
        var cur = currentStatusValue();

        var wrap = document.createElement('div');
        wrap.id = 'mrt-status-override';
        wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:6px 8px 6px 0;';

        var label = document.createElement('span');
        label.textContent = '⚙ Force status:';
        label.style.cssText = 'font-weight:600;font-size:12px;color:#2D2D3B;';

        var sel = document.createElement('select');
        sel.className = 'mrt-so-sel';
        sel.style.cssText = 'font-size:12px;padding:3px 6px;border:1px solid #B9BDCB;border-radius:4px;background:#fff;max-width:220px;';
        opts.forEach(function (o) {
            var op = document.createElement('option');
            op.value = o[0]; op.textContent = o[1];
            if (o[0] === cur) op.selected = true;
            sel.appendChild(op);
        });

        var btn = document.createElement('a');
        btn.href = '#';
        btn.className = 'btn btn-new btn-primary mrt-so-apply';
        btn.textContent = 'Apply';
        btn.style.cssText = 'font-size:12px;';

        wrap.appendChild(label);
        wrap.appendChild(sel);
        wrap.appendChild(btn);

        // Prefer RepairQ's own properties form area (matches native placement);
        // fall back to the ticket header span8 (built when the form is gone).
        var propForm = document.querySelector('.properties .properties-form.ticket-properties');
        if (propForm) {
            propForm.appendChild(wrap);
        } else {
            var span8 = document.querySelector('#ticket > div:nth-child(3) > div > div > div.span8');
            if (!span8) return;   // not ready — retry on next DOM tick
            var box = document.createElement('div');
            box.className = 'properties';
            var inner = document.createElement('div');
            inner.className = 'properties-form ticket-properties control form-inline';
            inner.appendChild(wrap);
            box.appendChild(inner);
            span8.prepend(box);
        }

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            apply(sel, btn);
        });
        log('control injected on ticket', ticketId());
    }

    function apply(sel, btn) {
        var status = sel.value;
        var statusLabel = sel.options[sel.selectedIndex].textContent.trim();
        var id = ticketId();
        var token = csrf();
        if (!id || !token) { alert('[myRepairTools] Could not read ticket id / CSRF token. Refresh and retry.'); return; }
        if (!confirm('Force this ticket to "' + statusLabel + '"?\n\nThis writes the status straight to RepairQ, bypassing the normal restriction.')) return;

        btn.textContent = 'Applying…';
        btn.style.pointerEvents = 'none';
        btn.style.opacity = '0.7';

        var params = { YII_CSRF_TOKEN: token, ticketId: id, status: status };
        var assignee = currentAssignee();
        if (assignee) params.assignee_id = assignee;   // preserve when readable

        fetch('https://cpr.repairq.io/ajax/ticket/updateTicketProperties', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'accept': 'application/json, text/javascript, */*; q=0.01',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest',
            },
            body: new URLSearchParams(params).toString(),
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            location.reload();
        }).catch(function (err) {
            console.error('[MRT-StatusOverride] apply failed:', err);
            alert('[myRepairTools] Status change failed. Check the console for details.');
            btn.textContent = 'Apply';
            btn.style.pointerEvents = '';
            btn.style.opacity = '';
        });
    }

    // ─── Init ────────────────────────────────────────────────────

    mcprSetting('statusOverride', false).then(function (on) {
        if (!on) return;
        mcprWaitForElement('#ticket').then(function () {
            injectControl();
            // RepairQ re-renders the header/properties area; re-inject if ours
            // gets swept away.
            mcprWatchDOM(function () {
                if (!document.getElementById('mrt-status-override')) injectControl();
            });
        }).catch(function () {});
    });
})();
