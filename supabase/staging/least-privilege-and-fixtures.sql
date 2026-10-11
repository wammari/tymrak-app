-- Run only as part of the guarded empty-staging bootstrap.
-- Do not copy production's browser TRUNCATE, TRIGGER or REFERENCES grants.
revoke all on table public.employees, public.overtime_rules, public.punches,
  public.user_roles, public.timecard_approvals, public.timecard_approval_history
  from public, anon, authenticated, service_role;
revoke all on sequence public.punches_id_seq from public, anon, authenticated, service_role;
grant usage on schema public to authenticated, service_role;
grant select on public.employees, public.overtime_rules, public.punches to authenticated;
grant insert on public.punches to authenticated;
grant usage on sequence public.punches_id_seq to authenticated, service_role;
grant select, insert, update on public.employees to service_role;
grant select, insert, update, delete on public.punches to service_role;
grant select on public.overtime_rules, public.user_roles, public.timecard_approval_history to service_role;
grant select, insert, update on public.timecard_approvals to service_role;
revoke execute on function public.set_updated_at() from public, anon, authenticated, service_role;
-- Other trigger-function and activation RPC grants come from the exact migrations.

comment on table public.employees is 'TYMRAK empty staging bootstrap: cztwqcsizwkrqgpgrgg';

-- Synthetic fixture for ON-only smoke tests, not a recovered business dataset.
insert into public.overtime_rules (
  province_code, province_name, rule_name, weekly_threshold_hours, effective_from, notes
) values (
  'ON', 'Ontario', 'STAGING TEST ONLY - weekly smoke test', 44, '2026-01-01',
  'Synthetic test fixture. Not approved for payroll or legal compliance.'
);
-- No employee profiles or auth.users are inserted. Invite controlled test inboxes through the app.
