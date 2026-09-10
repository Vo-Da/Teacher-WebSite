-- Shared curriculum for a school.
-- Run after add_learning_progress_terms_and_google_calendar.sql.
-- The old student_topic_nodes table is kept intact so existing test data is not lost.

create table if not exists public.school_topic_nodes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  parent_id uuid references public.school_topic_nodes(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 200),
  sort_order integer not null default 0,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);

create index if not exists school_topic_nodes_tree_idx
  on public.school_topic_nodes (school_id, parent_id, sort_order, created_at);

create table if not exists public.student_topic_progress (
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  topic_id uuid not null references public.school_topic_nodes(id) on delete cascade,
  is_completed boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (school_id, student_id, topic_id)
);

create index if not exists student_topic_progress_student_idx
  on public.student_topic_progress (school_id, student_id, is_completed);

alter table public.school_topic_nodes enable row level security;
alter table public.student_topic_progress enable row level security;

drop policy if exists "school_topic_nodes_read_team" on public.school_topic_nodes;
create policy "school_topic_nodes_read_team" on public.school_topic_nodes
for select to authenticated using (
  public.is_school_admin(school_id) or public.has_school_role(school_id, 'teacher')
);

drop policy if exists "student_topic_progress_read_team" on public.student_topic_progress;
create policy "student_topic_progress_read_team" on public.student_topic_progress
for select to authenticated using (public.can_manage_student_context(school_id, student_id));

create or replace function public.create_school_topic_node(
  p_school_id uuid,
  p_title text,
  p_parent_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_parent public.school_topic_nodes;
  v_topic_id uuid;
  v_title text := trim(coalesce(p_title, ''));
begin
  if auth.uid() is null or not public.is_school_admin(p_school_id) then
    raise exception 'Admin access required';
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'Topic title must contain 1 to 200 characters';
  end if;
  if p_parent_id is not null then
    select * into v_parent from public.school_topic_nodes where id = p_parent_id;
    if not found or v_parent.school_id <> p_school_id then
      raise exception 'Parent topic access denied';
    end if;
  end if;

  insert into public.school_topic_nodes (school_id, parent_id, title, sort_order, created_by)
  values (
    p_school_id,
    p_parent_id,
    v_title,
    coalesce((
      select max(sort_order) + 1
      from public.school_topic_nodes
      where school_id = p_school_id
        and parent_id is not distinct from p_parent_id
    ), 0),
    auth.uid()
  ) returning id into v_topic_id;

  return v_topic_id;
end;
$$;

create or replace function public.rename_school_topic_node(
  p_topic_id uuid,
  p_title text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_topic public.school_topic_nodes;
  v_title text := trim(coalesce(p_title, ''));
begin
  select * into v_topic from public.school_topic_nodes where id = p_topic_id;
  if not found or auth.uid() is null or not public.is_school_admin(v_topic.school_id) then
    raise exception 'Admin access required';
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'Topic title must contain 1 to 200 characters';
  end if;

  update public.school_topic_nodes
  set title = v_title, updated_at = now()
  where id = p_topic_id;
end;
$$;

create or replace function public.delete_school_topic_node(p_topic_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_topic public.school_topic_nodes;
begin
  select * into v_topic from public.school_topic_nodes where id = p_topic_id;
  if not found or auth.uid() is null or not public.is_school_admin(v_topic.school_id) then
    raise exception 'Admin access required';
  end if;

  delete from public.school_topic_nodes where id = p_topic_id;
end;
$$;

create or replace function public.set_student_topic_progress(
  p_school_id uuid,
  p_student_id uuid,
  p_topic_id uuid,
  p_is_completed boolean
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_topic public.school_topic_nodes;
begin
  if auth.uid() is null or not public.can_manage_student_context(p_school_id, p_student_id) then
    raise exception 'Student context access denied';
  end if;

  select * into v_topic from public.school_topic_nodes where id = p_topic_id;
  if not found or v_topic.school_id <> p_school_id then
    raise exception 'Topic access denied';
  end if;

  insert into public.student_topic_progress (
    school_id, student_id, topic_id, is_completed, completed_at, completed_by, updated_at
  ) values (
    p_school_id,
    p_student_id,
    p_topic_id,
    p_is_completed,
    case when p_is_completed then now() else null end,
    case when p_is_completed then auth.uid() else null end,
    now()
  ) on conflict (school_id, student_id, topic_id) do update
  set is_completed = excluded.is_completed,
      completed_at = case when excluded.is_completed then now() else null end,
      completed_by = case when excluded.is_completed then auth.uid() else null end,
      updated_at = now();
end;
$$;

revoke all on function public.create_school_topic_node(uuid, text, uuid) from public;
revoke all on function public.rename_school_topic_node(uuid, text) from public;
revoke all on function public.delete_school_topic_node(uuid) from public;
revoke all on function public.set_student_topic_progress(uuid, uuid, uuid, boolean) from public;

grant execute on function public.create_school_topic_node(uuid, text, uuid) to authenticated;
grant execute on function public.rename_school_topic_node(uuid, text) to authenticated;
grant execute on function public.delete_school_topic_node(uuid) to authenticated;
grant execute on function public.set_student_topic_progress(uuid, uuid, uuid, boolean) to authenticated;
