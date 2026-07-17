# RepairQ "Reverse API" — Build Handoff (for another CPR franchisee)

**Who this is for:** an AI coding assistant (Claude Code or similar) helping a
CPR franchise owner stand up their own live data pull from RepairQ — the same
capability Brett K. pioneered and CPR Oregon productionized. This document is
the recipe: what it is, why it works, the exact login/replay mechanics, the
gotchas that cost us days, and a safe build order.

**Read this first, then build incrementally.** Every step below has a "prove it
works before moving on" checkpoint. Do not skip them — RepairQ's internal API is
undocumented and fails silently, so blind coding wastes hours.

---

## 1. What "reverse API" means here

RepairQ has **no official public API** for the data a shop actually wants
(ticket queues, inventory, sales, device consumption). What it *does* have is:

- a normal web app at `https://<subdomain>.repairq.io` that your staff log into, and
- Looker-backed analytics dashboards embedded inside that web app.

The "reverse API" is: **authenticate as a real RepairQ user the same way the
browser does, cache the session, then call RepairQ's own internal endpoints
(and replay its own Looker queries) to get JSON back on demand.** You are not
breaking in — you're using your own legitimate login, just from a server instead
of a person clicking. It's the same trust level as a staff member with a browser.

There are **two independent layers**, and a mature setup uses both:

| Layer | Where it runs | Auth | Best for |
|---|---|---|---|
| **A. Server session-replay** | An edge function (Supabase/Deno, or any server) | Your RepairQ username/password → cached `PHPSESSID` cookie | Scheduled pulls (crons), admin tools, anything headless. Data lands in your database. |
| **B. Extension same-origin** | A Chrome content script running *inside* the RepairQ tab | The logged-in staff member's own browser session + the page's CSRF token | Live in-page actions: reading the ticket list, writing notes, forcing a status, reading the queue. No credentials stored anywhere. |

Layer B is easier and safer (no stored credentials — it rides the human's
session) but only works while a tech has RepairQ open. Layer A is the real
"API" — it runs without anyone watching. **Build Layer B first** (fast win,
teaches you RepairQ's endpoints), then Layer A.

---

## 2. The core insight (why it works at all)

RepairQ is a **Yii/PHP** app. Every authenticated request needs two things:

1. A valid **`PHPSESSID` cookie** (proves you're logged in).
2. For any **write** (POST), a **`YII_CSRF_TOKEN`** that matches the session.
   Every RepairQ page embeds this token in a hidden `<input name="YII_CSRF_TOKEN">`
   and in a `csrfTokenName`/`csrfToken` JS var. Read it off the page you're on.

Once you hold a valid session cookie, you can hit **any endpoint the web app
hits** — because to RepairQ's server you *are* the web app. The endpoints are
discoverable by opening Chrome DevTools → Network → Fetch/XHR while you click
around RepairQ. Every button is an AJAX call you can replay.

Useful endpoints we found by watching the Network panel (yours may differ
slightly by RepairQ version — **verify each in DevTools**):

- `GET  /ticket` — the ticket list HTML (paginated via `?Ticket_page=N`)
- `GET  /ticket/<id>` — a single ticket (HTML + a big inline JSON blob with `notes`, items, customer)
- `POST /ajax/ticketNote/save` — add a note (`YII_CSRF_TOKEN`, `ticketId`, `note`, `print`, `important`)
- `POST /ajax/ticketNote/delete` — delete a note (`YII_CSRF_TOKEN`, `id`, `ticketId`)
- `POST /ajax/ticket/updateTicketProperties` — change status/assignee
- `POST /ticket/globalSearch` — the header search
- `POST /site/login` — the login form (Layer A only)

---

## 3. Layer A — server session-replay (the real API)

This is the part Brett's method describes. Implement it as one edge function
(we call ours `repairq-query`). Deno/Supabase shown; any server language works.

### 3.1 Secrets (never in the browser, never in git in plaintext)

Set these as function secrets / env vars:

- `REPAIRQ_USERNAME` — a RepairQ login (make a dedicated service user if you can)
- `REPAIRQ_PASSWORD`
- `REPAIRQ_WORKSTATION_KEY` — a fallback workstation key (see 3.2; the login form
  usually issues a fresh one, but keep one from the form as backup)
- `REPAIRQ_LOGIN_LOCATION` — a numeric RepairQ location id to auth under (find it
  in the login form's `currentLocation` dropdown or a location URL)
- `REPAIRQ_PROXY_SECRET` — a long random string YOU invent. Callers must send it
  in an `X-CPR-RQ-SECRET` header. This is what stops the public internet from
  driving your function. **This is the single most important guard rail.**

### 3.2 The login dance (this is where naive attempts fail)

RepairQ's login is **two requests**, not one:

1. **`GET /site/login` first.** This primes the session cookies AND carries two
   values you must echo back: the `YII_CSRF_TOKEN` and a server-issued
   `UserLoginForm[workstation_key]` (fresh per visit — prefer it over your stored
   secret). Parse both out of the returned HTML with a regex on the hidden inputs.
   **Skipping this GET is the #1 reason logins silently fail.**

2. **`POST /site/login`** with `redirect: "manual"` and body:
   ```
   YII_CSRF_TOKEN=<from step 1>
   UserLoginForm[username]=<REPAIRQ_USERNAME>
   UserLoginForm[password]=<REPAIRQ_PASSWORD>
   UserLoginForm[workstation_key]=<from step 1, else secret>
   UserLoginForm[currentLocation]=<REPAIRQ_LOGIN_LOCATION>
   ```
   Send the cookies from step 1 in the `Cookie` header. **`redirect: "manual"` is
   mandatory** — the `PHPSESSID` you need is set on the **302 response**, and if
   you let fetch follow the redirect you lose it.

   **Success = a 3xx redirect whose `Location` is NOT `/site/login`.** A 200 that
   re-renders the login page means bad credentials (scrape the `.errorSummary` /
   `.help-inline` divs for the reason).

3. **Extract `PHPSESSID`** from the 302's `Set-Cookie`. Gotcha: Deno's `fetch`
   collapses multiple `Set-Cookie` headers into one string — use
   `response.headers.getSetCookie()` (returns an array) to split them properly.
   Store the whole cookie jar as a `Cookie` header string.

4. **Cache the session** in a module-level variable with a TTL (we re-login
   defensively after 20 min). Reuse it for every request; only re-login on a 401
   or when the cache expires. Never send credentials per request.

**Checkpoint:** build a `ping` action that logs in, then does
`GET /ticket` and confirms the response is real ticket HTML and NOT a bounce to
`/site/login`. When `ping` returns `{ok:true}`, your session works. Do not build
anything else until it does.

### 3.3 The authenticated proxy (`raw` action)

One function that takes `{ method, path, body|form, headers }`, attaches the
cached session cookie + a browser-like `User-Agent`, hits
`https://<subdomain>.repairq.io<path>`, and returns `{status, body, json}`.
On a 401 or a redirect to `/site/login`, re-login once and retry. **Everything
else is built on this** — reading tickets, writing notes, replaying Looker.

### 3.4 Looker data replay (the analytics numbers)

RepairQ's reports (inventory, sales, device consumption) are Looker dashboards
embedded via a **signed SSO iframe URL**. To pull those numbers headless:

1. Load the RepairQ analytics page (`/analytics` or similar — find it by scanning
   the home page nav for links containing "analytic"/"looker"/"insight"/"bi").
2. Scrape the **full** `https://<subdomain>.looker.com/login/embed/…&signature=…`
   URL out of the iframe `src`. **Grab the entire quoted attribute — never
   truncate the signature** or Looker bounces you to its login.
3. Follow that SSO URL (again `redirect: "manual"`, accumulating cookies across
   up to ~12 hops) until you land an authenticated Looker session + its CSRF.
4. In the browser, capture ONE dashboard tile's `query`/`run` payload from the
   Network panel. Replay it against Looker's query endpoint with your Looker
   session. The **location id in the payload can be swapped** to pull any store.
5. Save captured payloads as named templates in a `repairq_queries` table with
   `{loc}` token substitution; a `query` action replays a template by name and
   caches results. **Capture once, replay forever.**

This Looker layer is the fiddliest part — leave it for last, after Layer A's
`raw` action is solid. Many useful pulls (ticket list, notes, ticket details)
need only `raw` and no Looker at all.

---

## 4. Layer B — extension same-origin (in-page live actions)

A Manifest V3 Chrome extension with content scripts matched to
`https://<subdomain>.repairq.io/*`. Because the script runs *in the page*, it
already has the staff member's session — **no credentials, no login code.**

Pattern for any action:
1. Read `YII_CSRF_TOKEN` from `document.getElementsByName('YII_CSRF_TOKEN')[0].value`.
2. `fetch()` the RepairQ AJAX endpoint with `credentials: 'same-origin'` and
   `x-requested-with: XMLHttpRequest`.

### Hard-won gotchas (these cost us real time — save yourself the pain):

- **Never use `keepalive: true` on a content-script fetch to RepairQ.** Chrome
  attributes keepalive requests from content scripts to the *extension's* origin,
  so the "same-origin" call CORS-fails and vanishes silently. If you need a write
  to survive a page navigation (e.g. a note written right before a status change
  reloads the page), route it through the **background service worker** instead
  (message `{type:'note:save', ...}` → the SW `fetch`es RepairQ; the SW outlives
  the page turn). Give the SW `host_permissions` for the RepairQ domain.

- **RepairQ's database is 3-byte MySQL (`utf8`, not `utf8mb4`).** Any note text
  containing a 4-byte character (most emoji: 📣 🛡 📞) **truncates at the first
  such character** — a note that *starts* with an emoji stores as completely
  **blank**, and RepairQ then refuses to save the whole ticket ("Note cannot be
  blank"). **Strip astral characters before every note write:**
  `text.replace(/[\u{10000}-\u{10FFFF}]/gu, '')`. Keep note prefixes to ASCII/BMP
  (`✔ ⚠ ⛔` are safe 3-byte chars; `📣 🛡` are not).

- **Never POST a blank note.** Guard every write: if the text is empty after
  stripping/trimming, don't send it — a blank note bricks the ticket save.

- **The ticket list is paginated** via `?Ticket_page=N`. Follow pages until a
  page returns no new `tr[data-id]` rows.

- **RepairQ's header buttons are floats.** If you inject your own buttons into
  the header row, an overflowing row wraps RepairQ's *own* buttons onto a hidden
  second line and they look "missing." Measure and yield: if a native button has
  wrapped below your inserted element, hide yours.

- **Skip your gates inside iframes** (`window.self !== window.top`) so RepairQ
  can embed your tools without the login overlay firing.

---

## 5. Build order (do it in this sequence)

1. **Layer B, read-only:** an extension that reads the current ticket's inline
   JSON and logs it to console. Proves you can parse RepairQ's page data. *(1 hr)*
2. **Layer B, one write:** add a ticket note through the background-SW path, with
   the astral-strip + blank guard. Proves the write path + CSRF. *(1 hr)*
3. **Layer A, `ping`:** the two-step login + session cache + `GET /ticket` sanity
   check. Do not proceed until it returns `{ok:true}`. *(half a day — the login
   dance is finicky; budget for it)*
4. **Layer A, `raw`:** the authenticated proxy. Now you can script any RepairQ
   read/write from a cron. *(1 hr)*
5. **Layer A, Looker replay:** SSO iframe → capture payload → `save_query` /
   `query` with `{loc}` substitution → cache to a table. *(1 day; optional if you
   only need ticket/note data)*
6. **Wire it to real tools** (dashboards, order suggestions, etc.), pulling from
   your cached tables, not hammering RepairQ live.

---

## 6. Guard rails & ethics (non-negotiable)

- **Credentials live server-side only.** The browser/extension NEVER holds the
  RepairQ password. Layer A keeps it in function secrets; Layer B uses the human's
  own session and stores nothing.
- **Gate the proxy with a secret header.** No `REPAIRQ_PROXY_SECRET`, no calls.
  This is what keeps your function from becoming an open RepairQ relay.
- **You may only pull YOUR OWN store's data with YOUR OWN login.** This works
  because you're a legitimate RepairQ customer using your own account. Don't use
  it against data you aren't entitled to.
- **Be gentle.** Cache aggressively; run crons at sane intervals (hourly, not
  every minute). You're a guest on an undocumented internal API — hammering it
  is how integrations get noticed and killed.
- **Expect breakage.** It's undocumented; RepairQ can change an endpoint or the
  Looker embed shape any time. Isolate all RepairQ coupling behind ONE function
  (Layer A) and ONE extension module (Layer B) so a break is swappable, not woven
  through every tool. Keep a `ping`/health action so you notice fast.

---

## 7. Stack Corey will need (mirrors CPR Oregon's)

- **GitHub repo** for the site/tools (GitHub Pages is free static hosting).
- **Supabase project** (free tier fine to start): Postgres for data, Edge
  Functions (Deno) for the RepairQ proxy + any other secrets-holding backend,
  Storage for files. Get a **Supabase Personal Access Token** so his Claude can
  apply SQL and deploy functions via the management API (that's how his AI will
  "read and write his database" the way this session does for CPR Oregon).
- **Chrome extension** (unpacked for dev; unlisted Chrome Web Store listing for
  painless auto-updates across store machines — hand-installing zips means a
  broken version can linger on one machine for days).
- His **own RepairQ login + workstation key + a location id.**

The companion setup handoff (`docs/barbershop-starter-handoff.md` in CPR Oregon's
repo) walks through wiring an AI assistant to Supabase + GitHub with the right
tokens end-to-end — the same plumbing applies here.
