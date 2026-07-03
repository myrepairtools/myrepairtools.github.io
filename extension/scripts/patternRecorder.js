/*
    Pattern Recorder:
    Adds a graphical input form to record customer's unlock
    patterns. Works on every repair ticket. It copies the
    pattern to the clipboard rather than just directly
    injecting it into the relevant input field on the page,
    because the "relevant" field can change several times
    during the creation of a ticket in RQ, and this way
    gives the user more flexibility.
*/

// Check the user's sync storage to see if they've disabled this
// whole feature. If they have, don't run any other code in this file.
function checkIfPREnabled() {
    chrome.storage.sync.get(['enabled'])
    .then((result => {
        if (result.enabled == undefined) {
            initialize();
        } else if (result.enabled[6] == 1) {
            initialize();
        } else {
            return;
        }
    }));

}

window.onload = () => {
    checkIfPREnabled();
};

// Initialize some variables that going to be passed around by various 
// functions in a little bit
let patternDrawer;

let mouseCheck = false;

let pattern = '';
 
let patternDisplay;

let coordinates = [];

let positions = [];

let drawing;

// Start creating all the necessary page elements
function initialize() {
    // Create a button the user can click to open the
    // pattern recorder
    let openButton = document.createElement('li');
        // Use existing class name to make this element look
        // like its neighbors
        openButton.classList.add('active');
        openButton.classList.add('in');
        openButton.id = 'prOpen';
        openButton.addEventListener('click', showPatternDrawer);
    
    // Place the button in the sidebar
    let injectPoint = document.getElementById('tab');
    injectPoint.appendChild(openButton);

    // Add some finishing touches to the button, again to
    // make it match its neighbors' appearance
    let buttonEdit = document.getElementById('prOpen');
    if (buttonEdit != undefined) {
        let addition1 = document.createElement('div');
        addition1.classList.add('arrow-left');

        let addition2 = document.createElement('a');
        addition2.innerText = '\u270E UNLOCK PATTERN';

        buttonEdit.appendChild(addition1);
        buttonEdit.appendChild(addition2);

    }

    spawnPatternDrawer();
}

// This function toggles the pattern recorder to appear or disappear
function showPatternDrawer() {
    let bgBlocker = document.getElementById('bgBlocker');
    if (patternDrawer.style.display == 'block') {
        patternDrawer.style.display = 'none';
        bgBlocker.style.display = 'none';
    } else {
        bgBlocker.style.display = 'block';
        patternDrawer.style.display = 'block';        
    }
}

// Creat the pattern recorder. This will be a little complicated
function spawnPatternDrawer() {
    // This is where the pattern recorder will spawn
    let popUpPoint = document.getElementById('ticketForm');

    // bgBlocker creates a faded, mostly-opaque backdrop to 
    // improve visual contrast when the pattern recorder
    // 'pops up'
    let bgBlocker = document.createElement('div');
    bgBlocker.style.width = '100vw';
    bgBlocker.style.height = '100%';
    bgBlocker.style.backgroundColor = 'black';
    bgBlocker.style.opacity = '90%';
    bgBlocker.style.position = 'absolute';
    bgBlocker.style.top = '0';
    bgBlocker.style.left = '0';
    bgBlocker.id = 'bgBlocker';
    bgBlocker.style.display = 'none';
    popUpPoint.appendChild(bgBlocker);

    /*
        This is the actual pattern recorder itself. It is a 5-by-5 grid
        of divs. Nine of them are interactable, and the rest are filler.
        It's essentially a tic-tac-toe board.
    */
    let framei = document.createElement('div');
    framei.id = 'patternRecorder';

    framei.innerHTML = `
        <style>
            #patternRecorder {
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
                text-align: center;
                position: fixed;
                top: calc(40vh - 15vw);
                left: 35vw;
                background-color: #C7D4DA;
                width: calc(30vw + 10px);
                height: calc(30vw + 10px);
                border: solid 5px #275163;
                display: none;
                z-index: 369;
            }            
            #patternDrawer {
                width: 30vw;
                height: 30vw;
                margin: 0 auto;
                display: flex;
                flex-wrap: wrap;
                position: absolute;
                top: 5;
                left: 5;
                
            }
            
            .gridItem {
                width: 6vw;
                height: 6vw;
                font-size: 2rem;
                color: #030608;
            }
            
            .gridInput {
                display: flex;
                background-color: transparent;
                line-height: 1rem;
                font-size: 6vw;
                justify-content: center;
                align-items: center;

                cursor: pointer;
            
                -webkit-touch-callout: none; 
                -webkit-user-select: none; 
                -khtml-user-select: none; 
                -moz-user-select: none; 
                    -ms-user-select: none; 
                        user-select: none;
            }
            
            .gridLine {
                background-color: transparent;
            }
            
            #currentPattern {
                font-size: 3rem;
                color: #275163;
                width: calc(30vw + 5px);
                height: 4vw;
                position: absolute;
                top: 32vw;
                left: 0;
                display: flex;
                justify-content: center;
                align-items: center;

                background-color: #C7D4DA;
                border: solid 5px #275163;
                border-radius: 10px;
            }
            
            #patternCanvas {
                position: absolute;
                top: 5;
                left: 5;
            }
            
            #patternSubmitButton {
                font-size: 2rem;
                color: #030608;
            
                background-color: #C7D4DA;
                border: solid 5px #C7D4DA;
                border-radius: 10px;
            
                width: calc(30vw + 10px);
                height: 4vw;
                position: absolute;
                left: 0;
                top: 38vw;
                display: flex;
                justify-content: center;
                align-items: center;

                cursor: pointer;
            }
            
            #patternSubmitButton:hover {
                border-color: #275163;
                transition: 0.2s;
            }
        </style>

        <div id="patternDrawer" draggable="false">

            <div draggable="false" class="gridItem gridInput" id="gi-1">&#9678;</div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridInput" id="gi-2">&#9678;</div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridInput" id="gi-3">&#9678;</div>

            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>

            <div draggable="false" class="gridItem gridInput" id="gi-4">&#9678;</div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridInput" id="gi-5">&#9678;</div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridInput" id="gi-6">&#9678;</div>

            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridLine"></div>

            <div draggable="false" class="gridItem gridInput" id="gi-7">&#9678;</div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridInput" id="gi-8">&#9678;</div>
            <div draggable="false" class="gridItem gridLine"></div>
            <div draggable="false" class="gridItem gridInput" id="gi-9">&#9678;</div>

        </div>


        
        <div id="currentPattern">0000</div>

        <div id="patternSubmitButton">Copy & close</div>
    `;


    popUpPoint.appendChild(framei);

    patternDrawer = document.getElementById('patternRecorder');

    let saveButton = document.getElementById('patternSubmitButton');
    saveButton.addEventListener('click', savePattern);

    initializePatternRecorder();

}

// Add the necessary code for recording user inputs on 
// the pattern recorder
function initializePatternRecorder() {
    // Clear the pattern whenever the user starts to
    // draw again
    document.addEventListener('mousedown', resetPattern);
    // Reveal the pattern whenever the user releases the mouse
    document.addEventListener('mouseup', showPattern);
    patternDisplay = document.getElementById('currentPattern');

    let inputs = document.getElementsByClassName('gridInput');
    for (let i=0; i<9; i++) {
        // Register an input whenever the user drags their mouse over
        // a target or releases the mouse over a target
        inputs[i].addEventListener('mouseleave', receiveInput);
        inputs[i].addEventListener('mouseup', receiveLastInput);

        // Register the coordinates of the user's inputs, so we
        // can later draw a line between them
        let leftCoord = inputs[i].offsetLeft;
        let inputWidth = inputs[i].offsetWidth;
        let topCoord = inputs[i].offsetTop;
        let inputHeight = inputs[i].offsetHeight;
        coordinates[i] = [(leftCoord + (inputWidth * 0.5)), (topCoord + (inputHeight * 0.5))];
    }
    
    
}

function resetPattern() {
    mouseCheck = true;
    pattern = '';
    positions = [];


    let boldReset = document.getElementsByClassName('gridInput');
    for (let b = 0; b < boldReset.length; b++) {
        boldReset[b].innerText = '\u25CE';
    }
}

function showPattern() {
    mouseCheck = false;

    for (let i = 0; i < pattern.length; i++) {
        let position = parseInt(pattern.charAt(i)) - 1;
        positions[i] = position;
    }

    
}

function receiveInput() {
    if (mouseCheck == true) {
        pattern += (this.id.replace('gi-', ''));
        patternDisplay.innerText = pattern;
        this.innerText = '\u25C9';
    }
    
}

function receiveLastInput() {
    pattern += (this.id.replace('gi-', ''));
    patternDisplay.innerText = pattern;
    this.innerText = '\u25C9';
}

// When the user clicks the save button, close the pattern
// recorder and copy the pattern to the clipboard. They
// can then paste it wherever they'd like.
function savePattern() {
    let savedpattern = document.getElementById('currentPattern').innerText;
    let passcode = `###${savedpattern}`;
    navigator.clipboard.writeText(passcode);

    showPatternDrawer();
    

    // Final passocde with look something like:
    // ###12569
}

