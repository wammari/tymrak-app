-- The Main Administrator can change a company's pay schedule, but only from a future pay
-- period. organizations.pay_frequency / pay_period_anchor stay as the schedule chosen at
-- sign-up (still locked); each change is a history row that applies from its date on.
-- Periods that have started, been approved or been paid can never move. If a change
-- starts inside a future period of the old schedule, that period ends the day before the
-- change (one short transition period).
begin;

create table public.pay_schedule_changes (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id),
  pay_frequency text not null,
  pay_period_anchor date,
  effective_from date not null,
  changed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint pay_schedule_changes_frequency_check
    check (pay_frequency in ('weekly', 'biweekly', 'semi_monthly', 'monthly')),
  -- Weekly and every-two-weeks periods are counted from the change date itself.
  constraint pay_schedule_changes_anchor_check
    check ((pay_frequency in ('weekly', 'biweekly') and pay_period_anchor = effective_from)
        or (pay_frequency in ('semi_monthly', 'monthly') and pay_period_anchor is null)),
  constraint pay_schedule_changes_one_per_date unique (organization_id, effective_from)
);
comment on table public.pay_schedule_changes is
  'Pay schedule changes made by the Main Administrator; each applies from effective_from.';

alter table public.pay_schedule_changes enable row level security;
revoke all on public.pay_schedule_changes from public, anon, authenticated;
grant select on public.pay_schedule_changes to service_role;

-- True when a pay period of this schedule starts on day d.
create function tymrak_private.pay_period_starts_on(p_frequency text, p_anchor date, p_day date)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case p_frequency
    when 'monthly' then extract(day from p_day) = 1
    when 'semi_monthly' then extract(day from p_day) in (1, 16)
    when 'weekly' then mod(mod(p_day - p_anchor, 7) + 7, 7) = 0
    when 'biweekly' then mod(mod(p_day - p_anchor, 14) + 14, 14) = 0
  end, false)
$$;
revoke all on function tymrak_private.pay_period_starts_on(text, date, date) from public, anon, authenticated;

-- The first day of the period of this schedule that contains day d.
create function tymrak_private.pay_period_start(p_frequency text, p_anchor date, p_day date)
returns date language sql immutable set search_path = '' as $$
  select case p_frequency
    when 'monthly' then date_trunc('month', p_day)::date
    when 'semi_monthly' then date_trunc('month', p_day)::date + case when extract(day from p_day) >= 16 then 15 else 0 end
    when 'weekly' then p_day - mod(mod(p_day - p_anchor, 7) + 7, 7)
    when 'biweekly' then p_day - mod(mod(p_day - p_anchor, 14) + 14, 14)
  end
$$;
revoke all on function tymrak_private.pay_period_start(text, date, date) from public, anon, authenticated;

-- Schedules a change. Server only. Refuses anything that would move a period already
-- started: the change must start on a future date that can begin a period of the new
-- schedule, and the old-schedule period it falls in (which then ends early) must not have
-- started yet.
create function public.change_company_pay_schedule(
  p_organization_id uuid, p_pay_frequency text, p_effective_from date, p_changed_by uuid
)
returns table (id bigint, organization_id uuid, pay_frequency text, pay_period_anchor date, effective_from date)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_today date := (now() at time zone 'America/Toronto')::date;
  v_old_frequency text;
  v_old_anchor date;
  v_old_from date;
  v_change_id bigint;
begin
  -- One change at a time per company.
  perform 1 from public.organizations o where o.id = p_organization_id for update;
  if not found then
    raise exception 'Company not found' using errcode = 'no_data_found';
  end if;
  if p_effective_from is null or p_effective_from <= v_today then
    raise exception 'A new pay schedule can only start on a future date' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.pay_schedule_changes c
             where c.organization_id = p_organization_id and c.effective_from > v_today) then
    raise exception 'This company already has a pay schedule change waiting to start. Cancel it first.'
      using errcode = 'check_violation';
  end if;
  select c.pay_frequency, c.pay_period_anchor, c.effective_from into v_old_frequency, v_old_anchor, v_old_from
  from public.pay_schedule_changes c
  where c.organization_id = p_organization_id and c.effective_from < p_effective_from
  order by c.effective_from desc limit 1;
  if not found then
    select o.pay_frequency, o.pay_period_anchor into v_old_frequency, v_old_anchor
    from public.organizations o where o.id = p_organization_id;
  end if;
  if p_pay_frequency is not distinct from v_old_frequency then
    raise exception 'The company already uses this pay schedule' using errcode = 'check_violation';
  end if;
  if greatest(tymrak_private.pay_period_start(v_old_frequency, v_old_anchor, p_effective_from),
              coalesce(v_old_from, '-infinity'::date)) <= v_today then
    raise exception 'That date falls inside a pay period that has already started. Choose a date after it ends.'
      using errcode = 'check_violation';
  end if;
  if not tymrak_private.pay_period_starts_on(p_pay_frequency, p_effective_from, p_effective_from) then
    raise exception 'The new pay schedule must start on the first day of one of its own pay periods'
      using errcode = 'check_violation';
  end if;
  insert into public.pay_schedule_changes (organization_id, pay_frequency, pay_period_anchor, effective_from, changed_by)
  values (p_organization_id, p_pay_frequency,
          case when p_pay_frequency in ('weekly', 'biweekly') then p_effective_from end,
          p_effective_from, p_changed_by)
  returning public.pay_schedule_changes.id into v_change_id;
  return query
    select c.id, c.organization_id, c.pay_frequency, c.pay_period_anchor, c.effective_from
    from public.pay_schedule_changes c where c.id = v_change_id;
end $$;
revoke all on function public.change_company_pay_schedule(uuid, text, date, uuid) from public, anon, authenticated;
grant execute on function public.change_company_pay_schedule(uuid, text, date, uuid) to service_role;

-- Cancels a change that has not started yet. Server only. Returns false when there was no
-- such change (already started, or not this company's).
create function public.cancel_pay_schedule_change(p_organization_id uuid, p_change_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.pay_schedule_changes c
  where c.id = p_change_id and c.organization_id = p_organization_id
    and c.effective_from > (now() at time zone 'America/Toronto')::date;
  return found;
end $$;
revoke all on function public.cancel_pay_schedule_change(uuid, bigint) from public, anon, authenticated;
grant execute on function public.cancel_pay_schedule_change(uuid, bigint) to service_role;

-- The employee timecard page now gets the whole history: the sign-up schedule first
-- (effective_from null), then each change. Still only for the employee's own company.
drop function public.employee_pay_schedule();
create function public.employee_pay_schedule()
returns table (pay_frequency text, pay_period_anchor date, effective_from date)
language sql stable security definer set search_path = '' as $$
  select s.pay_frequency, s.pay_period_anchor, s.effective_from from (
    select o.pay_frequency, o.pay_period_anchor, null::date as effective_from
    from public.employees e join public.organizations o on o.id = e.organization_id
    where e.auth_user_id = (select auth.uid())
    union all
    select c.pay_frequency, c.pay_period_anchor, c.effective_from
    from public.employees e join public.pay_schedule_changes c on c.organization_id = e.organization_id
    where e.auth_user_id = (select auth.uid())
  ) s
  order by s.effective_from nulls first
$$;
revoke all on function public.employee_pay_schedule() from public, anon;
grant execute on function public.employee_pay_schedule() to authenticated;

commit;
