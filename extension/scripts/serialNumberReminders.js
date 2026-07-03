/*
    Serial Number Reminders:
    While editing a ticket, the serial number input form will be highlighted if it is empty.
*/
function checkForBlankSn() {
    let snFound =  false;
    // Find the serial number input box element
    let snBox = document.querySelectorAll("input[placeholder='Serial number...']");
    
    // If that element is found, add a big red border
    if (snBox[0] !== undefined) {
        if (snBox[0].value.length <= 4) {
            snBox[0].style.borderColor = '#FF3100';
            snBox[0].style.borderStyle = 'solid';
            snBox[0].style.borderWidth = '8px';
            snBox[0].style.borderRadius = '4px';
        }
    }
    

}
 

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfSNREnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            checkForBlankSn();
        } else if (result.enabled[1] == 1) {
            checkForBlankSn();
        } else {
            return;
        }
    }));

}

checkIfSNREnabled();