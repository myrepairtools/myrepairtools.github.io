# Session Handoff — myRepairTools

For any new Claude Code session on this repo. **Read CLAUDE.md first** — it has the
deep architecture (page model, both backends, every tool's data layer). This file
covers what CLAUDE.md doesn't: how we work, current state, and how to run multiple
sessions in parallel without stepping on each other.

## How we work (established with the owner)

- **Branch + merge flow:** each session develops on its own `claude/*` branch and
  merges to `main` (`--no-ff`) after verification. Merging to main after each
  verified feature is the established pattern — deployment IS `git push` to main
  (GitHub Pages). `git fetch origin main && git merge origin/main` into your branch
  BEFORE starting each work item; other sessions are landing on main too.
- **Verify before merge, every time:** extract inline `<script>` blocks →
  `node --check`; edge functions → `npx esbuild --bundle --format=esm
  --platform=neutral --external:'https://*' --external:'npm:*' <fn>/index.ts`;
  UI changes → headless Chromium (playwright-core is in the session scratchpad
  pattern; Chromium at `/opt/pw-browsers/chromium`) at iPhone viewport 390×760.
  For gated pages, build a harness copy: strip `pin-gate.js`/`nav.js` script tags
  and replace the supabase import with a stub client.
- **Owner communication style:** phone screenshots with a one-line complaint. Fix
  the root cause, verify in a browser, ship, explain what was actually wrong.
  Title Case for UI titles. The owner tests on an iPhone via Added-to-Home-Screen
  apps — remember the service worker means installed apps pick up deploys on next
  open (no more delete/re-add).
- **Git identity:** `user.email noreply@anthropic.com`, `user.name Claude`.
  Never put model IDs in commits/code. Push with `git push -u origin <branch>`,
  retry on network errors with backoff.

## Multi-session lane rules (IMPORTANT)

Sessions divide work to avoid merge conflicts:

- **Feature session** (the original session): new tools, schema, edge functions,
  notifications project, anything touching `assets/nav.js`, `assets/pin-gate.js`,
  `sw.js`, `settings.html`, `CLAUDE.md` architecture paragraphs.
- **Page-improvements session(s):** visual/UX polish INSIDE individual tool pages
  (one self-contained .html each — naturally conflict-free). Avoid editing shared
  `assets/*` or CLAUDE.md beyond appending a line; if a page fix genuinely needs a
  shared-asset change, note it in the commit and keep it minimal.
- Everyone: small focused commits, merge to main promptly (long-lived branches
  rot fast here), pull main before each new item.

## Ops cheatsheet

- Supabase project `xuvsehrevxackuhmbmry`; management API via `$SUPABASE_ACCESS_TOKEN`:
  - SQL: `jq -Rs '{query: .}' file.sql | curl -X POST
    https://api.supabase.com/v1/projects/xuvsehrevxackuhmbmry/database/query
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -d @-`
  - Deploy a function: `POST .../functions/deploy?slug=<name>` multipart with
    `metadata={"entrypoint_path":"index.ts","name":"<name>","verify_jwt":false}`
    + `file=@supabase/functions/<name>/index.ts`. **Warm instances keep boot-time
    env — redeploy after changing any secret.**
  - Secrets: `POST .../secrets` (names are listable, values are not).
- Schema changes: apply live via the SQL endpoint AND commit the same SQL under
  `docs/sql/` (house convention).
- Crons: `select jobname, schedule from cron.job` — includes
  `edge-warm-interactive` (*/4 min, pings cpr-auth + qbo `{action:'ping'}`; add
  new latency-sensitive functions there).
- The committed anon key + gates are the deliberate interim posture; secrets
  stay server-side, always.

## Current state (as of this handoff)

Recently shipped, all live on main: site-wide hash deep links + pinned-chrome view
transitions; vendored supabase-js + hover prefetch + edge warming; mobile app shell
(bottom tab bar Home/Tasks/My Time/Commission/More, Lucide icon system, safe-area
handling in nav.js); Alerts feed + bell/app-icon badges; network-first service
worker; My Profile (onboarding checklist, contact info, notification preference
matrix, change-PIN, web push enable); alerts edge function fanout (push via VAPID +
SMS via messaging `system_send`); senders: goal hits, day-of birthdays/anniversaries,
Schedule Admin Notify, KB required-reading publish. Expenses app (receipt →
AI-extract → QBO Purchase + attach). Cash Journal → QBO journal entries.

**Waiting on the owner:** confirm the 1-855 is on RingCentral and toll-free-verified
for SMS, then set the `ALERTS_FROM_NUMBER` secret and redeploy `messaging`; first
QBO journal post (June Eugene, $7,206); Clackamas June starting cash; expense-app
improvement list "when back at books"; real-device push test (Enable Push in My
Profile on the installed app).

**Deferred / backlog (fair game for either session as assigned):** end-of-shift
task nudge sender (needs server-side schedule resolution); email delivery channel;
per-user bottom-tab customization editor (dashboard_layouts pattern); store/month
in deep links (e.g. cash-journal.html#eugene/2026); LCD scorecard/commission
tie-in; site-side SMS inbox panel; page-content emoji → Lucide sweep (page-by-page,
only when redesigning that page — good page-improvements fodder).
