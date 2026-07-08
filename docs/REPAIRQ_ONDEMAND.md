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

## Actions

| Action | Purpose |
|---|---|
| `ping` | login (or reuse the cached session); confirms creds are valid |
| `raw` | proxy ONE authenticated request — used to first-test a captured payload |
| `save_query` | store a captured payload as a reusable named template |
| `list_queries` | the saved templates |
| `query` | run a saved template (token-substituted), cache the result, return data |

## Saved templates + the demand cache (the infrastructure)

Two tables back the demand pull (both server-write, manager-read via `is_admin()`):

- **`repairq_queries`** — named templates: `{ name, path, method, body_template }`.
  Any `{loc}` in the path/body is swapped for the pulled location; any other
  `{token}` is swapped from the call's `params`. Capture a payload once, save it,
  replay it forever.
- **`repairq_cache`** — where pulls land: `{ query_name, location, params, data
  (jsonb), row_count, fetched_at }`. Consumers read the **freshest** row — pages
  never hit RepairQ directly.

`store_lines.rq_location_id` maps a **store name → RepairQ location id**, so a pull
can say `"location":"CPR Clackamas OR"` instead of a raw id (numeric ids also work).

## Capturing a report payload (do this at a computer)

1. In RepairQ, build the report you want in Looker and drop it on a temporary
   dashboard.
2. Open the browser **DevTools → Network** panel, filter to **Fetch/XHR**.
3. Click the dashboard's **refresh** icon. A request named like
   `query/<something>-<locationID>-<userID>` appears.
4. Right-click it → **Copy → Copy request payload** (the JSON body) and note the
   request **URL/path**. Send both to Claude.
5. **Test it** with `raw` (raw path + body), then **save it** as a template:
   ```
   {"action":"save_query","name":"commission_by_tech",
    "path":"/query/…-{loc}-…",
    "body_template":{ …the captured JSON, with the location swapped for {loc}… }}
   ```
6. From then on, pull it by name:
   ```
   {"action":"query","name":"commission_by_tech","location":"CPR Clackamas OR"}
   ```
   → returns clean JSON **and** writes a `repairq_cache` row.

## The right consumption pattern

**Do NOT pull live on every page view** (slow pages, hammered API). Instead:

- A **pg_cron** job calls `query` for each store on an interval (Brett runs his
  ~every 5 min) and the result lands in `repairq_cache`. Employees read that
  table — instant, and RepairQ is hit a fixed few times per interval regardless
  of traffic. Add the cron once a template exists (example below).
- A **"🔄 Refresh now"** button does an on-demand `query` for the moments
  freshness matters (payroll close-out, a manager double-checking).

### Example cron (add after the first template is saved)

```sql
select cron.schedule('repairq-pull-5min', '*/5 * * * *', $$
  select net.http_post(
    url    := 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/repairq-query',
    headers:= jsonb_build_object('Content-Type','application/json','x-cpr-rq-secret','<REPAIRQ_PROXY_SECRET>'),
    body   := jsonb_build_object('action','query','name','commission_by_tech','location','CPR Clackamas OR')
  );
$$);
```

## Notes / caveats

- Undocumented internal API — if RepairQ changes it, re-capture a payload.
- The session expires; the function auto-re-logs-in on a bounce.
- Same credentials can query **any** location id — our own stores only, by
  policy.
