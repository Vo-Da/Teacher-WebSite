-- Interactive exercise library for Teacher Portal.
-- Run this once in Supabase SQL Editor after production_schema.sql.

create table if not exists public.exercise_templates (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('multiple_choice', 'multiple_select', 'fill_blank', 'word_order', 'matching_pairs', 'wordwall')),
  title text not null check (char_length(trim(title)) between 2 and 200),
  prompt text not null default '' check (char_length(prompt) <= 10000),
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Answer keys are deliberately separate: students can read a template, never its correct answers.
create table if not exists public.exercise_template_answers (
  template_id uuid primary key references public.exercise_templates(id) on delete cascade,
  answer_data jsonb not null default '{}'::jsonb check (jsonb_typeof(answer_data) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.exercise_assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  template_id uuid not null references public.exercise_templates(id) on delete restrict,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  deadline_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.exercise_assignment_students (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.exercise_assignments(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started', 'completed', 'submitted', 'reviewed')),
  attempts_count integer not null default 0 check (attempts_count >= 0),
  best_score integer,
  total_score integer,
  completed_at timestamptz,
  reviewed_at timestamptz,
  unique (assignment_id, student_id),
  check (best_score is null or best_score >= 0),
  check (total_score is null or total_score >= 0),
  check (best_score is null or total_score is null or best_score <= total_score)
);

create table if not exists public.exercise_attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_student_id uuid not null references public.exercise_assignment_students(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  score integer,
  total_score integer,
  submitted_at timestamptz not null default now(),
  check (score is null or score >= 0),
  check (total_score is null or total_score >= 0),
  check (score is null or total_score is null or score <= total_score)
);

create index if not exists exercise_templates_school_teacher_idx on public.exercise_templates (school_id, teacher_id, created_at desc);
create index if not exists exercise_template_answers_template_idx on public.exercise_template_answers (template_id);
create index if not exists exercise_assignments_teacher_idx on public.exercise_assignments (school_id, teacher_id, created_at desc);
create index if not exists exercise_assignment_students_student_idx on public.exercise_assignment_students (student_id, status);
create index if not exists exercise_attempts_assignment_student_idx on public.exercise_attempts (assignment_student_id, submitted_at desc);

create or replace function public.is_exercise_template_recipient(p_template_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.exercise_assignments assignment_row
    join public.exercise_assignment_students recipient on recipient.assignment_id = assignment_row.id
    where assignment_row.template_id = p_template_id
      and recipient.student_id = auth.uid()
  )
$$;

create or replace function public.is_exercise_assignment_recipient(p_assignment_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.exercise_assignment_students
    where assignment_id = p_assignment_id and student_id = auth.uid()
  )
$$;

create or replace function public.can_manage_exercise_assignment(p_assignment_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.exercise_assignments
    where id = p_assignment_id
      and (teacher_id = auth.uid() or public.is_school_admin(school_id))
  )
$$;

create or replace function public.can_manage_exercise_recipient(p_recipient_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.exercise_assignment_students recipient
    join public.exercise_assignments assignment_row on assignment_row.id = recipient.assignment_id
    where recipient.id = p_recipient_id
      and (assignment_row.teacher_id = auth.uid() or public.is_school_admin(assignment_row.school_id))
  )
$$;

alter table public.exercise_templates enable row level security;
alter table public.exercise_template_answers enable row level security;
alter table public.exercise_assignments enable row level security;
alter table public.exercise_assignment_students enable row level security;
alter table public.exercise_attempts enable row level security;

drop policy if exists "exercise_templates_read_related" on public.exercise_templates;
create policy "exercise_templates_read_related" on public.exercise_templates for select to authenticated using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or public.is_exercise_template_recipient(id)
);

drop policy if exists "exercise_templates_teacher_create" on public.exercise_templates;
create policy "exercise_templates_teacher_create" on public.exercise_templates for insert to authenticated with check (
  teacher_id = auth.uid() and public.has_school_role(school_id, 'teacher')
);

drop policy if exists "exercise_templates_teacher_update" on public.exercise_templates;
create policy "exercise_templates_teacher_update" on public.exercise_templates for update to authenticated
using (teacher_id = auth.uid() or public.is_school_admin(school_id))
with check (teacher_id = auth.uid() or public.is_school_admin(school_id));

drop policy if exists "exercise_templates_teacher_delete" on public.exercise_templates;
create policy "exercise_templates_teacher_delete" on public.exercise_templates for delete to authenticated using (
  teacher_id = auth.uid() or public.is_school_admin(school_id)
);

drop policy if exists "exercise_template_answers_teacher_manage" on public.exercise_template_answers;
create policy "exercise_template_answers_teacher_manage" on public.exercise_template_answers for all to authenticated
using (exists (
  select 1 from public.exercise_templates template
  where template.id = template_id
    and (template.teacher_id = auth.uid() or public.is_school_admin(template.school_id))
))
with check (exists (
  select 1 from public.exercise_templates template
  where template.id = template_id
    and (template.teacher_id = auth.uid() or public.is_school_admin(template.school_id))
));

drop policy if exists "exercise_assignments_read_related" on public.exercise_assignments;
create policy "exercise_assignments_read_related" on public.exercise_assignments for select to authenticated using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or public.is_exercise_assignment_recipient(id)
);

drop policy if exists "exercise_assignment_students_read_related" on public.exercise_assignment_students;
create policy "exercise_assignment_students_read_related" on public.exercise_assignment_students for select to authenticated using (
  student_id = auth.uid() or public.can_manage_exercise_recipient(id)
);

drop policy if exists "exercise_attempts_read_related" on public.exercise_attempts;
create policy "exercise_attempts_read_related" on public.exercise_attempts for select to authenticated using (
  student_id = auth.uid() or public.can_manage_exercise_recipient(assignment_student_id)
);

create or replace function public.create_exercise_template(
  p_school_id uuid,
  p_kind text,
  p_title text,
  p_prompt text default '',
  p_content jsonb default '{}'::jsonb,
  p_answer_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_template_id uuid;
begin
  if auth.uid() is null or not public.has_school_role(p_school_id, 'teacher') then
    raise exception 'Teacher access required';
  end if;
  if char_length(trim(p_title)) < 2 then
    raise exception 'Exercise title is required';
  end if;
  if p_kind not in ('multiple_choice', 'fill_blank', 'wordwall') then
    raise exception 'Unsupported exercise type';
  end if;
  if jsonb_typeof(p_content) <> 'object' or jsonb_typeof(p_answer_data) <> 'object' then
    raise exception 'Invalid exercise data';
  end if;
  if p_kind = 'multiple_choice'
    and (
      jsonb_typeof(p_content -> 'options') <> 'array'
      or jsonb_array_length(case when jsonb_typeof(p_content -> 'options') = 'array' then p_content -> 'options' else '[]'::jsonb end) < 2
      or coalesce(p_answer_data ->> 'correctOptionId', '') = ''
      or not exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(p_content -> 'options') = 'array' then p_content -> 'options' else '[]'::jsonb end) option_row
        where option_row ->> 'id' = p_answer_data ->> 'correctOptionId'
      )
    ) then
    raise exception 'Multiple choice needs options and a correct answer';
  end if;
  if p_kind = 'fill_blank'
    and (coalesce(jsonb_typeof(p_answer_data -> 'acceptedAnswers'), '') <> 'array' or jsonb_array_length(case when jsonb_typeof(p_answer_data -> 'acceptedAnswers') = 'array' then p_answer_data -> 'acceptedAnswers' else '[]'::jsonb end) = 0) then
    raise exception 'Fill in the blank needs at least one accepted answer';
  end if;
  if p_kind = 'wordwall' and coalesce(p_content ->> 'url', '') !~ '^https://([a-z0-9-]+\.)?wordwall\.net/' then
    raise exception 'A secure Wordwall link is required';
  end if;

  insert into public.exercise_templates (school_id, teacher_id, kind, title, prompt, content)
  values (p_school_id, auth.uid(), p_kind, trim(p_title), coalesce(p_prompt, ''), p_content)
  returning id into v_template_id;

  insert into public.exercise_template_answers (template_id, answer_data)
  values (v_template_id, p_answer_data);
  return v_template_id;
end;
$$;

create or replace function public.create_exercise_assignment(
  p_school_id uuid,
  p_template_id uuid,
  p_student_ids uuid[],
  p_deadline_at timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_assignment_id uuid;
  v_student_id uuid;
  v_template public.exercise_templates;
begin
  if auth.uid() is null or not public.has_school_role(p_school_id, 'teacher') then
    raise exception 'Teacher access required';
  end if;

  select * into v_template
  from public.exercise_templates
  where id = p_template_id and school_id = p_school_id and is_active;
  if not found or (v_template.teacher_id <> auth.uid() and not public.is_school_admin(p_school_id)) then
    raise exception 'Exercise template access denied';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'At least one student is required';
  end if;

  foreach v_student_id in array p_student_ids loop
    if not exists (
      select 1 from public.teacher_students
      where school_id = p_school_id
        and teacher_id = auth.uid()
        and student_id = v_student_id
        and is_active
    ) then
      raise exception 'Selected student is not assigned to this teacher';
    end if;
  end loop;

  insert into public.exercise_assignments (school_id, template_id, teacher_id, deadline_at)
  values (p_school_id, p_template_id, auth.uid(), p_deadline_at)
  returning id into v_assignment_id;

  foreach v_student_id in array p_student_ids loop
    insert into public.exercise_assignment_students (assignment_id, student_id)
    values (v_assignment_id, v_student_id);
  end loop;
  return v_assignment_id;
end;
$$;

create or replace function public.submit_exercise_attempt(
  p_assignment_student_id uuid,
  p_answers jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_student_id uuid;
  v_kind text;
  v_content jsonb;
  v_answer_data jsonb;
  v_submitted_answer text;
  v_normalized_answer text;
  v_correct boolean := false;
  v_score integer;
  v_total integer;
  v_status text;
begin
  select recipient.student_id,
    template.kind,
    template.content,
    answer_key.answer_data
  into v_student_id, v_kind, v_content, v_answer_data
  from public.exercise_assignment_students recipient
  join public.exercise_assignments assignment_row on assignment_row.id = recipient.assignment_id
  join public.exercise_templates template on template.id = assignment_row.template_id
  join public.exercise_template_answers answer_key on answer_key.template_id = template.id
  where recipient.id = p_assignment_student_id;

  if not found or v_student_id <> auth.uid() then
    raise exception 'Exercise access denied';
  end if;

  if v_kind = 'multiple_choice' then
    v_submitted_answer := trim(coalesce(p_answers ->> 'answer', ''));
    v_total := 1;
    v_score := case when v_submitted_answer <> '' and v_submitted_answer = coalesce(v_answer_data ->> 'correctOptionId', '') then 1 else 0 end;
    v_status := 'completed';
  elsif v_kind = 'fill_blank' then
    v_submitted_answer := trim(coalesce(p_answers ->> 'answer', ''));
    v_normalized_answer := lower(regexp_replace(v_submitted_answer, '\s+', ' ', 'g'));
    select exists (
      select 1
      from jsonb_array_elements_text(coalesce(v_answer_data -> 'acceptedAnswers', '[]'::jsonb)) accepted(answer)
      where lower(regexp_replace(trim(accepted.answer), '\s+', ' ', 'g')) = v_normalized_answer
    ) into v_correct;
    v_total := 1;
    v_score := case when v_submitted_answer <> '' and v_correct then 1 else 0 end;
    v_status := 'completed';
  elsif v_kind = 'wordwall' then
    v_score := null;
    v_total := null;
    v_status := 'submitted';
  else
    raise exception 'Unsupported exercise type';
  end if;

  insert into public.exercise_attempts (assignment_student_id, student_id, answers, score, total_score)
  values (p_assignment_student_id, auth.uid(), coalesce(p_answers, '{}'::jsonb), v_score, v_total);

  update public.exercise_assignment_students
  set attempts_count = attempts_count + 1,
      best_score = case
        when v_score is null then best_score
        when best_score is null then v_score
        else greatest(best_score, v_score)
      end,
      total_score = coalesce(v_total, total_score),
      status = v_status,
      completed_at = now()
  where id = p_assignment_student_id;

  return jsonb_build_object('status', v_status, 'score', v_score, 'total', v_total);
end;
$$;

create or replace function public.review_wordwall_exercise(p_assignment_student_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.can_manage_exercise_recipient(p_assignment_student_id) then
    raise exception 'Exercise access denied';
  end if;

  if not exists (
    select 1
    from public.exercise_assignment_students recipient
    join public.exercise_assignments assignment_row on assignment_row.id = recipient.assignment_id
    join public.exercise_templates template on template.id = assignment_row.template_id
    where recipient.id = p_assignment_student_id and template.kind = 'wordwall'
  ) then
    raise exception 'Only Wordwall assignments can be confirmed manually';
  end if;

  update public.exercise_assignment_students
  set status = 'reviewed', reviewed_at = now()
  where id = p_assignment_student_id;
end;
$$;

revoke all on function public.create_exercise_template(uuid, text, text, text, jsonb, jsonb) from public;
revoke all on function public.create_exercise_assignment(uuid, uuid, uuid[], timestamptz) from public;
revoke all on function public.submit_exercise_attempt(uuid, jsonb) from public;
revoke all on function public.review_wordwall_exercise(uuid) from public;
grant execute on function public.create_exercise_template(uuid, text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.create_exercise_assignment(uuid, uuid, uuid[], timestamptz) to authenticated;
grant execute on function public.submit_exercise_attempt(uuid, jsonb) to authenticated;
grant execute on function public.review_wordwall_exercise(uuid) to authenticated;
