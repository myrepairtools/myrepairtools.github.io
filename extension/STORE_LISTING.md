# Chrome Web Store listing kit — myRepairTools

Everything the dev console asks for, ready to paste. Upload
`myrepairtools-<version>.zip` (zip of this folder's contents, manifest.json at
the zip root: `cd extension && zip -r ../myrepairtools.zip . -x '*.md'`).

## Store listing tab

**Name:** myRepairTools

**Summary (132 chars max):**
CPR Oregon's RepairQ companion — LCD buyback labels, What's Next queue, AI
assistant, parts gate, price calculator and more.

**Description:**
Internal tool for CPR Oregon staff. myRepairTools extends RepairQ
(cpr.repairq.io) with the workflows our stores run every day:

• LCD Buyback — adding an iPhone, Galaxy S, Galaxy Note, Galaxy Z, or Pixel
screen repair to a ticket pops a Good/Bad display grading modal, logs the
answer to our internal LCD Buyback Log, and prints a send-display label
(with a scannable QR serial) alongside the ticket label. Device families
can be toggled in Options.
• What's Next? — a button in the RepairQ top bar that ranks the workable
ticket queue (express → overdue → due-soonest) and tells the tech which
repair to grab next, with an order-board view for the shop TV.
• CPR Assistant — the company AI assistant inside RepairQ; answers come
from our Knowledge Base with citations, grounded in the ticket on screen.
• Workflow gates: a Parts Gate that stops tickets closing without the
matching part bundled, one-click Update Assignee, supplier stock badges on
MobileSentrix / cpr.parts, and optional popup auto-advance + clock-in guard.
• Price Calculator & Price Guide in the toolbar popup.
• Quality-of-life RepairQ mods: serial number and quote reminders, bigger
click targets, custom quick links, unlock-pattern recording and label
printing, due-today highlighting, custom bin label text, quick-search fixes.

Only runs on cpr.repairq.io and our parts suppliers' catalogs. Intended for
CPR Oregon employees; it does nothing useful on other sites or for other
organizations.

**Category:** Workflow & Planning (or Tools)
**Language:** English

**Screenshots (1280×800):** shot1 = grading modal on a ticket, shot2 = LCD
Buyback Log, shot3 = recycler audit scanning. Icon = images/mrt128.png.

## Privacy tab

**Single purpose:** Extends the RepairQ point-of-sale site with CPR Oregon's
internal repair-shop workflows (display grading/labeling, price tools, UI
shortcuts).

**Permission justifications:**
- `storage` — saves the user's feature toggles (which mods are on, which
  device families trigger the grading modal).
- `tabs` — detects when a RepairQ label-print tab opens so the send-display
  label can be added before the page auto-prints; opens the full-view
  calculator tab.
- `scripting` — injects the print-gate into label-print tabs at load time so
  auto-print waits for the label stamp (never longer than 4 seconds).
- `activeTab` — popup interacts with the currently open RepairQ tab.
- Host `cpr.repairq.io` — the site this extension exists to extend.
- Host `xuvsehrevxackuhmbmry.supabase.co` — our own backend; display grades
  are logged there and read back at label-print time.
- Hosts `mobilesentrix.com` / `cpr.parts` — our parts suppliers; the Stock
  Badges tool displays each product tile's on-hand quantity (read from the
  page itself; nothing is sent anywhere).

**Remote code:** No, all code is packaged.

**Data usage:** The extension sends the following to our own (CPR Oregon)
backend, only on ticket/label pages: ticket number, device model, store
location, the grading answer, and the signed-in RepairQ employee name.
Nothing is sold or shared with third parties; no browsing history, no
personal customer data. In the console's data disclosure, check
"User activity" ➜ used for app functionality only (the employee name +
grading actions), and certify the three "I do not sell/transfer…" statements.

**Visibility:** Unlisted — installable by link only. Share the store link in
Communications once approved.

## Each release

1. Bump `"version"` in manifest.json (e.g. 2.0.1).
2. Re-zip, upload as a new package on the existing item, submit for review.
3. Installed copies auto-update within hours of approval.
