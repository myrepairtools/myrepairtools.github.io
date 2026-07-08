# RepairQ on-demand pulls (`repairq-query` edge function)

Pull live data from RepairQ instead of waiting for its scheduled exports.
Method courtesy of Brett K. Credentials live only as Supabase secrets — never
in the browser.

## How it works

1. **Login** — the function POSTs to `cpr.repairq.io/site/login` with our
   username/password + workstation key + a location id, and keeps the
   `PHPSESSID` session cookie it gets back. The session is reused (cached ~20
   min per warm instance) and silently re-authenticated when RepairQ bounces
   it. We never re-send the password per request.
2. **Query** — RepairQ's reports are Looker-backed internal `query/…` calls.
   You capture one report's request payload from the browser once (below),
   store it as a named template, and the function replays it on demand. The
   location id inside the payload can be swapped to pull any store.

## Secrets (Supabase → Edge Functions → Secrets)

| Secret | Value | Set? |
|---|---|---|
| `REPAIRQ_USERNAME` | the RQ login username | **needed** |
| `REPAIRQ_PASSWORD` | the RQ login password | **needed** |
| `REPAIRQ_WORKSTATION_KEY` | `FEsJJETN5fUHn9qt` (from the login form) | ✅ set |
| `REPAIRQ_LOGIN_LOCATION` | `1089` (any location we can auth under) | ✅ set |
| `REPAIRQ_PROXY_SECRET` | admin gate — only server-side callers | ✅ set |

After adding/changing any secret, **redeploy** `repairq-query` (warm instances
keep boot-time env).

## Verify the login

```
curl -sS -X POST "https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/repairq-query" \
  -H "x-cpr-rq-secret: <REPAIRQ_PROXY_SECRET>" \
  -H "apikey: <anon>" -H "Authorization: Bearer <anon>" \
  -H "Content-Type: application/json" \
  -d '{"action":"ping"}'
```
`{"ok":true,"session":"active"}` = login works.

## Capturing a report payload (do this at a computer)

1. In RepairQ, build the report you want in Looker and drop it on a temporary
   dashboard.
2. Open the browser **DevTools → Network** panel, filter to **Fetch/XHR**.
3. Click the dashboard's **refresh** icon. A request named like
   `query/<something>-<locationID>-<userID>` appears.
4. Right-click it → **Copy → Copy request payload** (the JSON body) and note the
   request **URL/path**. Send both to Claude.
5. We store it as a named template and replay it via the `raw` action:
   ```
   {"action":"raw","path":"/query/…","body":"<the captured JSON payload>"}
   ```
   The response is your RQ data as clean JSON.

## The right consumption pattern

**Do NOT pull live on every page view** (slow pages, hammered API). Instead:

- A **pg_cron** job pulls each store on an interval (e.g. every 15–30 min) and
  writes into our Supabase tables. Employees read our tables — instant, and
  RepairQ is hit a fixed few times per hour regardless of traffic.
- A **"🔄 Refresh now"** button does an on-demand pull for the moments freshness
  matters (payroll close-out, a manager double-checking). That's the deliberate
  use of `raw`.

## Notes / caveats

- Undocumented internal API — if RepairQ changes it, re-capture a payload.
- The session expires; the function auto-re-logs-in on a bounce.
- Same credentials can query **any** location id — our own stores only, by
  policy.
