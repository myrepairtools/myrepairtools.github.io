/*
    Inventory View Click Targets:
    While looking at inventory search results, block clicks everywhere except for
    the checkbox and the Action menu.
*/

function inventoryViewClickTargets() {
    // Identify all the elements with the 'inventory-items' class. These ones
    // are often misclicked and don't serve any benefit to the user, so we'll
    // change their href to 'nothing'.
    const rowParents = document.getElementsByClassName('inventory-items')[0];
    if (rowParents != undefined) {
        let rows = rowParents.children;
        for (let element = 0; element < rows.length; element ++) {
            // 'data-url' is how this particular website sets href values
            rows[element].setAttribute('data-url', '');
        }
    }
    
}

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfIVCTEnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            inventoryViewClickTargets();
        } else if (result.enabled[4] == 1) {
            inventoryViewClickTargets();
        } else {
            return;
        }
    }));

}

checkIfIVCTEnabled();