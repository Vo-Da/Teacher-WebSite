-- Follow-up for the current production schema and interactive-exercise migrations.
-- Adds safe exercise versioning, student conditions, private learning progress,
-- and server-only tables used by the Google Calendar Edge Function.

alter table public.exercise_templates
  add column if not exists replaces_template_id uuid references public.exercise_templates(id) on delete set null;

create index if not exists exercise_templates_replaces_template_idx
  on public.exercise_templates (replaces_template_id)
  where replaces_template_id is not null;

-- Editing an exercise creates a new version. Existing homework, attempts and
-- answer history keep their original template and therefore remain trustworthy.
create or replace function public.replace_exercise_template(
  p_template_id uuid,
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
  v_original public.exercise_templates;
  v_new_template_id uuid;
begin
  if auth.uid() is null or not public.has_school_role(p_school_id, 'teacher') then
    raise exception 'Teacher access required';
  end if;

  select * into v_original
  from public.exercise_templates
  where id = p_template_id and school_id = p_school_id;

  if not found or v_original.teacher_id <> auth.uid() then
    raise exception 'Exercise template access denied';
  end if;

  v_new_template_id := public.create_exercise_template(
    p_school_id,
    p_kind,
    p_title,
    p_prompt,
    p_content,
    p_answer_data,
    p_group_id
  );

  update public.exercise_templates
  set replaces_template_id = v_original.id
  where id = v_new_template_id;

  update public.exercise_templates
  set is_active = false, updated_at = now()
  where id = v_original.id;

  return v_new_template_id;
end;
$$;

create table if not exists public.school_student_conditions (
  school_id uuid primary key references public.schools(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 12000),
  version integer not null default 1 check (version >= 1),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.student_condition_acknowledgements (
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  conditions_version integer not null check (conditions_version >= 1),
  acknowledged_at timestamptz not null default now(),
  primary key (school_id, student_id)
);

alter table public.school_student_conditions enable row level security;
alter table public.student_condition_acknowledgements enable row level security;

drop policy if exists "school_student_conditions_read_member" on public.school_student_conditions;
create policy "school_student_conditions_read_member" on public.school_student_conditions
for select to authenticated using (public.is_school_member(school_id));

drop policy if exists "student_condition_acknowledgements_read_related" on public.student_condition_acknowledgements;
create policy "student_condition_acknowledgements_read_related" on public.student_condition_acknowledgements
for select to authenticated using (student_id = auth.uid() or public.is_school_admin(school_id));

create or replace function public.save_school_student_conditions(
  p_school_id uuid,
  p_body text
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_version integer;
  v_body text := trim(coalesce(p_body, ''));
begin
  if auth.uid() is null or not public.is_school_admin(p_school_id) then
    raise exception 'Admin access required';
  end if;
  if char_length(v_body) > 12000 then
    raise exception 'Conditions text is too long';
  end if;

  insert into public.school_student_conditions as conditions (school_id, body, version, updated_by, updated_at)
  values (p_school_id, v_body, 1, auth.uid(), now())
  on conflict (school_id) do update
  set body = excluded.body,
      version = case
        when conditions.body is distinct from excluded.body
          then conditions.version + 1
        else conditions.version
      end,
      updated_by = auth.uid(),
      updated_at = now()
  returning version into v_version;

  return v_version;
end;
$$;

create or replace function public.acknowledge_school_student_conditions(
  p_school_id uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_conditions public.school_student_conditions;
begin
  if auth.uid() is null or not public.has_school_role(p_school_id, 'student') then
    raise exception 'Student access required';
  end if;

  select * into v_conditions
  from public.school_student_conditions
  where school_id = p_school_id;

  if not found or trim(v_conditions.body) = '' then
    raise exception 'Conditions are not available';
  end if;

  insert into public.student_condition_acknowledgements (
    school_id, student_id, conditions_version, acknowledged_at
  ) values (
    p_school_id, auth.uid(), v_conditions.version, now()
  ) on conflict (school_id, student_id) do update
  set conditions_version = excluded.conditions_version,
      acknowledged_at = excluded.acknowledged_at;
end;
$$;

create table if not exists public.student_topic_nodes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references public.student_topic_nodes(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 200),
  sort_order integer not null default 0,
  is_completed boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);

create index if not exists student_topic_nodes_tree_idx
  on public.student_topic_nodes (school_id, student_id, parent_id, sort_order, created_at);

alter table public.student_topic_nodes enable row level security;

drop policy if exists "student_topic_nodes_read_team" on public.student_topic_nodes;
create policy "student_topic_nodes_read_team" on public.student_topic_nodes
for select to authenticated using (public.can_manage_student_context(school_id, student_id));

create or replace function public.create_student_topic_node(
  p_school_id uuid,
  p_student_id uuid,
  p_title text,
  p_parent_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_parent public.student_topic_nodes;
  v_node_id uuid;
  v_title text := trim(coalesce(p_title, ''));
begin
  if auth.uid() is null or not public.can_manage_student_context(p_school_id, p_student_id) then
    raise exception 'Student context access denied';
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'Topic title must contain 1 to 200 characters';
  end if;
  if p_parent_id is not null then
    select * into v_parent
    from public.student_topic_nodes
    where id = p_parent_id;
    if not found or v_parent.school_id <> p_school_id or v_parent.student_id <> p_student_id then
      raise exception 'Parent topic access denied';
    end if;
  end if;

  insert into public.student_topic_nodes (
    school_id, student_id, parent_id, title, sort_order, created_by
  ) values (
    p_school_id,
    p_student_id,
    p_parent_id,
    v_title,
    coalesce((
      select max(sort_order) + 1
      from public.student_topic_nodes
      where school_id = p_school_id
        and student_id = p_student_id
        and parent_id is not distinct from p_parent_id
    ), 0),
    auth.uid()
  ) returning id into v_node_id;

  return v_node_id;
end;
$$;

create or replace function public.set_student_topic_completed(
  p_topic_id uuid,
  p_is_completed boolean
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_topic public.student_topic_nodes;
begin
  select * into v_topic from public.student_topic_nodes where id = p_topic_id;
  if not found or auth.uid() is null or not public.can_manage_student_context(v_topic.school_id, v_topic.student_id) then
    raise exception 'Topic access denied';
  end if;

  update public.student_topic_nodes
  set is_completed = p_is_completed,
      completed_at = case when p_is_completed then now() else null end,
      completed_by = case when p_is_completed then auth.uid() else null end,
      updated_at = now()
  where id = p_topic_id;
end;
$$;

create or replace function public.rename_student_topic_node(
  p_topic_id uuid,
  p_title text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_topic public.student_topic_nodes;
  v_title text := trim(coalesce(p_title, ''));
begin
  select * into v_topic from public.student_topic_nodes where id = p_topic_id;
  if not found or auth.uid() is null or not public.can_manage_student_context(v_topic.school_id, v_topic.student_id) then
    raise exception 'Topic access denied';
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'Topic title must contain 1 to 200 characters';
  end if;

  update public.student_topic_nodes
  set title = v_title, updated_at = now()
  where id = p_topic_id;
end;
$$;

create or replace function public.delete_student_topic_node(
  p_topic_id uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_topic public.student_topic_nodes;
begin
  select * into v_topic from public.student_topic_nodes where id = p_topic_id;
  if not found or auth.uid() is null or not public.can_manage_student_context(v_topic.school_id, v_topic.student_id) then
    raise exception 'Topic access denied';
  end if;

  delete from public.student_topic_nodes where id = p_topic_id;
end;
$$;

-- OAuth secrets are encrypted in the Edge Function before they reach this table.
-- There are intentionally no client RLS policies: only the service-role function
-- may read or update connection and token records.
create table if not exists public.google_calendar_oauth_states (
  state text primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id text not null,
  calendar_summary text not null default 'School Portal',
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, user_id)
);

create table if not exists public.google_calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.google_calendar_connections(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  google_event_id text not null,
  synced_at timestamptz not null default now(),
  unique (connection_id, lesson_id)
);

create index if not exists google_calendar_oauth_states_expiry_idx
  on public.google_calendar_oauth_states (expires_at);
create index if not exists google_calendar_event_links_lesson_idx
  on public.google_calendar_event_links (lesson_id);

alter table public.google_calendar_oauth_states enable row level security;
alter table public.google_calendar_connections enable row level security;
alter table public.google_calendar_event_links enable row level security;

revoke all on function public.replace_exercise_template(uuid, uuid, text, text, text, jsonb, jsonb, uuid) from public;
revoke all on function public.save_school_student_conditions(uuid, text) from public;
revoke all on function public.acknowledge_school_student_conditions(uuid) from public;
revoke all on function public.create_student_topic_node(uuid, uuid, text, uuid) from public;
revoke all on function public.set_student_topic_completed(uuid, boolean) from public;
revoke all on function public.rename_student_topic_node(uuid, text) from public;
revoke all on function public.delete_student_topic_node(uuid) from public;

grant execute on function public.replace_exercise_template(uuid, uuid, text, text, text, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.save_school_student_conditions(uuid, text) to authenticated;
grant execute on function public.acknowledge_school_student_conditions(uuid) to authenticated;
grant execute on function public.create_student_topic_node(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.set_student_topic_completed(uuid, boolean) to authenticated;
grant execute on function public.rename_student_topic_node(uuid, text) to authenticated;
grant execute on function public.delete_student_topic_node(uuid) to authenticated;
