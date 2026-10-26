-- READ ONLY. Run against the confirmed TYMRAK production project
-- tsosredghislnehfyypi, not staging. This query does not authorize migration.
select jsonb_build_object(
 'employees', (select count(*) from public.employees),
 'punches', (select count(*) from public.punches),
 'auth_users', (select count(*) from auth.users),
 'storage_objects', (select count(*) from storage.objects),
 'organizations_table', to_regclass('public.organizations'),
 'workplaces_table', to_regclass('public.workplaces'),
 'employee_workplaces_table', to_regclass('public.employee_workplaces'),
 'manager_workplaces_table', to_regclass('public.manager_workplaces'),
 'activation_rpc', to_regprocedure('public.complete_employee_activation(uuid)'),
 'geofenced_punch_rpc', to_regprocedure('public.record_geofenced_punch(uuid,text,uuid,text,jsonb)'),
 'manager_scope_rpc', to_regprocedure('public.manager_employee_scope(uuid)'),
 'duplicate_employee_auth_mappings', (select count(*) from (
   select auth_user_id from public.employees where auth_user_id is not null
   group by auth_user_id having count(*)>1
 ) d),
 'company_admin_identity', (select jsonb_agg(jsonb_build_object(
   'auth_user_id',u.id,'email',u.email,'confirmed',u.email_confirmed_at is not null,'current_role',r.role
 )) from auth.users u left join public.user_roles r on r.auth_user_id=u.id
 where lower(u.email)='w.ammari@outlook.com')
) as release_preflight;

-- These are trigger/event-trigger helpers, not public RPCs. Their public
-- EXECUTE privileges need review before launch; do not change their bodies.
select p.oid::regprocedure as routine,p.prorettype::regtype as returns,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
from pg_proc p where p.pronamespace='public'::regnamespace
and p.proname in ('rls_auto_enable','prevent_approved_timecard_punch_changes','set_updated_at');
