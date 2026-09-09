-- Safe teacher replacement and optional read-only student archive sharing.
-- Run after production_schema.sql and refine_exercises_for_homework.sql.

create table if not exists public.teacher_student_transfers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  previous_teacher_id uuid not null references auth.users(id) on delete cascade,
  new_teacher_id uuid not null references auth.users(id) on delete cascade,
  archive_access boolean not null default false,
  transferred_by uuid references auth.users(id) on delete set null,
  transferred_at timestamptz not null default now(),
  unique (school_id, student_id, previous_teacher_id, new_teacher_id),
  check (previous_teacher_id <> new_teacher_id),
  check (student_id <> previous_teacher_id and student_id <> new_teacher_id)
);

create index if not exists teacher_student_transfers_new_teacher_idx
  on public.teacher_student_transfers (school_id, new_teacher_id, student_id)
  where archive_access;

alter table public.teacher_student_transfers enable row level security;

create or replace function public.can_view_transferred_student_archive(
  p_school_id uuid,
  p_student_id uuid,
  p_previous_teacher_id uuid
)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.teacher_student_transfers transfer_row
    join public.teacher_students active_relation
      on active_relation.school_id = transfer_row.school_id
      and active_relation.teacher_id = transfer_row.new_teacher_id
      and active_relation.student_id = transfer_row.student_id
      and active_relation.is_active
    join public.school_memberships current_membership
      on current_membership.school_id = transfer_row.school_id
      and current_membership.user_id = transfer_row.new_teacher_id
      and current_membership.status = 'active'
      and 'teacher'::public.app_role = any(current_membership.roles)
    where transfer_row.school_id = p_school_id
      and transfer_row.student_id = p_student_id
      and transfer_row.previous_teacher_id = p_previous_teacher_id
      and transfer_row.new_teacher_id = auth.uid()
      and transfer_row.archive_access
  )
$$;

drop policy if exists "teacher_student_transfers_read_related" on public.teacher_student_transfers;
create policy "teacher_student_transfers_read_related" on public.teacher_student_transfers
for select to authenticated using (
  public.is_school_admin(school_id)
  or public.can_view_transferred_student_archive(school_id, student_id, previous_teacher_id)
);

create or replace function public.can_view_transferred_lesson(p_lesson_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.lessons lesson
    join public.lesson_students lesson_student on lesson_student.lesson_id = lesson.id
    where lesson.id = p_lesson_id
      and lesson.status in ('completed', 'cancelled', 'cancelled_paid')
      and public.can_view_transferred_student_archive(lesson.school_id, lesson_student.student_id, lesson.teacher_id)
  )
$$;

create or replace function public.can_view_transferred_lesson_student(
  p_lesson_id uuid,
  p_student_id uuid
)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.lessons lesson
    join public.lesson_students lesson_student on lesson_student.lesson_id = lesson.id
    where lesson.id = p_lesson_id
      and lesson_student.student_id = p_student_id
      and lesson.status in ('completed', 'cancelled', 'cancelled_paid')
      and public.can_view_transferred_student_archive(lesson.school_id, lesson_student.student_id, lesson.teacher_id)
  )
$$;

create or replace function public.can_view_transferred_homework(p_homework_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.homework homework_row
    join public.homework_students recipient on recipient.homework_id = homework_row.id
    where homework_row.id = p_homework_id
      and homework_row.status in ('published', 'archived')
      and public.can_view_transferred_student_archive(homework_row.school_id, recipient.student_id, homework_row.teacher_id)
  )
$$;

create or replace function public.can_view_transferred_homework_recipient(p_homework_student_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.homework_students recipient
    join public.homework homework_row on homework_row.id = recipient.homework_id
    where recipient.id = p_homework_student_id
      and homework_row.status in ('published', 'archived')
      and public.can_view_transferred_student_archive(homework_row.school_id, recipient.student_id, homework_row.teacher_id)
  )
$$;

create or replace function public.can_view_transferred_submission(p_submission_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.homework_submissions submission
    where submission.id = p_submission_id
      and public.can_view_transferred_homework_recipient(submission.homework_student_id)
  )
$$;

create or replace function public.can_view_transferred_exercise_template(p_template_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.exercise_templates template
    join public.exercise_assignments assignment_row on assignment_row.template_id = template.id
    join public.exercise_assignment_students exercise_recipient on exercise_recipient.assignment_id = assignment_row.id
    join public.homework_students homework_recipient on homework_recipient.id = exercise_recipient.homework_student_id
    join public.homework homework_row on homework_row.id = homework_recipient.homework_id and homework_row.id = assignment_row.homework_id
    where template.id = p_template_id
      and homework_row.status in ('published', 'archived')
      and public.can_view_transferred_student_archive(template.school_id, homework_recipient.student_id, template.teacher_id)
  )
$$;

create or replace function public.can_view_transferred_exercise_assignment(p_assignment_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.exercise_assignments assignment_row
    join public.exercise_assignment_students exercise_recipient on exercise_recipient.assignment_id = assignment_row.id
    join public.homework_students homework_recipient on homework_recipient.id = exercise_recipient.homework_student_id
    join public.homework homework_row on homework_row.id = homework_recipient.homework_id and homework_row.id = assignment_row.homework_id
    where assignment_row.id = p_assignment_id
      and homework_row.status in ('published', 'archived')
      and public.can_view_transferred_student_archive(assignment_row.school_id, homework_recipient.student_id, assignment_row.teacher_id)
  )
$$;

create or replace function public.can_view_transferred_exercise_recipient(p_recipient_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.exercise_assignment_students exercise_recipient
    where exercise_recipient.id = p_recipient_id
      and public.can_view_transferred_exercise_assignment(exercise_recipient.assignment_id)
  )
$$;

create or replace function public.can_view_transferred_exercise_attempt(p_attempt_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.exercise_attempts attempt
    where attempt.id = p_attempt_id
      and public.can_view_transferred_exercise_recipient(attempt.assignment_student_id)
  )
$$;

create or replace function public.replace_student_teacher(
  p_school_id uuid,
  p_student_id uuid,
  p_previous_teacher_id uuid,
  p_new_teacher_id uuid,
  p_share_archive boolean default false
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_school_admin(p_school_id) then
    raise exception 'Administrator access required';
  end if;
  if p_previous_teacher_id = p_new_teacher_id then
    raise exception 'Choose a different new teacher';
  end if;
  if not exists (
    select 1 from public.teacher_students
    where school_id = p_school_id
      and teacher_id = p_previous_teacher_id
      and student_id = p_student_id
      and is_active
  ) then
    raise exception 'Selected teacher is not currently assigned to this student';
  end if;
  if not exists (
    select 1 from public.school_memberships
    where school_id = p_school_id
      and user_id = p_new_teacher_id
      and status = 'active'
      and 'teacher'::public.app_role = any(roles)
  ) then
    raise exception 'New teacher needs an active teacher role';
  end if;

  update public.teacher_students
  set is_active = false
  where school_id = p_school_id
    and teacher_id = p_previous_teacher_id
    and student_id = p_student_id;

  insert into public.teacher_students (school_id, teacher_id, student_id, is_active)
  values (p_school_id, p_new_teacher_id, p_student_id, true)
  on conflict (school_id, teacher_id, student_id)
  do update set is_active = true;

  insert into public.teacher_student_transfers (
    school_id,
    student_id,
    previous_teacher_id,
    new_teacher_id,
    archive_access,
    transferred_by
  ) values (
    p_school_id,
    p_student_id,
    p_previous_teacher_id,
    p_new_teacher_id,
    coalesce(p_share_archive, false),
    auth.uid()
  )
  on conflict (school_id, student_id, previous_teacher_id, new_teacher_id)
  do update set
    archive_access = excluded.archive_access,
    transferred_by = excluded.transferred_by,
    transferred_at = now();

  insert into public.audit_events (school_id, actor_id, event_type, entity_type, entity_id, payload)
  values (
    p_school_id,
    auth.uid(),
    'teacher_replaced',
    'teacher_student',
    p_student_id,
    jsonb_build_object(
      'previous_teacher_id', p_previous_teacher_id,
      'new_teacher_id', p_new_teacher_id,
      'archive_access', coalesce(p_share_archive, false)
    )
  );
end;
$$;

grant execute on function public.replace_student_teacher(uuid, uuid, uuid, uuid, boolean) to authenticated;

drop policy if exists "lessons_read_related" on public.lessons;
create policy "lessons_read_related" on public.lessons for select to authenticated using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or public.is_lesson_student(id)
  or public.can_view_transferred_lesson(id)
);

drop policy if exists "lesson_students_read_related" on public.lesson_students;
create policy "lesson_students_read_related" on public.lesson_students for select to authenticated using (
  student_id = auth.uid()
  or public.is_lesson_teacher(lesson_id)
  or exists (select 1 from public.lessons lesson where lesson.id = lesson_id and public.is_school_admin(lesson.school_id))
  or public.can_view_transferred_lesson_student(lesson_id, student_id)
);

drop policy if exists "homework_read_related" on public.homework;
create policy "homework_read_related" on public.homework for select to authenticated using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or (status = 'published' and public.is_homework_recipient(id))
  or public.can_view_transferred_homework(id)
);

drop policy if exists "homework_students_read_related" on public.homework_students;
create policy "homework_students_read_related" on public.homework_students for select to authenticated using (
  student_id = auth.uid()
  or exists (
    select 1 from public.homework homework_row
    where homework_row.id = homework_id
      and (homework_row.teacher_id = auth.uid() or public.is_school_admin(homework_row.school_id))
  )
  or public.can_view_transferred_homework_recipient(id)
);

drop policy if exists "submissions_read_related" on public.homework_submissions;
create policy "submissions_read_related" on public.homework_submissions for select to authenticated using (
  student_id = auth.uid()
  or exists (
    select 1
    from public.homework_students recipient
    join public.homework homework_row on homework_row.id = recipient.homework_id
    where recipient.id = homework_student_id
      and (homework_row.teacher_id = auth.uid() or public.is_school_admin(homework_row.school_id))
  )
  or public.can_view_transferred_submission(id)
);

drop policy if exists "attachments_read_related" on public.file_attachments;
create policy "attachments_read_related" on public.file_attachments for select to authenticated using (
  uploaded_by = auth.uid()
  or public.is_school_admin(school_id)
  or (lesson_id is not null and (public.is_lesson_teacher(lesson_id) or public.is_lesson_student(lesson_id) or public.can_view_transferred_lesson(lesson_id)))
  or (homework_id is not null and (
    exists (
      select 1 from public.homework homework_row
      where homework_row.id = homework_id
        and (homework_row.teacher_id = auth.uid() or (homework_row.status = 'published' and public.is_homework_recipient(homework_row.id)))
    )
    or public.can_view_transferred_homework(homework_id)
  ))
  or (submission_id is not null and (public.can_view_transferred_submission(submission_id) or exists (
    select 1
    from public.homework_submissions submission
    join public.homework_students recipient on recipient.id = submission.homework_student_id
    join public.homework homework_row on homework_row.id = recipient.homework_id
    where submission.id = submission_id
      and (submission.student_id = auth.uid() or homework_row.teacher_id = auth.uid())
  )))
  or (homework_student_id is not null and (public.can_view_transferred_homework_recipient(homework_student_id) or exists (
    select 1
    from public.homework_students recipient
    join public.homework homework_row on homework_row.id = recipient.homework_id
    where recipient.id = homework_student_id
      and (recipient.student_id = auth.uid() or homework_row.teacher_id = auth.uid())
  )))
);

create or replace function public.can_access_file(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.file_attachments attachment
    where attachment.storage_path = p_path
      and (
        attachment.uploaded_by = auth.uid()
        or public.is_school_admin(attachment.school_id)
        or (attachment.lesson_id is not null and (public.is_lesson_teacher(attachment.lesson_id) or public.is_lesson_student(attachment.lesson_id) or public.can_view_transferred_lesson(attachment.lesson_id)))
        or (attachment.homework_id is not null and (public.can_view_transferred_homework(attachment.homework_id) or exists (
          select 1 from public.homework homework_row
          where homework_row.id = attachment.homework_id
            and (homework_row.teacher_id = auth.uid() or (homework_row.status = 'published' and public.is_homework_recipient(homework_row.id)))
        )))
        or (attachment.submission_id is not null and (public.can_view_transferred_submission(attachment.submission_id) or exists (
          select 1
          from public.homework_submissions submission
          join public.homework_students recipient on recipient.id = submission.homework_student_id
          join public.homework homework_row on homework_row.id = recipient.homework_id
          where submission.id = attachment.submission_id
            and (submission.student_id = auth.uid() or homework_row.teacher_id = auth.uid())
        )))
        or (attachment.homework_student_id is not null and (public.can_view_transferred_homework_recipient(attachment.homework_student_id) or exists (
          select 1
          from public.homework_students recipient
          join public.homework homework_row on homework_row.id = recipient.homework_id
          where recipient.id = attachment.homework_student_id
            and (recipient.student_id = auth.uid() or homework_row.teacher_id = auth.uid())
        )))
      )
  )
$$;

drop policy if exists "exercise_templates_read_related" on public.exercise_templates;
create policy "exercise_templates_read_related" on public.exercise_templates for select to authenticated using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or public.is_exercise_template_recipient(id)
  or public.can_view_transferred_exercise_template(id)
);

drop policy if exists "exercise_assignments_read_related" on public.exercise_assignments;
create policy "exercise_assignments_read_related" on public.exercise_assignments for select to authenticated using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or public.is_exercise_assignment_recipient(id)
  or public.can_view_transferred_exercise_assignment(id)
);

drop policy if exists "exercise_assignment_students_read_related" on public.exercise_assignment_students;
create policy "exercise_assignment_students_read_related" on public.exercise_assignment_students for select to authenticated using (
  student_id = auth.uid()
  or public.can_manage_exercise_recipient(id)
  or public.can_view_transferred_exercise_recipient(id)
);

drop policy if exists "exercise_attempts_read_related" on public.exercise_attempts;
create policy "exercise_attempts_read_related" on public.exercise_attempts for select to authenticated using (
  student_id = auth.uid()
  or public.can_manage_exercise_recipient(assignment_student_id)
  or public.can_view_transferred_exercise_attempt(id)
);
