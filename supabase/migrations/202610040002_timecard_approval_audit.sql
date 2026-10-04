-- Phase 2B: reversible approvals with append-only approval history.
-- Existing approved rows are retained and backfilled into the history table.
alter table public.timecard_approvals
  drop constraint if exists timecard_approvals_status_check;

alter table public.timecard_approvals
  add column if not exists reopened_by uuid references auth.users(id),
  add column if not exists reopened_at timestamptz,
  add column if not exists reopen_reason text,
  add constraint timecard_approvals_status_check
    check (status in ('approved', 'reopened')),
  add constraint timecard_approvals_reopen_fields_check check (
    (status = 'approved') or
    (reopened_by is not null and reopened_at is not null and
     reopen_reason is not null and btrim(reopen_reason) <> '')
  );

create table if not exists public.timecard_approval_history (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.timecard_approvals(id),
  employee_id uuid not null references public.employees(id),
  period_start date not null,
  period_end date not null,
  work_timezone text not null,
  action text not null check (action in ('approved', 'reopened', 're-approved')),
  manager_user_id uuid not null references auth.users(id),
  occurred_at timestamptz not null,
  reopen_reason text,
  constraint timecard_approval_history_period_order check (period_end >= period_start),
  constraint timecard_approval_history_timezone_present check (btrim(work_timezone) <> ''),
  constraint timecard_approval_history_reason_check check (
    (action = 'reopened' and reopen_reason is not null and
     btrim(reopen_reason) <> '') or
    (action <> 'reopened' and reopen_reason is null)
  )
);

-- Capture the approvals that predate this audit table without changing them.
insert into public.timecard_approval_history
  (approval_id, employee_id, period_start, period_end, work_timezone, action,
   manager_user_id, occurred_at, reopen_reason)
select id, employee_id, period_start, period_end, work_timezone, 'approved',
       approved_by, approved_at, null
from public.timecard_approvals
where status = 'approved'
  and not exists (
    select 1 from public.timecard_approval_history h
    where h.approval_id = timecard_approvals.id and h.action = 'approved'
  );

create or replace function public.audit_timecard_approval_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_action text;
  audit_manager uuid;
  audit_time timestamptz;
  audit_reason text;
begin
  if tg_op = 'INSERT' then
    audit_action := 'approved';
    audit_manager := new.approved_by;
    audit_time := new.approved_at;
  elsif old.status = 'reopened' and new.status = 'approved' then
    audit_action := 're-approved';
    audit_manager := new.approved_by;
    audit_time := new.approved_at;
  elsif old.status = 'approved' and new.status = 'reopened' then
    audit_action := 'reopened';
    audit_manager := new.reopened_by;
    audit_time := new.reopened_at;
    audit_reason := new.reopen_reason;
  else
    return new;
  end if;

  insert into public.timecard_approval_history
    (approval_id, employee_id, period_start, period_end, work_timezone, action,
     manager_user_id, occurred_at, reopen_reason)
  values
    (new.id, new.employee_id, new.period_start, new.period_end,
     new.work_timezone, audit_action, audit_manager, audit_time, audit_reason);
  return new;
end
$$;

create or replace function public.prevent_timecard_approval_history_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001',
    message = 'Timecard approval history is append-only.';
end
$$;

drop trigger if exists audit_timecard_approval_changes on public.timecard_approvals;
create trigger audit_timecard_approval_changes
after insert or update on public.timecard_approvals
for each row execute function public.audit_timecard_approval_change();

drop trigger if exists prevent_timecard_approval_history_changes on public.timecard_approval_history;
create trigger prevent_timecard_approval_history_changes
before update or delete on public.timecard_approval_history
for each row execute function public.prevent_timecard_approval_history_changes();

alter table public.timecard_approval_history enable row level security;

-- Like approvals, history has no browser policy. Only protected server operations
-- use the service credential; the trigger is the only application writer.
revoke all on table public.timecard_approval_history from anon, authenticated;
revoke execute on function public.audit_timecard_approval_change() from public;
revoke execute on function public.prevent_timecard_approval_history_changes() from public;

comment on table public.timecard_approval_history is
  'Append-only audit events for approval, reopen, and re-approval transitions.';
