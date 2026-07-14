-- Consumption report "Already ordered" → quantity-aware.
-- The MobileSentrix ordering flow used a per-SKU boolean skip (a row in
-- consumption_export_skips meant "already ordered today, leave off the export").
-- That breaks when the same SKU is used both before AND after the 3:30 PT
-- MobileSentrix cutoff: the whole SKU was excluded, so the afternoon unit never
-- got ordered.
--
-- Now we track HOW MANY of each SKU have been ordered today. Each export orders
-- only the remaining need (suggest − ordered_qty) and bumps ordered_qty by what
-- it exported. A row reads "ordered" when fully covered, or "N of M ordered" when
-- partial (and still exports the rest). Resets per day (rows are keyed by day).

alter table public.consumption_export_skips
  add column if not exists ordered_qty integer not null default 0;

-- existing rows were boolean skips = "fully ordered"; treat as covered (a large
-- sentinel so suggest − ordered_qty floors at 0 regardless of the suggested qty).
update public.consumption_export_skips set ordered_qty = 999999 where ordered_qty = 0;
