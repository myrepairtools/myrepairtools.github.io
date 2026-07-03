/*
    Quote Reminders:
    While on a customer page, if they have an active quote, block the "+ repair"
    button and highlight the Quotes tab
*/

// Identify if there are any active quotes
function checkForQuote() {
    let quoteFound = false;
    // If there is an active quote, this query selector should find something
    const quoteElements = document.querySelectorAll("a[data-original-title='convert']");
    if (quoteElements.length > 0) {
        quoteFound = true;
    }   
    return(quoteFound);
}

// If a quote was found, draw a red box around the 'quotes' link
function remind(required) {
    const quoteLink = document.querySelectorAll("a[href='#quotes']")[0];
    quoteLink.style.borderColor = '#FF3100';
    quoteLink.style.borderStyle = 'solid';
    quoteLink.style.borderWidth = '8px';
    quoteLink.style.borderRadius = '4px';

    if (required) {
        blockClick();
    }
}

// Make sure we're not duplicating the override message here
let overrideAsked = false;

function askForOverride(target) {
    if (!overrideAsked) {
        let overrideButton = document.createElement('a');
        overrideButton.classList = 'btn btn-new btn-primary';
        overrideButton.innerText = 'Yes, make a ticket anyway.';
        overrideButton.style.marginBottom = '25px';
        overrideButton.href = target;

        const injectSpot = document.getElementById('summary');
        let overrideMessage = document.createElement('h4');
        overrideMessage.classList.add('section-header');
        overrideMessage.innerText = 'This customer has a quote. Are you sure you want to make a new ticket instead of converting the quote?';
        overrideMessage.style.borderColor = '#FF3100';
        overrideMessage.style.borderStyle = 'solid';
        overrideMessage.style.borderWidth = '4px';
        overrideMessage.style.borderRadius = '4px';
        overrideMessage.style.paddingTop = '10px';
        overrideMessage.style.paddingBottom = '10px';
    
        injectSpot.insertBefore(overrideButton, injectSpot.firstChild);
        injectSpot.insertBefore(overrideMessage, injectSpot.firstChild);
    
        overrideAsked = true;

    }
}

// Prevent the "add ticket" button from being clicked
function blockClick() {
    const injectPoint = document
        .getElementsByClassName('btn-group pull-right dropdown-with-backdrop')[0]
        .getElementsByTagName('ul')[0]
        .getElementsByTagName('li')[1]
        .getElementsByTagName('a')[0];

    let targetTarget = injectPoint.href;
    injectPoint.href='#';
    injectPoint.addEventListener('click', () => askForOverride(targetTarget));
}

function handlePopUp() {
    let candidates = document.getElementsByClassName('modal-header');
    for (let c  = 0; c < candidates.length; c++) {
        if (candidates[c].children.length !== undefined && candidates[c].children.length > 1) {
            if (candidates[c].children[1].innerText === 'Customer has open items') {
                let footerLink = candidates[c].parentNode.children[2].children[0];
                footerLink.innerText = 'Click here to ignore the leads (not recommended).';
                footerLink.style.borderColor = '#FF3100';
                footerLink.style.borderStyle = 'solid';
                footerLink.style.borderWidth = '4px';
                footerLink.style.borderRadius = '4px';

                candidates[c].parentNode.children[1].children[0].innerText = 'Customer has a lead. Click this button to see their leads, then click the play button next to one to convert it.';
                candidates[c].parentNode.children[1].children[1].style.display = 'none';
                candidates[c].parentNode.children[1].children[2].style.display = 'none';
            }
        }
    }
    
}

function watchForPopUp() {
    let watch = document.getElementsByClassName('c-ticket')[0];
    const config = {childList: true, attributes: true};
    const observer = new MutationObserver(handlePopUp);
    if (document.getElementsByClassName('c-ticket')[0]) {
        observer.observe(watch, config);
    }

    
}

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfQREnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            watchForPopUp();
            let quoteFound = checkForQuote();
            if (quoteFound == true) {
                remind();
            }
        } else if (result.enabled[2] == 1) {
            watchForPopUp();
            let quoteFound = checkForQuote();
            if (quoteFound == true) {
                let required = false;
                if (result.enabled[3] == 1) {
                    required = true;
                }
                remind(required);
            }
        } else {
            return;
        }
    }));

}

checkIfQREnabled();