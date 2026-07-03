/*
    Pattern Printer:
    When printing the barcode label for a ticket, if the customer's passcode
    is marked as a pattern (i.e. it begins with '###'), render a drawing of
    the pattern so that it can be printed out along with the usual label.
*/

let passcode = '';

// Generate the pattern display element
function createPattern() {
    let height = document.getElementsByTagName('table')[0].offsetHeight;
    let dimension = `${height}px`;

    let pattern = document.createElement('div');
    pattern.id = 'pattern';

    // Place nine tiles inside of the pattern display
    for (let i = 0; i < 9; i++) {
        let tile = document.createElement('div');
        tile.classList.add('tile');
        tile.id = `tile-${i}`;
        tile.innerText = '\u25CE';

        pattern.appendChild(tile);
    }

    // Create and prepare a canvas on top of the pattern display. This
    // will let us draw the line and actually show the pattern
    let canvas = document.createElement('canvas');
    canvas.id = 'patternCanvas';
    canvas.width = document.getElementsByTagName('table')[0].offsetHeight;
    canvas.height = document.getElementsByTagName('table')[0].offsetHeight;
    canvas.style.backgroundColor = '#00000000';

    pattern.appendChild(canvas);
    
    // Add some CSS to make sure everything is the right size and shape
    let style = document.createElement('style');
    style.innerText = `
        #pattern {
            width: ${dimension};
            height: ${dimension};
            position: absolute;
            left: calc(50vw - (0.5 * ${dimension}));
            display: flex;
            flex-wrap: wrap;
        }

        #patternCanvas {
            display: flex;
            position: absolute;
            left: 0;
        }

        .tile {
            width: calc(0.33 * ${dimension});
            height: calc(0.33 * ${dimension});
            font-size: calc(0.25 * ${dimension});
        }
    
    `;

    pattern.appendChild(style);

    return pattern;
}

// Now we'll actually draw the pattern on the canvas
function drawPattern() {

    let tiles = document.getElementsByClassName('tile');

    let coordinates = [];

    let position = 0;

    // The passcode is going to be a string of numbers, like '153'.
    // We'll get each number, 1-by-1, then turn that number into
    // a pair of coordinates on the canvas.
    for (let c = 0; c < passcode.length; c++) {
        position = parseInt(passcode.charAt(c)) - 1;

        // Determine the coordinates by finding the exact center of 
        // the relevant tile
        let leftCoord = tiles[position].offsetLeft;
        let inputWidth = tiles[position].offsetWidth;
        let topCoord = tiles[position].offsetTop;
        let inputHeight = tiles[position].offsetHeight;
        coordinates[c] = [(leftCoord + (inputWidth * 0.5)), (topCoord + (inputHeight * 0.5))];

        tiles[position].innerText = '';
        
    }

    // For the very last tile, change the inner text to this
    // filled-in target symbol, to indicate where teh pattern ends
    tiles[position].innerText = '\u25C9';

    // Start drawing the pattern on the canvas, going doordinate-
    // by-coordiate
    let drawing = document.getElementById('patternCanvas').getContext('2d');
    drawing.lineWidth = 3;
    drawing.lineCap = 'round';
    drawing.beginPath();

    for (let p = 0; p < (coordinates.length - 1); p++) {
        drawing.moveTo(coordinates[p][0], coordinates[p][1]);
        drawing.lineTo(coordinates[p + 1][0], coordinates[p + 1][1]);
        drawing.stroke();
    }

}

// Start the process of adding the pattern viewer to the page
function addPattern() {
    // This is where the viewer will go
    let injectPoint = document.getElementsByClassName('print-receipt')[0];

    // 'upMarker' is just the word 'top' so the user will be
    // able to see which way is up once this page is printed
    let upMarker = document.createElement('p');
    upMarker.innerText = 'Top';
    upMarker.style.fontSize = '10pt';
    upMarker.style.marginBottom = '0';
    injectPoint.appendChild(upMarker);

    let pattern = createPattern();

    injectPoint.appendChild(pattern);

    drawPattern();
}

// Check if this device has a pattern for a passcode,
// rather than just a PIN number. If there is no pattern,
// don't run any other code here.
function checkIfPattern() {
    let confirmed = false;

    let datas = document.querySelectorAll("td");
    for (let d = 0; d < datas.length; d++) {
        // We're using '###' at the beginning of a code
        // to indicate that it is a pattern code
        if (datas[d].innerText.includes('###')) {
            confirmed = true;
            passcode = datas[d].innerText.replace('Password: ###', '');
        }
    }

    if (confirmed == true) {
        addPattern();
    }
}

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfPPEnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            checkIfPattern();
        } else if (result.enabled[6] == 1) {
            checkIfPattern();
        } else {
            return;
        }
    }));

}

checkIfPPEnabled();