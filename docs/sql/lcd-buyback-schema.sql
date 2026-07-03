-- LCD Buyback — pulled-display harvest log, labels & recycler audits.
--
-- Every iPhone / Galaxy S / Galaxy Note / Pixel screen repair pops a Good/Bad
-- modal in the myRepairTools Chrome extension; the answer lands here (via the
-- lcd-buyback edge function, service-role) keyed by the RepairQ ticket number,
-- which is also the display's serial / QR-code content on the Dymo 30334 send
-- label. Displays go into the store's buyback box; when the recycler visits, a
-- manager runs an Audit: every display is scanned into the bucket the recycler
-- sorted it into (good / bad / aftermarket), and closing the audit computes
-- grading accuracy and flags in-window displays that never got scanned
-- (missing) together with the status they were recorded at.
--
-- Surfaces: lcd-buyback.html (Operations) + the myRepairTools extension.

-- ---------- displays ----------
create table if not exists lcd_displays (
  id bigint generated always as identity primary key,
  ticket_no   text not null,             -- RepairQ ticket number = serial = QR content
  item_key    text not null default '',  -- disambiguator when one ticket pulls 2+ displays
  store       text not null,             -- CPRLocations name
  model       text not null,             -- "Apple iPhone 17 Pro Max"
  item_name   text,                      -- full RepairQ line-item name
  status      text not null check (status in ('good','bad')),
  graded_by   text,                      -- RepairQ display name of the tech who answered
  staff_id    bigint references staff(id),
  source      text not null default 'extension',   -- extension | manual
  captured_at timestamptz not null default now(),
  status_history jsonb not null default '[]'::jsonb, -- [{from,to,by,at}]
  label_prints int not null default 0,
  audit_id    bigint,                    -- last audit that scanned (or flagged) it
  audit_result text check (audit_result in ('good','bad','aftermarket')),
  audited_at  timestamptz,
  missing     boolean not null default false, -- audit closed without this display being scanned
  deleted     boolean not null default false,
  unique (ticket_no, item_key)
);
create index if not exists lcd_displays_store_idx on lcd_displays(store, captured_at desc);
create index if not exists lcd_displays_ticket_idx on lcd_displays(ticket_no);

-- ---------- audits (one per recycler visit / batch) ----------
create table if not exists lcd_audits (
  id bigint generated always as identity primary key,
  store      text,                       -- null = all stores
  start_date date not null,              -- day of the previous audit (window start)
  end_date   date not null,              -- user-picked window end
  status     text not null default 'open' check (status in ('open','closed')),
  created_by bigint references staff(id),
  created_at timestamptz not null default now(),
  closed_at  timestamptz,
  summary    jsonb                       -- computed at close (counts, accuracy, missing)
);

-- ---------- per-display recycler scans ----------
create table if not exists lcd_audit_scans (
  id bigint generated always as identity primary key,
  audit_id  bigint not null references lcd_audits(id) on delete cascade,
  ticket_no text not null,
  bucket    text not null check (bucket in ('good','bad','aftermarket')),
  display_id bigint references lcd_displays(id),
  recorded_status text,                  -- display.status at scan time (null = unknown ticket)
  is_match  boolean,                     -- recorded_status = bucket (aftermarket ⇒ false)
  scanned_by bigint references staff(id),
  scanned_at timestamptz not null default now(),
  unique (audit_id, ticket_no)
);
create index if not exists lcd_audit_scans_audit_idx on lcd_audit_scans(audit_id);

-- ---------- RLS ----------
alter table lcd_displays    enable row level security;
alter table lcd_audits      enable row level security;
alter table lcd_audit_scans enable row level security;

-- displays: staff read their store(s); any staff can log one manually for
-- their store; only managers change status / delete (extension writes go
-- through the edge function with the service role and bypass RLS).
drop policy if exists lcd_displays_read  on lcd_displays;
drop policy if exists lcd_displays_ins   on lcd_displays;
drop policy if exists lcd_displays_upd   on lcd_displays;
create policy lcd_displays_read on lcd_displays for select to authenticated
  using (can_see_store(store));
create policy lcd_displays_ins on lcd_displays for insert to authenticated
  with check (can_see_store(store));
create policy lcd_displays_upd on lcd_displays for update to authenticated
  using (is_admin(store)) with check (is_admin(store));

-- audits + scans: staff can read (transparency), managers run them.
drop policy if exists lcd_audits_read  on lcd_audits;
drop policy if exists lcd_audits_write on lcd_audits;
create policy lcd_audits_read on lcd_audits for select to authenticated
  using (store is null or can_see_store(store));
create policy lcd_audits_write on lcd_audits for all to authenticated
  using (is_admin(store)) with check (is_admin(store));

drop policy if exists lcd_audit_scans_read  on lcd_audit_scans;
drop policy if exists lcd_audit_scans_write on lcd_audit_scans;
create policy lcd_audit_scans_read on lcd_audit_scans for select to authenticated
  using (exists (select 1 from lcd_audits a where a.id = audit_id
                 and (a.store is null or can_see_store(a.store))));
create policy lcd_audit_scans_write on lcd_audit_scans for all to authenticated
  using (exists (select 1 from lcd_audits a where a.id = audit_id and is_admin(a.store)))
  with check (exists (select 1 from lcd_audits a where a.id = audit_id and is_admin(a.store)));
