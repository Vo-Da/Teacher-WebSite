-- Teacher Portal production schema
-- Run this file in a NEW Supabase staging project.
-- Monetary values are whole UAH only. Never store balances as editable fields.

create extension if not exists "pgcrypto";

create type public.app_role as enum ('admin', 'teacher', 'student');
create type public.membership_status as enum ('pending', 'active', 'suspended');
create type public.lesson_status as enum ('planned', 'completed', 'cancelled', 'cancelled_paid');
create type public.homework_status as enum ('draft', 'published', 'archived');
create type public.submission_status as enum ('not_started', 'submitted', 'needs_revision', 'reviewed');
create type public.ledger_kind as enum ('payment', 'lesson_charge', 'refund', 'adjustment');
create type public.ledger_status as enum ('pending', 'confirmed', 'voided');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 2 and 120),
  requested_role public.app_role not null default 'student',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete restrict,
  currency text not null default 'UAH' check (currency = 'UAH'),
  timezone text not null default 'Europe/Kyiv',
  created_at timestamptz not null default now()
);

create table public.school_memberships (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  status public.membership_status not null default 'pending',
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (school_id, user_id)
);

create table public.registration_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  requested_role public.app_role not null check (requested_role in ('teacher', 'student')),
  full_name text not null,
  status public.membership_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  color text not null default '#0f766e',
  default_duration_minutes smallint not null default 60 check (default_duration_minutes between 15 and 240),
  is_active boolean not null default true,
  unique (school_id, name)
);

-- Only administrators manage these relations. A student may be taught by many teachers.
create table public.teacher_students (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (school_id, teacher_id, student_id),
  check (teacher_id <> student_id)
);

-- The price paid by a student and the payout due to a teacher are independent.
create table public.student_rates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  teacher_id uuid references auth.users(id) on delete cascade,
  subject_id uuid references public.subjects(id) on delete cascade,
  lesson_price_uah integer not null check (lesson_price_uah >= 0),
  teacher_payout_uah integer not null check (teacher_payout_uah >= 0),
  active_from date not null default current_date,
  active_to date,
  created_at timestamptz not null default now(),
  check (active_to is null or active_to >= active_from)
);

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  meeting_url text,
  location_text text,
  status public.lesson_status not null default 'planned',
  teacher_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table public.lesson_students (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  attendance text check (attendance in ('present', 'absent', 'late')),
  price_snapshot_uah integer not null default 0 check (price_snapshot_uah >= 0),
  teacher_payout_snapshot_uah integer not null default 0 check (teacher_payout_snapshot_uah >= 0),
  unique (lesson_id, student_id)
);

create table public.homework (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  teacher_id uuid not null references auth.users(id) on delete restrict,
  title text not null,
  description text not null default '',
  deadline_at timestamptz,
  status public.homework_status not null default 'draft',
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table public.homework_students (
  id uuid primary key default gen_random_uuid(),
  homework_id uuid not null references public.homework(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  status public.submission_status not null default 'not_started',
  teacher_comment text not null default '',
  grade text,
  reviewed_at timestamptz,
  unique (homework_id, student_id)
);

create table public.homework_submissions (
  id uuid primary key default gen_random_uuid(),
  homework_student_id uuid not null references public.homework_students(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  submitted_at timestamptz not null default now()
);

-- Metadata only; binary files live in the private Storage bucket portal-files.
create table public.file_attachments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  lesson_id uuid references public.lessons(id) on delete cascade,
  homework_id uuid references public.homework(id) on delete cascade,
  submission_id uuid references public.homework_submissions(id) on delete cascade,
  homework_student_id uuid references public.homework_students(id) on delete cascade,
  storage_path text not null unique,
  original_name text not null,
  mime_type text,
  byte_size bigint check (byte_size >= 0),
  created_at timestamptz not null default now(),
  check (num_nonnulls(lesson_id, homework_id, submission_id, homework_student_id) = 1)
);

-- Every wallet change is immutable. Corrections are separate operations.
create table public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete restrict,
  teacher_id uuid references auth.users(id) on delete set null,
  lesson_id uuid references public.lessons(id) on delete set null,
  kind public.ledger_kind not null,
  status public.ledger_status not null default 'confirmed',
  amount_uah integer not null check (amount_uah <> 0),
  teacher_payout_uah integer not null default 0,
  note text not null default '',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  voided_by uuid references auth.users(id) on delete set null,
  voided_at timestamptz,
  check (
    (kind = 'payment' and amount_uah > 0)
    or (kind in ('lesson_charge', 'refund', 'adjustment'))
  )
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index teacher_students_teacher_idx on public.teacher_students (school_id, teacher_id) where is_active;
create index lessons_teacher_time_idx on public.lessons (teacher_id, starts_at);
create index lesson_students_student_idx on public.lesson_students (student_id);
create index wallet_student_idx on public.wallet_ledger (school_id, student_id, created_at desc);
create index homework_students_student_idx on public.homework_students (student_id);

-- Role and ownership helpers used by the RLS policies below.
create or replace function public.my_role(p_school_id uuid)
returns public.app_role
language sql stable security definer set search_path = public
as $$
  select role from public.school_memberships
  where school_id = p_school_id and user_id = auth.uid() and status = 'active'
  limit 1
$$;

create or replace function public.is_school_admin(p_school_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.my_role(p_school_id) = 'admin' $$;

create or replace function public.is_lesson_teacher(p_lesson_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.lessons where id = p_lesson_id and teacher_id = auth.uid())
$$;

create or replace function public.is_lesson_student(p_lesson_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.lesson_students where lesson_id = p_lesson_id and student_id = auth.uid()
  )
$$;

-- A security-definer helper avoids RLS policy recursion between homework and
-- homework_students when a student loads their published assignments.
create or replace function public.is_homework_recipient(p_homework_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.homework_students
    where homework_id = p_homework_id and student_id = auth.uid()
  )
$$;

alter table public.profiles enable row level security;
alter table public.schools enable row level security;
alter table public.school_memberships enable row level security;
alter table public.registration_requests enable row level security;
alter table public.subjects enable row level security;
alter table public.teacher_students enable row level security;
alter table public.student_rates enable row level security;
alter table public.lessons enable row level security;
alter table public.lesson_students enable row level security;
alter table public.homework enable row level security;
alter table public.homework_students enable row level security;
alter table public.homework_submissions enable row level security;
alter table public.file_attachments enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.audit_events enable row level security;

create policy "profiles_read_own_or_related" on public.profiles for select to authenticated using (
  id = auth.uid()
  or exists (
    select 1 from public.teacher_students ts
    where (
      (ts.teacher_id = auth.uid() and ts.student_id = profiles.id)
      or (ts.student_id = auth.uid() and ts.teacher_id = profiles.id)
    ) and ts.is_active
  )
  or exists (
    select 1 from public.school_memberships target
    where target.user_id = profiles.id and public.is_school_admin(target.school_id)
  )
);
create policy "profiles_update_own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "schools_read_member" on public.schools for select to authenticated using (public.my_role(id) is not null);
create policy "schools_update_admin" on public.schools for update to authenticated using (public.is_school_admin(id));

create policy "memberships_read_member" on public.school_memberships for select to authenticated using (user_id = auth.uid() or public.is_school_admin(school_id));
create policy "memberships_admin_manage" on public.school_memberships for all to authenticated using (public.is_school_admin(school_id)) with check (public.is_school_admin(school_id));

create policy "registration_request_read_own" on public.registration_requests for select to authenticated using (user_id = auth.uid());
create policy "registration_request_admin_read" on public.registration_requests for select to authenticated using (exists (select 1 from public.school_memberships sm where sm.user_id = auth.uid() and sm.role = 'admin' and sm.status = 'active'));

create policy "subjects_read_member" on public.subjects for select to authenticated using (public.my_role(school_id) is not null);
create policy "subjects_admin_manage" on public.subjects for all to authenticated using (public.is_school_admin(school_id)) with check (public.is_school_admin(school_id));

create policy "teacher_students_read_related" on public.teacher_students for select to authenticated using (teacher_id = auth.uid() or student_id = auth.uid() or public.is_school_admin(school_id));
create policy "teacher_students_admin_manage" on public.teacher_students for all to authenticated using (public.is_school_admin(school_id)) with check (public.is_school_admin(school_id));

create policy "rates_admin_only" on public.student_rates for all to authenticated using (public.is_school_admin(school_id)) with check (public.is_school_admin(school_id));

create policy "lessons_read_related" on public.lessons for select to authenticated using (
  teacher_id = auth.uid() or public.is_school_admin(school_id) or public.is_lesson_student(id)
);
create policy "lessons_teacher_create" on public.lessons for insert to authenticated with check (teacher_id = auth.uid() and public.my_role(school_id) = 'teacher');
create policy "lessons_teacher_update" on public.lessons for update to authenticated using (teacher_id = auth.uid() or public.is_school_admin(school_id)) with check (teacher_id = auth.uid() or public.is_school_admin(school_id));
create policy "lessons_teacher_delete" on public.lessons for delete to authenticated using (teacher_id = auth.uid() or public.is_school_admin(school_id));

-- Lesson creation and changes must go through security-definer functions below.
-- This keeps student assignment, price snapshots, status accounting and conflict checks atomic.
alter policy "lessons_teacher_create" on public.lessons with check (false);
alter policy "lessons_teacher_update" on public.lessons using (false) with check (false);

create policy "lesson_students_read_related" on public.lesson_students for select to authenticated using (student_id = auth.uid() or public.is_lesson_teacher(lesson_id) or exists (select 1 from public.lessons l where l.id = lesson_id and public.is_school_admin(l.school_id)));
create policy "lesson_students_teacher_manage" on public.lesson_students for all to authenticated using (public.is_lesson_teacher(lesson_id) or exists (select 1 from public.lessons l where l.id = lesson_id and public.is_school_admin(l.school_id))) with check (public.is_lesson_teacher(lesson_id) or exists (select 1 from public.lessons l where l.id = lesson_id and public.is_school_admin(l.school_id)));

create policy "homework_read_related" on public.homework for select to authenticated using (teacher_id = auth.uid() or public.is_school_admin(school_id) or (status = 'published' and public.is_homework_recipient(id)));
create policy "homework_teacher_manage" on public.homework for all to authenticated using (teacher_id = auth.uid() or public.is_school_admin(school_id)) with check (teacher_id = auth.uid() or public.is_school_admin(school_id));
-- Publishing uses create_homework(), which validates every recipient before insert.
alter policy "homework_teacher_manage" on public.homework using (false) with check (false);

create policy "homework_students_read_related" on public.homework_students for select to authenticated using (student_id = auth.uid() or exists (select 1 from public.homework h where h.id = homework_id and (h.teacher_id = auth.uid() or public.is_school_admin(h.school_id))));
create policy "homework_students_teacher_create" on public.homework_students for insert to authenticated with check (exists (select 1 from public.homework h where h.id = homework_id and (h.teacher_id = auth.uid() or public.is_school_admin(h.school_id))));
create policy "homework_students_teacher_manage" on public.homework_students for update to authenticated using (exists (select 1 from public.homework h where h.id = homework_id and (h.teacher_id = auth.uid() or public.is_school_admin(h.school_id)))) with check (exists (select 1 from public.homework h where h.id = homework_id and (h.teacher_id = auth.uid() or public.is_school_admin(h.school_id))));
alter policy "homework_students_teacher_create" on public.homework_students with check (false);

create policy "submissions_read_related" on public.homework_submissions for select to authenticated using (student_id = auth.uid() or exists (select 1 from public.homework_students hs join public.homework h on h.id = hs.homework_id where hs.id = homework_student_id and (h.teacher_id = auth.uid() or public.is_school_admin(h.school_id))));
create policy "submissions_student_create" on public.homework_submissions for insert to authenticated with check (student_id = auth.uid() and exists (select 1 from public.homework_students where id = homework_student_id and student_id = auth.uid()));
-- The submit_homework() RPC inserts a submission and updates the recipient status together.
alter policy "submissions_student_create" on public.homework_submissions with check (false);

create policy "attachments_read_related" on public.file_attachments for select to authenticated using (
  uploaded_by = auth.uid()
  or public.is_school_admin(school_id)
  or (lesson_id is not null and (public.is_lesson_teacher(lesson_id) or public.is_lesson_student(lesson_id)))
  or (homework_id is not null and exists (select 1 from public.homework h where h.id = homework_id and (h.teacher_id = auth.uid() or (h.status = 'published' and exists (select 1 from public.homework_students hs where hs.homework_id = h.id and hs.student_id = auth.uid())))))
  or (submission_id is not null and exists (select 1 from public.homework_submissions s join public.homework_students hs on hs.id = s.homework_student_id join public.homework h on h.id = hs.homework_id where s.id = submission_id and (s.student_id = auth.uid() or h.teacher_id = auth.uid())))
  or (homework_student_id is not null and exists (select 1 from public.homework_students hs join public.homework h on h.id = hs.homework_id where hs.id = homework_student_id and (hs.student_id = auth.uid() or h.teacher_id = auth.uid())))
);

create policy "wallet_admin_read" on public.wallet_ledger for select to authenticated using (public.is_school_admin(school_id));
create policy "wallet_teacher_create_payment" on public.wallet_ledger for insert to authenticated with check (kind = 'payment' and created_by = auth.uid() and teacher_id = auth.uid() and exists (select 1 from public.teacher_students ts where ts.school_id = wallet_ledger.school_id and ts.teacher_id = auth.uid() and ts.student_id = wallet_ledger.student_id and ts.is_active));
create policy "wallet_admin_manage" on public.wallet_ledger for all to authenticated using (public.is_school_admin(school_id)) with check (public.is_school_admin(school_id));

create policy "audit_admin_read" on public.audit_events for select to authenticated using (public.is_school_admin(school_id));

create or replace function public.can_access_file(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.file_attachments fa
    where fa.storage_path = p_path
      and (
        fa.uploaded_by = auth.uid()
        or public.is_school_admin(fa.school_id)
        or (fa.lesson_id is not null and (public.is_lesson_teacher(fa.lesson_id) or public.is_lesson_student(fa.lesson_id)))
        or (fa.homework_id is not null and exists (select 1 from public.homework h where h.id = fa.homework_id and (h.teacher_id = auth.uid() or (h.status = 'published' and exists (select 1 from public.homework_students hs where hs.homework_id = h.id and hs.student_id = auth.uid())))))
        or (fa.submission_id is not null and exists (select 1 from public.homework_submissions s join public.homework_students hs on hs.id = s.homework_student_id join public.homework h on h.id = hs.homework_id where s.id = fa.submission_id and (s.student_id = auth.uid() or h.teacher_id = auth.uid())))
        or (fa.homework_student_id is not null and exists (select 1 from public.homework_students hs join public.homework h on h.id = hs.homework_id where hs.id = fa.homework_student_id and (hs.student_id = auth.uid() or h.teacher_id = auth.uid())))
      )
  )
$$;

create or replace function public.register_file_attachment(
  p_school_id uuid,
  p_storage_path text,
  p_original_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_lesson_id uuid default null,
  p_homework_id uuid default null,
  p_submission_id uuid default null,
  p_homework_student_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_allowed boolean := false;
  v_target_school_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if num_nonnulls(p_lesson_id, p_homework_id, p_submission_id, p_homework_student_id) <> 1 then raise exception 'Exactly one file target is required'; end if;
  if (storage.foldername(p_storage_path))[1] <> auth.uid()::text then raise exception 'Invalid storage path'; end if;

  if p_lesson_id is not null then
    select school_id into v_target_school_id from public.lessons where id = p_lesson_id;
    v_allowed := public.is_lesson_teacher(p_lesson_id) or public.is_lesson_student(p_lesson_id);
  elsif p_homework_id is not null then
    select school_id into v_target_school_id from public.homework where id = p_homework_id;
    v_allowed := exists (select 1 from public.homework h where h.id = p_homework_id and (h.teacher_id = auth.uid() or (h.status = 'published' and exists (select 1 from public.homework_students hs where hs.homework_id = h.id and hs.student_id = auth.uid()))));
  elsif p_submission_id is not null then
    select h.school_id into v_target_school_id from public.homework_submissions s join public.homework_students hs on hs.id = s.homework_student_id join public.homework h on h.id = hs.homework_id where s.id = p_submission_id;
    v_allowed := exists (select 1 from public.homework_submissions s join public.homework_students hs on hs.id = s.homework_student_id join public.homework h on h.id = hs.homework_id where s.id = p_submission_id and (s.student_id = auth.uid() or h.teacher_id = auth.uid()));
  elsif p_homework_student_id is not null then
    select h.school_id into v_target_school_id from public.homework_students hs join public.homework h on h.id = hs.homework_id where hs.id = p_homework_student_id;
    v_allowed := exists (select 1 from public.homework_students hs join public.homework h on h.id = hs.homework_id where hs.id = p_homework_student_id and (hs.student_id = auth.uid() or h.teacher_id = auth.uid()));
  end if;
  if not v_allowed then raise exception 'Access denied'; end if;
  if v_target_school_id is distinct from p_school_id then raise exception 'Invalid school for attachment'; end if;

  insert into public.file_attachments (school_id, uploaded_by, lesson_id, homework_id, submission_id, homework_student_id, storage_path, original_name, mime_type, byte_size)
  values (p_school_id, auth.uid(), p_lesson_id, p_homework_id, p_submission_id, p_homework_student_id, p_storage_path, p_original_name, p_mime_type, p_byte_size)
  returning id into v_id;
  return v_id;
end;
$$;

-- The very first authenticated account creates the school and becomes its administrator.
-- Once a school exists, this function refuses every further call.
create or replace function public.bootstrap_school(p_school_name text, p_full_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_school_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from public.schools) then raise exception 'A school already exists'; end if;
  if char_length(trim(p_school_name)) < 2 then raise exception 'School name is required'; end if;

  insert into public.profiles (id, full_name, requested_role)
  values (auth.uid(), trim(p_full_name), 'admin')
  on conflict (id) do update set full_name = excluded.full_name, requested_role = 'admin', updated_at = now();

  insert into public.schools (name, owner_id) values (trim(p_school_name), auth.uid()) returning id into v_school_id;
  insert into public.school_memberships (school_id, user_id, role, status, approved_by, approved_at)
  values (v_school_id, auth.uid(), 'admin', 'active', auth.uid(), now());
  return v_school_id;
end;
$$;

-- This exposes only whether the first-school setup is still available.
create or replace function public.can_bootstrap_school()
returns boolean
language sql stable security definer set search_path = public
as $$
  select not exists (select 1 from public.schools)
$$;

grant execute on function public.can_bootstrap_school() to authenticated;

-- Public registration creates only a pending request. It never grants a role.
create or replace function public.request_membership(p_full_name text, p_requested_role public.app_role)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_requested_role = 'admin' then raise exception 'Admin role cannot be requested'; end if;
  if char_length(trim(p_full_name)) < 2 then raise exception 'Full name is required'; end if;

  insert into public.profiles (id, full_name, requested_role)
  values (auth.uid(), trim(p_full_name), p_requested_role)
  on conflict (id) do update set full_name = excluded.full_name, requested_role = excluded.requested_role, updated_at = now();

  insert into public.registration_requests (user_id, requested_role, full_name, status)
  values (auth.uid(), p_requested_role, trim(p_full_name), 'pending')
  on conflict (user_id) do update set requested_role = excluded.requested_role, full_name = excluded.full_name, status = 'pending', decided_at = null, decided_by = null;
end;
$$;

create or replace function public.approve_registration(p_request_id uuid, p_school_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_request public.registration_requests;
begin
  if not public.is_school_admin(p_school_id) then raise exception 'Admin access required'; end if;
  select * into v_request from public.registration_requests where id = p_request_id and status = 'pending' for update;
  if not found then raise exception 'Pending request not found'; end if;

  insert into public.school_memberships (school_id, user_id, role, status, approved_by, approved_at)
  values (p_school_id, v_request.user_id, v_request.requested_role, 'active', auth.uid(), now())
  on conflict (school_id, user_id) do update set role = excluded.role, status = 'active', approved_by = auth.uid(), approved_at = now();

  update public.registration_requests set status = 'active', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
end;
$$;

-- Changes to chargeable lesson statuses are made only through this function.
-- It records compensating ledger entries instead of rewriting historical balances.
create or replace function public.set_lesson_status(p_lesson_id uuid, p_status public.lesson_status, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_lesson public.lessons;
  v_was_chargeable boolean;
  v_is_chargeable boolean;
  v_student record;
begin
  select * into v_lesson from public.lessons where id = p_lesson_id for update;
  if not found then raise exception 'Lesson not found'; end if;
  if v_lesson.teacher_id <> auth.uid() and not public.is_school_admin(v_lesson.school_id) then raise exception 'Access denied'; end if;

  v_was_chargeable := v_lesson.status in ('completed', 'cancelled_paid');
  v_is_chargeable := p_status in ('completed', 'cancelled_paid');
  perform set_config('teacher_portal.lesson_status_via_rpc', 'true', true);
  update public.lessons set status = p_status, teacher_note = coalesce(p_note, teacher_note), updated_at = now() where id = p_lesson_id;

  if not v_was_chargeable and v_is_chargeable then
    for v_student in select * from public.lesson_students where lesson_id = p_lesson_id loop
      insert into public.wallet_ledger (school_id, student_id, teacher_id, lesson_id, kind, amount_uah, teacher_payout_uah, note, created_by)
      values (v_lesson.school_id, v_student.student_id, v_lesson.teacher_id, p_lesson_id, 'lesson_charge', -v_student.price_snapshot_uah, v_student.teacher_payout_snapshot_uah, case when p_status = 'cancelled_paid' then 'Скасоване заняття з оплатою' else 'Проведене заняття' end, auth.uid());
    end loop;
  elsif v_was_chargeable and not v_is_chargeable then
    for v_student in select * from public.lesson_students where lesson_id = p_lesson_id loop
      insert into public.wallet_ledger (school_id, student_id, teacher_id, lesson_id, kind, amount_uah, teacher_payout_uah, note, created_by)
      values (v_lesson.school_id, v_student.student_id, v_lesson.teacher_id, p_lesson_id, 'adjustment', v_student.price_snapshot_uah, -v_student.teacher_payout_snapshot_uah, 'Коригування статусу заняття', auth.uid());
    end loop;
  end if;
end;
$$;

-- Status changes create financial operations, so they may only go through
-- set_lesson_status() rather than a direct browser update.
create or replace function public.prevent_direct_lesson_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
    and current_setting('teacher_portal.lesson_status_via_rpc', true) is distinct from 'true' then
    raise exception 'Use set_lesson_status to change a lesson status';
  end if;
  return new;
end;
$$;

create trigger lessons_status_via_rpc_only
before update of status on public.lessons
for each row execute function public.prevent_direct_lesson_status_change();

create or replace function public.prevent_financial_lesson_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.wallet_ledger where lesson_id = old.id and status = 'confirmed') then
    raise exception 'A lesson with financial history cannot be deleted; cancel it instead';
  end if;
  return old;
end;
$$;

create trigger lessons_keep_financial_history
before delete on public.lessons
for each row execute function public.prevent_financial_lesson_delete();

create or replace function public.create_lesson(
  p_school_id uuid,
  p_subject_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_student_ids uuid[],
  p_meeting_url text default null,
  p_location_text text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_lesson_id uuid;
  v_student_id uuid;
  v_rate public.student_rates;
begin
  if auth.uid() is null or public.my_role(p_school_id) <> 'teacher' then raise exception 'Teacher access required'; end if;
  if p_ends_at <= p_starts_at then raise exception 'End must be after start'; end if;
  if coalesce(array_length(p_student_ids, 1), 0) = 0 then raise exception 'At least one student is required'; end if;
  if char_length(trim(p_title)) < 2 then raise exception 'Lesson title is required'; end if;
  if not exists (select 1 from public.subjects where id = p_subject_id and school_id = p_school_id and is_active) then
    raise exception 'Selected subject is unavailable';
  end if;
  -- Calendar free slots are a convenience in the UI; this server check prevents
  -- overlapping active lessons when two browser sessions are open at once.
  if exists (
    select 1 from public.lessons l
    where l.teacher_id = auth.uid()
      and l.status not in ('cancelled', 'cancelled_paid')
      and l.starts_at < p_ends_at
      and l.ends_at > p_starts_at
  ) then
    raise exception 'This time overlaps an existing lesson';
  end if;

  insert into public.lessons (school_id, teacher_id, subject_id, title, starts_at, ends_at, meeting_url, location_text)
  values (p_school_id, auth.uid(), p_subject_id, trim(p_title), p_starts_at, p_ends_at, nullif(trim(p_meeting_url), ''), nullif(trim(p_location_text), ''))
  returning id into v_lesson_id;

  foreach v_student_id in array p_student_ids loop
    if not exists (select 1 from public.teacher_students ts where ts.school_id = p_school_id and ts.teacher_id = auth.uid() and ts.student_id = v_student_id and ts.is_active) then
      raise exception 'Selected student is not assigned to this teacher';
    end if;

    select * into v_rate
    from public.student_rates sr
    where sr.school_id = p_school_id
      and sr.student_id = v_student_id
      and (sr.teacher_id is null or sr.teacher_id = auth.uid())
      and (sr.subject_id is null or sr.subject_id = p_subject_id)
      and sr.active_from <= p_starts_at::date
      and (sr.active_to is null or sr.active_to >= p_starts_at::date)
    order by (sr.teacher_id is not null) desc, (sr.subject_id is not null) desc, sr.active_from desc
    limit 1;
    if not found then raise exception 'No active price is set for selected student'; end if;

    insert into public.lesson_students (lesson_id, student_id, price_snapshot_uah, teacher_payout_snapshot_uah)
    values (v_lesson_id, v_student_id, v_rate.lesson_price_uah, v_rate.teacher_payout_uah);
  end loop;
  return v_lesson_id;
end;
$$;

create or replace function public.create_homework(
  p_school_id uuid,
  p_lesson_id uuid,
  p_title text,
  p_description text default '',
  p_deadline_at timestamptz default null,
  p_student_ids uuid[] default '{}'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_homework_id uuid;
  v_student_id uuid;
  v_lesson public.lessons;
  v_recipients uuid[];
begin
  if auth.uid() is null or public.my_role(p_school_id) <> 'teacher' then raise exception 'Teacher access required'; end if;
  if char_length(trim(p_title)) < 2 then raise exception 'Homework title is required'; end if;

  if p_lesson_id is not null then
    select * into v_lesson from public.lessons where id = p_lesson_id and school_id = p_school_id;
    if not found or v_lesson.teacher_id <> auth.uid() then raise exception 'Lesson access denied'; end if;
    select coalesce(array_agg(student_id), '{}') into v_recipients from public.lesson_students where lesson_id = p_lesson_id;
  else
    v_recipients := p_student_ids;
  end if;

  if coalesce(array_length(v_recipients, 1), 0) = 0 then raise exception 'At least one student is required'; end if;
  foreach v_student_id in array v_recipients loop
    if not exists (
      select 1 from public.teacher_students ts
      where ts.school_id = p_school_id and ts.teacher_id = auth.uid() and ts.student_id = v_student_id and ts.is_active
    ) then
      raise exception 'Selected student is not assigned to this teacher';
    end if;
  end loop;

  insert into public.homework (school_id, lesson_id, teacher_id, title, description, deadline_at, status, published_at)
  values (p_school_id, p_lesson_id, auth.uid(), trim(p_title), coalesce(p_description, ''), p_deadline_at, 'published', now())
  returning id into v_homework_id;

  foreach v_student_id in array v_recipients loop
    insert into public.homework_students (homework_id, student_id) values (v_homework_id, v_student_id);
  end loop;
  return v_homework_id;
end;
$$;

create or replace function public.submit_homework(p_homework_student_id uuid, p_body text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_submission_id uuid;
begin
  if not exists (select 1 from public.homework_students where id = p_homework_student_id and student_id = auth.uid()) then
    raise exception 'Access denied';
  end if;
  insert into public.homework_submissions (homework_student_id, student_id, body)
  values (p_homework_student_id, auth.uid(), coalesce(p_body, ''))
  returning id into v_submission_id;
  update public.homework_students set status = 'submitted' where id = p_homework_student_id;
  return v_submission_id;
end;
$$;

-- Private bucket. SQL does not store binary data.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portal-files', 'portal-files', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create policy "portal_files_read_related" on storage.objects for select to authenticated using (
  bucket_id = 'portal-files' and public.can_access_file(name)
);
create policy "portal_files_upload_own_folder" on storage.objects for insert to authenticated with check (
  bucket_id = 'portal-files' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "portal_files_delete_owner" on storage.objects for delete to authenticated using (
  bucket_id = 'portal-files' and owner_id = auth.uid()::text
);
