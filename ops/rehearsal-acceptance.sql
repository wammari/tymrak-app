-- Executed only against a validated disposable loopback restore.
-- All mappings, workplaces, Auth fixtures and punches roll back together.
begin;
set local search_path=public,pg_catalog;
do $$
declare
 company uuid:=gen_random_uuid(); other_company uuid:=gen_random_uuid();
 admin_id uuid:='0bfba2af-ee44-47e5-ad08-d61a98992f55';
 manager_a uuid:=gen_random_uuid(); manager_b uuid:=gen_random_uuid(); foreign_admin uuid:=gen_random_uuid();
 worker_a uuid:=gen_random_uuid(); worker_b uuid:=gen_random_uuid(); worker_c uuid:=gen_random_uuid();
 employee_a uuid:=gen_random_uuid(); employee_b uuid:=gen_random_uuid(); employee_c uuid:=gen_random_uuid();
 site_a uuid:=gen_random_uuid(); site_b uuid:=gen_random_uuid(); site_c uuid:=gen_random_uuid();
 ids uuid[]; fixture record; payload jsonb; first_punch jsonb; retry_punch jsonb; last_id text;
 request_id uuid:=gen_random_uuid(); original_employees bigint; original_punches bigint;
begin
 select count(*) into original_employees from public.employees;
 select count(*) into original_punches from public.punches;
 if original_employees<>4 or not exists(select 1 from auth.users where id=admin_id and lower(email)='w.ammari@outlook.com' and email_confirmed_at is not null) then
  raise exception 'Legacy mapping assumptions require review';
 end if;
 if exists(select 1 from public.employees where organization_id is not null) then raise exception 'Unexpected preassigned company';end if;
 insert into public.organizations(id,name) values(company,'I Care Pharmacy'),(other_company,'REHEARSAL ONLY other company');
 update public.employees set organization_id=company;
 update public.user_roles set organization_id=company;
 update public.user_roles set role='admin' where auth_user_id=admin_id;
 if not found then raise exception 'Expected administrator membership missing';end if;

 -- No real workplace coordinates are assumed. These are disposable fixtures.
 insert into public.workplaces(id,organization_id,name,address,latitude,longitude,radius_metres) values
 (site_a,company,'REHEARSAL ONLY A','Synthetic location',43,-79,150),
 (site_b,company,'REHEARSAL ONLY B','Synthetic location',44,-79,150),
 (site_c,other_company,'REHEARSAL ONLY C','Synthetic location',43,-79,150);
 for fixture in select * from (values
  (manager_a,'manager-a'),(manager_b,'manager-b'),(foreign_admin,'foreign-admin'),
  (worker_a,'worker-a'),(worker_b,'worker-b'),(worker_c,'worker-c')) as fixtures(id,label)
 loop
  insert into auth.users(id,email,role,aud,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
  values(fixture.id,fixture.label||'-'||fixture.id::text||'@example.invalid','authenticated','authenticated',now(),'{}','{}');
 end loop;
 insert into public.user_roles(auth_user_id,role,organization_id) values
 (manager_a,'manager',company),(manager_b,'manager',company),(foreign_admin,'admin',other_company);
 for fixture in select * from (values
  (employee_a,worker_a,company),(employee_b,worker_b,company),(employee_c,worker_c,other_company)) as fixtures(id,auth_id,org_id)
 loop
  insert into public.employees select (jsonb_populate_record(null::public.employees,to_jsonb(e)||jsonb_build_object(
   'id',fixture.id,'auth_user_id',fixture.auth_id,'organization_id',fixture.org_id,
   'email',fixture.id::text||'@example.invalid','username','rehearsal-'||fixture.id::text,
   'is_active',true,'invitation_status','Account Activated','province','ON'))).*
  from public.employees e order by e.id limit 1;
 end loop;
 insert into public.employee_workplaces(employee_id,workplace_id,organization_id) values
 (employee_a,site_a,company),(employee_b,site_b,company),(employee_c,site_c,other_company);
 insert into public.manager_workplaces(manager_id,workplace_id,organization_id) values
 (manager_a,site_a,company),(manager_b,site_b,company),(foreign_admin,site_c,other_company);
 alter table public.employees validate constraint employees_company_required;
 alter table public.workplaces validate constraint workplaces_company_required;
 alter table public.employee_workplaces validate constraint employee_workplaces_company_required;

 execute 'set local role service_role';
 payload:=public.manager_employee_scope(manager_a);
 if payload->'employeeIds' is distinct from jsonb_build_array(employee_a) then raise exception 'Manager A scope incorrect';end if;
 payload:=public.manager_employee_scope(manager_b);
 if payload->'employeeIds' is distinct from jsonb_build_array(employee_b) then raise exception 'Manager B scope incorrect';end if;
 payload:=public.manager_employee_scope(admin_id);
 if jsonb_array_length(payload->'employeeIds') is distinct from original_employees+2 or payload->'employeeIds' @> jsonb_build_array(employee_c) then
  raise exception 'Company administrator scope incorrect';end if;
 payload:=public.manage_workplaces(manager_a,jsonb_build_object('id',site_c));
 if payload->>'error' is distinct from 'workplace_not_found' then raise exception 'Cross-company workplace accepted';end if;
 payload:=public.manage_workplaces(manager_a,jsonb_build_object('id',site_b));
 if payload->>'error' is distinct from 'workplace_not_found' then raise exception 'Unassigned workplace accepted';end if;
 execute 'reset role';
 insert into public.employee_workplaces(employee_id,workplace_id,organization_id) values(employee_a,site_b,company);
 execute 'set local role service_role';
 payload:=public.manager_employee_scope(manager_b);
 if jsonb_array_length(payload->'employeeIds') is distinct from 2 or not payload->'employeeIds' @> jsonb_build_array(employee_a,employee_b) then
  raise exception 'Shared employee scope incorrect';end if;
 payload:=public.record_geofenced_punch(worker_a,'clock_in',gen_random_uuid(),null,
  jsonb_build_object('latitude',45,'longitude',-79,'accuracyMetres',5,'capturedAt',extract(epoch from clock_timestamp())*1000));
 if payload->>'error' is distinct from 'outside_geofence' then raise exception 'Outside geofence accepted';end if;
 payload:=public.record_geofenced_punch(worker_a,'clock_in',gen_random_uuid(),null,null);
 if payload->>'error' is distinct from 'location_required' then raise exception 'Missing GPS accepted';end if;
 payload:=public.record_geofenced_punch(worker_a,'clock_in',gen_random_uuid(),null,
  jsonb_build_object('latitude',43,'longitude',-79,'accuracyMetres',5,'capturedAt',extract(epoch from clock_timestamp()-interval '60 seconds')*1000));
 if payload->>'error' is distinct from 'stale_location' then raise exception 'Stale GPS accepted';end if;
 first_punch:=public.record_geofenced_punch(worker_a,'clock_in',request_id,null,
  jsonb_build_object('latitude',43,'longitude',-79,'accuracyMetres',5,'capturedAt',extract(epoch from clock_timestamp())*1000));
 if first_punch->>'success' is distinct from 'true' then raise exception 'Clock in failed';end if;
 retry_punch:=public.record_geofenced_punch(worker_a,'clock_in',request_id,null,null);
 if retry_punch is distinct from first_punch then raise exception 'Idempotent retry failed';end if;
 last_id:=first_punch->'punch'->>'id';
 payload:=public.record_geofenced_punch(worker_a,'clock_out',gen_random_uuid(),last_id,
  jsonb_build_object('latitude',43,'longitude',-79,'accuracyMetres',5,'capturedAt',extract(epoch from clock_timestamp())*1000));
 if payload->>'success' is distinct from 'true' then raise exception 'Clock out failed';end if;
 execute 'reset role';
 if (select count(*) from public.punches)<>original_punches+2 then raise exception 'Unexpected duplicate punch';end if;
 begin
  insert into public.employee_workplaces(employee_id,workplace_id,organization_id) values(employee_c,site_a,company);
  raise exception 'Cross-company assignment accepted';
 exception when foreign_key_violation then null;
 end;
 if has_function_privilege('authenticated','public.record_geofenced_punch(uuid,text,uuid,text,jsonb)','execute')
 or has_function_privilege('anon','public.manager_employee_scope(uuid)','execute')
 or has_table_privilege('authenticated','public.punches','insert')
 or has_table_privilege('authenticated','public.manager_workplaces','insert') then raise exception 'Browser write permissions exposed';end if;
 if exists(select 1 from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname in ('set_updated_at','prevent_approved_timecard_punch_changes','rls_auto_enable')
  and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))) then
  raise exception 'Trigger helper directly exposed';end if;
 perform set_config('request.jwt.claim.sub',worker_a::text,true);
 execute 'set local role authenticated';
 select array_agg(id) into ids from public.employees;
 if ids is distinct from array[employee_a] then raise exception 'Employee RLS scope incorrect';end if;
 if exists(select 1 from public.punches where employee_id<>employee_a) then raise exception 'Employee punch RLS scope incorrect';end if;
 execute 'reset role';
end $$;
select jsonb_build_object('all_checks_passed',true,'company_admin',true,'workplace_manager_scope',true,
 'shared_employee',true,'cross_company_denial',true,'employee_rls',true,'clock_in_out',true,
 'idempotent_retry',true,'outside_geofence_denial',true,'gps_required',true,'stale_gps_denial',true,
 'company_constraints_validated',true,'trigger_helpers_hardened',true) as acceptance;
rollback;
