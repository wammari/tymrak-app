-- OPTIONAL, MANUAL, STAGING ONLY: after creating ONE controlled test manager in Auth.
-- Verify Dashboard project cztwqcsizwkrqgpgrgg. This does not create or alter Auth users.
begin;
-- Uncomment only after checking the project:
-- set local tymrak.staging_confirmation = 'cztwqcsizwkrqgpgrgg';
do $seed$
declare
  test_manager_id uuid;
  test_manager_email text := 'REPLACE_WITH_CONTROLLED_TEST_MANAGER_EMAIL';
begin
  if current_setting('tymrak.staging_confirmation', true) is distinct from 'cztwqcsizwkrqgpgrgg'
    or obj_description('public.employees'::regclass, 'pg_class')
      is distinct from 'TYMRAK empty staging bootstrap: cztwqcsizwkrqgpgrgg' then
    raise exception 'STOP: staging bootstrap marker and explicit confirmation required';
  end if;
  if test_manager_email = 'REPLACE_WITH_CONTROLLED_TEST_MANAGER_EMAIL' then
    raise exception 'Replace the test manager email; never use a production account';
  end if;
  select id into strict test_manager_id from auth.users where email = test_manager_email;
  if exists (select 1 from public.employees where auth_user_id = test_manager_id) then
    raise exception 'Use a separate test manager, not an employee identity';
  end if;
  insert into public.user_roles (auth_user_id, role) values (test_manager_id, 'manager');
  -- No ON CONFLICT UPDATE: never silently change an existing role.
end;
$seed$;
commit;
