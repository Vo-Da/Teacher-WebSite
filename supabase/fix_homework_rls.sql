-- Run this once in Supabase Dashboard -> SQL Editor -> New query.
-- It fixes the "infinite recursion detected in policy for relation homework" error.

create or replace function public.is_homework_recipient(p_homework_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.homework_students
    where homework_id = p_homework_id and student_id = auth.uid()
  )
$$;

alter policy "homework_read_related" on public.homework using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or (status = 'published' and public.is_homework_recipient(id))
);
