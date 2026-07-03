// Notify users of updates on the homepage dashboard

// Add the update text to the page
function injectUpdates(update) {
    let dashboard = document.getElementById('dashboard'); // Find the dashboard element
    if (dashboard !== null) {

    }
}

// Turn the bullet points of the update into HTML elements
function createUpdate(updateText) {
    
}

// If it's been five days since the update, don't show this
function checkDate(updateText) {
    const date = new Date();
    const dd = parseInt(date.getDate());
    const mm = parseInt(date.getMonth()) + 1;
    const yyyy = parseInt(date.getFullYear());

    if (updateText.date[2] === yyyy && updateText.date[0] === mm) {
        if (updateText.date[1] <= dd + 5) {
            console.log('good');
        }
    }

}

// The contents of the update text
const updateText = {
    date: [7, 10, 2024],
    version: '1.2.1',
    bullets: [
        'Added this update banner. This banner will appear after every update to let you know what has been added and what has been changed.'
    ]
};


checkDate(updateText);

/* TODO
OKAY SO TWO PROBLEMS
One, this date thing isn't working. I think I have the comparison wrong. BUT IT DOESN'T MATTER Because
Two: what if I push an update on the first? Five days before that is like, the 26th. 26 is way higher than 1.



Add the rest of the bullet points
Create the module and inject it in the page
Make a button to dismiss the module

{
            "js": [
                "scripts/dashboardUpdates.js"
            ],
            "matches" : [
                "https://cpr.repairq.io/",
                "https://cpr.repairq.io/#"
            ],
            "run_at": "document_end"
        }


*/