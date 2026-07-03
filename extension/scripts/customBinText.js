// Custom Bin Text: change the text of the "bin number/in possession" to something more useful

function changeText(text) {
    // Find the elements we want to change, assuming they exist on this page
    // Start with the actual editable form on the ticket
    let potentialTargets = document.querySelectorAll("label[for='TicketForm_in_possession']");
    if (potentialTargets.length > 0) {
        potentialTargets[0].childNodes[4].textContent = text; // Change the text of the label
        document.getElementById('TicketForm_storage_bin').placeholder = '';
    }

    // Now on to the popup while viewing the ticket
    let others = document.querySelectorAll('p[class="alert alert-info"]');
    if (others.length > 0) {
        let replace = others[0].childNodes[0].textContent; // reference the text content
        // Only change the text if it's the storage bin and not the shipping one
        if (replace.includes('Device(s) in possession. Storage bin')) {
            others[0].childNodes[0].textContent = text + ': ';
        }
    }
}

function checkIfCBTEnabled() {
    chrome.storage.sync.get(['cbt'])
    .then((result => {
        if (result.cbt == undefined || result.cbt.text == undefined) {
            return;
        } else if (result.cbt.enabled && result.cbt.text.length > 0) {
            changeText(result.cbt.text);
        } else {
            return;
        }
    }));

}

checkIfCBTEnabled();


