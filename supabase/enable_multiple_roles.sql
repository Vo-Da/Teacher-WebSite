-- Run once in Supabase SQL Editor for an existing project.
-- Converts one membership role into a set of roles without creating duplicate users.
-- The old column is intentionally kept during this release so already open site tabs stay compatible.
begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'school_memberships' and column_name = 'roles'
  ) then
    alter table public.school_memberships add column roles public.app_role[];
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'school_memberships' and column_name = 'role'
  ) then
    update public.school_memberships set roles = array[role]::public.app_role[] where roles is null;
  end if;
end;
$$;

alter table public.school_memberships drop constraint if exists school_memberships_roles_not_empty;
alter table public.school_memberships alter column roles set not null;
alter table public.school_memberships
  add constraint school_memberships_roles_not_empty check (cardinality(roles) > 0);

create or replace function public.sync_membership_roles()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.roles is null or cardinality(new.roles) = 0 then
    new.roles := array[new.role];
  end if;
  new.role := case
    when 'admin' = any(new.roles) then 'admin'::public.app_role
    when 'teacher' = any(new.roles) then 'teacher'::public.app_role
    else 'student'::public.app_role
  end;
  return new;
end;
$$;

drop trigger if exists school_memberships_sync_roles on public.school_memberships;
create trigger school_memberships_sync_roles
before insert or update of role, roles on public.school_memberships
for each row execute function public.sync_membership_roles();

create or replace function public.my_role(p_school_id uuid)
returns public.app_role
language sql stable security definer set search_path = public
as $$
  select roles[1] from public.school_memberships
  where school_id = p_school_id and user_id = auth.uid() and status = 'active'
  limit 1
$$;

create or replace function public.is_school_member(p_school_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.school_memberships
    where school_id = p_school_id and user_id = auth.uid() and status = 'active'
  )
$$;

create or replace function public.has_school_role(p_school_id uuid, p_role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.school_memberships
    where school_id = p_school_id
      and user_id = auth.uid()
      and status = 'active'
      and p_role = any(roles)
  )
$$;

create or replace function public.is_school_admin(p_school_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.has_school_role(p_school_id, 'admin') $$;

alter policy "schools_read_member" on public.schools using (public.is_school_member(id));
alter policy "subjects_read_member" on public.subjects using (public.is_school_member(school_id));
alter policy "lessons_teacher_create" on public.lessons with check (false);

drop policy if exists "registration_request_admin_read" on public.registration_requests;
create policy "registration_request_admin_read" on public.registration_requests for select to authenticated using (
  exists (select 1 from public.schools s where public.is_school_admin(s.id))
);

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
  insert into public.school_memberships (school_id, user_id, roles, status, approved_by, approved_at)
  values (v_school_id, auth.uid(), array['admin']::public.app_role[], 'active', auth.uid(), now());
  return v_school_id;
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

  insert into public.school_memberships (school_id, user_id, roles, status, approved_by, approved_at)
  values (p_school_id, v_request.user_id, array[v_request.requested_role], 'active', auth.uid(), now())
  on conflict (school_id, user_id) do update set roles = excluded.roles, status = 'active', approved_by = auth.uid(), approved_at = now();

  update public.registration_requests set status = 'active', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
end;
$$;

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
  if auth.uid() is null or not public.has_school_role(p_school_id, 'teacher') then raise exception 'Teacher access required'; end if;
  if p_ends_at <= p_starts_at then raise exception 'End must be after start'; end if;
  if coalesce(array_length(p_student_ids, 1), 0) = 0 then raise exception 'At least one student is required'; end if;
  if char_length(trim(p_title)) < 2 then raise exception 'Lesson title is required'; end if;
  if not exists (select 1 from public.subjects where id = p_subject_id and school_id = p_school_id and is_active) then
    raise exception 'Selected subject is unavailable';
  end if;
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
  if auth.uid() is null or not public.has_school_role(p_school_id, 'teacher') then raise exception 'Teacher access required'; end if;
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

grant execute on function public.is_school_member(uuid) to authenticated;
grant execute on function public.has_school_role(uuid, public.app_role) to authenticated;

commit;
