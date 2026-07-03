/*
    Necessary code for saving user-selected options
*/

function toggleBox() {
    if (this.getAttribute('data-checked') == 'checked') {
        this.setAttribute('data-checked', 'unchecked');
        this.className = 'checkmark unchecked';
    } else {
        this.setAttribute('data-checked', 'checked');
        this.className = 'checkmark checked';
    }
}

function toggleLinkBox() {
    if (this.getAttribute('data-checked') == 'checked') {
        this.setAttribute('data-checked', 'unchecked');
        this.className = 'ql-checkmark unchecked';
    } else {
        this.setAttribute('data-checked', 'checked');
        this.className = 'ql-checkmark checked';
    }
}

function toggleLcdBox() {
    if (this.getAttribute('data-checked') == 'checked') {
        this.setAttribute('data-checked', 'unchecked');
        this.className = 'lcd-checkmark unchecked';
    } else {
        this.setAttribute('data-checked', 'checked');
        this.className = 'lcd-checkmark checked';
    }
}

function saveOptions() {
    let checkedBoxes = [];
    let checkboxes = document.getElementsByClassName('checkmark');
    for (let b = 0; b < checkboxes.length; b++) {
        if (checkboxes[b].getAttribute('data-checked') == 'checked') {
            checkedBoxes[b] = 1;
        } else {
            checkedBoxes[b] = 0;
        }
    }
    const customQuickLinkName1 = document.getElementById('customQuickLinkName1').value;
    const customQuickLinkUrl1 = document.getElementById('customQuickLinkUrl1').value;
    const customQuickLinkName2 = document.getElementById('customQuickLinkName2').value;
    const customQuickLinkUrl2 = document.getElementById('customQuickLinkUrl2').value;
    const customQuickLinkName3 = document.getElementById('customQuickLinkName3').value;
    const customQuickLinkUrl3 = document.getElementById('customQuickLinkUrl3').value;
    const cbtText = document.getElementById('binLabelName').value;
    // LCD Buyback toggles (own storage key so the legacy `enabled` array is untouched)
    const lcdIds = { enabled: 'lcdEnabled', iphone: 'lcdIphone', galaxys: 'lcdGalaxys', galaxynote: 'lcdGalaxynote', galaxyz: 'lcdGalaxyz', pixel: 'lcdPixel' };
    let lcd = {};
    for (const k in lcdIds) {
        lcd[k] = document.getElementById(lcdIds[k]).getAttribute('data-checked') === 'checked';
    }
    let customQuickLinkFrame1 = false;
    if (document.getElementById('customQuickLinkFrame1').getAttribute('data-checked') === 'checked') {
        customQuickLinkFrame1 = true;
    }
    let customQuickLinkFrame2 = false;
    if (document.getElementById('customQuickLinkFrame2').getAttribute('data-checked') === 'checked') {
        customQuickLinkFrame2 = true;
    }
    let customQuickLinkFrame3 = false;
    if (document.getElementById('customQuickLinkFrame3').getAttribute('data-checked') === 'checked') {
        customQuickLinkFrame3 = true;
    }
    chrome.storage.sync.set(
        {
            customQuickLinkName1: customQuickLinkName1,
            customQuickLinkUrl1: customQuickLinkUrl1,
            customQuickLinkFrame1: customQuickLinkFrame1,
            customQuickLinkName2: customQuickLinkName2,
            customQuickLinkUrl2: customQuickLinkUrl2,
            customQuickLinkFrame2: customQuickLinkFrame2,
            customQuickLinkName3: customQuickLinkName3,
            customQuickLinkUrl3: customQuickLinkUrl3,
            customQuickLinkFrame3: customQuickLinkFrame3,
            enabled: checkedBoxes,
            cbt: {enabled: true, text: cbtText},
            lcd: lcd
        }, () => {
            alert('Options saved!');
        }
    );
}

function restoreOptions() {
    chrome.storage.sync.get([
        'customQuickLinkName1', 'customQuickLinkUrl1', 'customQuickLinkFrame1',
        'customQuickLinkName2', 'customQuickLinkUrl2', 'customQuickLinkFrame2',
        'customQuickLinkName3', 'customQuickLinkUrl3', 'customQuickLinkFrame3',
        'enabled', 'cbt', 'lcd'
    ])
    .then((result => {
        document.getElementById('customQuickLinkName1').value = result.customQuickLinkName1 || '';
        document.getElementById('customQuickLinkUrl1').value = result.customQuickLinkUrl1 || '';
        document.getElementById('customQuickLinkName2').value = result.customQuickLinkName2 || '';
        document.getElementById('customQuickLinkUrl2').value = result.customQuickLinkUrl2 || '';
        document.getElementById('customQuickLinkName3').value = result.customQuickLinkName3 || '';
        document.getElementById('customQuickLinkUrl3').value = result.customQuickLinkUrl3 || '';
        if (result.cbt !== undefined) {
            document.getElementById('binLabelName').value = result.cbt.text;
        } else {
            document.getElementById('binLabelName').value = 'In Possession';
        }
        const frameIds = ['customQuickLinkFrame1', 'customQuickLinkFrame2', 'customQuickLinkFrame3'];
        for (let i = 0; i < frameIds.length; i++) {
            const el = document.getElementById(frameIds[i]);
            if (result[frameIds[i]]) {
                el.setAttribute('data-checked', 'checked');
                el.className = 'ql-checkmark checked';
            } else {
                el.setAttribute('data-checked', 'unchecked');
                el.className = 'ql-checkmark unchecked';
            }
        }
        const lcdIds = { enabled: 'lcdEnabled', iphone: 'lcdIphone', galaxys: 'lcdGalaxys', galaxynote: 'lcdGalaxynote', galaxyz: 'lcdGalaxyz', pixel: 'lcdPixel' };
        for (const k in lcdIds) {
            const el = document.getElementById(lcdIds[k]);
            const on = !result.lcd || result.lcd[k] !== false;   // default: everything on
            el.setAttribute('data-checked', on ? 'checked' : 'unchecked');
            el.className = 'lcd-checkmark ' + (on ? 'checked' : 'unchecked');
        }
        let checkboxes = document.getElementsByClassName('checkmark');
        for (let c = 0; c < checkboxes.length; c++) {
            if (result.enabled == undefined) {
                checkboxes[c].setAttribute('data-checked', 'checked');
                checkboxes[c].className = 'checkmark checked';
            } else if (result.enabled[c] == 0) {
                checkboxes[c].setAttribute('data-checked', 'unchecked');
                checkboxes[c].className = 'checkmark unchecked';
            } else {
                checkboxes[c].setAttribute('data-checked', 'checked');
                checkboxes[c].className = 'checkmark checked';
            }
        }
    }));
}

function addButtonListeners() {
    let checkboxes = document.getElementsByClassName('checkmark');
    for (let n = 0; n < checkboxes.length; n++) {
        checkboxes[n].addEventListener('click', toggleBox);
    }
    let lcdBoxes = document.getElementsByClassName('lcd-checkmark');
    for (let n = 0; n < lcdBoxes.length; n++) {
        lcdBoxes[n].addEventListener('click', toggleLcdBox);
    }
    document.getElementById('customQuickLinkFrame1').addEventListener('click', toggleLinkBox);
    document.getElementById('customQuickLinkFrame2').addEventListener('click', toggleLinkBox);
    document.getElementById('customQuickLinkFrame3').addEventListener('click', toggleLinkBox);
}

restoreOptions();
addButtonListeners();

const saveButton = document.getElementById('saveOptions');
saveButton.addEventListener('click', () => {saveOptions()});
