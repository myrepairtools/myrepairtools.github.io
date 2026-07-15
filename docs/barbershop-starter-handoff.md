# Building Your Own Shop Platform — A Handoff

*From the team behind myRepairTools (CPR Oregon's internal platform) — for a barber
building his own scheduling tool. Give this whole document to Claude in your first
session; it's written to be read by both of you.*

We spent months building a phone-repair shop platform and learned most of these
lessons the expensive way — by retrofitting them later. This is the version of the
map we wish we'd had on day one. Follow it and your infrastructure won't need to be
rebuilt as you grow.

---

## Part 1 — The Platform Recipe (what to stand on)

Our whole platform runs on two services and costs almost nothing:

1. **GitHub Pages** hosts the site. Every tool is ONE self-contained `.html` file
   (its CSS and JS live inline in that file). No build system, no framework, no
   node_modules. Deploying is `git push`. This sounds primitive; it is actually the
   superpower — any page can be understood, fixed, and shipped in minutes, and an
   AI session can hold an entire tool in its head at once.
2. **Supabase** (free tier goes far) is the everything-backend:
   - **Postgres** — your real data lives in clean, well-named tables.
   - **Row Level Security (RLS)** — the database itself enforces who can see what.
     This is your security model; learn it first.
   - **Edge functions** — small server programs. **Every secret (PayPal keys, SMS
     keys) lives here and ONLY here.** The browser never holds a secret, ever.
   - **Storage** — photos/files (private buckets + RLS).
   - **pg_cron** — scheduled jobs (reminders, syncs, keep-warm pings).

The division of labor that keeps you sane: **pages read and write data through
Supabase with RLS; anything involving a secret or money goes through an edge
function.** That one rule prevents 90% of security mistakes.

## Part 2 — Do These From Day One (each of these cost us a retrofit)

1. **One page = one file, shared code earned its place.** Only genuinely cross-tool
   code goes in a shared `assets/` folder (navigation shell, date pickers, the
   Supabase client bundle). The bar for "shared" is high.
2. **A design-token brand from the first page.** Pick your fonts + 5 CSS variables
   (`--brand`, `--dark`, `--accent`, `--grey`, `--bg`) and use ONLY those. Every
   page will look native forever.
3. **Real SVG icons, never emoji, in navigation/chrome.** We shipped emoji
   everywhere and later swept ~40 icons to Lucide (lucide.dev, free) because it
   looked cheap. Start with Lucide inline SVGs.
4. **URL hash deep links on every tabbed page from day one.** Pattern: valid
   `location.hash` > localStorage > default at load; every tab switch does
   `history.replaceState(null,'','#'+tab)`; a `hashchange` listener routes through
   the same switch function. Bookmarkable, shareable, back-button-friendly.
5. **A network-first service worker from day one.** iPhones cache home-screen web
   apps brutally; without a service worker your phone runs week-old code. Ours:
   every request tries the network (navigations force revalidation), cache is
   offline-fallback only. ~40 lines. It's also where push notifications live later.
6. **Design mobile-as-app from the start**: `viewport-fit=cover`, safe-area insets
   (`env(safe-area-inset-top/bottom)`), 16px+ input fonts (or iOS zooms), 44px+
   touch targets, a web app manifest so it installs to the home screen, and a
   bottom tab bar under 860px. Your booking calendar will live on your phone.
7. **Vendor your dependencies.** We bundle supabase-js into our own `assets/`
   file — one same-origin request, pinned version, no CDN outages, no surprise
   upgrades. Same for anything else you'd pull from a CDN.
8. **Tenant data as DATA, not code.** We hard-coded store names and fought them
   for months. You have one shop today — still put shop name, hours, services,
   prices, chairs in TABLES from day one. When you add a second barber or a
   second location, it's a row, not a rewrite.
9. **Identity per person from day one, even solo.** A `staff` table + per-person
   PIN → Supabase session. Every write gets attributed. When you hire, you add a
   row instead of re-architecting auth. Add a `roles`/`permissions` catalog early;
   gate pages by permission key, not by name.
10. **View state persists**: active tab in localStorage AND the hash (see #4);
    date navigation uses a calendar-dropdown picker, not endless arrow-clicking.
11. **Money operations get idempotency + atomic claims — non-negotiable.** Learned
    on our QuickBooks/Square integrations:
    - Every payment/booking-charge request carries an **idempotency key** (PayPal:
      the `PayPal-Request-Id` header) so a retry can't charge twice.
    - Before the money call, do an **atomic claim** on the database row (a
      conditional UPDATE only one caller can win); roll it back on failure. This
      is what makes a double-tap or flaky Wi-Fi harmless.
    - Server computes the amount **from the database row** — never trust a number
      sent from the browser.
12. **Public pages use capability URLs.** Anything a CUSTOMER touches (your booking
    page!) is a public page with **no login, where a long random token IS the
    credential** — our contract-signing page works this way. Customers never get
    accounts or passwords; writes from public pages go through an edge function
    that validates the token.
    ⚠️ One honest caveat about our own shortcut: our internal pages commit the
    Supabase anon key and lean on RLS + light gates — acceptable for an internal
    staff tool, NOT for customer-facing surfaces. Your booking page must only ever
    reach data through token-validating edge functions or tightly-scoped RLS.
13. **One notification fanout function.** When you want reminders ("haircut
    tomorrow at 2"), build ONE function that writes an in-app feed row and fans
    out to channels (SMS/push) per preferences — every feature calls it. We built
    per-feature notifications first and consolidated later; skip that step.
14. **Keep a `CLAUDE.md` in the repo from the first commit.** It's the project's
    brain: what exists, the conventions, the data model. Every AI session reads it
    first and stays consistent with every session before it. Update it every time
    something ships. This single habit is why our platform stayed coherent.

## Part 3 — The Scheduling Tool Blueprint

The complaint with off-the-shelf tools — "no guard rails AND no flexibility" —
dissolves when the rules are YOUR rows in YOUR database. Guard rails become
defaults; flexibility becomes an owner override that logs itself.

**Tables** (names matter; your AI sessions will navigate by them):

- `services` — name, duration_min, buffer_after_min, price, deposit_required,
  deposit_amount, active, sort. (Fade = 45 min, beard add-on = 15, kid cut = 30…)
- `providers` — you today, chairs/hires tomorrow: name, color, active.
- `provider_hours` — weekly template per provider (weekday, open, close, breaks).
- `schedule_overrides` — a date + provider: closed, custom hours, or blocked span
  ("dentist 2–3pm"). Overrides beat the weekly template.
- `customers` — name, phone (E.164), email, notes ("#2 guard, sensitive neck"),
  no_show_count, flags.
- `appointments` — provider, service, customer, start/end (timestamptz), status
  (`booked → confirmed → done | no_show | cancelled`), source (`self | owner |
  walk_in`), deposit_status, paypal_order_id, price_charged, notes. One booking =
  one row; the calendar renders straight from this.
- `booking_tokens` — if you want private/regular-client booking links later.

**Guard rails (server-enforced, in the booking edge function — never only in the
browser):** no double-booking (overlap check against appointments + blocks + hours,
in the database, atomically — two customers grabbing the last slot must resolve to
one winner); per-service duration + buffer; minimum notice ("no online bookings
< 2 hours out"); daily caps; no-show policy (2+ no-shows → deposit required or
call-to-book). **Flexibility = the owner surface ignores the guard rails on
purpose**: your admin calendar can drag, overlap, squeeze a 15-minute lineup
between bookings, or book past close — logged, but allowed. Guard rails bind the
public page, not you.

**Surfaces (in build order):**
1. `book.html` — PUBLIC, no login, mobile-first: pick service → see real open
   slots (an edge function computes them from hours − overrides − appointments −
   buffers) → name + phone → (deposit if required) → confirmed. Slot math lives
   server-side so the page can't be gamed.
2. `calendar.html` — YOUR day/week view (installed to your home screen): tap to
   book/move/complete/no-show, walk-in button, drag to block time.
3. `customers.html` — history per person, notes, no-show record.
4. `settings.html` — services/prices/hours/rules as editable data (see Part 2 #8).
5. Later: SMS reminders via the notification fanout (Twilio is the simple choice;
   a "reply C to confirm" cron the night before kills most no-shows).

## Part 4 — PayPal (your Square equivalent)

You have the PayPal Zettle terminal (the phone-sized touchscreen one). Two honest
capability notes before patterns, because they shape the design:

- **PayPal REST APIs** (Orders v2, payment links, Invoicing, webhooks) are solid
  and are how your site takes money: **deposits at booking time** and pay-by-link.
  This is the exact pattern as our Square payment links, and it's the part that
  matters most — a deposit held at booking is the no-show cure.
- **The Zettle terminal** is a full POS on its own. Its public developer API
  (developer.zettle.com) has historically been strongest at **reading** — purchase
  history, products, inventory — while *pushing* a checkout TO the standalone
  terminal from your own web app (the way we push to Square Terminal) has NOT been
  a generally available public API. **Have your Claude session verify the current
  Zettle/PayPal docs at build time** — APIs evolve — but design as if the terminal
  is independent: it takes the in-person payment on its own, and your platform
  **reconciles** by pulling Zettle purchase history on a cron (we do exactly this
  with Square for tips) and matching amounts/times to appointments.

**Patterns to copy regardless (from our Square/QBO integrations):**
- One `paypal` edge function owns credentials (client id/secret as function
  secrets), does the OAuth token dance server-side, caches the access token, and
  exposes only named actions (`create_deposit_order`, `check_order`,
  `sync_purchases`) — the browser calls the function, never PayPal.
- **Verify webhooks** (PayPal signs them) before trusting "payment completed."
- **Idempotency on every charge** (`PayPal-Request-Id` = your appointment id) +
  the atomic-claim pattern from Part 2 #11.
- Log every attempt to a `payments` table (appointment id, order id, amount,
  status) — reconciliation is a query, not a shoebox.
- Refunds stay in PayPal's own dashboard until much later. (We still do this with
  Square. Complexity you don't build is complexity that can't break.)

## Part 5 — Getting Started (the checklist)

Accounts (one evening): GitHub (repo named `<something>.github.io` for free
hosting) → Supabase project (save the URL + anon key; the service key never leaves
edge-function secrets) → a domain if you want one ($12/yr, point it at Pages) →
developer.paypal.com app (sandbox first — fake money until the flow works).

Then paste this into your first Claude Code session:

> Read the file `docs/barbershop-starter-handoff.md` in this repo — it's the
> architecture handoff from a working platform and it constrains every choice.
> Set up the skeleton exactly as Part 2 prescribes: CLAUDE.md, brand tokens,
> vendored supabase-js, service worker, web-app manifest, Lucide icons, and an
> empty index.html shell. Then build Part 3's schema in Supabase with RLS, then
> `calendar.html` (my owner view) with sample data. One verified step at a time;
> screenshot pages at iPhone size (390px) before calling anything done.

Build order that worked for us: skeleton → schema → YOUR calendar (usable in week
one, even booking everything yourself) → public `book.html` → deposits (sandbox →
live) → Zettle reconciliation cron → SMS reminders. Ship each piece when it works;
never two half-built features.

## Part 6 — Starter CLAUDE.md for his repo

```markdown
# CLAUDE.md — <Shop Name> platform
Static site on GitHub Pages + Supabase (Postgres/RLS, edge functions, storage,
pg_cron). One self-contained .html per tool, inline CSS/JS; shared code only in
assets/ (high bar). Deploy = git push to main.
Brand: fonts <X>/<Y>; tokens --brand:# --dark:# --accent:# --grey:# --bg:#.
Rules: secrets only in edge functions; money ops = idempotency key + atomic claim
+ server-computed amounts; customer-facing pages use capability tokens and never
raw table access; tabbed pages get hash deep links + localStorage; mobile-first
(16px inputs, 44px targets, safe areas); icons = inline Lucide SVGs; update this
file every time something ships.
Tables: <maintain the list here as they're created>
```

---

*Last note from us: the single biggest factor in how fast this goes is keeping
every piece small enough to verify. One page, one table, one function at a time —
ship it, use it Monday morning, fix what annoys you, repeat. That loop built
everything we have. Good luck — from one shop to another.* 🛠️✂️
