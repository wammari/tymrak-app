-- Reopen reasons are optional. Manager identity and timestamp remain mandatory,
-- and existing approval/history rows remain valid without being rewritten.
alter table public.timecard_approvals
  drop constraint if exists timecard_approvals_reopen_fields_check;

alter table public.timecard_approvals
  add constraint timecard_approvals_reopen_fields_check check (
    (status = 'approved') or
    (reopened_by is not null and reopened_at is not null)
  );

alter table public.timecard_approval_history
  drop constraint if exists timecard_approval_history_reason_check;

alter table public.timecard_approval_history
  add constraint timecard_approval_history_reason_check check (
    (action = 'reopened') or
    (action <> 'reopened' and reopen_reason is null)
  );

comment on column public.timecard_approvals.reopen_reason is
  'Optional manager-supplied context for a reopened timecard.';

comment on column public.timecard_approval_history.reopen_reason is
  'Optional context captured for reopened events; null for other actions.';
