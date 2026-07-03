function highlightDueToday() {
    // Make sure we have the right element to deal with
    if (document.getElementById('mainModelList')) {
        
        // Loop through each instance of an estimate date and highlight the dates
        if (document.querySelectorAll("td[data-column='est']")) {
            let dates = document.querySelectorAll("td[data-column='est']");
            for (let c = 0; c < dates.length; c++) {
                // Get the estimate date
                let estDate = dates[c].children[0].innerText;
                // Get today's date in the same format
                let d = new Date();
                let yyyy = d.getFullYear();
                let mm = d.getMonth() + 1;
                let dd = d.getDate();
                let todaysDate = `${mm}/${dd}/${yyyy - 2000}`;
                if (estDate.includes(todaysDate)) {
                    let estDate = dates[c].children[0].style = 'font-weight: bold !important; font-style: italic !important;';
                }
            }
        }
        
    }
}


// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfHDTEnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled && result.enabled.length > 0) {
            if (result.enabled[9]) {
                if (result.enabled[9] == undefined) {
                    highlightDueToday();
                } else if (result.enabled[9] == 1) {
                    highlightDueToday();
                } else {
                    return;
                }
            } else {
                highlightDueToday();
            }
        }
        
        
    }));

}

checkIfHDTEnabled();