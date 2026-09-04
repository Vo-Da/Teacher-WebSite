-- Teacher Portal: production schema starter
-- Run in Supabase SQL Editor (project-level) on 2026-04-07 or later.

create extension if not exists "pgcrypto";

-- -----------------------------
-- 0) Quick cloud sync table
-- -----------------------------
-- This table is used by current frontend "Push/Pull" sync mode.
-- For strict production security, replace these permissive policies with
-- authenticated + portal membership policies (see tables below).
create table if not exists public.portal_snapshots (
  portal_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.portal_snapshots enable row level security;

drop policy if exists "portal_snapshots_select_all" on public.portal_snapshots;
drop policy if exists "portal_snapshots_upsert_all" on public.portal_snapshots;

create policy "portal_snapshots_select_all"
on public.portal_snapshots
for select
to anon, authenticated
using (true);

create policy "portal_snapshots_upsert_all"
on public.portal_snapshots
for all
to anon, authenticated
using (true)
with check (true);

-- -----------------------------
-- 1) Core normalized model
-- -----------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin', 'teacher', 'student')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_members (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'teacher', 'student')),
  created_at timestamptz not null default now(),
  unique (portal_id, user_id)
);

create table if not exists public.teacher_students (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (portal_id, teacher_id, student_id)
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete restrict,
  title text not null,
  lesson_date date not null,
  lesson_time time not null,
  platform text not null,
  meeting_link text,
  status text not null default 'planned' check (status in ('planned','done','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lesson_students (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  attendance text check (attendance in ('present','absent','late')) default null,
  unique (lesson_id, student_id)
);

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete restrict,
  linked_lesson_id uuid references public.lessons(id) on delete set null,
  title text not null,
  description text,
  deadline date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assignment_students (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started','in_progress','completed')),
  teacher_comment text,
  unique (assignment_id, student_id)
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  solution_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete restrict,
  student_id uuid not null references auth.users(id) on delete cascade,
  linked_lesson_id uuid references public.lessons(id) on delete set null,
  title text not null,
  description text,
  material_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null default 'portal-files',
  path text not null,
  file_kind text not null check (file_kind in ('assignment_teacher','submission_student','material')),
  created_at timestamptz not null default now()
);

create table if not exists public.student_notes (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.portals(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  note text not null default '',
  updated_at timestamptz not null default now(),
  unique (portal_id, teacher_id, student_id)
);

-- -----------------------------
-- 2) Security helpers
-- -----------------------------
create or replace function public.my_role_in_portal(p_portal_id uuid)
returns text
language sql
stable
as $$
  select pm.role
  from public.portal_members pm
  where pm.portal_id = p_portal_id and pm.user_id = auth.uid()
  limit 1
$$;

create or replace function public.is_member_of_portal(p_portal_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.portal_members pm
    where pm.portal_id = p_portal_id and pm.user_id = auth.uid()
  )
$$;

-- -----------------------------
-- 3) RLS policies (normalized)
-- -----------------------------
alter table public.profiles enable row level security;
alter table public.portals enable row level security;
alter table public.portal_members enable row level security;
alter table public.teacher_students enable row level security;
alter table public.lessons enable row level security;
alter table public.lesson_students enable row level security;
alter table public.assignments enable row level security;
alter table public.assignment_students enable row level security;
alter table public.submissions enable row level security;
alter table public.materials enable row level security;
alter table public.files enable row level security;
alter table public.student_notes enable row level security;

drop policy if exists "profiles_self_rw" on public.profiles;
create policy "profiles_self_rw" on public.profiles
for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "portals_member_read" on public.portals;
create policy "portals_member_read" on public.portals
for select to authenticated
using (public.is_member_of_portal(id));

drop policy if exists "portals_owner_write" on public.portals;
create policy "portals_owner_write" on public.portals
for all to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "portal_members_member_read" on public.portal_members;
create policy "portal_members_member_read" on public.portal_members
for select to authenticated
using (public.is_member_of_portal(portal_id));

drop policy if exists "portal_members_admin_write" on public.portal_members;
create policy "portal_members_admin_write" on public.portal_members
for all to authenticated
using (public.my_role_in_portal(portal_id) = 'admin')
with check (public.my_role_in_portal(portal_id) = 'admin');

drop policy if exists "teacher_students_member_read" on public.teacher_students;
create policy "teacher_students_member_read" on public.teacher_students
for select to authenticated
using (public.is_member_of_portal(portal_id));

drop policy if exists "teacher_students_admin_teacher_write" on public.teacher_students;
create policy "teacher_students_admin_teacher_write" on public.teacher_students
for all to authenticated
using (
  public.my_role_in_portal(portal_id) = 'admin'
  or teacher_id = auth.uid()
)
with check (
  public.my_role_in_portal(portal_id) = 'admin'
  or teacher_id = auth.uid()
);

drop policy if exists "lessons_member_read" on public.lessons;
create policy "lessons_member_read" on public.lessons
for select to authenticated
using (public.is_member_of_portal(portal_id));

drop policy if exists "lessons_admin_teacher_write" on public.lessons;
create policy "lessons_admin_teacher_write" on public.lessons
for all to authenticated
using (
  public.my_role_in_portal(portal_id) = 'admin'
  or teacher_id = auth.uid()
)
with check (
  public.my_role_in_portal(portal_id) = 'admin'
  or teacher_id = auth.uid()
);

drop policy if exists "lesson_students_member_read" on public.lesson_students;
create policy "lesson_students_member_read" on public.lesson_students
for select to authenticated
using (
  exists (
    select 1
    from public.lessons l
    where l.id = lesson_id
      and public.is_member_of_portal(l.portal_id)
  )
);

drop policy if exists "lesson_students_teacher_admin_write" on public.lesson_students;
create policy "lesson_students_teacher_admin_write" on public.lesson_students
for all to authenticated
using (
  exists (
    select 1
    from public.lessons l
    where l.id = lesson_id
      and (
        public.my_role_in_portal(l.portal_id) = 'admin'
        or l.teacher_id = auth.uid()
      )
  )
)
with check (
  exists (
    select 1
    from public.lessons l
    where l.id = lesson_id
      and (
        public.my_role_in_portal(l.portal_id) = 'admin'
        or l.teacher_id = auth.uid()
      )
  )
);

drop policy if exists "assignments_member_read" on public.assignments;
create policy "assignments_member_read" on public.assignments
for select to authenticated
using (public.is_member_of_portal(portal_id));

drop policy if exists "assignments_admin_teacher_write" on public.assignments;
create policy "assignments_admin_teacher_write" on public.assignments
for all to authenticated
using (
  public.my_role_in_portal(portal_id) = 'admin'
  or teacher_id = auth.uid()
)
with check (
  public.my_role_in_portal(portal_id) = 'admin'
  or teacher_id = auth.uid()
);

drop policy if exists "assignment_students_read" on public.assignment_students;
create policy "assignment_students_read" on public.assignment_students
for select to authenticated
using (
  student_id = auth.uid()
  or exists (
    select 1
    from public.assignments a
    where a.id = assignment_id
      and (
        a.teacher_id = auth.uid()
        or public.my_role_in_portal(a.portal_id) = 'admin'
      )
  )
);

drop policy if exists "assignment_students_write_teacher_admin" on public.assignment_students;
create policy "assignment_students_write_teacher_admin" on public.assignment_students
for all to authenticated
using (
  exists (
    select 1
    from public.assignments a
    where a.id = assignment_id
      and (
        a.teacher_id = auth.uid()
        or public.my_role_in_portal(a.portal_id) = 'admin'
      )
  )
)
with check (
  exists (
    select 1
    from public.assignments a
    where a.id = assignment_id
      and (
        a.teacher_id = auth.uid()
        or public.my_role_in_portal(a.portal_id) = 'admin'
      )
  )
);

drop policy if exists "submissions_read_owner_teacher_admin" on public.submissions;
create policy "submissions_read_owner_teacher_admin" on public.submissions
for select to authenticated
using (
  student_id = auth.uid()
  or exists (
    select 1
    from public.assignments a
    where a.id = assignment_id
      and (
        a.teacher_id = auth.uid()
        or public.my_role_in_portal(a.portal_id) = 'admin'
      )
  )
);

drop policy if exists "submissions_write_student" on public.submissions;
create policy "submissions_write_student" on public.submissions
for insert to authenticated
with check (student_id = auth.uid());

drop policy if exists "materials_member_read" on public.materials;
create policy "materials_member_read" on public.materials
for select to authenticated
using (
  student_id = auth.uid()
  or teacher_id = auth.uid()
  or public.my_role_in_portal(portal_id) = 'admin'
);

drop policy if exists "materials_teacher_admin_write" on public.materials;
create policy "materials_teacher_admin_write" on public.materials
for all to authenticated
using (
  teacher_id = auth.uid()
  or public.my_role_in_portal(portal_id) = 'admin'
)
with check (
  teacher_id = auth.uid()
  or public.my_role_in_portal(portal_id) = 'admin'
);

drop policy if exists "files_member_read" on public.files;
create policy "files_member_read" on public.files
for select to authenticated
using (public.is_member_of_portal(portal_id));

drop policy if exists "files_owner_write" on public.files;
create policy "files_owner_write" on public.files
for all to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "student_notes_read" on public.student_notes;
create policy "student_notes_read" on public.student_notes
for select to authenticated
using (
  teacher_id = auth.uid()
  or student_id = auth.uid()
  or public.my_role_in_portal(portal_id) = 'admin'
);

drop policy if exists "student_notes_write_teacher_admin" on public.student_notes;
create policy "student_notes_write_teacher_admin" on public.student_notes
for all to authenticated
using (
  teacher_id = auth.uid()
  or public.my_role_in_portal(portal_id) = 'admin'
)
with check (
  teacher_id = auth.uid()
  or public.my_role_in_portal(portal_id) = 'admin'
);

