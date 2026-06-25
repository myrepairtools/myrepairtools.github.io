-- Schedule v2: shifts carry BOTH a location and a day (per employee), so a tech
-- can work different stores on different days (multi-location handled natively).
-- Plus avatar personalization (emoji + color) employees can set themselves.

-- 1. Avatar personalization on staff.
alter table staff add column if not exists avatar text;
alter table staff add column if not exists avatar_color text;

-- 2. Convert staff_schedule.shifts from {"<day>":"<label>"} to
--    {"<day>":{"store":"<store>","label":"<label>"}}. Off/blank keep label only.
--    Idempotent: only rewrites rows that still hold string day-values.
update staff_schedule s set shifts = (
  select coalesce(jsonb_object_agg(k,
    case
      when jsonb_typeof(v)='object' then v
      when btrim(v#>>'{}') in ('','Off') then jsonb_build_object('label', btrim(v#>>'{}'))
      else jsonb_build_object('store', s.store, 'label', btrim(v#>>'{}'))
    end
  ), '{}'::jsonb)
  from jsonb_each(s.shifts) e(k,v)
)
where shifts is not null and shifts <> '{}'::jsonb
  and exists (select 1 from jsonb_each(s.shifts) e(k,v) where jsonb_typeof(v)='string');

-- 3. Let a signed-in employee set ONLY their own avatar (not role/store) via RPC.
create or replace function set_my_avatar(p_avatar text, p_color text)
returns void language sql security definer set search_path=public as $$
  update staff set avatar = p_avatar, avatar_color = p_color where auth_uid = auth.uid();
$$;
revoke all on function set_my_avatar(text,text) from public;
grant execute on function set_my_avatar(text,text) to authenticated;

-- 4. Shift presets are managed in Settings → Page Settings → Schedule. Admins may
--    add/edit/delete presets for stores they administer (read stays open).
drop policy if exists shift_presets_ins on shift_presets;
create policy shift_presets_ins on shift_presets for insert to authenticated with check (is_admin(store));
drop policy if exists shift_presets_upd on shift_presets;
create policy shift_presets_upd on shift_presets for update to authenticated using (is_admin(store)) with check (is_admin(store));
drop policy if exists shift_presets_del on shift_presets;
create policy shift_presets_del on shift_presets for delete to authenticated using (is_admin(store));
