# Google Business Profile ("Google Traffic") — Design Handoff

**Owner:** Britt (CPR Oregon)  ·  **Status:** proposal for design  ·  **Date:** 2026-07-10
**Working name:** Google Traffic  ·  **New page:** `google-traffic.html`

We are wiring the operations site into the Google Business Profile (GBP) APIs —
API access is already approved by Google — to (1) *measure* why our Eugene store has
the best Google traffic of any CPR store in the country, (2) *replicate* it at Salem
Northeast and Clackamas, and (3) *automate* the local-search flywheel: review velocity,
review responses, photo freshness, and profile accuracy.

This doc gives design (and the next engineer) the business context, the three build
phases, screen-by-screen requirements, wireframes, the data model, permissions, and
the open questions to resolve. **Sections 9 and 16 are where design input matters most.**

---

## 1. The one-paragraph ask

Design a **Google Traffic** tool (one new page + one dashboard widget + one Settings
panel) that lets the owner and store managers compare all stores' Google performance
month by month, work a **review inbox** (every new Google review gets an AI-drafted,
human-approved reply), keep photos fresh via a phone-first **photo queue**, and see a
weekly **scorecard** in the team Communications feed. Everything must look native to
the existing site (see §13) and follow its three-phase rollout (§5) — Phase 1 is
read-only and shippable alone.

---

## 2. Why (business context)

- We own 3 CPR Cell Phone Repair franchise stores. Corporate says **Eugene has the
  best Google traffic in the country**; we currently have no day-to-day visibility
  into *why*, or how Salem NE / Clackamas compare.
- Local ranking is roughly **half proximity** (not controllable). The controllable
  half is dominated by: **review signals** (velocity, response rate, recency —
  ~16–20% of local-pack ranking), **profile signals** (primary category, services,
  completeness), and **engagement** (photos: profiles with 100+ photos get several
  times more calls; Google Posts were shown in controlled studies to have *no*
  ranking effect — deliberately deprioritized).
- As a franchise, the **website** GBP links to is corporate's landing page — not in
  scope. The **GBP listings themselves are ours** to manage; that's where we play.
- Expectation-setting: Eugene dominates a mid-size market; Clackamas fights the whole
  Portland metro. Goal is closing controllable gaps, not "every store #1 nationally."

---

## 3. Product context (read once)

- **What this is:** internal web tools for a phone-repair business, served as a
  static site (GitHub Pages). Backend is Supabase (Postgres + edge functions).
  No framework, no build step — each tool is one hand-authored HTML file with
  inline CSS/JS.
- **Stores:** Eugene, Salem Northeast, Clackamas. The store list is data-driven via
  `assets/locations.js` (canonical names `CPR Eugene`, `CPR Salem Northeast`,
  `CPR Clackamas OR`) and can grow — **never hard-code 3**.
- **Roles:** `owner` → `admin` (store managers) → `employee` (techs), enforced by the
  nav role gate + Supabase RLS. Pages declare a `minRole`.
- **AI-first directive (site-wide):** all data lives in clean, well-named Supabase
  tables so the site's AI assistant (`cpr-assistant` edge function) can query it
  server-side. Writes that leave our system are **named, permission-checked,
  confirm-gated** actions: read → propose → human confirms → write → audit-log.
  Nothing posts to Google without a human click.

---

## 4. What already exists to build on

| Existing piece | How this project reuses it |
|---|---|
| `square-tips` edge function pattern | Template for `gbp-sync`: API secret held server-side, pg_cron nightly pull, idempotent upserts into clean tables |
| Looker → `ingest` edge function webhooks | RepairQ reports already POST rows per (date, store, employee). Phase 2 adds one new feed (closed tickets + customer contact) on the same rails |
| Communications feed (`communications` table, `assets/comms.js`) | Weekly GBP scorecard auto-posts here; review alerts can too |
| Checklist engine (`task_templates` → `task_instances`) | "Post 2 store photos" as a recurring rotating task |
| Dashboard widget registry (`REG` in `index.html`) | New "Google Reviews" widget is one more module |
| `assets/pickers.js` | Month navigator on the new page (site convention) |
| Store Leaderboard (`leaderboard-summary.js`) | Phase 2 adds "reviews that mention you" as a tech stat |
| `notify` edge function (Resend/Gmail) | Email channel for review requests; manager alerts |

---

## 5. The build, in three phases

| Phase | Name | One-liner | Risk |
|---|---|---|---|
| **1** | **Measure** | Nightly pull of metrics/keywords/reviews into Supabase + the Google Traffic comparison page + dashboard widget | Zero — read-only from Google |
| **2** | **Review engine** | Automated review *requests* after closed tickets + an AI-drafted, human-approved review *reply* inbox | Writes replies to Google (confirm-gated) |
| **3** | **Freshness & sync** | Photo queue (phone-first), hours/holiday push, services sync from our catalog, weekly scorecard, Q&A monitor | Writes profile data (confirm-gated) |

Each phase ships independently. Phase 1 is the diagnostic that answers "what is
Eugene doing?" — expect the answer to shape Phase 2/3 emphasis.

---

## 6. Phase 1 — Measure (build first)

### 6.1 Data pulled nightly per store (by `gbp-sync`)

From the **Business Profile Performance API**:

- Impressions, split 4 ways: `BUSINESS_IMPRESSIONS_DESKTOP_MAPS`,
  `BUSINESS_IMPRESSIONS_DESKTOP_SEARCH`, `BUSINESS_IMPRESSIONS_MOBILE_MAPS`,
  `BUSINESS_IMPRESSIONS_MOBILE_SEARCH` (Google counts unique viewers/day)
- Actions: `CALL_CLICKS` (taps on Call — not answered calls), `WEBSITE_CLICKS`,
  `BUSINESS_DIRECTION_REQUESTS`
- **Monthly search keywords** per store: the actual queries we appeared for +
  impression counts (Google returns "<15" as a threshold value for rare terms —
  UI must render that state, not `0`)

From the **reviews API**: full review list (historical backfill, then deltas) —
stars, text, reviewer display name, created/updated time, our reply + reply time.
Reviews can be edited or deleted by customers → upsert by Google's review id,
soft-delete when one disappears.

Profile snapshot (Business Information API): categories, services, hours,
attributes — stored per sync for **drift detection** ("Salem NE is missing 4
services Eugene lists").

**Important data realities (affect design):**

- Performance metrics **lag ~3–5 days**. Every surface shows a "data through
  {date}" stamp and must never render the trailing lag days as zeros.
- Keyword data is **monthly**, not daily. The Keywords tab is month-granular.
- History: Google serves ~18 months back. We backfill once at connect, then retain
  forever in our tables (our charts eventually exceed what Google shows).
- "Discovery vs branded" is **not a Google field** — we derive it by classifying
  keywords (contains "cpr" / store name = branded; else discovery). Label it as
  derived; expect a small "unclassified" bucket.
- GBP chat/messaging was discontinued by Google (2024) — no messaging metrics or
  surfaces anywhere in this project.

### 6.2 New page: `google-traffic.html`

- Nav: **Privileged** section, `minRole: admin` (managers + owner). Employees never
  see this page (see §12 for what they *do* see).
- Header: `📈 Google Traffic` + **month picker** (pickers.js month popover, future
  months blocked) + store filter chips (**All** / per-store, from `CPRLocations`).
- Four tabs (active tab, month, and store filter persist in `localStorage`):

**Compare (default)** — one card per store, same stat block each, current month
with Δ vs prior month: impressions (+ discovery share), calls, directions, website
clicks, review velocity (new this month), avg rating (lifetime), reply rate & median
reply time, photo freshness (days since last upload). Best store per row gets a
subtle highlight. Below the cards: an auto-written **gap analysis** strip ("vs
Eugene: Clackamas −22pt discovery share, −7 reviews/mo, photos 54 days staler").

**Trends** — 12-month lines, all stores overlaid, one metric at a time (metric
switcher: impressions / calls / directions / clicks / review velocity / rating).
Charts are hand-rolled SVG (site has no chart library; keep marks simple: line +
dots + hover tooltip). Needs a **canonical store color** decision — see §16 Q1.

**Keywords** — per selected month: side-by-side store columns of top keywords with
impression counts, branded/discovery badge per keyword, and a **diff view** toggle:
"keywords Eugene appears for that {store} doesn't." This tab is the "what is Eugene
doing" answer machine.

**Reviews** — unified review feed, newest first: stars, text (clamped, expandable),
reviewer name, store chip, age, reply status (`✓ replied` / `⚠ unanswered Nd`).
Filters: store, unanswered-only, star range. In Phase 1 this tab is **read-only**
(reply actions arrive in Phase 2 — design the tab with the reply drawer in mind so
Phase 2 doesn't re-layout).

First-run / error states: "not connected" hero with an owner-only **Connect
Google** CTA; per-store sync-error banner (last sync stamp lives in the footer of
every tab); empty month state.

### 6.3 Dashboard widget: "Google Reviews"

One `REG` module on `index.html`. Content: per-store rating strip, **unanswered
count badge** (the widget's whole job is making unanswered reviews impossible to
ignore — include oldest-unanswered age), newest review snippet, link into the page's
Reviews tab. Must render sanely at the board's 100/60/40 widths. Visibility: see §16 Q2.

---

## 7. Phase 2 — Review engine

### 7.1 Review requests (get more reviews, steadily)

- **Trigger:** new Looker feed on the existing ingest rails —
  `feed=tickets_closed`: Location, Ticket #, Accounted on Date, Customer Name,
  Customer Phone, Customer Email, ticket type/status. Idempotent per ticket.
- **Pipeline:** closed ticket → eligibility check (dedupe: never ask the same
  customer twice in 90 days; skip warranty-return tickets; quiet hours 8am–8pm
  local; daily per-store cap) → send SMS (Twilio; "Reply STOP" opt-out honored)
  with email fallback (existing notify path) → log to `gbp_review_requests`.
- **The link:** each store's direct review URL
  (`search.google.com/local/writereview?placeid=…`) behind a short per-store link.
  **Print asset:** a counter QR card per store (see §16 Q6).
- **Manual fallback queue:** a "Today's completed tickets" list on the Reviews tab
  with per-row **Send ask** buttons — used if the feed lags and for walk-in asks.
- **Compliance guardrails (design must not violate):** *no review gating* — we may
  not pre-filter by sentiment ("how was your experience?" → only happy people get
  the link violates Google policy + FTC rules). Every eligible customer gets the
  same ask. No incentives, ever. Do not design a sentiment pre-screen step.

### 7.2 Review reply inbox (answer 100%, fast)

- New review lands in `gbp_reviews` → `gbp-sync` drafts a reply via the Anthropic
  API (same server-side pattern as `cpr-assistant`; tone kit from §16 Q4; 1–2 star
  drafts always include the take-it-offline script + store phone) → row appears in
  the queue.
- **Reply drawer** on the Reviews tab (see wireframe §9.2): the review, the
  editable AI draft, **Regenerate**, **Approve & post**, **Skip**. Approve = post
  to Google via API + audit row (who/when/final text). SLA: 24h target — unanswered
  timers go amber at 12h, red at 24h. Notification nudge to the store's manager at
  12h (existing notify/Communications path).
- **No auto-posting.** A human approves every reply. Non-negotiable (site-wide
  write-gating directive + brand safety).

### 7.3 Tech attribution

Reviews mentioning a tech's first name (roster match, human-confirmable flag)
count as "⭐ reviews mentioning you" — surfaced on the Store Leaderboard widget and
in the scorecard. Motivation loop: techs *ask* for the review at pickup.

---

## 8. Phase 3 — Freshness & sync

- **Photo queue (phone-first):** tech picks store → snaps/uploads → caption +
  category (storefront / interior / team / at-work) → manager approves → published
  to GBP via API. Weekly rotating checklist task ("post 2 store photos") drives
  cadence; the Compare tab's "photo freshness" stat keeps score. Target ≥2/store/week.
- **Hours & holiday push:** our schedule system already models holidays. Before
  each one: proposed special-hours diff per store → owner/manager confirms → pushed
  to GBP. Wrong Google hours are a trust-killer; this makes them impossible.
- **Services sync:** curated mapping from our price/service catalog to GBP service
  items, one shared list applied to all stores (parity with whatever Eugene's
  profile does well). Confirm-gated diff push, same as hours.
- **Weekly scorecard → Communications:** auto-post (existing `source_key`
  idempotency): per-store review velocity, reply rate/time, unanswered count,
  photo freshness, impressions Δ, keyword wins. Managers see it where they already
  read team news. Day/time: §16 Q8.
- **Q&A monitor:** new public questions on any profile → Communications alert to
  that store's manager with a link to answer on Google. Monitor-only (no answer
  composer in v1).
- **Google Posts:** *deliberately minimal* — optional monthly recurring offer post
  (API supports recurring posts). No calendar, no composer UI. Studies show no
  ranking effect; we spend the effort on reviews/photos instead.

---

## 9. Screens & wireframes *(design input matters most here)*

### 9.1 `google-traffic.html` — Compare tab

```
┌ 📈 Google Traffic ────────────────────── ‹ [ June 2026 ▾ ] › ┐
│ [Compare] [Trends] [Keywords] [Reviews ●3]   ○All ●Eug ○Sal ○Cla │
├──────────────────────────────────────────────────────────────────┤
│ ┌─ Eugene ──────────┐ ┌─ Salem Northeast ─┐ ┌─ Clackamas ──────┐ │
│ │ 👁 12,480  ▲8%    │ │ 👁 4,120   ▲2%    │ │ 👁 3,890   ▼4%   │ │
│ │ discovery 71% ★   │ │ discovery 55%     │ │ discovery 49%    │ │
│ │ 📞 214   🧭 187   │ │ 📞 96    🧭 71    │ │ 📞 88    🧭 64   │ │
│ │ 🌐 342            │ │ 🌐 118            │ │ 🌐 104           │ │
│ │ ⭐ 4.9 · 612 total │ │ ⭐ 4.8 · 241      │ │ ⭐ 4.7 · 198     │ │
│ │ +9 new ★  reply 100%│ │ +3 new · reply 82%⚠│ │ +2 new · reply 64%⚠│
│ │ 📷 last photo 4d ★ │ │ 📷 31d ⚠          │ │ 📷 58d ⚠         │ │
│ └───────────────────┘ └───────────────────┘ └──────────────────┘ │
│ Gap vs Eugene — Salem NE: −16pt discovery, −6 reviews/mo.        │
│ Clackamas: −22pt discovery, −7 reviews/mo, photos 54d staler.    │
│                                    data through Jul 5 · synced 3:04am │
└──────────────────────────────────────────────────────────────────┘
```
`★` = best-of-row highlight (subtle, not a leaderboard shout). Cards stack
vertically on mobile.

### 9.2 Reviews tab + reply drawer (Phase 2 adds the drawer)

```
│ filter: [All stores ▾] [★ any ▾] [● Unanswered 12]  [Send asks…] │
│ ┌ feed ─────────────────────────┐┌ reply drawer ────────────────┐ │
│ │ ★★★★★ "Fixed my S24 screen   ││ ★★  Salem NE · Rob G · 2d ⚠  │ │
│ │ in an hour!" Dana W · Eug · 3h ││ "Waited 45 min past my       │ │
│ │ ✓ replied 2h                  ││  appointment time…"           │ │
│ │ ─────────────────────────────  ││ AI draft            [↻ Regen] │ │
│ │ ★★ "Waited 45 min…" Rob G    ││ ┌───────────────────────────┐ │ │
│ │ Salem NE · 2d · ⚠ 26h overdue ││ │ Hi Rob — you're right, …  │ │ │
│ │ ─────────────────────────────  ││ │ (editable textarea)       │ │ │
│ │ ★★★★ "Great price on…"       ││ └───────────────────────────┘ │ │
│ │ Clackamas · 4d · ✓ replied    ││ [✓ Approve & post]  [Skip]    │ │
│ └───────────────────────────────┘└───────────────────────────────┘ │
```
Drawer is a side pane on desktop; §16 Q3 decides mobile treatment. Posting shows a
confirm ("This reply is public on Google") on first use per session.

### 9.3 Dashboard widget (100-width shown; must degrade to 60/40)

```
┌ 🔍 Google Reviews ────────────────────────────┐
│ Eugene ⭐4.9 · Salem NE ⭐4.8 · Clackamas ⭐4.7 │
│ ● 3 unanswered — oldest 26h ⚠                 │
│ "Fixed my S24 screen in an hour!" ★★★★★ · Eug │
│                        [Open Google Traffic →] │
└────────────────────────────────────────────────┘
```

### 9.4 Photo queue (Phase 3, phone-first ~390px)

```
┌ 📷 Store photos — [Eugene ▾] ┐
│ [＋ Snap / upload photo]      │
│ Pending approval (2)          │
│ ┌────┐ ┌────┐                 │
│ │ 📱 │ │ 🏪 │  caption…      │
│ └────┘ └────┘  [✓ approve][✕] │
│ Published this week: 3 ✓ goal 2│
└───────────────────────────────┘
```
Approve/reject visible to managers only; techs see their upload status.

### 9.5 Settings → Page settings → Google (managers/owner)

Rail-list + detail-pane pattern (same as Settings → Contracts). Panels:
**Connection** (Google account, token health, per-store location-ID mapping —
auto-matched by name like square-tips with manual override, last sync, error log) ·
**Review requests** (channel order, delay after close, quiet hours, 90-day dedupe,
daily cap, message copy w/ placeholders, per-store short link + QR download) ·
**Reply SLA & tone** (SLA hours, tone kit text, banned phrases, offline-script) ·
**Scorecard** (weekday/time, on/off).

---

## 10. Data model (new Supabase tables, all `gbp_*`)

| Table | Columns (key ones) | Notes / RLS |
|---|---|---|
| `gbp_locations` | store (PK, = CPRLocations name), google_location_id, place_id, connected_at, last_sync_at, last_error | Read: staff. Write: service role |
| `gbp_metrics_daily` | store, date, metric, value · unique(store,date,metric) | metric = Google enum string. Read: staff |
| `gbp_keywords_monthly` | store, month, keyword, impressions, is_threshold, is_branded | Read: staff |
| `gbp_reviews` | id (Google review name, PK), store, stars int, comment, reviewer_name, created_at, updated_at, reply_text, replied_at, deleted_at, raw jsonb | Read: staff. Reply fields written by edge fn only |
| `gbp_review_queue` | review_id FK, ai_draft, status draft→approved→posted/skipped, approved_by, posted_at, error | Phase 2. Approve: `is_admin()` |
| `gbp_review_requests` | ticket_ref, store, customer_name, contact (see §16 Q7), channel, sent_at, status, opt_out | Phase 2. Read: managers |
| `gbp_media` | id, store, category, caption, uploaded_by, state pending→approved→published/rejected, google_media_id | Phase 3 |
| `gbp_profile_snapshots` | store, taken_at, categories/services/hours/attributes jsonb | Drift detection. Read: managers |
| `gbp_audit` | actor, action, store, payload jsonb, at | Every outbound write to Google |

All tables are assistant-queryable by design (server-side, via `cpr-assistant` tools).

---

## 11. Backend architecture

- **One edge function `gbp-sync`** (pattern: `square-tips`). Actions:
  `?action=pull` (nightly metrics+reviews delta), `backfill` (18-mo, on connect),
  `keywords` (monthly), `draft` (AI reply draft), `reply` (post approved reply),
  `send-ask` (review request), `publish-media`, `push-hours`, `status`.
  Cron auth via a `GBP_SYNC_SECRET`; user-facing actions auth via Supabase JWT +
  role check.
- **Secrets (function env, never in browser):** `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET`,
  `GBP_REFRESH_TOKEN`, `GBP_SYNC_SECRET` (+ existing `ANTHROPIC_API_KEY`,
  Twilio creds for Phase 2).
- **Google APIs used:** Business Profile Performance API
  (`fetchMultiDailyMetricsTimeSeries`, monthly search-keywords); My Business v4
  (reviews list/reply, media upload, localPosts recurring); Business Information
  API (locations, hours, services, categories); Account Management API (location
  discovery at connect). OAuth scope `https://www.googleapis.com/auth/business.manage`.
- **OAuth:** one-time owner consent (offline access) mints the refresh token →
  stored as a function secret. Settings shows "Connected as {email}" + Reconnect.
  No end-user OAuth ever.
- **Cron:** `gbp-sync-nightly` (pg_cron, ~11:05 UTC, 7-day metric re-pull window to
  absorb Google's lag) + monthly keywords job + weekly scorecard job (Phase 3).
- **Quotas:** GBP APIs default ~300 requests/min after approval — 3 locations
  nightly is trivial. Retry w/ backoff; failures surface in Settings + page banner,
  never silently.

---

## 12. Permissions & visibility

| Surface | Owner | Manager (admin) | Tech (employee) |
|---|---|---|---|
| Google Traffic page (all tabs) | ✓ | ✓ (all stores — cross-store comparison is the point; confirm §16 Q2) | ✗ |
| Google Reviews dashboard widget | ✓ | ✓ | proposal: ✓ read-only snapshot (motivation) — §16 Q2 |
| Approve & post replies | ✓ | ✓ | ✗ |
| Send review asks (manual queue) | ✓ | ✓ | ✗ |
| Photo upload | ✓ | ✓ | ✓ (approval required) |
| Photo approve / hours push / services sync | ✓ | ✓ | ✗ |
| Settings → Google | ✓ | ✓ (not Connection panel — owner only) | ✗ |
| "Reviews mentioning you" leaderboard stat | ✓ | ✓ | ✓ (own store) |

---

## 13. Design constraints (must-follow, site-wide)

- **Brand:** fonts `Nunito`/`Nunito Sans`; CSS props `--red:#DC282E`
  `--dark:#2D2D3B` `--blue:#4FB0E3` `--grey:#B9BDCB` `--light-grey:#F3F2F2`.
  The page must sit next to `commission-dashboard.html` and look like family.
- **Page model:** one self-contained HTML file, inline CSS/JS, no framework, no
  build step, no chart library — charts are hand-rolled SVG.
- **Nav:** entry in `nav.js` `PRIVILEGED` (minRole admin) + a tile on `index.html`.
- **Date nav:** `assets/pickers.js` month picker; future months blocked.
- **State persistence:** active tab, store filter, selected month → `localStorage`.
- **Stores:** always via `CPRLocations` (names, order, display).
- **Mobile:** managers live on phones — every tab usable at 390px; photo queue is
  designed phone-first.
- **Gates:** site-gate + nav role auth; all gates skip inside iframes (tools embed
  in RepairQ) — nothing in this tool may depend on being top-window.
- **Write safety:** every outbound write to Google (reply, ask, photo, hours) =
  explicit human confirm + `gbp_audit` row. No background writes, no auto-posts.

---

## 14. Non-functional requirements

- **Idempotency everywhere:** metric upserts keyed (store,date,metric); reviews by
  Google id; asks unique per ticket; scorecard posts by `source_key`.
- **Failure visibility:** last-sync stamp on the page; error banner per store;
  errors also in Settings → Connection. A stale sync must be obvious within one day.
- **Customer PII minimization:** review-request contact info is used to send, then
  masked (keep last-4 / hash for 90-day dedupe); no full contact retained long-term
  (final call: §16 Q7).
- **Policy compliance is a product requirement:** no review gating, no incentives,
  no sentiment pre-screen, SMS opt-out honored, quiet hours enforced. These rules
  live in code, not in training.

---

## 15. Explicitly out of scope

- Corporate website / landing pages (franchise-controlled) · Google Posts beyond
  one optional recurring offer · Q&A auto-answering · Reserve with Google /
  bookings · Google Ads / Local Services Ads · review filtering or gating of any
  kind (policy) · multi-account agency features · GBP messaging (discontinued by
  Google).

---

## 16. Open questions for design (and Britt)

1. **Store series colors** — no canonical per-store colors exist today. Trends
   charts, filter chips, and store chips need an accessible 3-color set that works
   with the brand palette (and scales to store #4). Proposal to react to:
   Eugene `--blue`, Salem NE `--red`, Clackamas `--dark`.
2. **Tech visibility** — page is manager+; should the dashboard widget show a
   read-only per-store snapshot to everyone (motivation), or stay manager-only?
3. **Reply drawer on mobile** — side drawer, full-screen sheet, or inline expand?
4. **AI tone kit** — need from Britt: 2–3 real replies he loves (a 5★, a 3★, a 1★),
   banned words/phrases, and the standard take-it-offline script per store.
5. **Gap analysis presentation** — auto-written sentence strip (wireframed) vs a
   badge matrix ("behind on: velocity, photos")? 
6. **QR counter cards** — in scope for design? If yes: print spec (size, per-store
   QR, brand layout) delivered as a printable from Settings.
7. **Customer contact retention** — mask after send (proposed) vs keep plaintext
   like other tools (claim ledger stores names openly). Britt decides.
8. **Scorecard timing** — proposal: Monday 8:30am, one post covering all stores.
   Confirm day/format (per-store posts vs one combined).
9. **Naming** — "Google Traffic" as the tool name, or "Google" / "Reviews & Traffic"?

---

## 17. Acceptance criteria

**Phase 1 done when:** nightly sync green 7 consecutive days · Compare/Trends
render 12 months for all stores · Keywords tab shows per-store terms + diff view ·
Reviews tab lists every historical review with reply status · widget live on the
dashboard · the "why Eugene wins" question is answerable from the page alone.

**Phase 2 done when:** a closed ticket produces an ask (or appears in the manual
queue) same day · every new review has an AI draft within minutes · approve → reply
visible on Google · reply rate + median reply time tracked on Compare · zero replies
posted without human approval · opt-outs and 90-day dedupe enforced.

**Phase 3 done when:** a tech can publish a photo from their phone in <1 min
(manager-approved) · next holiday's special hours pushed via confirm flow for all
stores · scorecard posts 4 consecutive Mondays · services parity report shows no
unintended drift between stores.

---

## 18. Appendix — pointers for the engineer

- Deploy model: SQL migrations land in `docs/sql/`, edge functions in
  `supabase/functions/gbp-sync/`; both applied via the Supabase dashboard (no CLI
  on this machine). Cron jobs are SQL (`pg_cron`), same as `square-tips-daily`.
- Codebase precedents: nightly external pull → `supabase/functions/square-tips` ·
  webhook ingest → `supabase/functions/ingest` · confirm-gated writes + audit →
  contracts flow · rail-list + detail-pane settings → Settings → Contracts ·
  master registry widget → `REG` in `index.html`.
- Review link format: `https://search.google.com/local/writereview?placeid={PLACE_ID}`.
- Metric names in `gbp_metrics_daily.metric` are Google's enum strings verbatim —
  don't invent friendlier keys; the UI maps them to labels.
