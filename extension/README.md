# myRepairTools — Chrome extension

CPR Oregon's RepairQ companion. One extension, three ancestries:

- **Price Calculator** (the old "CPR Tools" popup) — toolbar popup with the
  price calculator, price guide, and full view.
- **RQ Mods** (Ben's extension, absorbed) — all content-script mods: serial
  number + quote reminders, click targets, quick links/frames, pattern
  recorder/printer, due-today highlighting, custom bin text, quick-search fixes.
- **LCD Buyback** (new) — see below.

## LCD Buyback

1. A tech adds a screen-repair line item for an **iPhone / Galaxy S /
   Galaxy Note / Pixel** on a RepairQ ticket (`scripts/lcdCapture.js` watches
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

- `manifest.json` — MV3; content scripts run only on `cpr.repairq.io`.
- `scripts/bg.js` — service worker: print gate injector + LCD API proxy
  (edge-function URL + shared secret live here).
- `scripts/lcdCapture.js`, `scripts/lcdLabel.js`, `scripts/printGate.js`,
  `style/lcd.css` — the LCD buyback feature.
- `scripts/qrcode.js` — vendored [qrcode-generator](https://www.npmjs.com/package/qrcode-generator) (MIT).
- everything else in `scripts/` + `style/` — RQ Mods features, unmodified;
  their on/off switches are the checkbox list in Options (`options.html`).
- `popup/` — the Price Calculator popup, unmodified apart from branding.
