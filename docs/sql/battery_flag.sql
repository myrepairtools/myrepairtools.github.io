-- icon column for data-driven flag icons in the table
alter table public.flag_types add column if not exists icon text;
update public.flag_types set icon='🛒' where key='special_order' and (icon is null or icon='');

-- the Battery flag type
insert into public.flag_types (key, label, color, active, sort, icon)
values ('battery','Battery','#2E9E5B', true, coalesce((select max(sort) from public.flag_types),0)+1, '🔋')
on conflict (key) do update set active=true, label=excluded.label, icon=excluded.icon;

-- seed the Battery flag onto every matching stock SKU at each store
insert into public.sku_flags (store, sku, flag_key)
select distinct s.store, s.sku, 'battery'
from public.stock s
where s.name ~* '\y(battery|batteries)\y'
  and s.name !~* '(battery|batteries)[[:space:]]+(adhesive|cover|connector|flex|cable|bracket|sticker|sleeve|holder|clip|screw|spacer|foam|gasket|tape|insulator)'
  and s.name !~* 'adhesive[[:space:]]+(tape|strip|sticker|sheet|pad)'
on conflict (store, sku, flag_key) do nothing;
