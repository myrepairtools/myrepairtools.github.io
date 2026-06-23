# Auth Redesign — PIN-only sign-in

Working branch: `claude/auth-roles-permissions-design-5yz462`

This document captures the full design and plan agreed with the owner (Britt) so
work can continue seamlessly across sessions. **Status: design complete, not yet
implemented.**

## Goal

Replace the current multi-step sign-in with a single **PIN-only** login on the
shared shop computers. A technician walks up, types their PIN, presses Enter, and
is both **logged in** and **identified** — no username, no name picking, no store
picking. The PIN attributes every action (checklists, tasks) to the right person.

## Agreed design decisions

- **PIN is the identity.** Typing a PIN both authenticates *and* identifies the
  person. No username or name-selection step.
- **PINs match RepairQ PINs**, which are **unique company-wide** (confirmed by
  owner). Length is variable: **4 to 6 digits.**
- **Clean UI:** a single password-style box (masked dots), like the existing
  Repair-options page. No on-screen keypad. On mobile, the field triggers the
  numeric 10-key (`inputmode="numeric"`).
- **Submit with Enter** (PIN length varies, so no auto-submit on Nth digit).
- **Quick-switch for the shared computer:** screen shows "You are: <name>" with a
  **Switch User** button so the next tech re-PINs in one tap.
- **Idle relock after 5 minutes**, so a walk-away never mis-attributes work.
- **Role comes from the PIN.** A technician's PIN shows technician tools; an
  admin's PIN instantly unlocks all admin tools — no second login.
- **Store access** is controlled per person via the existing
  `staff.authorized_stores` (+ `home_store`). The Add/Edit Employee screen sets
  these.
- **Admin/owner PINs** may be longer/more guarded since they unlock everything
  (owner preference; not a hard rule).

## Open questions (decide before/at implementation)

1. **Lockout behavior on a shared device.** Current code locks the *device* after
   5 wrong tries and requires a manager to reset. On a shared station, typos from
   the whole crew could lock everyone out. Proposed: raise to ~10 tries **and**
   auto-unlock after a few minutes instead of requiring a manager. *Owner has not
   confirmed yet.*
2. **Role naming.** The `cpr-auth` function uses roles `owner` / `manager` /
   `employee`, but the site nav (`nav.js`, `index.html`) uses `employee` / `admin`
   / `owner`. Pick one vocabulary (Manager vs Admin) and standardize everywhere.
   *Owner has not confirmed yet.*

## What already exists (no need to rebuild)

The newer Supabase stack already has most of the plumbing.

### `staff` table
`id, auth_uid (uuid), display_name, first_name, last_name, username, role,
home_store, authorized_stores (text[]), pin_hash, active, created_at`

### `staff_roster` (view)
Safe public projection of staff: `display_name, username, role, home_store,
authorized_stores, active` — hides `pin_hash`, `id`, `auth_uid`.

### `login_attempts` table
`id, device_id, ip, staff_id, fails, locked, last_attempt` — per-device
brute-force lockout (LOCK_AT = 5 in current code).

### `stores` table
`store, rq_name, display_order, active`.

### `cpr-auth` Edge Function (`/functions/v1/cpr-auth`)
Already implements, with PBKDF2 PIN hashing (random per-row salt, 100k iters,
SHA-256, constant-time compare) and role-based permission checks
(`canManageRole`: owner manages anyone; manager manages only employees):

- `login` — **currently by `username` + pin + device_id** (also accepts `store`,
  passed through only). On success generates a real Supabase Auth session
  (access/refresh tokens) so RLS applies, and returns `{display_name, role,
  home_store, authorized_stores}`.
- `list_staff_admin`, `list_lockouts`
- `create_staff`, `update_staff`, `set_pin`, `reset_lockout`

The front-end prototype is `login-test.html` (store -> name dropdown -> PIN).

## The key technical reality

Because each `pin_hash` uses a **random per-row salt**, you cannot look up a
person by PIN with a single hash. PIN-only login must **scan active staff and
`verifyPin` against each** until the (at most one, since PINs are unique) match.
Fine for shop-scale staff counts. If it ever feels slow, add a deterministic
blind-index column (e.g. HMAC(pin) with a server secret) for O(1) lookup.

## Implementation plan

1. **`cpr-auth` → add PIN-only login.** Accept `{ pin, device_id }` (no
   username). Keep device lockout. Identify the person by scanning active staff
   and `verifyPin`. Reuse existing session-generation + return shape. Keep the old
   username path during transition if convenient.
2. **Make `username` optional** in `create_staff` (owner doesn't want usernames).
   Likely auto-generate or allow null; check the unique constraint.
3. **New front door page/shell:** single masked PIN box, `inputmode="numeric"`,
   Enter to submit, "You are: <name>" + Switch User, 5-min idle relock. This
   becomes the real site gate (replacing/superseding the older gates for Supabase
   tools). Reconcile with `site-gate.js` / `admin-gate.js` / `nav.js`.
4. **Add / Edit Employee screen:** front-end onto the existing `create_staff` /
   `update_staff` / `set_pin` / `list_staff_admin` / `reset_lockout` actions.
   Fields: first/last name, PIN, role, home_store, authorized_stores, active.
5. **(Phase 2) Task/activity logging:** stamp checklists/tasks with the current
   user. No table exists yet — net-new (e.g. `activity_log`).

## Access setup status (Supabase, for Claude's direct access)

- `.mcp.json` committed (Supabase MCP server, project ref
  `xuvsehrevxackuhmbmry`, token via `SUPABASE_ACCESS_TOKEN` env var).
- Owner added env var `SUPABASE_ACCESS_TOKEN` and set Network access = Custom with
  `api.supabase.com` + `*.supabase.co` (+ default package managers).
- Network changes apply to **new sessions** only. Verified in the session where
  this doc was written: `*.supabase.co` reachable, `api.supabase.com` not yet
  (because that session predated the `.com` addition). **Next step: a fresh
  session picks up the full allowlist; then validate access via the Supabase
  Management API (`api.supabase.com`) or the MCP tools.**
