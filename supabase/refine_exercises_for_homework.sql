-- Follow-up for add_interactive_exercises.sql.
-- Run this after the initial experimental exercise migration.
-- It moves exercises into homework, supports up to 30 auto-checked questions,
-- and keeps answer keys unavailable to students.

alter table public.exercise_templates
  drop constraint if exists exercise_templates_kind_check;

alter table public.exercise_templates
  add constraint exercise_templates_kind_check
  check (kind in ('multiple_choice', 'multiple_select', 'fill_blank', 'word_order', 'matching_pairs', 'wordwall'));

create table if not exists public.exercise_groups (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 100),
  created_at timestamptz not null default now(),
  unique (school_id, teacher_id, name)
);

alter table public.exercise_templates
  add column if not exists group_id uuid references public.exercise_groups(id) on delete set null;

create index if not exists exercise_groups_school_teacher_idx
  on public.exercise_groups (school_id, teacher_id, name);

create index if not exists exercise_templates_group_idx
  on public.exercise_templates (group_id)
  where group_id is not null;

create or replace function public.is_exercise_group_recipient(p_group_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.exercise_templates template
    join public.exercise_assignments assignment_row on assignment_row.template_id = template.id
    join public.exercise_assignment_students recipient on recipient.assignment_id = assignment_row.id
    where template.group_id = p_group_id
      and recipient.student_id = auth.uid()
  )
$$;

alter table public.exercise_groups enable row level security;

drop policy if exists "exercise_groups_read_related" on public.exercise_groups;
create policy "exercise_groups_read_related" on public.exercise_groups for select to authenticated using (
  teacher_id = auth.uid()
  or public.is_school_admin(school_id)
  or public.is_exercise_group_recipient(id)
);

drop policy if exists "exercise_groups_teacher_create" on public.exercise_groups;
create policy "exercise_groups_teacher_create" on public.exercise_groups for insert to authenticated with check (
  teacher_id = auth.uid() and public.has_school_role(school_id, 'teacher')
);

drop policy if exists "exercise_groups_teacher_update" on public.exercise_groups;
create policy "exercise_groups_teacher_update" on public.exercise_groups for update to authenticated
using (teacher_id = auth.uid() or public.is_school_admin(school_id))
with check (teacher_id = auth.uid() or public.is_school_admin(school_id));

drop policy if exists "exercise_groups_teacher_delete" on public.exercise_groups;
create policy "exercise_groups_teacher_delete" on public.exercise_groups for delete to authenticated using (
  teacher_id = auth.uid() or public.is_school_admin(school_id)
);

alter table public.exercise_assignments
  add column if not exists homework_id uuid references public.homework(id) on delete cascade;

alter table public.exercise_assignment_students
  add column if not exists homework_student_id uuid references public.homework_students(id) on delete cascade;

alter table public.exercise_attempts
  add column if not exists results jsonb not null default '{}'::jsonb
  check (jsonb_typeof(results) = 'object');

create index if not exists exercise_assignments_homework_idx
  on public.exercise_assignments (homework_id, created_at desc)
  where homework_id is not null;

create index if not exists exercise_assignment_students_homework_idx
  on public.exercise_assignment_students (homework_student_id)
  where homework_student_id is not null;

create unique index if not exists exercise_assignments_homework_template_unique
  on public.exercise_assignments (homework_id, template_id)
  where homework_id is not null;

-- Convert templates created by the first experimental version. They had exactly
-- one question, so preserving them as q1 keeps existing libraries usable.
update public.exercise_templates template
set content = jsonb_build_object(
  'items',
  jsonb_build_array(jsonb_build_object(
    'id', 'q1',
    'prompt', template.prompt,
    'options', template.content -> 'options'
  ))
)
where template.kind = 'multiple_choice'
  and jsonb_typeof(template.content -> 'options') = 'array';

update public.exercise_template_answers answer_key
set answer_data = jsonb_build_object(
  'items',
  jsonb_build_array(jsonb_build_object(
    'id', 'q1',
    'correctOptionId', answer_key.answer_data ->> 'correctOptionId'
  ))
)
from public.exercise_templates template
where template.id = answer_key.template_id
  and template.kind = 'multiple_choice'
  and answer_key.answer_data ? 'correctOptionId';

update public.exercise_templates template
set content = jsonb_build_object(
  'items',
  jsonb_build_array(jsonb_build_object(
    'id', 'q1',
    'prompt', template.prompt
  ))
)
where template.kind = 'fill_blank'
  and jsonb_typeof(template.content -> 'items') is distinct from 'array';

update public.exercise_template_answers answer_key
set answer_data = jsonb_build_object(
  'items',
  jsonb_build_array(jsonb_build_object(
    'id', 'q1',
    'acceptedAnswers', answer_key.answer_data -> 'acceptedAnswers'
  ))
)
from public.exercise_templates template
where template.id = answer_key.template_id
  and template.kind = 'fill_blank'
  and jsonb_typeof(answer_key.answer_data -> 'acceptedAnswers') = 'array';

drop function if exists public.create_exercise_template(uuid, text, text, text, jsonb, jsonb);

create or replace function public.create_exercise_template(
  p_school_id uuid,
  p_kind text,
  p_title text,
  p_prompt text default '',
  p_content jsonb default '{}'::jsonb,
  p_answer_data jsonb default '{}'::jsonb,
  p_group_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_template_id uuid;
  v_items jsonb;
  v_answer_items jsonb;
  v_right_options jsonb;
  v_item jsonb;
  v_answer_item jsonb;
  v_correct_option_ids jsonb;
  v_item_id text;
  v_group public.exercise_groups;
begin
  if auth.uid() is null or not public.has_school_role(p_school_id, 'teacher') then
    raise exception 'Teacher access required';
  end if;
  if char_length(trim(p_title)) < 2 then
    raise exception 'Exercise title is required';
  end if;
  if p_kind not in ('multiple_choice', 'multiple_select', 'fill_blank', 'word_order', 'matching_pairs', 'wordwall') then
    raise exception 'Unsupported exercise type';
  end if;
  if jsonb_typeof(p_content) <> 'object' or jsonb_typeof(p_answer_data) <> 'object' then
    raise exception 'Invalid exercise data';
  end if;
  if p_group_id is not null then
    select * into v_group
    from public.exercise_groups
    where id = p_group_id and school_id = p_school_id;
    if not found or v_group.teacher_id <> auth.uid() then
      raise exception 'Exercise group access denied';
    end if;
  end if;

  if p_kind in ('multiple_choice', 'multiple_select', 'fill_blank', 'word_order', 'matching_pairs') then
    v_items := p_content -> 'items';
    v_answer_items := p_answer_data -> 'items';
    if jsonb_typeof(v_items) <> 'array' or jsonb_typeof(v_answer_items) <> 'array' then
      raise exception 'Exercise items are invalid';
    end if;
    if jsonb_array_length(v_items) = 0
      or jsonb_array_length(v_items) > 30
      or jsonb_array_length(v_items) <> jsonb_array_length(v_answer_items)
      or (p_kind = 'matching_pairs' and jsonb_array_length(v_items) < 2) then
      raise exception 'Exercise items are invalid';
    end if;
    if (select count(distinct item.value ->> 'id') from jsonb_array_elements(v_items) as item(value)) <> jsonb_array_length(v_items) then
      raise exception 'Exercise question ids must be unique';
    end if;
    if p_kind = 'matching_pairs' then
      v_right_options := p_content -> 'rightOptions';
      if jsonb_typeof(v_right_options) <> 'array'
        or jsonb_array_length(v_right_options) <> jsonb_array_length(v_items)
        or (select count(distinct option_item.value ->> 'id') from jsonb_array_elements(v_right_options) as option_item(value)) <> jsonb_array_length(v_right_options)
        or (select count(distinct answer_item.value ->> 'correctRightId') from jsonb_array_elements(v_answer_items) as answer_item(value)) <> jsonb_array_length(v_answer_items)
        or (select count(distinct item.value -> 'left' ->> 'id') from jsonb_array_elements(v_items) as item(value)) <> jsonb_array_length(v_items)
        or exists (
          select 1 from jsonb_array_elements(v_right_options) as option_item(value)
          where trim(coalesce(option_item.value ->> 'id', '')) = ''
            or trim(coalesce(option_item.value ->> 'text', '')) = ''
        ) then
        raise exception 'Matching pairs need unique right-side options';
      end if;
    end if;

    for v_item in select item.value from jsonb_array_elements(v_items) as item(value) loop
      v_item_id := trim(coalesce(v_item ->> 'id', ''));
      if v_item_id = '' or trim(coalesce(v_item ->> 'prompt', '')) = '' then
        raise exception 'Each exercise item needs an id and text';
      end if;

      select answer_item.value into v_answer_item
      from jsonb_array_elements(v_answer_items) as answer_item(value)
      where answer_item.value ->> 'id' = v_item_id
      limit 1;
      if not found then
        raise exception 'Each exercise item needs an answer key';
      end if;

      if p_kind = 'multiple_choice' then
        if jsonb_typeof(v_item -> 'options') <> 'array' then
          raise exception 'Multiple choice item needs options and at least one correct answer';
        end if;
        v_correct_option_ids := case
          when jsonb_typeof(v_answer_item -> 'correctOptionIds') = 'array' then v_answer_item -> 'correctOptionIds'
          else jsonb_build_array(coalesce(v_answer_item ->> 'correctOptionId', ''))
        end;
        if jsonb_array_length(v_item -> 'options') < 2
          or jsonb_array_length(v_correct_option_ids) = 0
          or jsonb_array_length(v_correct_option_ids) > jsonb_array_length(v_item -> 'options')
          or (select count(distinct correct_option.value) from jsonb_array_elements_text(v_correct_option_ids) correct_option(value)) <> jsonb_array_length(v_correct_option_ids)
          or exists (
            select 1 from jsonb_array_elements_text(v_correct_option_ids) correct_option(value)
            where not exists (
              select 1 from jsonb_array_elements(v_item -> 'options') option_item(value)
              where option_item.value ->> 'id' = correct_option.value
                and trim(coalesce(option_item.value ->> 'text', '')) <> ''
            )
          ) then
          raise exception 'Multiple choice item needs options and at least one correct answer';
        end if;
      elsif p_kind = 'multiple_select' then
        if jsonb_typeof(v_item -> 'options') <> 'array'
          or jsonb_typeof(v_answer_item -> 'correctOptionIds') <> 'array' then
          raise exception 'Multiple select item needs options and correct answers';
        end if;
        if jsonb_array_length(v_item -> 'options') < 2
          or jsonb_array_length(v_answer_item -> 'correctOptionIds') = 0
          or jsonb_array_length(v_answer_item -> 'correctOptionIds') > jsonb_array_length(v_item -> 'options')
          or (select count(distinct correct_option.value) from jsonb_array_elements_text(v_answer_item -> 'correctOptionIds') correct_option(value)) <> jsonb_array_length(v_answer_item -> 'correctOptionIds')
          or exists (
            select 1 from jsonb_array_elements_text(v_answer_item -> 'correctOptionIds') correct_option(value)
            where not exists (
              select 1 from jsonb_array_elements(v_item -> 'options') option_item(value)
              where option_item.value ->> 'id' = correct_option.value
                and trim(coalesce(option_item.value ->> 'text', '')) <> ''
            )
          ) then
          raise exception 'Multiple select item needs options and correct answers';
        end if;
      elsif p_kind = 'fill_blank' and jsonb_typeof(v_answer_item -> 'acceptedAnswers') <> 'array' then
        raise exception 'Fill in the blank item needs an accepted answer';
      elsif p_kind = 'fill_blank' and jsonb_array_length(v_answer_item -> 'acceptedAnswers') = 0 then
        raise exception 'Fill in the blank item needs an accepted answer';
      elsif p_kind = 'word_order' then
        if jsonb_typeof(v_item -> 'tokens') <> 'array'
          or jsonb_array_length(v_item -> 'tokens') < 2
          or jsonb_typeof(v_answer_item -> 'correctTokenIds') <> 'array'
          or jsonb_array_length(v_answer_item -> 'correctTokenIds') <> jsonb_array_length(v_item -> 'tokens')
          or (select count(distinct token_item.value ->> 'id') from jsonb_array_elements(v_item -> 'tokens') as token_item(value)) <> jsonb_array_length(v_item -> 'tokens')
          or exists (
            select 1 from jsonb_array_elements(v_item -> 'tokens') as token_item(value)
            where trim(coalesce(token_item.value ->> 'id', '')) = ''
              or trim(coalesce(token_item.value ->> 'text', '')) = ''
          )
          or (select count(distinct answer_token.value) from jsonb_array_elements_text(v_answer_item -> 'correctTokenIds') answer_token(value)) <> jsonb_array_length(v_item -> 'tokens')
          or exists (
            select 1 from jsonb_array_elements_text(v_answer_item -> 'correctTokenIds') answer_token(value)
            where not exists (
              select 1 from jsonb_array_elements(v_item -> 'tokens') token_item(value)
              where token_item.value ->> 'id' = answer_token.value
            )
          ) then
          raise exception 'Word order item needs unique words and a complete answer order';
        end if;
      elsif p_kind = 'matching_pairs' then
        if jsonb_typeof(v_item -> 'left') <> 'object'
          or trim(coalesce(v_item -> 'left' ->> 'id', '')) = ''
          or trim(coalesce(v_item -> 'left' ->> 'text', '')) = ''
          or coalesce(v_answer_item ->> 'correctRightId', '') = ''
          or not exists (
            select 1 from jsonb_array_elements(v_right_options) as option_item(value)
            where option_item.value ->> 'id' = v_answer_item ->> 'correctRightId'
          ) then
          raise exception 'Matching pair needs both sides and an answer key';
        end if;
      end if;
    end loop;
  elsif coalesce(p_content ->> 'url', '') !~ '^https://([a-z0-9-]+\.)?wordwall\.net/' then
    raise exception 'A secure Wordwall link is required';
  end if;

  insert into public.exercise_templates (school_id, teacher_id, group_id, kind, title, prompt, content)
  values (p_school_id, auth.uid(), p_group_id, p_kind, trim(p_title), coalesce(p_prompt, ''), p_content)
  returning id into v_template_id;

  insert into public.exercise_template_answers (template_id, answer_data)
  values (v_template_id, p_answer_data);
  return v_template_id;
end;
$$;

create or replace function public.create_homework_exercise_assignment(
  p_school_id uuid,
  p_template_id uuid,
  p_homework_id uuid
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_assignment_id uuid;
  v_homework public.homework;
  v_template public.exercise_templates;
begin
  if auth.uid() is null or not public.has_school_role(p_school_id, 'teacher') then
    raise exception 'Teacher access required';
  end if;

  select * into v_homework
  from public.homework
  where id = p_homework_id and school_id = p_school_id;
  if not found or (v_homework.teacher_id <> auth.uid() and not public.is_school_admin(p_school_id)) then
    raise exception 'Homework access denied';
  end if;

  select * into v_template
  from public.exercise_templates
  where id = p_template_id and school_id = p_school_id and is_active;
  if not found or (v_template.teacher_id <> auth.uid() and not public.is_school_admin(p_school_id)) then
    raise exception 'Exercise template access denied';
  end if;

  if not exists (select 1 from public.homework_students where homework_id = p_homework_id) then
    raise exception 'Homework has no recipients';
  end if;

  select id into v_assignment_id
  from public.exercise_assignments
  where homework_id = p_homework_id and template_id = p_template_id;
  if found then
    return v_assignment_id;
  end if;

  insert into public.exercise_assignments (school_id, template_id, teacher_id, homework_id, deadline_at)
  values (p_school_id, p_template_id, v_homework.teacher_id, p_homework_id, v_homework.deadline_at)
  returning id into v_assignment_id;

  insert into public.exercise_assignment_students (assignment_id, student_id, homework_student_id)
  select v_assignment_id, recipient.student_id, recipient.id
  from public.homework_students recipient
  where recipient.homework_id = p_homework_id;

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
  v_item jsonb;
  v_answer_item jsonb;
  v_item_id text;
  v_submitted_answer text;
  v_submitted_json jsonb;
  v_correct_option_ids jsonb;
  v_normalized_answer text;
  v_correct boolean;
  v_score integer;
  v_total integer;
  v_status text;
  v_results jsonb := '{}'::jsonb;
begin
  select recipient.student_id, template.kind, template.content, answer_key.answer_data
  into v_student_id, v_kind, v_content, v_answer_data
  from public.exercise_assignment_students recipient
  join public.exercise_assignments assignment_row on assignment_row.id = recipient.assignment_id
  join public.exercise_templates template on template.id = assignment_row.template_id
  join public.exercise_template_answers answer_key on answer_key.template_id = template.id
  where recipient.id = p_assignment_student_id;

  if not found or v_student_id <> auth.uid() then
    raise exception 'Exercise access denied';
  end if;
  if jsonb_typeof(coalesce(p_answers, '{}'::jsonb)) <> 'object' then
    raise exception 'Exercise answers are invalid';
  end if;

  if v_kind in ('multiple_choice', 'multiple_select', 'fill_blank', 'word_order', 'matching_pairs') then
    v_total := 0;
    v_score := 0;
    for v_item in select item.value from jsonb_array_elements(coalesce(v_content -> 'items', '[]'::jsonb)) as item(value) loop
      v_item_id := v_item ->> 'id';
      v_submitted_answer := trim(coalesce(p_answers ->> v_item_id, ''));
      select answer_item.value into v_answer_item
      from jsonb_array_elements(coalesce(v_answer_data -> 'items', '[]'::jsonb)) as answer_item(value)
      where answer_item.value ->> 'id' = v_item_id
      limit 1;
      if not found then
        raise exception 'Exercise answer key is invalid';
      end if;

      v_correct := false;
      if v_kind = 'multiple_choice' then
        v_correct_option_ids := case
          when jsonb_typeof(v_answer_item -> 'correctOptionIds') = 'array' then v_answer_item -> 'correctOptionIds'
          else jsonb_build_array(coalesce(v_answer_item ->> 'correctOptionId', ''))
        end;
        select v_submitted_answer <> '' and exists (
          select 1 from jsonb_array_elements_text(v_correct_option_ids) correct_option(value)
          where correct_option.value = v_submitted_answer
        ) into v_correct;
      elsif v_kind = 'multiple_select' then
        begin
          v_submitted_json := coalesce((p_answers ->> v_item_id)::jsonb, '[]'::jsonb);
        exception when others then
          v_submitted_json := '[]'::jsonb;
        end;
        if v_submitted_answer = '' or jsonb_typeof(v_submitted_json) <> 'array' then
          v_correct := false;
        else
          select jsonb_array_length(v_submitted_json) = jsonb_array_length(v_answer_item -> 'correctOptionIds')
            and (select count(distinct submitted_option.value) from jsonb_array_elements_text(v_submitted_json) submitted_option(value)) = jsonb_array_length(v_submitted_json)
            and not exists (
              select 1 from jsonb_array_elements_text(v_submitted_json) submitted_option(value)
              where not exists (
                select 1 from jsonb_array_elements_text(v_answer_item -> 'correctOptionIds') correct_option(value)
                where correct_option.value = submitted_option.value
              )
            ) into v_correct;
        end if;
      elsif v_kind = 'fill_blank' then
        v_normalized_answer := lower(regexp_replace(v_submitted_answer, '\s+', ' ', 'g'));
        select exists (
          select 1
          from jsonb_array_elements_text(coalesce(v_answer_item -> 'acceptedAnswers', '[]'::jsonb)) accepted(answer)
          where lower(regexp_replace(trim(accepted.answer), '\s+', ' ', 'g')) = v_normalized_answer
        ) into v_correct;
        v_correct := v_submitted_answer <> '' and v_correct;
      elsif v_kind = 'word_order' then
        begin
          v_submitted_json := coalesce((p_answers ->> v_item_id)::jsonb, '[]'::jsonb);
        exception when others then
          v_submitted_json := '[]'::jsonb;
        end;
        v_correct := v_submitted_answer <> ''
          and jsonb_typeof(v_submitted_json) = 'array'
          and v_submitted_json = coalesce(v_answer_item -> 'correctTokenIds', '[]'::jsonb);
      else
        v_correct := v_submitted_answer <> '' and v_submitted_answer = coalesce(v_answer_item ->> 'correctRightId', '');
      end if;
      v_total := v_total + 1;
      if v_correct then v_score := v_score + 1; end if;
      v_results := v_results || jsonb_build_object(v_item_id, v_correct);
    end loop;
    if v_total = 0 then raise exception 'Exercise has no items'; end if;
    v_status := 'completed';
  elsif v_kind = 'wordwall' then
    v_score := null;
    v_total := null;
    v_status := 'submitted';
  else
    raise exception 'Unsupported exercise type';
  end if;

  insert into public.exercise_attempts (assignment_student_id, student_id, answers, results, score, total_score)
  values (p_assignment_student_id, auth.uid(), coalesce(p_answers, '{}'::jsonb), v_results, v_score, v_total);

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

revoke all on function public.create_exercise_assignment(uuid, uuid, uuid[], timestamptz) from public, authenticated;
revoke all on function public.create_homework_exercise_assignment(uuid, uuid, uuid) from public;
revoke all on function public.create_exercise_template(uuid, text, text, text, jsonb, jsonb, uuid) from public;
revoke all on function public.submit_exercise_attempt(uuid, jsonb) from public;

grant execute on function public.create_homework_exercise_assignment(uuid, uuid, uuid) to authenticated;
grant execute on function public.create_exercise_template(uuid, text, text, text, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.submit_exercise_attempt(uuid, jsonb) to authenticated;
