# myRepairTools — Chrome extension

CPR Oregon's RepairQ companion. One extension, three ancestries:

- **Price Calculator** (the old "CPR Tools" popup) — toolbar popup with the
  price calculator, price guide, and full view.
- **RQ Mods** (Ben's extension, absorbed) — all content-script mods: serial
  number + quote reminders, click targets, quick links/frames, pattern
  recorder/printer, due-today highlighting, custom bin text, quick-search fixes.
- **LCD Buyback** (new) — see below.
- **CPR Assistant overlay** (new) — a ✨ button inside RepairQ that opens the
  company AI assistant (`scripts/assistantOverlay.js` + iframe of
  myrepairtools.github.io/assistant.html). Answers come from the Knowledge Base
  with citations; the overlay posts the current page's context (ticket #,
  store, tech, line items) into the chat so questions are pre-grounded. Auth
  rides the MRT origin's session — sign in to myRepairTools once per browser.
  Toggle in Options.
- **What's Next?** (new) — the "McDonald's order board". A 🍔 button in
  RepairQ's top bar (`scripts/whatsNext.js`) fetches RepairQ's own ticket
  list (same-origin, follows pagination), keeps only workable tickets
  (New / New Claim / In Diagnosis / Ready for Repair — never Waiting for
  Part, Pending Notification, pickup or closed), and ranks them: express →
  overdue → due-soonest → oldest. The card says exactly which ticket to
  grab, with Open/Skip; 📺 board mode shows the whole ranked queue with
  urgency colors (drop a tab of it on the shop TV). Toggle in Options.
- **RepairQ workflow tools** (absorbed from **MyCPRTools**, another CPR
  franchisee's extension) — `scripts/mcprUtils.js` + `scripts/mcprConfig.js`
  carry the shared plumbing (axios replaced with fetch; the hardcoded
  employee roster replaced by a dynamic assignee lookup). Five tools, all
  toggleable in Options → RepairQ workflow tools:
  - **Parts Gate** (`scripts/partsGate.js`, default ON) — blocks closing a
    ticket when a "Repair - X" labor line has no matching "Part - X"
    bundled. Exemptions: diagnostic/unlock keywords (`mcprConfig.js`), a
    ticket note saying "no part needed"; claims with a "without frame"
    panel screen also require front + back adhesive.
  - **Update Assignee** (`scripts/updateAssignee.js`, default ON) — a
    one-click "assign this ticket to me" button on ticket view pages.
  - **Stock Badges** (`scripts/stockBadges.js`, default ON) — paints the
    hidden on-hand quantity onto MobileSentrix / cpr.parts product tiles
    (red 0 / orange ≤2 / green).
  - **Price Overlay** (`scripts/priceOverlay.js`, default ON — ours, not
    from MyCPRTools) — under each supplier product tile, shows what we'd
    charge the customer: **Repair** (part + $100 labor, fee-loaded,
    CPR-rounded) and **Add-on** (2× / 1.5× / +$25 tiered markup,
    fee-loaded). The math mirrors `popup/popup.js` — keep them in sync.
    Prefers the sale price when a tile shows one; stays silent on tiles
    with no readable price.
  - **KBB Returns** (`scripts/kbbReturns.js` + `style/kbb.css`, default ON —
    ours) — automates checking off Apple Known-Bad-Board returns across
    **cpr.parts** (`/kbbprocessing`) and **RepairQ** (`/rmaTracking`). A
    📦 KBB panel: scan your return-order numbers (HAL…) once; on cpr.parts
    it ticks every matching row's checkbox *and harvests* that row's RQ
    ticket # + KBB serial into a shared batch (chrome.storage.local); on
    RepairQ it ticks the matching rows using the harvested KBB serial
    (identical across both systems) — falling back to ticket # for
    no-serial parts, consumed one row at a time so multiple no-serial
    parts on one ticket still line up. You still process the returns
    manually; the tool only does the cross-reference + check-off that used
    to take ~an hour.
  - **Popup Blocker** (`scripts/popupBlocker.js`, **default OFF**) —
    auto-dismisses yellow banners (keeps "Find My" warnings) and
    auto-advances the claim walkthrough, T&C + signature flow (bg.js
    injects a jSignature stroke in MAIN world), and Samsung Genuine Parts
    form. Off by default because it signs forms automatically — enable
    deliberately.
  - **Clock Guard** (`scripts/clockGuard.js`, **default OFF**) — blocks
    clocking in before an Options-configurable time (default 9:40 AM).

## LCD Buyback

1. A tech adds a screen-repair line item for an **iPhone / Galaxy S / Galaxy Note /
   Galaxy Z (Fold/Flip) / Pixel** on a RepairQ ticket (`scripts/lcdCapture.js` watches
   `tr.ticket-item-row` on `/ticket/*`). Matching is by item **name**
   (device family + "screen repair/replacement"), so new models trigger
   automatically — no update needed. Families toggle in Options.
2. A modal asks **GOOD or BAD** (is the display coming off the phone good?).
   The answer, model, store, and tech go to the MRT LCD Buyback Log
   (`lcd-buyback` Supabase edge function, proxied through `scripts/bg.js`).
   On a brand-new ticket the answer waits in sessionStorage until the save
   gives it a ticket number.
3. Printing the ticket label (`/ticket/printLabel/*`) also prints a
   **send-display label** (Dymo 30334, 2¼" × 1¼") per logged display: store,
   GOOD/BAD pill, model, ticket #, date, QR code (= ticket number), and
   POST-REMOVAL check boxes (`scripts/lcdLabel.js` + vendored
   `scripts/qrcode.js`). `bg.js` holds the page's auto-print until the label
   is injected (4s safety net — printing is never blocked).
4. Displays are graded/audited on
   [myrepairtools.github.io/lcd-buyback.html](https://myrepairtools.github.io/lcd-buyback.html);
   the QR is what gets scanned into the audit when the recycler visits.

## Install (unpacked, for the team today)

1. Download/clone this repo, or grab just the `extension/` folder.
2. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
3. **Load unpacked** → select the `extension/` folder.

## Publish to the Chrome Web Store

1. Register a developer account at
   https://chrome.google.com/webstore/devconsole (one-time $5 fee, any Google
   account — use the business one so ownership isn't personal).
2. Zip the CONTENTS of `extension/` (manifest.json at the zip root):
   `cd extension && zip -r ../myrepairtools.zip . -x '*.md'`
3. Dev console → **New item** → upload the zip → fill the listing
   (name: myRepairTools; screenshots of the popup + modal work well).
4. Under **Distribution** choose **Unlisted** (installable by link only) —
   the LCD secret and internal URLs shouldn't be one search away.
5. Each release: bump `"version"` in manifest.json, re-zip, upload. Review
   usually takes a few hours to a couple of days.

Once it's on the store, installs update themselves — no more re-loading
unpacked folders, and no more waiting on anyone else to publish updates.

## Layout

- `manifest.json` — MV3; content scripts run on `cpr.repairq.io` (plus
  `mobilesentrix.com` / `cpr.parts` for Stock Badges only).
- `scripts/bg.js` — service worker: print gate injector, LCD API proxy
  (edge-function URL + shared secret live here), and the Popup Blocker's
  jSignature injector (MAIN-world executeScript).
- `scripts/lcdCapture.js`, `scripts/lcdLabel.js`, `scripts/printGate.js`,
  `style/lcd.css` — the LCD buyback feature.
- `scripts/whatsNext.js` + `style/whatsnext.css` — the What's Next queue.
- `scripts/promiseTime.js` — the Promise-Time Advisor: rolling queue
  snapshot + suggested pickup time on new tickets, one tap writes
  RepairQ's Promised-on date/time (bg.js MAIN-world datepicker driver),
  soft nudge when saving without one. Settings live in the `wn` object.
- `scripts/assistantOverlay.js` + `style/assistant.css` — the AI overlay.
- `scripts/mcprConfig.js`, `scripts/mcprUtils.js`, `scripts/partsGate.js`,
  `scripts/updateAssignee.js`, `scripts/stockBadges.js`,
  `scripts/popupBlocker.js`, `scripts/clockGuard.js` — the RepairQ workflow
  tools (from MyCPRTools). Settings live in the synced `mcpr` object.
- `scripts/priceOverlay.js` — customer Repair/Add-on prices on supplier
  tiles (Price Calculator math; also toggled via the `mcpr` object).
- `scripts/kbbReturns.js` + `style/kbb.css` — the KBB Returns matcher
  (cpr.parts /kbbprocessing + RepairQ /rmaTracking; batch in
  chrome.storage.local; toggled via the `mcpr` object).
- `scripts/qrcode.js` — vendored [qrcode-generator](https://www.npmjs.com/package/qrcode-generator) (MIT).
- everything else in `scripts/` + `style/` — RQ Mods features, unmodified;
  their on/off switches are the checkbox list in Options (`options.html`).
- `popup/` — the Price Calculator popup, unmodified apart from branding.
