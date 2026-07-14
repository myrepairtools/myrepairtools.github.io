/*
    Custom Quick Link:
    Users can save a custom URL and a name for that URL in the settings for this extension.
    This script renders that link alongside the usual RQ nav links on every page.
*/

function openFrame(src, id) {
    let frame = document.createElement('div'); // Create the frame element
    frame.id = id;
    frame.classList = 'rqModsFrame';
    let close = document.createElement('div'); // Create the close button
    close.innerText = 'X';
    close.classList = 'rqmf-close-button';
    close.onclick = () => {document.getElementById(id).style.display = 'none'};
    frame.appendChild(close);
    let iFrame = document.createElement('iframe'); // Create the iFrame
    iFrame.id = 'customiframe-' + id;
    iFrame.classList = 'customiframe';
    iFrame.title = 'RQ Mods Custom Frame';
    iFrame.src = src;
    iFrame.width = '90%';
    iFrame.height = '90%';
    frame.style.display = 'none';
    frame.appendChild(iFrame);

    document.body.insertBefore(frame, document.body.lastChild);
}

function openOptions() {
    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
    } else {
    window.open(chrome.runtime.getURL('options.html'));
    }
}

function checkDate() { // Check if an update has come out in the last five days
    let updateDate = '7-21-2024'.split('-'); // I'll manually set the update date (plus five days) here
    let um = parseInt(updateDate[0]); // Parse out the date
    let ud = parseInt(updateDate[1]);
    let uy = parseInt(updateDate[2]);

    let today = new Date(); // Get today's date and parse it
    let tm = parseInt(today.getMonth() + 1);
    let td = parseInt(today.getDate());
    let ty = parseInt(today.getFullYear());

    let update = true;
    if (td > ud) {
        update = false;
    } else if (tm > um) {
        update = false;
    } else if (ty > uy) {
        update = false;
    }

    return update;
}

function rqModsButton() { // Add the RQ Mods link
    let navBarItems = document.getElementsByClassName('hover-menu');
    let insertPoint = navBarItems[6];

    // Create the link element with different attributes if a new update is out
    let html = '';
    if (checkDate()) {
        html = `
            <li class='hover-menu'>
            <a id="rqModsLink" href='#' title='New update!' style='color:#47c57a'>&#10227; RQ Mods</a>
        `;
    } else {
        html = `
            <li class='hover-menu'>
            <a id="rqModsLink" href='#' title='RQ Mods'>RQ Mods</a>
        `;
    }
    
    try {
        insertPoint.insertAdjacentHTML('afterend', html);
        document.getElementById('rqModsLink').onclick = () => { openOptions() };
    } catch {
        return;
    }
}

rqModsButton();

/* ---------------- Report Extension Issue (next to RQ Mods) ---------------- */
function mrtReportContext() {
    var url = location.href;
    var mt = url.match(/\/ticket\/(?:edit\/|view\/)?(\d+)\b/);
    var ticket = mt ? mt[1] : '';
    var store = '';
    try { var st = document.querySelector('.location.tooltip-toggle span'); if (st) store = st.textContent.trim(); } catch (e) {}
    var tech = '';
    try {
        var ud = document.getElementById('user_dropdown');
        if (ud) { var raw = ud.textContent.replace(/\s+/g, ' ').trim(); var m = raw.match(/^([^,]+),\s*(.+)$/); tech = m ? (m[2] + ' ' + m[1]).trim() : raw; }
    } catch (e) {}
    var ver = ''; try { ver = chrome.runtime.getManifest().version; } catch (e) {}
    return { url: url, ticket_no: ticket, store: store, reporter: tech, ext_version: ver, user_agent: navigator.userAgent };
}

function openReportModal() {
    if (document.getElementById('mrt-rep-ov')) return;
    var ctx = mrtReportContext();
    var ov = document.createElement('div');
    ov.id = 'mrt-rep-ov';
    ov.setAttribute('style', 'position:fixed;inset:0;z-index:2147483600;background:rgba(20,20,28,.5);display:flex;align-items:center;justify-content:center;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif');
    ov.innerHTML =
        '<div style="width:440px;max-width:calc(100vw - 32px);background:#fff;border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.35);overflow:hidden">' +
          '<div style="background:#2D2D3B;color:#fff;padding:12px 16px;font-weight:800;font-size:14px">🐞 Report an Extension Issue</div>' +
          '<div style="padding:16px">' +
            '<div style="font-size:12px;color:#666;margin-bottom:8px">What glitched? A sentence or two — what you clicked and what happened. (Page, ticket #, store &amp; version are attached automatically.)</div>' +
            '<textarea id="mrt-rep-txt" rows="5" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;font-family:inherit" placeholder="e.g. Clicked Ready for Pickup and got a Note-cannot-be-blank error…"></textarea>' +
            '<div style="font-size:11px;color:#999;margin-top:8px">' + (ctx.store ? esc0(ctx.store) + ' · ' : '') + (ctx.ticket_no ? 'ticket ' + esc0(ctx.ticket_no) + ' · ' : '') + 'v' + esc0(ctx.ext_version || '?') + (ctx.reporter ? ' · ' + esc0(ctx.reporter) : '') + '</div>' +
            '<div id="mrt-rep-msg" style="font-size:12px;margin-top:10px;min-height:16px"></div>' +
          '</div>' +
          '<div style="display:flex;justify-content:flex-end;gap:10px;padding:0 16px 16px">' +
            '<button id="mrt-rep-cancel" style="padding:8px 14px;border:1px solid #ccc;border-radius:8px;background:#f5f5f5;cursor:pointer;font-size:13px">Cancel</button>' +
            '<button id="mrt-rep-send" style="padding:8px 16px;border:none;border-radius:8px;background:#DC282E;color:#fff;font-weight:700;cursor:pointer;font-size:13px">Send report</button>' +
          '</div>' +
        '</div>';
    document.body.appendChild(ov);
    function esc0(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }
    var txt = ov.querySelector('#mrt-rep-txt');
    var msg = ov.querySelector('#mrt-rep-msg');
    var send = ov.querySelector('#mrt-rep-send');
    function close() { ov.remove(); }
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#mrt-rep-cancel').onclick = close;
    txt.focus();
    send.onclick = function () {
        var body = (txt.value || '').trim();
        if (!body) { msg.style.color = '#C0392B'; msg.textContent = 'Type a quick description first.'; txt.focus(); return; }
        send.disabled = true; send.textContent = 'Sending…'; msg.style.color = '#666'; msg.textContent = '';
        var payload = Object.assign({ message: body }, mrtReportContext());
        try {
            chrome.runtime.sendMessage({ type: 'issue:report', payload: payload }, function (res) {
                var ok = res && res.ok && !chrome.runtime.lastError;
                if (ok) {
                    msg.style.color = '#1E9E5B'; msg.textContent = '✓ Sent — thank you!';
                    setTimeout(close, 900);
                } else {
                    send.disabled = false; send.textContent = 'Send report';
                    msg.style.color = '#C0392B';
                    msg.textContent = '⚠ Could not send' + ((res && res.error) ? (' — ' + res.error) : '') + '. Try again.';
                }
            });
        } catch (e) {
            send.disabled = false; send.textContent = 'Send report';
            msg.style.color = '#C0392B'; msg.textContent = '⚠ ' + String(e && e.message || e);
        }
    };
}

function reportIssueButton() {
    if (document.getElementById('mrtReportLink')) return;
    var html = "<li class='hover-menu'><a id='mrtReportLink' href='#' title='Report a problem with the myRepairTools extension'>🐞 Report Issue</a></li>";
    var anchor = document.getElementById('rqModsLink');
    var li = anchor ? anchor.closest('li') : null;
    try {
        if (li) { li.insertAdjacentHTML('afterend', html); }
        else {
            var items = document.getElementsByClassName('hover-menu');
            if (!items[6]) return;
            items[6].insertAdjacentHTML('afterend', html);
        }
        document.getElementById('mrtReportLink').onclick = function (e) { e.preventDefault(); openReportModal(); };
    } catch (e) { /* nav not ready */ }
}

reportIssueButton();

function renderLink(name, link, frame) {
    // Identify the navbar, and specifically choose the last item in the navbar. 
    // This is where our link will be placed.
    let navBarItems = document.getElementsByClassName('hover-menu');
    let insertPoint = navBarItems[6];

    // Catch undefined in case the user hasn't set up a link yet
    if (name === undefined || name.length < 1 || name === 'undefined') {
        name = 'custom quick link';
    }
    if (link === undefined || link.length < 1 || link === 'undefined') {
        link = 'https://cpr.repairq.io';
    }

    // Create the new link element and insert it
    let html = '';
    if (frame === true && frame !== undefined && link !== 'https://cpr.repairq.io') {
        let frameId = name.replace(/\s/gm, '-');

        html = `
            <li class='hover-menu'>
            <a href='#' alt='${name}' title='user-custom-link' onclick = 'document.getElementById("${frameId}").style.display = "block"'>${name}</a>
        `;
        
        openFrame(link, frameId);
    } else {
        html = `
            <li class='hover-menu'>
            <a href='${link}' alt='${name}' title='user-custom-link'>${name}</a>
        `;
    }

    if (name !== 'custom quick link') {
        try {
            insertPoint.insertAdjacentHTML('afterend', html);
        } catch {
            return;
        }
    }  
}

// Get the user's custom link name and URL from their sync storage
function getLink() {
    let name = '';
    let link = '';
    chrome.storage.sync.get(['customQuickLinkName1', 'customQuickLinkUrl1', 'customQuickLinkFrame1'])
    .then((result => {
        name = result.customQuickLinkName1;
        link = result.customQuickLinkUrl1;
        frame = result.customQuickLinkFrame1;
        renderLink(name, link, frame);
    }));
    chrome.storage.sync.get(['customQuickLinkName2', 'customQuickLinkUrl2', 'customQuickLinkFrame2'])
    .then((result => {
        name = result.customQuickLinkName2;
        link = result.customQuickLinkUrl2;
        frame = result.customQuickLinkFrame2;
        renderLink(name, link, frame);
    }));
    chrome.storage.sync.get(['customQuickLinkName3', 'customQuickLinkUrl3', 'customQuickLinkFrame3'])
    .then((result => {
        name = result.customQuickLinkName3;
        link = result.customQuickLinkUrl3;
        frame = result.customQuickLinkFrame3;
        renderLink(name, link, frame);
    }));
}

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfCQLEnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            getLink();
        } else if (result.enabled[0] == 1) {
            getLink();
        } else {
            return;
        }
    }));

}

checkIfCQLEnabled();