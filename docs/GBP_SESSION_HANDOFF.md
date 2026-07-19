# GBP Integration — Session Handoff (continue from here)

**For:** any new Claude session (claude.ai/code cloud or local) picking up the Google
Business Profile project. **Read this + `docs/GBP_DESIGN_HANDOFF.md` (the product plan)
before doing anything.** State below is accurate as of **2026-07-17**.

## What this project is (10 seconds)

CPR Oregon (3 stores: Eugene, Salem Northeast, Clackamas — see `assets/locations.js`)
is wiring its ops site into the Google Business Profile APIs to measure why Eugene has
the best Google traffic in the country and replicate it. Phase 1 ("Measure") is **fully
built and sitting in this repo** — it just needs deploying to Supabase.

## What is DONE — do not rebuild or re-mint any of this

| Piece | Where / proof |
|---|---|
| Product plan + wireframes | `docs/GBP_DESIGN_HANDOFF.md` |
| DB schema (6 tables, 2 views, RLS, cron templates) | `docs/sql/2026-07-10-gbp-schema.sql` |
| `gbp-sync` edge function (discover/backfill/pull/keywords/status; per-stage fault tolerance) | `supabase/functions/gbp-sync/index.ts` |
| Google Traffic page (Compare/Trends/Keywords/Reviews tabs) | `google-traffic.html` |
| Dashboard widget + summary lib | `index.html` (`greviews` module) + `assets/gbp-summary.js` |
| Nav entry (Reports, minRole admin) | `assets/nav.js` |
| Google Cloud APIs | ALL enabled on project **myrepairtools** (number **867043752842**), incl. the hidden v4 `mybusiness.googleapis.com` (allowlist granted 2026-07-10). Performance API quota confirmed 300 QPM. |
| OAuth client (Web) | `867043752842-sj82ghqirc8utpthv8alhapaa1bgbkb9.apps.googleusercontent.com`, redirect URI `https://developers.google.com/oauthplayground`, consent screen **Internal** (no token expiry, no verification) |
| Refresh token | **Minted 2026-07-16, in Britt's private note** (scope `business.manage`, account britt@irepairphoneshop.com — the GBP owner/manager account) |
| Client secret | New secret minted 2026-07-16 — value in Britt's note (also in the client-secret JSON on his MacBook Pro at `~/Documents/GitHub/client_secret_867…json`). Old + new secrets both enabled. |

Britt's private note holds the four secret **values**: client ID (also above, public),
client secret (`GOCSPX-…`), refresh token, and the chosen `GBP_SYNC_SECRET`. Ask him to
paste them where needed — never commit them to this repo.

## DEPLOYED 2026-07-19 — the runbook below is DONE

Phase 1 is live: secrets set, schema applied, `gbp-sync` deployed (JWT off), both
crons installed, all 3 stores mapped, 18-month backfill complete (11,193 metric rows,
4,256 keyword rows, 2,102 reviews; `last_error` null everywhere). One gotcha found:
all three Google listings share the title "CPR Cell Phone Repair", so discover now
also matches on `storefrontAddress` — and the Clackamas listing's address city is
**Happy Valley**, which matches no store keyword, so its `gbp_locations` row was
mapped manually (it persists; discover never overwrites unmatched stores' rows).
Remaining: load `google-traffic.html` as a manager and eyeball the tabs (step 7).

## What REMAINS — the deploy runbook (~15 min, mostly Claude)

Supabase project: **`xuvsehrevxackuhmbmry`** (same project as every other tool here).

1. **Access check:** confirm the session can reach Supabase (claude.ai Supabase connector
   `https://mcp.supabase.com/mcp`, or a management access token). If not, stop and ask
   Britt to connect it (claude.ai → Settings → Connectors).
2. **Secrets** — set 4 function secrets (values from Britt's note):
   `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET`, `GBP_REFRESH_TOKEN`, `GBP_SYNC_SECRET`.
   If the connector can't manage secrets, have Britt paste them in the dashboard
   (Edge Functions → Secrets) — that page accepts bulk `.env`-style paste.
3. **Schema:** run `docs/sql/2026-07-10-gbp-schema.sql` (idempotent; skip the commented
   cron block for now).
4. **Deploy** `supabase/functions/gbp-sync` — **JWT verification must be OFF**
   (`--no-verify-jwt` / untick "Enforce JWT verification"): the function auths via
   `?secret=` (cron + curl), not Supabase JWTs. Forgetting this = every call 401s.
5. **Crons:** run the two `cron.schedule` statements at the bottom of the schema file
   with the real `GBP_SYNC_SECRET` substituted (nightly pull 11:05 UTC; monthly keywords).
6. **Map + backfill** (SECRET = the sync secret):
   `GET https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/gbp-sync?action=discover&secret=SECRET`
   → expect all 3 stores mapped, `unmatched: []` (matching is by listing title keywords —
   Eugene/Salem/Clackamas).
   Then `…?action=backfill&secret=SECRET` — 18 months of metrics + keywords + ALL reviews.
   If it times out, re-run per store (`&store=Eugene` etc.) — everything is idempotent.
7. **Verify:** `…?action=status&secret=SECRET` → per-store `last_sync_at` set, `last_error`
   null, row counts: metrics tens-of-thousands, keywords thousands, reviews = roughly the
   profiles' lifetime review counts. Then load `google-traffic.html` (manager sign-in) —
   Compare/Trends/Keywords/Reviews all populate; Keywords tab has the Eugene diff view.

## Gotchas the last session already hit (save yourself the hour)

- Google metrics **lag 3–5 days** (nightly cron re-pulls a 10-day window on purpose).
  Keywords are **monthly**, published after month end — current month is legitimately empty.
- Reviews: if any pull ran before access existed, it self-heals — empty table triggers a
  full pull (watermark = newest stored review). Review API = legacy **v4**; the newer APIs
  don't have reviews.
- The function's stages (metrics/reviews/keywords/snapshot) are independent per store —
  one failing writes `last_error` but never blocks the others.
- `stores` table in Supabase is the store-name source for matching (same as square-tips).
- Site deploy = git push to main (GitHub Pages). Local Claude sessions on Britt's MacBook
  Pro cannot push (no git creds) — Britt pushes via GitHub Desktop.

## After Phase 1 is live

Ask Britt for the `docs/GBP_DESIGN_HANDOFF.md` §16 design answers (store chart colors,
tech widget visibility, AI reply tone kit, contact retention, QR cards, scorecard timing),
then Phase 2 = review-request engine + AI-drafted reply queue (plan in the design doc).
