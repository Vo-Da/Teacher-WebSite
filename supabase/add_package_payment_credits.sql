-- Run once in the Supabase SQL Editor after deploying the matching frontend.
-- It adds package pricing while preserving every existing rate and ledger entry.
begin;

alter table public.student_rates
  add column if not exists package_lesson_price_uah integer,
  add column if not exists teacher_payout_percent numeric(5,2);

-- Existing rates keep their old lesson price as the initial package price.
update public.student_rates
set package_lesson_price_uah = lesson_price_uah
where package_lesson_price_uah is null;

-- Convert the historical fixed payout into a percentage where possible.
update public.student_rates
set teacher_payout_percent = case
  when lesson_price_uah > 0 then least(100, round((teacher_payout_uah::numeric * 100) / lesson_price_uah, 2))
  else 0
end
where teacher_payout_percent is null;

alter table public.student_rates
  alter column package_lesson_price_uah set not null,
  alter column teacher_payout_percent set not null;

-- The former fixed-payout column remains only for historical rows. New rates
-- use teacher_payout_percent, so make the legacy field safe to omit.
alter table public.student_rates
  alter column teacher_payout_uah set default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'student_rates_package_price_check'
  ) then
    alter table public.student_rates add constraint student_rates_package_price_check
      check (package_lesson_price_uah >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'student_rates_teacher_payout_percent_check'
  ) then
    alter table public.student_rates add constraint student_rates_teacher_payout_percent_check
      check (teacher_payout_percent >= 0 and teacher_payout_percent <= 100);
  end if;
end;
$$;

alter table public.wallet_ledger
  add column if not exists payment_date date,
  add column if not exists paid_lesson_count integer;

-- A credit is a reserved, prepaid lesson at the rate in force on the actual
-- payment date. The residual cash remains available for a later payment.
create table if not exists public.student_payment_credits (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete restrict,
  rate_id uuid references public.student_rates(id) on delete set null,
  payment_id uuid not null references public.wallet_ledger(id) on delete restrict,
  teacher_id uuid references auth.users(id) on delete set null,
  subject_id uuid references public.subjects(id) on delete set null,
  paid_at date not null,
  tariff_kind text not null check (tariff_kind in ('package', 'single')),
  unit_price_uah integer not null check (unit_price_uah >= 0),
  teacher_payout_percent numeric(5,2) not null check (teacher_payout_percent >= 0 and teacher_payout_percent <= 100),
  initial_lesson_count integer not null check (initial_lesson_count > 0),
  remaining_lesson_count integer not null check (remaining_lesson_count >= 0 and remaining_lesson_count <= initial_lesson_count),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists student_payment_credits_available_idx
  on public.student_payment_credits (school_id, student_id, paid_at, created_at)
  where remaining_lesson_count > 0;

alter table public.wallet_ledger
  add column if not exists payment_credit_id uuid references public.student_payment_credits(id) on delete restrict;

alter table public.student_payment_credits enable row level security;

drop policy if exists "payment_credits_admin_read" on public.student_payment_credits;
create policy "payment_credits_admin_read" on public.student_payment_credits
  for select to authenticated using (public.is_school_admin(school_id));

-- New financial entries are created only by the guarded RPCs below. This
-- prevents a browser request from issuing paid lessons without full funding.
drop policy if exists "wallet_admin_manage" on public.wallet_ledger;

create or replace function public.record_student_payment(
  p_school_id uuid,
  p_student_id uuid,
  p_rate_id uuid,
  p_amount_uah integer,
  p_paid_at date,
  p_lesson_count integer,
  p_note text default ''
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_rate public.student_rates;
  v_payment_id uuid;
  v_credit_id uuid;
  v_tariff_kind text;
  v_unit_price integer;
  v_required_uah integer;
  v_wallet_uah integer;
  v_reserved_uah integer;
  v_available_uah integer;
begin
  if not public.is_school_admin(p_school_id) then raise exception 'Admin access required'; end if;
  if p_amount_uah <= 0 then raise exception 'Payment amount must be positive'; end if;
  if p_lesson_count <= 0 then raise exception 'Lesson count must be positive'; end if;
  if p_paid_at is null or p_paid_at > current_date then raise exception 'Payment date must be today or earlier'; end if;

  -- Serialize funding decisions for a student so two admin tabs cannot use the
  -- same residual balance twice.
  perform pg_advisory_xact_lock(hashtext(p_school_id::text || ':' || p_student_id::text));

  select * into v_rate
  from public.student_rates sr
  where sr.id = p_rate_id
    and sr.school_id = p_school_id
    and sr.student_id = p_student_id
    and sr.active_from <= p_paid_at
    and (sr.active_to is null or sr.active_to >= p_paid_at)
  for share;
  if not found then raise exception 'No selected rate is active on the payment date'; end if;

  v_tariff_kind := case when p_lesson_count >= 8 then 'package' else 'single' end;
  v_unit_price := case when v_tariff_kind = 'package' then v_rate.package_lesson_price_uah else v_rate.lesson_price_uah end;
  v_required_uah := v_unit_price * p_lesson_count;

  select coalesce(sum(amount_uah), 0)::integer into v_wallet_uah
  from public.wallet_ledger
  where school_id = p_school_id and student_id = p_student_id and status = 'confirmed';

  select coalesce(sum(remaining_lesson_count * unit_price_uah), 0)::integer into v_reserved_uah
  from public.student_payment_credits
  where school_id = p_school_id and student_id = p_student_id;

  v_available_uah := v_wallet_uah - v_reserved_uah;
  if v_available_uah + p_amount_uah < v_required_uah then
    raise exception 'Not enough available funds: required %, available after payment %', v_required_uah, v_available_uah + p_amount_uah;
  end if;

  insert into public.wallet_ledger (
    school_id, student_id, teacher_id, kind, amount_uah, teacher_payout_uah,
    payment_date, paid_lesson_count, note, created_by
  ) values (
    p_school_id, p_student_id, null, 'payment', p_amount_uah, 0,
    p_paid_at, p_lesson_count, coalesce(trim(p_note), ''), auth.uid()
  ) returning id into v_payment_id;

  insert into public.student_payment_credits (
    school_id, student_id, rate_id, payment_id, teacher_id, subject_id, paid_at,
    tariff_kind, unit_price_uah, teacher_payout_percent,
    initial_lesson_count, remaining_lesson_count, created_by
  ) values (
    p_school_id, p_student_id, v_rate.id, v_payment_id, v_rate.teacher_id, v_rate.subject_id, p_paid_at,
    v_tariff_kind, v_unit_price, v_rate.teacher_payout_percent,
    p_lesson_count, p_lesson_count, auth.uid()
  ) returning id into v_credit_id;

  return v_credit_id;
end;
$$;

create or replace function public.set_lesson_status(p_lesson_id uuid, p_status public.lesson_status, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_lesson public.lessons;
  v_was_chargeable boolean;
  v_is_chargeable boolean;
  v_student record;
  v_credit public.student_payment_credits;
  v_charge public.wallet_ledger;
  v_price_uah integer;
  v_payout_uah integer;
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
      select * into v_credit
      from public.student_payment_credits credit
      where credit.school_id = v_lesson.school_id
        and credit.student_id = v_student.student_id
        and credit.remaining_lesson_count > 0
        and (credit.teacher_id is null or credit.teacher_id = v_lesson.teacher_id)
        and (credit.subject_id is null or credit.subject_id = v_lesson.subject_id)
      order by (credit.teacher_id is not null) desc, (credit.subject_id is not null) desc, credit.paid_at, credit.created_at
      for update skip locked
      limit 1;

      if found then
        update public.student_payment_credits
        set remaining_lesson_count = remaining_lesson_count - 1
        where id = v_credit.id;
        v_price_uah := v_credit.unit_price_uah;
        v_payout_uah := round((v_credit.unit_price_uah * v_credit.teacher_payout_percent) / 100.0)::integer;
      else
        v_price_uah := v_student.price_snapshot_uah;
        v_payout_uah := v_student.teacher_payout_snapshot_uah;
      end if;

      insert into public.wallet_ledger (school_id, student_id, teacher_id, lesson_id, payment_credit_id, kind, amount_uah, teacher_payout_uah, note, created_by)
      values (v_lesson.school_id, v_student.student_id, v_lesson.teacher_id, p_lesson_id, case when found then v_credit.id else null end, 'lesson_charge', -v_price_uah, v_payout_uah, case when p_status = 'cancelled_paid' then 'Скасоване заняття з оплатою' else 'Проведене заняття' end, auth.uid());
    end loop;
  elsif v_was_chargeable and not v_is_chargeable then
    for v_student in select * from public.lesson_students where lesson_id = p_lesson_id loop
      select * into v_charge
      from public.wallet_ledger
      where lesson_id = p_lesson_id
        and student_id = v_student.student_id
        and kind = 'lesson_charge'
        and status = 'confirmed'
      order by created_at desc
      limit 1;

      if found and v_charge.payment_credit_id is not null then
        update public.student_payment_credits
        set remaining_lesson_count = least(initial_lesson_count, remaining_lesson_count + 1)
        where id = v_charge.payment_credit_id;
      end if;

      v_price_uah := coalesce(abs(v_charge.amount_uah), v_student.price_snapshot_uah);
      v_payout_uah := coalesce(v_charge.teacher_payout_uah, v_student.teacher_payout_snapshot_uah);
      insert into public.wallet_ledger (school_id, student_id, teacher_id, lesson_id, kind, amount_uah, teacher_payout_uah, note, created_by)
      values (v_lesson.school_id, v_student.student_id, v_lesson.teacher_id, p_lesson_id, 'adjustment', v_price_uah, -v_payout_uah, 'Коригування статусу заняття', auth.uid());
    end loop;
  end if;
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
    values (v_lesson_id, v_student_id, v_rate.lesson_price_uah, round((v_rate.lesson_price_uah * v_rate.teacher_payout_percent) / 100.0)::integer);
  end loop;
  return v_lesson_id;
end;
$$;

grant execute on function public.record_student_payment(uuid, uuid, uuid, integer, date, integer, text) to authenticated;

commit;
