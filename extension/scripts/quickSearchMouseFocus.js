/*
    Quick search mouse focus:
    Make the cursor automatically focus on the search bar
    when you pull up the quick search box.

*/

// Initialize this counter variable
let refocused = 0;

// These functions are in reverse-action order, so this
// first one will typically be called last

// Focus the mouse on the search bar again, up to three times.
// RQ software yoinks away the cursor three times for some reason
// (because it's glitchy), so this counters that
function refocus() {
    let searchBar = document.getElementById('keyword_box_id');
    if (refocused < 3) {
        searchBar.focus();
        refocused += 1;
    }
}

// Focus the mouse in the search bar so the user can start
// typing right away
function focusMouse() {
    refocused = 0;
    let searchBar = document.getElementById('keyword_box_id');
    searchBar.focus();
    searchBar.onblur = () => { refocus()};
}

function quickSearchMouseFocus() {
    // Listen for the user to click the button which brings up the search bar
    const quickSearchButton = document.querySelectorAll("a[href='#priceCheck']")[0];
    // This button doesn't always exist, so catch the exception
    if (quickSearchButton != undefined) {
        quickSearchButton.addEventListener('click', () => focusMouse());
    }
    // Identify the actual search bar
    const searchBar = document.getElementById('keyword_box_id');
    if (searchBar != undefined) {
        // This search bar does not come with its own tabIndex,
        // so we need to give it something. We'll use 369 to pay
        // honor to Lil Jon
        searchBar.tabIndex = 369;
    }
    
}

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfQSMFEnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            quickSearchMouseFocus();
        } else if (result.enabled[8] == 1) {
            quickSearchMouseFocus();
        } else {
            return;
        }
    }));

}

checkIfQSMFEnabled();

