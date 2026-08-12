# Pre-Repair Diagnostics Suite — investigation

**The idea (owner, 2026-08-11):** at check-in, when the tech saves the ticket, the
Chrome extension pops a QR code. The customer's device scans it and lands on a testing
page with a unique ID; the device **tests itself** in the browser; results save to
Supabase (not RepairQ), with a ticket-note + sidebar section on the RepairQ ticket the
way Follow-Up does it.

**Why it matters — the policy already exists, only the discipline is manual.** KB
article #51 (*Repair Test Checklists*, Ben's SharePoint import) already mandates
pre- and post-repair testing and tells the exact liability story: a phone checked in
with a dead screen, fixed, then "my cell service is gone — it worked before." The
intake note *"nothing visible on the screen"* is the whole defense. It even threatens:
"if checklist results aren't being communicated, the annoying built-in RepairQ
checklists come back." This suite is that article, automated — and article #51 is the
requirements document. No new test list needs inventing.

---

## 1. The one hard design problem, up front

**The highest-liability device can't run the tests.** A dead/black screen — the exact
case KB 51 uses as its cautionary tale — cannot scan a QR or run a browser page. Same
for no-power, dead digitizer, boot loops.

So the extension modal can't be *only* a QR. It needs a first fork:

> **Device testable?** → [Show QR] / [Not testable — record why]

"Not testable" is a first-class result (KB 51 already defines it), captured tech-side
in two taps ("screen dead", "won't power on", "digitizer unresponsive", free text) and
written to the same session row + ticket note. That path is arguably the most valuable
part of the whole feature.

## 2. Flow

```
Check-in save (ticket/repair)
  └─ extension modal: Testable? ── no ──► record reason ──► note + chip
        │ yes
        ▼
  QR on the RepairQ screen  ──scanned by──►  customer device opens
  diag.html?t=<token>  (public token page, no login)
        │  runs tests, submits each result incrementally (partial results survive)
        ▼
  Supabase `diag_sessions` row  ◄─ polls ─  extension sidebar chip updates live
        │                                     "Diagnostics · 6 pass · 1 fail · running…"
        ▼ on finish (or tech closes it out)
  RepairQ ticket note: "✔ Pre-repair diagnostics: 11 pass · 1 FAIL (lower mic) ·
  2 not testable (no SIM) — by <tech>"   + sidebar block with per-test lines
```

Results deliberately live in Supabase (queryable, RLS'd, assistant-readable per the
AI directive); RepairQ gets a human-readable note + the live sidebar block, exactly
the Follow-Up split (`ticket_contacts` + note backup).

## 3. Reuse map — every piece has a proven precedent

| Need | Precedent (verified) |
|---|---|
| QR rendering in the extension | `extension/scripts/qrcode.js` already vendored; `lcdLabel.js` uses it |
| Pop a modal at first save of a check-in | `followUp.js` — pops "right after the first save", once-per-ticket memory, skip-stash on the pre-save page (`pendingSet`) |
| Unique ID before the ticket number exists | `lcdCapture.js` — sessionStorage `mrt_lcd_pending`, flushes with the ticket # when the saved ticket loads (lines 15-18, 156-169) |
| Extension → Supabase writes | `bg.js` lcd pattern: secret-gated edge function (`LCD_FN`/`LCD_SECRET`, `lcd:*` messages, lines 26-27, 334-338) |
| Ticket-note backup | `bg.js` `note:save` proxy (line 171) + `followUp.js` `writeNote` (line 144) — **including the 3-byte-UTF-8 rule: a 4-byte emoji blanks the note and blocks ticket saves; ✔ ⚠ ⛔ are safe** |
| Sidebar section by the Customer block | `followUp.js` sidebar block injection (lines ~320-360, both view + edit layouts handled) |
| Public token page, no gates | `intake.html` / `contract-sign.html` — token is the credential; table closed to anon; token-scoped SECURITY DEFINER RPCs |
| Post-repair hook (phase 2) | `readyText.js` already intercepts Ready-for-Pickup — the natural trigger for the *post* run KB 51 also requires |

Net: the only genuinely new engineering is the test page itself.

## 4. What a browser can actually test (the honest matrix)

Mapped against KB 51's phone checklist. "Guided" = the page drives it, a human
confirms. iOS Safari is the constraint that matters (most check-ins are iPhones).

| KB 51 test | Automation | iOS | Android | How |
|---|---|---|---|---|
| Touch screen (dead zones, ghost touch) | **Auto** | ✓ | ✓ | Paint-the-grid: swipe until every cell is hit; ghost-touch = cells firing untouched. The single best automated test — it maps *where* the dead zone is. |
| Multi-touch | **Auto** | ✓ | ✓ | 2-3 finger detection |
| Display (visible everywhere, artifacts) | **Guided** | ✓ | ✓ | Full-viewport color sweeps (R/G/B/W/K), tap-through; human judges. ⚠ iPhone Safari has no true fullscreen — browser chrome stays; acceptable, note it |
| Loudspeaker | **Guided** | ✓ | ✓ | WebAudio tones, "did you hear both?" |
| Ear speaker | Manual | — | — | No route control from web; KB 51's test call stays |
| Microphones (upper/lower) | **Guided** | ✓ | ✓ | getUserMedia record + playback; per-mic separation is coarse |
| Rear cameras (incl. lens switch) | **Guided** | ✓ | ✓ | getUserMedia facingMode; lens quality/focus judged by eye. 0.5x/5x lenses not individually selectable on iOS Safari — note in result |
| Front camera | **Guided** | ✓ | ✓ | Same |
| Vibration | **Auto** | ✗ | ✓ | `navigator.vibrate` — Android only; iOS falls back to manual |
| Sensors (gyro/accel) | **Auto** | ✓* | ✓ | Tilt-ball-into-target mini-game; *iOS 13+ needs a permission tap first |
| Charging port | **Semi** | ✗ | ✓ | Android Battery API detects charging flips live ("plug in now… detected ✓"); iOS manual |
| Wireless charging | **Semi** | ✗ | ✓ | Same Battery API trick on a pad; iOS manual |
| Cellular / Wi-Fi / Bluetooth | Manual | — | — | No usable web APIs; guided pass/fail cards with KB 51's instructions |
| Buttons (volume/power) | Manual | — | — | Not exposed to web |
| Proximity sensor | Manual | — | — | No API; KB 51's call test |
| Biometrics | Manual† | — | — | †A WebAuthn platform-credential prompt *can* trigger Face ID/Touch ID — clever but confusing UX (passkey dialog); recommend keeping KB 51's add-a-face test as a manual card, revisit later |
| Cracks front/back | Manual | — | — | Tech-observed cards; photo capture is a possible phase 2 (storage bucket, like receipts) |
| Battery health % (iPhone) | Manual | — | — | Not readable from web; one number field, tech copies from Settings |

Everything "manual" still lives **in the same page** as guided pass/fail/not-testable
cards with KB 51's own test instructions inline — so the output is one complete,
timestamped record regardless of automation level. Free extras captured silently:
user agent (model family), screen resolution, OS version, battery level (Android).

## 5. Data model sketch

```
diag_sessions
  id, token (unique, capability URL), ticket_no, store, run 'pre'|'post',
  device_label, status open|done|not_testable|expired,
  results jsonb   {test_key: {status: pass|fail|not_testable|skipped, detail, at}},
  device jsonb    (ua, screen, platform — auto-captured),
  created_by_name, started_at, finished_at, created_at
```

- RLS: closed to anon; **authenticated read** (any staff sees results); writes only
  via token-scoped definer RPCs `diag_get(token)` / `diag_submit(token, test_key,
  result)` / `diag_finish(token)` — the intake.html pattern exactly. Incremental
  submit means a half-finished run still documents what it covered.
- Session creation from the extension: a small **`diagnostics` edge function**
  (`?action=create|get|note`) gated by a `DIAG_SECRET` held in `bg.js` — the
  lcd-buyback pattern verbatim. (A pure-RPC variant is possible but the edge function
  keeps parity with every other extension→Supabase write and leaves room for
  server-side note composition later.)
- Token expiry ~24h; re-showing the QR for an existing open session re-uses it.

## 6. RepairQ ticket surface ("like follow-up")

- **Note** on finish/not-testable, BMP-safe: `"✔ Pre-repair diagnostics: 11 pass ·
  1 FAIL (lower mic) · 2 not testable (no SIM) — set by Kade"` — this is the
  KB 51 "tell the team in the ticket notes" rule, automated, and it's what saves the
  store in the dispute case.
- **Sidebar block** under Customer (followUp injection points): status line, per-test
  ✔/✕/– rows, a "Show QR again" button, and for `run='post'` later, a compare view
  (pre vs post per test — the QC story).

## 7. Deliberately deferred

- **Post-repair run** — same table (`run='post'`), triggered from `readyText.js`'s
  existing Ready-for-Pickup interception. Design the schema for it now (done above),
  build it after `pre` proves itself.
- **Tablet & computer checklists** (KB 51 has both) — tablets mostly work on the same
  page; computers are a different surface (keyboard tester etc.). Phones first.
- **Crack photos** — customer-device camera → private storage bucket (receipts
  pattern). Real value, real scope; phase 2.
- **Commission / scorecard tie-ins** — same deferral lcd-buyback made.

## 8. Decisions (owner, 2026-08-11)

- **Tech-driven, on the customer's device.** The tech scans the QR with the
  customer's phone and runs the tests; copy addresses the tech.
- **Every repair** triggers it — no item-type gating.
- **Manual-first card model.** Every test is one card: instruction → optional
  helper button ("Play sound", "Show grid", "Open camera") → **Pass / Fail /
  Not testable**. The page assists; the tech judges. Free automation (touch grid
  mapping, Android charge detection) rides inside its card as the helper, never
  as a replacement for the tech's verdict.
- **Not-testable fork confirmed**: when the QR modal pops in RepairQ, a
  "Device not testable" button records the reason straight to MRT — no QR needed.
- **iPhone battery health**: manual number field, confirmed (>87% = good per KB 51).

### Two technical answers behind those decisions

- **Volume-button auto-detect: not possible.** iOS Safari exposes nothing when a
  hardware volume key is pressed, and Android Chrome doesn't reliably either — the
  keys change system volume without firing page events. So the card is guided:
  "Press volume up — did the volume overlay appear?" → Pass / Fail. (Keyboards on
  tablets/laptops DO fire key events — a real auto keyboard tester is possible for
  the computer checklist later.)
- **Deep link to Settings → Battery Health: blocked by Apple.** The `App-Prefs:`
  URL scheme that once opened Settings screens is private and has been blocked
  from web pages for years; attempts fail silently or throw a Safari error. The
  card instead shows the exact path ("Settings → Battery → Battery Health &
  Charging"), a big numeric input, and the >87% pass line. Android: skipped per
  KB 51.

## Still open

1. **Modal stacking** — Follow-Up already pops right after the first save; sequence
   Diagnostics after it, or merge into one check-in stepper? (Recommend sequencing.)
2. **Hard-block or soft-skip** — "all repairs" is the policy; can a slammed tech
   still skip, leaving a visible "skipped" mark on the ticket (Follow-Up model), or
   is it a hard gate?

## 9. Effort shape (rough)

| Piece | Size |
|---|---|
| Schema + RPCs + edge function | small — intake/lcd patterns copied |
| `diag.html` test page (the real work: 8 interactive tests + guided cards, phone-first, permission choreography) | the bulk — comparable to intake.html × 2 |
| Extension: modal + QR + not-testable path + sessionStorage pending | small-medium — followUp/lcdCapture composition |
| Sidebar block + note + live poll | small — followUp clone |
| Rebuild extension zip, KB article update | trivial |

Nothing here blocks on design, but the test page is customer-facing — worth a design
pass like intake if the flow survives contact with the owner's answers above.
