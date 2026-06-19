# Roles & Permissions — Design Handoff

> **Purpose of this document.** A self-contained brief for designing the new
> **Roles & Permissions** experience for CPR Oregon's internal tools site
> (`myrepairtools.github.io`). It assumes the designer has **no prior knowledge
> of the codebase**. Everything needed to design the screens — the goal, the
> data model, the exact screens/states, and the brand system — is here.
>
> Scope chosen: **Full RBAC with groups, scoped by store location.**
> Deliverable from design: screen layouts / flows we can then build against.

---

## 1. The one-sentence goal

Let an owner define **roles** (bundles of permissions), optionally bundle people
into **groups**, and grant people access **per store location** — so the same
employee can "see everything at Eugene, limited stuff at Salem, and nothing at
Clackamas."

---

## 2. Context you need

**What the site is.** A set of ~18 internal web tools for a phone-repair
business (CPR Oregon) — cash tracking, claim ledgers, commission, ordering,
pricing, staff records, etc. Each tool is its own page. Staff open them on shop
iPads/computers.

**Three store locations** (this list is fixed and central to everything):
- **Eugene**
- **Salem Northeast**
- **Clackamas**

**Who uses it.** A small team — a handful of employees per store, a few
managers, and the owner. Not hundreds of users. The design should feel simple
and fast for an owner managing it on a tablet, not an enterprise IAM console.

**The problem today.** Access is governed by a flat role (`employee` / `manager`
/ `owner`) with no real per-permission control, and there's an older parallel
login system that's inconsistent with it. We're consolidating to **one** model:
roles → permissions, assignable per location, optionally via groups.

**What already exists that the design should stay consistent with.** There is a
**Settings** page with a tab bar. Today it has two tabs: **Team Members** and
**Locations**. The new work adds a **third tab: "Roles & Permissions."** It
should look like it belongs next to the existing two. (See brand system in §7.)

---

## 3. The model in plain English

Four building blocks. Read these top to bottom — each builds on the last.

1. **Permission** — the smallest unit. A single capability, e.g. *"View cash
   counts"* or *"Manage staff."* There's a fixed master list (people rarely add
   new ones; they're tied to what the tools can do).

2. **Role** — a named bundle of permissions, e.g. **Manager** = {view cash, edit
   cash, view claims, view commission, manage staff…}. Owners create and edit
   roles by ticking which permissions belong to them. A few roles ship
   pre-made (Owner, Manager, Shift Lead, Employee); owners can add custom ones.

3. **Group** — a named bundle of **people** that carries role-grants, e.g.
   *"Eugene Managers"* = these 3 people, each gets the **Manager** role **at
   Eugene**. Groups are a convenience so you don't assign everyone one-by-one.

4. **Scoped grant (the key idea)** — access is always **role + location**. A
   person can hold *different roles at different stores*. They get grants two
   ways:
   - **Directly** — "give Britt the Manager role at Eugene."
   - **Via a group** — "Britt is in the Eugene Managers group, which grants
     Manager @ Eugene."

**How access is decided (the rule that powers everything):**
> For a given person at a given store, collect every role they hold there
> (direct + via groups). Their permissions at that store = the **union** of all
> those roles' permissions.

So Britt's example becomes:
- **Eugene** → Manager grant → sees everything a Manager can.
- **Salem Northeast** → Employee grant → limited.
- **Clackamas** → no grant → no access.

---

## 4. Data model (reference for builders, useful background for design)

Tables (names indicative). The design doesn't need to show these, but they
explain why the screens are shaped the way they are.

| Table | Holds | Key fields |
|---|---|---|
| `permissions` | master list of capabilities | `key` (e.g. `cash.edit`), `label`, `category` |
| `roles` | named permission bundles | `name`, `description`, `is_system` (built-in vs custom) |
| `role_permissions` | which permissions a role has | `role_id`, `permission_id` |
| `groups` | named bundles of people | `name`, `description` |
| `group_grants` | roles a group confers, per location | `group_id`, `role_id`, `location` (or `ALL`) |
| `group_members` | people in a group | `group_id`, `staff_id` |
| `staff_roles` | direct per-person grants | `staff_id`, `role_id`, `location` (or `ALL`) |

`location` can be a specific store **or** a special **"All stores"** value (for
the owner, or a chain-wide role).

**Seed permission catalog** (starting point — grouped by category, maps to the
real tools):

- **Cash** — `cash.view` (Cash Tracker), `cash.admin` (Cash Admin)
- **Claims** — `claims.view` (Claim Ledger)
- **Commission** — `commission.view` (Commission Calculator)
- **Profit** — `profit.view` (Profit First)
- **Staff** — `staff.view`, `staff.manage` (Employee Records, Staff Management)
- **Orders & Inventory** — `orders.hyla`, `orders.jerryding`, `orders.po`,
  `consumption.view`
- **Pricing** — `pricing.view` (Price Calc / Price Guide)
- **Damage** — `damage.view` (Tech Damage Tracker)
- **Admin** — `settings.locations`, `settings.access` (assign people),
  `settings.roles` (edit roles/permissions/groups — the most powerful)

**Seed roles** (illustrative):
- **Owner** — everything, at All stores.
- **Manager** — most things at their store: cash (view+admin), claims, staff
  view/manage, orders, pricing, damage. Not `settings.roles`.
- **Shift Lead** — cash view, orders, damage, pricing view.
- **Employee** — cash view, pricing view, damage view, orders they run.

---

## 5. Screens to design

This is the heart of the handoff. The new **"Roles & Permissions" tab** has
**three sub-views** (Roles · Permissions · Groups), plus it touches the existing
**Team Member** screen for per-person assignment. Design all of the following.

### 5.0 Shared frame (applies to every screen below)
- Lives inside Settings, under the page title **"Settings."**
- A tab bar: **Team Members · Locations · Roles & Permissions** (third active).
- Below the tab bar, a secondary sub-tab row for this section:
  **Roles · Permissions · Groups.**
- Everything sits on the light-grey app background inside white rounded cards.

---

### 5.1 Roles — list view  *(default sub-tab)*
**Purpose:** see and manage all roles.

**Layout:** a white card containing a table.
- Columns: **Role** (bold name) · **Description** (muted one-liner) ·
  **Permissions** (a count pill, e.g. "12") · **Used by** (count of people/groups
  using it, e.g. "4 people") · row action **Edit**.
- Rows: Owner, Manager, Shift Lead, Employee (+ any custom).
- **System roles** (Owner/Employee) show a small "Built-in" tag and can't be
  deleted, only edited.
- Top-right primary button: **+ New role** (red).

**States to show:** normal list; a custom role with a "Custom" tag; empty state
text ("No custom roles yet").

---

### 5.2 Role editor  *(modal or full panel)*
**Purpose:** define exactly what a role can do. **This is the most important
screen** — get it clean and scannable.

**Header:** "Edit role: Manager" + small description field.

**Body — the permission picker:** the master permission list, **grouped by
category** (Cash, Claims, Commission, Profit, Staff, Orders & Inventory,
Pricing, Damage, Admin). Under each category header, one row per permission with:
- the permission **label** ("View cash counts"),
- a tiny muted **key/hint** is optional,
- an **on/off toggle** (ON = blue, OFF = grey).

Design considerations:
- Category headers should let you **toggle a whole category** on/off at once
  (handy for "Manager gets all of Cash").
- Show a live **count** of how many permissions are on.
- Long list → needs comfortable vertical scroll inside the modal.

**Footer:** Cancel · Save. For custom roles, a destructive **Delete role** in the
footer-left (with confirm). Built-in roles hide Delete.

---

### 5.3 Permissions — master list  *(sub-tab)*
**Purpose:** reference list of every capability the system knows about. Mostly
read-only; owners rarely edit. Lowest-priority screen.

**Layout:** white card, grouped by category, each row = permission **label** +
**key** + **description** + which roles currently include it (small pills or a
count). Possibly a search box at top. No heavy editing UI needed in v1 — this is
a catalog. (If we ever support custom permissions, a "+ New permission" lives
here, but design it as secondary.)

---

### 5.4 Groups — list view  *(sub-tab)*
**Purpose:** manage bundles of people and the role(s) they get per location.

**Layout:** white card, one card-row or table-row per group:
- **Group name** ("Eugene Managers") + description.
- **Members:** a cluster of small colored **avatar circles** with initials
  (overflow shows "+2").
- **Grants:** role-at-location **pills**, e.g. `Manager @ Eugene`,
  `Employee @ Salem`. Could be multiple.
- Row action **Edit**.
- Top-right **+ New group** (red).

---

### 5.5 Group editor  *(modal or panel)*
**Purpose:** edit one group.

**Two parts:**
1. **Members** — add/remove people (a searchable people-picker; chosen people
   show as removable avatar chips).
2. **Grants** — a small repeating row of **[Role ▾] at [Location ▾]**, with an
   "+ Add grant" to stack more. Location dropdown options: each store + **All
   stores**.

**Footer:** Cancel · Save; Delete group (left, with confirm).

---

### 5.6 Person — "Access by location"  *(extends the existing Team Member modal)*
**Purpose:** the screen that makes Britt's example real — set what one person can
do at each store. This is likely where the owner spends the most time.

**Context:** the Team Member modal already has name / username / role / home
store / status fields. **Replace the single "role" field** with this richer
access block (or add it as a section).

**Layout — an "Access by location" grid:**
- A header avatar (colored circle, initials) + the person's name.
- One **row per store**: **Eugene · Salem Northeast · Clackamas**.
- Each row has a **Role dropdown**: e.g. Eugene = "Manager", Salem Northeast =
  "Employee", Clackamas = **"No access"** (an explicit option, not blank).
- Optionally allow **multiple roles per store** (a small multi-select / add-role
  control) since effective access is a union — but a single dropdown per store
  is fine for v1 if simpler.
- **Inherited-from-group indicator:** if the person already gets a role at a
  store *via a group*, show it as a **read-only pill** ("Manager @ Eugene — from
  *Eugene Managers* group") so the owner understands where access comes from and
  doesn't double-assign.
- Helper text under the grid: *"This person sees everything at Eugene, limited
  at Salem, and nothing at Clackamas."* (dynamic summary of the chosen grants).

**States to show:** a person with mixed access (the Britt example); a person
with "All stores" owner access; a person whose access is entirely inherited from
a group (all rows read-only pills).

---

## 6. Rules & edge cases the design should account for

- **"No access" is explicit.** Every store row offers a "No access" option;
  don't rely on an empty control to mean no access.
- **All stores.** Owner-type access uses an "All stores" scope rather than three
  separate grants.
- **Direct + group = union.** A person can have a direct grant *and* a group
  grant at the same store; effective permission is the union. Show inherited
  grants distinctly from direct ones.
- **Built-in roles** can be edited but not deleted; surface that clearly.
- **Deleting a role / group in use** needs a warning ("4 people use this role").
- **Self-lockout guard.** Warn if an owner is about to remove their own
  `settings.roles`/owner access.
- **This is an owner-only area.** Managers and employees never see the Roles &
  Permissions tab. (Design only the owner-facing view.)
- **Read-only fallback** for non-owners isn't needed here, but the Team Member
  "Access by location" block may be visible read-only to managers later — design
  with a read-only variant in mind.

---

## 7. Brand system (match the live site exactly)

Use these so the mockups look native to the existing tools.

**Colors (CSS values):**
- Red (primary buttons, brand accent): `#DC282E`
- Dark navy (text, active tab, sidebar): `#2D2D3B`
- Sky blue (secondary accent, active highlights, ON toggles): `#4FB0E3`
- Grey (muted text, labels): `#B9BDCB`
- Light grey (app background): `#F3F2F2`
- Card border: `#E0E2EA`
- White cards: `#FFFFFF`
- Success green (active dots/badges): `#2E9E5B`
- Amber (warnings): `#C9820B`

**Type:** **Nunito** (800/900 weights) for headings/labels/buttons;
**Nunito Sans** for body. Headings are bold and slightly tightened.

**Component patterns already used on the site (reuse them):**
- **Cards:** white, `12px` radius, `1px` border `#E0E2EA`, very subtle shadow.
- **Tab bar:** inline pill group; active tab = dark navy fill, white text.
- **Tables:** light-grey uppercase column headers (small, letter-spaced), thin
  row separators, row hover.
- **Buttons:** primary = red fill white text; secondary = white with border;
  small variants exist. Red is reserved for primary actions only.
- **Pills/badges:** rounded; status badges have a small colored dot (green =
  Active). Use blue-tinted pills (`#EAF6FD` bg, blue text) for selected/auth
  items.
- **Avatars:** colored circle (color hashed from the person), white bold
  initials.
- **Modals:** centered white panel, header with title + ✕, scrollable body,
  footer with left-aligned destructive action and right-aligned Cancel/Save.
- **Toggle/checkmark for permissions:** ON = blue; OFF = grey/outline.

**Density/feel:** generous whitespace, tablet-friendly tap targets, not
cluttered. It's an internal tool for a small team, so favor clarity over
information density.

---

## 8. Deliverables we'd love from design

1. The **Roles list** + **Role editor** (5.1, 5.2) — highest priority.
2. The **Groups list** + **Group editor** (5.4, 5.5).
3. The **per-person "Access by location"** block (5.6).
4. The **Permissions catalog** (5.3) — lightweight.
5. Desktop **and** tablet widths (owners manage this on an iPad).
6. Empty / filled / inherited / built-in states noted above.

---

## 9. Explicitly out of scope (for this design pass)

- The login screen / PIN entry (already exists, unchanged).
- Migrating the older parallel login system (engineering task, not design).
- Audit logs / permission history (future).
- Custom permission creation UI (future; catalog is read-only for now).

---

*Prepared as a handoff for designing in Claude Design. Questions for the
engineering side: how grants resolve, the seed catalog, and brand tokens are all
captured above.*
