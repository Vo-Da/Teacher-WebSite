-- Existing Supabase projects: run once in SQL Editor.
begin;

create table if not exists public.student_internal_profiles (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  goal text not null default '',
  starting_level text not null default '',
  current_level text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, student_id)
);

create table if not exists public.student_internal_notes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists student_internal_notes_student_idx on public.student_internal_notes (school_id, student_id, created_at desc);

create or replace function public.can_manage_student_context(p_school_id uuid, p_student_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_school_admin(p_school_id)
    or exists (
      select 1 from public.teacher_students
      where school_id = p_school_id
        and teacher_id = auth.uid()
        and student_id = p_student_id
        and is_active
    )
$$;

alter table public.student_internal_profiles enable row level security;
alter table public.student_internal_notes enable row level security;

drop policy if exists "student_internal_profiles_manage" on public.student_internal_profiles;
drop policy if exists "student_internal_notes_manage" on public.student_internal_notes;

create policy "student_internal_profiles_manage" on public.student_internal_profiles for all to authenticated
using (public.can_manage_student_context(school_id, student_id))
with check (public.can_manage_student_context(school_id, student_id));
create policy "student_internal_notes_manage" on public.student_internal_notes for all to authenticated
using (public.can_manage_student_context(school_id, student_id))
with check (public.can_manage_student_context(school_id, student_id));

update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/x-m4a', 'video/webm', 'video/mp4', 'video/quicktime']
where id = 'portal-files';

commit;
