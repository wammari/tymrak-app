-- Persistent manager approval and database-enforced punch locking by local work date.
create table if not exists public.timecard_approvals (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  -- Snapshot the timezone used to interpret these canonical dates. Today the
  -- protected API resolves this from province; a future Locations module can
  -- resolve it from the assigned work location without rewriting approvals.
  work_timezone text not null,
  status text not null default 'approved',
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timecard_approvals_period_order check (period_end >= period_start),
  constraint timecard_approvals_timezone_present check (btrim(work_timezone) <> ''),
  constraint timecard_approvals_status check (status = 'approved'),
  constraint timecard_approvals_employee_period_unique
    unique (employee_id, period_start, period_end)
);

alter table public.timecard_approvals enable row level security;

-- No browser policies are created. Approval reads/writes go through the protected
-- server API using the service credential after requireManager authorization.

create or replace function public.prevent_approved_timecard_punch_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_employee_id uuid;
  target_punched_at timestamptz;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    target_employee_id := old.employee_id;
    target_punched_at := old.punched_at;
    if exists (select 1 from public.timecard_approvals a
      where a.employee_id = target_employee_id and a.status = 'approved'
        and (target_punched_at at time zone a.work_timezone)::date
          between a.period_start and a.period_end) then
      raise exception using errcode = 'P0001',
        message = 'This timecard period is approved and locked.';
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;

  target_employee_id := new.employee_id;
  target_punched_at := new.punched_at;
  if exists (select 1 from public.timecard_approvals a
    where a.employee_id = target_employee_id and a.status = 'approved'
      and (target_punched_at at time zone a.work_timezone)::date
        between a.period_start and a.period_end) then
    raise exception using errcode = 'P0001',
      message = 'This timecard period is approved and locked.';
  end if;
  return new;
end
$$;

drop trigger if exists block_approved_timecard_punch_changes on public.punches;
create trigger block_approved_timecard_punch_changes
before insert or update or delete on public.punches
for each row execute function public.prevent_approved_timecard_punch_changes();

revoke all on table public.timecard_approvals from anon, authenticated;
revoke execute on function public.prevent_approved_timecard_punch_changes() from public;

comment on table public.timecard_approvals is
  'Manager-approved, locked employee pay periods; managed only through protected server APIs.';
