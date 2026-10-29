-- The original approval migration used a different constraint name than the
-- audit migration dropped. Keep the newer approved/reopened check intact.
-- No rows, audit events, triggers, or other constraints are changed.
alter table public.timecard_approvals
  drop constraint if exists timecard_approvals_status;
