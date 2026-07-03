/*
    RepairQ workflow tools — configuration (myRepairTools)

    Ported from the MyCPRTools extension (another CPR franchisee's toolkit,
    absorbed into myRepairTools v2.2.0). Edit these lists to tune the
    Parts Gate without touching the tool code.
*/

// Labor items containing any of these keywords are exempt from requiring
// a bundled part. Case-insensitive substring match.
const MCPR_LABOR_EXCLUSION_KEYWORDS = [
    'diagnostic',
    'unlock',
    // Add more here as needed, e.g.:
    // 'cleaning',
    // 'estimate',
    // 'data transfer',
];

// The phrase that, if found in any ticket note, exempts the
// entire ticket from the parts gate check.
const MCPR_NO_PART_NOTE_PHRASE = 'no part needed';

// Phrase in a bundled part name that triggers the adhesive check
// (claims only: if part contains this, front + back adhesive required)
const MCPR_PANEL_TRIGGER_PHRASE = 'without frame';

// Part type prefixes — used to match labor to part category
// e.g. "Repair - Phone" must have a "Part - Phone" bundled
const MCPR_REPAIR_PREFIX = 'repair -';
const MCPR_PART_PREFIX = 'part -';

// Display-name → assignee-ID overrides for Update Assignee. Normally leave
// this EMPTY — the dynamic lookup resolves the signed-in tech's ID from
// RepairQ itself, so nobody has to maintain a roster here. Only add an entry
// if the lookup ever fails for someone.
const MCPR_EMPLOYEES = {};
