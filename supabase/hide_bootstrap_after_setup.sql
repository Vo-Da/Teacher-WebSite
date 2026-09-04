-- Run once in Supabase SQL Editor for an existing project.
-- It lets the frontend show the first-school form only while no school exists.
create or replace function public.can_bootstrap_school()
returns boolean
language sql stable security definer set search_path = public
as $$
  select not exists (select 1 from public.schools)
$$;

grant execute on function public.can_bootstrap_school() to authenticated;
