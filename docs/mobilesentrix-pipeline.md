# MobileSentrix → QBO Auto-Expense Pipeline (in progress)

**Goal:** MobileSentrix orders automatically become QBO expenses — invoice PDF
attached, amounts split into the proper categories/classes per store — no manual
receipt entry.

## Why a droplet

MobileSentrix runs on **Magento**, and their API program (api-consumer) requires
**IP whitelisting**. Supabase edge functions have rotating egress IPs, so a tiny
DigitalOcean droplet with a **Reserved IP** acts as the fixed-IP relay: edge
function → droplet (shared-secret auth) → MobileSentrix API.

## Status

- [x] Droplet created (DigitalOcean, San Francisco — ubuntu-s-1vcpu-512mb-10gb-sfo2)
- [x] Reserved IP: **165.227.240.189** (confirmed on the droplet's Reserved IP
      tab, 2026-07-22)
- [x] Callback endpoint live: **`ms-callback` edge function**
      (`https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ms-callback`) —
      logs every request (method/headers/body) to `ms_callback_log`
      (service-role insert, owner-only read; schema
      docs/sql/ms-callback-schema.sql). Magento POSTs the integration's OAuth
      credentials to the callback on activation, so the one-time payload is
      captured even if nobody's watching.
- [x] api-consumer request submitted on cpr.parts/api-consumer (form: consumer
      name, callback URL, whitelist IP, optional file uploads).
      Consumer Name = **iRepair Phone Shop, LLC** — the owner's actual entity
      name (not placeholder text; don't "correct" it).
- [x] **APPROVED** (2026-07-22): Consumer Key + Consumer Secret received.
      Stored as Supabase function secrets `MS_CONSUMER_KEY` /
      `MS_CONSUMER_SECRET` — **never committed anywhere**. Production URL
      `https://www.cpr.parts`, staging `https://preprod.cpr.parts`. Support:
      ms.api@mobilesentrix.com.
- [x] OAuth handshake built into `ms-callback` (v5): `?action=start&k=<MS_START_KEY>`
      302s into `/oauth/authorize/identifier` (owner signs in with the cpr.parts
      account); the callback auto-POSTs `/oauth/authorize/identifiercallback`
      and upserts the long-lived access token into `integration_tokens`
      (provider `mobilesentrix`; `meta.access_token_secret`, `meta.base_url`).
- [x] All 3 stores connected (2026-07-22) — per-store tokens in
      `integration_tokens` `ms:<store>` (each store has its own cpr.parts
      account). Managed in **Settings → Integrations → MobileSentrix**.
- [x] **No relay needed**: production API calls work straight from the edge
      function — no IP whitelist in play. The droplet can be destroyed.
- [x] **Order mirror**: `mobilesentrix` edge function `?action=sync` pulls each
      store's orders (`/api/rest/orders`, OAuth 1.0a PLAINTEXT, incremental on
      `updated_at` w/ 3-day overlap, 60-day first backfill) into `ms_orders`
      (entity_id PK, items jsonb, admin-only RLS; docs/sql/ms-orders-schema.sql).
      Cron `ms-orders-sync` hourly at :40; any signed-in staff can kick a sync
      (15-min freshness guard).
- [x] **Consumption report integration**: `ms_ordered_for_day(store, day)`
      SECURITY DEFINER RPC (per-SKU qty actually ordered that Pacific day, no
      dollars exposed) merges into the report's ORDERED state — real cpr.parts
      purchases auto-check the Ordered column (raise-only; manual marks and
      export bookkeeping still work). Page kicks a background sync on load.
- [ ] **QBO expense booking: deliberately NOT built.** The owner will
      micro-manage that build step-by-step (do not auto-post anything to QBO
      from MobileSentrix data without explicit direction). Design notes below
      stay for that future session.

## Auth process (from docs.mobilesentrix.com "Authentication Process")

Magento-style OAuth 1.0a, PLAINTEXT signature only, three tokens:

1. **Browser GET** `{base}/oauth/authorize/identifier?consumer=<name>&authtype=1`
   `&flowentry=SignIn&consumer_key=…&consumer_secret=…&callback=<url>` — the
   user signs in; MS redirects to the callback with `oauth_token` +
   `oauth_verifier` (temporary).
2. **POST** `{base}/oauth/authorize/identifiercallback` (JSON: consumer_key,
   consumer_secret, oauth_token, oauth_verifier) → `{status:1, data:{
   access_token, access_token_secret}}`.
3. Access token + secret are **long-lived (no expiry unless revoked)** and are
   used on every API call (orders, products, invoices…).

Error codes: 400/401 with `version_rejected`, `parameter_absent`,
`signature_invalid`, `token_revoked`, `token_rejected`, `verifier_invalid`, etc.

## Build notes

- Relay: minimal HTTPS service, shared-secret header (function secret
  `MS_RELAY_SECRET`), forwards to MobileSentrix Magento API only — no other
  outbound. UFW locked to 443 + SSH.
- Keep the coupling behind one seam (like `repairq-query`) so the relay is
  swappable if MobileSentrix ever offers direct API access.
- Expense booking should reuse the `qbo` function's existing Purchase +
  Attachable + idempotency (DocNumber) machinery — same double-post safety as
  expenses.html.
