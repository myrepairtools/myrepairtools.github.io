function renderFrame(url) {
    const parent = document.getElementById('globalSearches');

    let customButton = document.createElement('a');
    customButton.href = '#';
    customButton.role = 'button';
    customButton.classList = 'modCustomAction';
    customButton.rel = 'tooltip';
    customButton.onclick = () => { 
        document.getElementById('customFrameContainer').style.display = 'block';
    };

    let customIcon = document.createElement('i');
    customIcon.classList = 'icon-customAction';
    customButton.appendChild(customIcon);

    let customDiv = document.createElement('div');
    customDiv.classList = 'modal modal-new modal-full fixed-footer hide fade in';
    customDiv.style = 'display: none; top: 30px; overflow: overlay;';
    customDiv.id = 'customFrameContainer';

    parent.insertBefore(customDiv, parent.childNodes[6]);
    parent.insertBefore(customButton, parent.childNodes[6]);

}

function getFrameSource() {
    chrome.storage.sync.get(['customFrameUrl'])
    .then((result => {
        link = result.customFrameUrl;
        renderFrame(link);
    }));
}

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfCQAEnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            getFrameSource();
        } else if (result.enabled[0] == 1) {
            getFrameSource();
        } else {
            return;
        }
    }));

}

checkIfCQAEnabled();


/*

{
            "js": [
                "scripts/customQuickAction.js"
            ],
            "css" : [
                "style/customActionIcon.css"
            ],
            "matches" : [
                "https://cpr.repairq.io/*"
            ],
            "run_at": "document_end"
        }
    

*/