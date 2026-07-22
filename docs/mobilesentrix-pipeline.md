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
- [ ] api-consumer request submitted on cpr.parts/api-consumer (form: consumer
      name, callback URL, whitelist IP, optional file uploads)
- [ ] API credentials received from MobileSentrix
- [ ] Relay service built on the droplet (bootstrap script pasted via the DO web
      console — owner keeps root access; no credentials shared into sessions)
- [ ] Supabase side: order poller → `qbo` function `create_expense`-style
      Purchase with invoice attachment + per-store class splits

## Build notes (when credentials arrive)

- Relay: minimal HTTPS service, shared-secret header (function secret
  `MS_RELAY_SECRET`), forwards to MobileSentrix Magento API only — no other
  outbound. UFW locked to 443 + SSH.
- Keep the coupling behind one seam (like `repairq-query`) so the relay is
  swappable if MobileSentrix ever offers direct API access.
- Expense booking should reuse the `qbo` function's existing Purchase +
  Attachable + idempotency (DocNumber) machinery — same double-post safety as
  expenses.html.
