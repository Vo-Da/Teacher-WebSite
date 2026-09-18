-- Keep existing connection metadata aligned with the new school brand.
alter table public.google_calendar_connections
  alter column calendar_summary set default 'Stella Academy';

update public.google_calendar_connections
set calendar_summary = 'Stella Academy'
where calendar_summary = 'School Portal';
