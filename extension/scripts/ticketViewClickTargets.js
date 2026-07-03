/*
    Ticket View Click Targets:
    While in ticket view (viewing a list of tickets), block any clicks on ticket
    items except for the ticket numbers. Prevents accidental misclicks that lead
    to editing a ticket.
*/

function ticketViewClickTargets() {
    // Identify all the elements which have these annoying links
    // that accidentally get mis-clicked all the time
    const rows = document.getElementsByClassName('largest-row');
    for (let element = 0; element < rows.length; element ++) {
        // Change their href (here data-url) to nothing
        rows[element].setAttribute('data-url', '');
    }
}


// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfTVCTEnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            ticketViewClickTargets();
        } else if (result.enabled[5] == 1) {
            ticketViewClickTargets();
        } else {
            return;
        }
    }));

}

checkIfTVCTEnabled();