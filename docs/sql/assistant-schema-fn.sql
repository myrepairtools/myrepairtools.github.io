-- assistant_schema(): compact public-schema map for the cpr-assistant's
-- db tools (table -> column list). SECURITY DEFINER; execute is revoked from
-- browser roles — only the edge function (service role) calls it.
create or replace function public.assistant_schema()
returns table(tbl text, cols text)
language sql stable security definer set search_path = public as $$
  select c.table_name::text,
         string_agg(c.column_name, ', ' order by c.ordinal_position)
  from information_schema.columns c
  join pg_tables t on t.tablename = c.table_name and t.schemaname = 'public'
  where c.table_schema = 'public'
  group by c.table_name
  order by c.table_name
$$;
revoke execute on function public.assistant_schema() from public, anon, authenticated;
