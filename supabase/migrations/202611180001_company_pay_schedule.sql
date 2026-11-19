-- Each company chooses its pay schedule once, at sign-up.
-- Existing companies keep the original semi-monthly schedule (1st-15th, 16th-end).
begin;

alter table public.organizations
  add column pay_frequency text not null default 'semi_monthly',
  add column pay_period_anchor date;

alter table public.organizations add constraint organizations_pay_frequency_check
  check (pay_frequency in ('weekly', 'biweekly', 'semi_monthly', 'monthly'));

-- Weekly and every-two-weeks schedules need the start date of a first pay period so
-- every later period can be counted from it. The other schedules follow the calendar.
alter table public.organizations add constraint organizations_pay_period_anchor_check
  check ((pay_frequency in ('weekly', 'biweekly')) = (pay_period_anchor is not null));

comment on column public.organizations.pay_frequency is
  'Pay schedule chosen at sign-up: weekly, biweekly, semi_monthly or monthly. Locked afterwards.';
comment on column public.organizations.pay_period_anchor is
  'Start date of any one pay period, for weekly and biweekly schedules only.';

-- Set once at sign-up. Changing it later would move the boundaries of pay periods that
-- may already be approved or sent to payroll. A deliberate support change can be made
-- from the SQL editor inside a transaction that first runs:
--   set local tymrak.allow_pay_schedule_change = 'on';
create function tymrak_private.lock_pay_schedule() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.pay_frequency is distinct from old.pay_frequency
      or new.pay_period_anchor is distinct from old.pay_period_anchor)
     and coalesce(current_setting('tymrak.allow_pay_schedule_change', true), '') <> 'on' then
    raise exception 'A company pay schedule is set at sign-up and cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function tymrak_private.lock_pay_schedule() from public, anon, authenticated;

create trigger organizations_lock_pay_schedule
  before update of pay_frequency, pay_period_anchor on public.organizations
  for each row execute function tymrak_private.lock_pay_schedule();

-- The employee timecard page needs its own company's schedule. Organizations stay
-- closed to the browser; this returns only the two schedule fields, and only for the
-- signed-in employee's own company.
create function public.employee_pay_schedule()
returns table (pay_frequency text, pay_period_anchor date)
language sql stable security definer set search_path = '' as $$
  select o.pay_frequency, o.pay_period_anchor
  from public.employees e
  join public.organizations o on o.id = e.organization_id
  where e.auth_user_id = (select auth.uid())
  limit 1
$$;
revoke all on function public.employee_pay_schedule() from public, anon;
grant execute on function public.employee_pay_schedule() to authenticated;

commit;
