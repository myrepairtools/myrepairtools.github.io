# Scheduling — Design Handoff

**Owner:** Britt (CPR Oregon)  ·  **Status:** proposal for design  ·  **Date:** 2026-06-25

We want to evolve employee scheduling from a flat "pick a time for each day" model
into a layered one:

> **Schedule › Shifts › Location › Days**

This doc gives design (and the next engineer) the context, the proposed information
architecture, wireframes, the data model, permissions, and the open questions to
resolve. **Sections 4 and 9 are where design input matters most.**

---

## 1. The one-paragraph ask

Make a **shift** a reusable, named thing (e.g. *Opener*, *Mid*, *Closer*, *Half-day*)
instead of a bare time-range. A shift's hours and availability can differ **by location**
and **by day of week**. Then design (a) the settings screen where shifts are defined
across that hierarchy, and (b) how those shifts get assigned to people in the weekly
schedule. Keep it native to the existing tool's look (see §10).

---

## 2. Product context (read once)

- **What this is:** internal web tools for a phone-repair business, served as a static
  site. Backend is Supabase (Postgres). No heavy framework — hand-authored HTML/CSS/JS.
- **Stores (locations):** Eugene, Salem Northeast, Clackamas. The store list is
  data-driven and can grow, so **never hard-code 3**.
- **People & roles:** `owner` (sees everything), `admin`/manager (scoped to the stores
  they're authorized for), `team_member` (employee). Everyone is row-level-security
  scoped to their authorized stores.
- **Why the schedule matters beyond "who works when":** the commission dashboard paces
  each tech's sales goal off their **scheduled work days** (not calendar days). So shift
  accuracy directly drives the numbers employees see. A "day worked" = any day with a
  shift that isn't *Off*.
- **Two surfaces exist today:**
  1. **Schedule tool** (admin-only page) — the weekly grid editor.
  2. **Settings → Page Settings → Schedule** — where shift options are managed.

---

## 3. Current state (v1, shipped) — and why it's not enough

**Data:** `shift_presets(store, label, start_min, end_min, color)` — a flat list of
selectable time-ranges, one set per store. `label` is literally a string like
`"9:00AM - 7:00PM"`.

**Weekly schedule:** stored per employee as a recurring pattern
`staff_schedule.shifts = { weekday: { store, label } }`. The Schedule tool shows **one
card per store**, employee rows, 7 day columns; each day cell picks a preset (or *Off*).
A tech can be put at another store on a given day (the cell shows that store's color/tag).

**Limitations that prompted "more layers":**
| Limitation | Example we can't express today |
|---|---|
| A "shift" isn't a named concept, just a time string | Can't say "put Vince on **Opener**" — only "9:00AM–7:00PM" |
| Hours can't vary by day within one shift | *Opener* is 9:00 Mon–Fri but 9:30 on Saturday |
| Presets are duplicated per store | The same *Closer* must be re-typed for each location |
| No "this shift doesn't run here / this day" | *Mid* exists at Eugene but not Clackamas; nobody opens Sunday |

---

## 4. Proposed hierarchy — what each layer means

> **Decision point for design/product:** this is the proposed meaning of each layer.
> Confirm or adjust before building.

```
Schedule            ← the feature / top-level section
└── Shifts          ← named, reusable shift definitions (Opener, Mid, Closer, Half-day…)
    └── Location    ← each shift is configured per store (may not exist at every store)
        └── Days    ← within a location, hours can vary per weekday (or be "closed")
```

- **Schedule** — the section in Settings (defining shifts) and the tool (assigning them).
- **Shift** — the reusable unit you assign to a person. Has a **name** and a **color**.
  Examples: *Opener*, *Mid*, *Closer*, *Half-day*, *Inventory*.
- **Location layer** — a shift is enabled per store, and its hours/color may differ per
  store. *Mid* might be 11–7 at Eugene and 10–6 at Salem, and simply not exist at Clackamas.
- **Days layer** — within a (shift, location), each weekday can have its own start/end, or
  inherit a default, or be **closed** (not offered that day).

The net effect: define *Opener* **once**, then fine-tune it down the tree only where it
deviates. Most shifts will set hours once at the location level and rarely touch the day
level — so the day layer should be **progressive disclosure**, not in your face.

---

## 5. Settings IA — the layered editor (primary design surface)

This lives under **Settings → Page Settings → Schedule** (it replaces today's flat
"one card per location" list). Suggested 3-pane drill-down, consistent with how other
Page Settings already work (a left rail of items, then detail to the right):

```
┌ Schedule settings ─────────────────────────────────────────────────────────┐
│  SHIFTS            │  ●  Opener            (selected)                         │
│  ───────           │  ──────────────────────────────────────────────────    │
│  ● Opener          │  Name [ Opener        ]   Color [▢ green]   ◉ Active    │
│  ○ Mid             │                                                          │
│  ○ Closer          │  LOCATION:  [ Eugene ] [ Salem ] [ Clackamas ]  ← tabs  │
│  ○ Half-day        │  ┌───────────────────────────────────────────────────┐ │
│  + New shift       │  │  Default hours:  [09:00] – [19:00]                 │ │
│                    │  │  ☑ Enabled at this location                        │ │
│                    │  │                                                     │ │
│                    │  │  Per-day overrides (optional):                      │ │
│                    │  │   Sun  ◻ closed                                     │ │
│                    │  │   Mon  • default (9:00–19:00)                       │ │
│                    │  │   …                                                 │ │
│                    │  │   Sat  [09:30] – [17:30]   ✎ overridden             │ │
│                    │  └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

Notes for design:
- **Left rail = Shifts.** Add / rename / recolor / archive. Order matters (sort).
- **Location = tabs** (or segmented control) inside the selected shift. An admin only
  sees tabs for stores they're authorized for; owner sees all.
- **Days = a compact list** under each location. Default state is "inherits default
  hours"; the user can override a single day or mark it **closed**. Keep overrides visually
  secondary (most shifts won't use them). Consider a "copy hours to all days" affordance
  and "copy this location's setup to another location."
- **Color** is set on the shift (top), with the option to override per location if needed
  (open question — see §9). Color is what shows on the schedule grid.

---

## 6. Schedule tool (assignment) — what changes

Conceptually unchanged from today's **per-location cards** layout (one card per store,
employee rows, Sun–Sat columns, managers first then alphabetical). What changes:

- A day cell now picks a **named shift** (grouped by location in the dropdown), not a raw
  time. The **displayed time is derived** from `shift × location × weekday`.
- Cell shows: shift name + derived time + shift color. Cross-location days show the other
  store's tag/color, as today.
- *Off* and blank (not scheduled) remain.

```
EUGENE                                                  (store color header)
            Sun     Mon       Tue       Wed     Thu     Fri     Sat
Vince  🦊   Off     Opener    Opener    Opener  Off     Mid     Half-day
                    9–7       9–7       9–7             11–7    9:30–1:30
Kade   ⚡   Mid     Mid       Off       Off     Closer  Closer  Closer
            …
```

> Open question (§9): do we keep recurring-weekly only, or add **specific calendar dates**
> (a real monthly calendar with date-specific shifts, time-off, etc.)? That's the bigger
> fork and affects the data model. v1 is recurring-weekly.

---

## 7. Future surfaces (note for scope, not v1)

- **My Hub (employee view):** read-only "my week / my month," location-scoped. Employees
  personalize an emoji avatar (already shipped) which should appear here.
- **Monthly view + drag-and-drop** to move shifts around (admin/owner only).
- **Time-off requests + approvals**, then **notifications** (reminders, approvals/denials).

These are roadmap; design can keep them in mind so the shift model doesn't box them out
(esp. the recurring-vs-dated question in §9).

---

## 8. Proposed data model (for engineering — design can skim)

```
shifts
  id            bigserial pk
  name          text                 -- "Opener"
  color         text                 -- grid color
  sort          int
  active        bool

shift_hours                          -- per location, per (optional) weekday
  id            bigserial pk
  shift_id      fk shifts
  store         text                 -- location
  weekday       int null             -- NULL = default for the location; 0..6 = override
  start_min     int null
  end_min       int null
  closed        bool default false   -- not offered that day
  unique(shift_id, store, weekday)

staff_schedule.shifts  (existing jsonb, value changes)
  { "<weekday>": { "store": "...", "shift_id": 123 } }   -- references a shift
  work_days[] still = weekdays that aren't Off (drives pace)
```

- Resolution at render: `hours(shift, store, weekday)` = the row for that exact weekday,
  else the `weekday IS NULL` default, else "not offered."
- **Migration:** today's `shift_presets` rows become `shifts` (name = the label or a
  derived name) + `shift_hours` defaults per store; existing `staff_schedule` labels map
  to the new `shift_id`. Keep a fallback so old string labels still render.
- **RLS:** writes to `shifts`/`shift_hours` gated by `is_admin(store)` (same pattern we
  already use for `shift_presets` and `staff_schedule`). A shift that spans locations is
  editable per-location-row by each authorized admin.

---

## 9. Open questions (please resolve with design/product)

1. **Layer semantics** — is the §4 interpretation right (a shift = named template; location
   + day refine its hours)? Or do you mean shifts should be defined *only* per-location
   from the start (no shared template)?
2. **Recurring vs. dated** — v1 is a recurring weekly pattern. Do you want a true
   **monthly calendar** with date-specific shifts (holidays, one-offs, coverage swaps)?
   This is the biggest fork; it changes the data model and most screens.
3. **Color** — set once on the shift, or allow a per-location color override?
4. **Overnight / cross-midnight shifts** — possible (end < start)? (Probably not for
   retail hours, but confirm.)
5. **Double-booking** — should the tool warn if a person is given two stores on the same
   day, or is "Eugene morning → Salem evening" legitimate? How do we want it shown?
6. **Who manages shifts** — owner-only, or any admin for their stores? (Current lean:
   admins for their authorized stores; owner for all.)
7. **Granularity of "Days"** — per-weekday hour overrides only, or also "this shift only
   runs Mon/Wed/Fri" availability? (We can model both with `closed`.)
8. **Naming** — are *Opener / Mid / Closer* the right default vocabulary, or freeform?

---

## 10. Brand & system reference (so new UI looks native)

- **Fonts:** `Nunito` (headings/weights 800–900), `Nunito Sans` (body).
- **Palette (CSS vars):** `--red:#DC282E` `--dark:#2D2D3B` `--blue:#4FB0E3`
  `--grey:#B9BDCB` `--light-grey:#F3F2F2`. Store colors are data-driven (Eugene green,
  Salem red, Clackamas blue by default) and used to color shifts/locations on the grid.
- **Existing components to reuse:** white rounded cards with a thin border and accent top
  bar; segmented controls (the seg pills); the 3-rail Page Settings layout; native color
  inputs; small pill/badge chips; a left store-color bar on cards.
- **Tone:** dense but friendly; lots of small uppercase labels; rounded 8–14px corners.
- Reference files for visual language: `settings.html`, `schedule.html`,
  `commission-dashboard.html` in the repo.

---

## 11. What design should deliver back

1. The **Shifts settings** screen (the §5 layered editor) — empty, one-shift, and
   multi-location-with-day-overrides states.
2. The updated **Schedule tool** cell + dropdown (shift name + derived time + color).
3. Answers/recommendations on the §9 open questions.
4. (Stretch) a first look at the **monthly view** if we decide to go dated (§9.2).
