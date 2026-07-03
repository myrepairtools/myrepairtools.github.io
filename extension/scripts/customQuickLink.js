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