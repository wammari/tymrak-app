-- REVIEW / REHEARSAL ONLY. This script always ROLLS BACK.
-- Run only after the five rehearsed release migrations, in a maintenance window.
-- Do not change ROLLBACK to COMMIT without reviewed production-cutover approval.
-- The candidate map pin has NOT passed owner/on-site verification. The new
-- workplace remains INACTIVE and no employee workplace access is granted here.
-- Snapshot guard refreshed for the October 31 read-only backup review (47 punches).
-- Any later activity must stop this script for another backup/mapping review.
begin;
set local search_path=public,pg_catalog;
lock table public.employees,public.user_roles,public.organizations,
 public.workplaces,public.employee_workplaces,public.manager_workplaces,
 public.punches in share row exclusive mode;
do $$
declare
 company uuid; administrator uuid;
 before_punches text; before_employees text; before_auth text; before_other_roles text;
begin
 if (select count(*) from public.employees)<>4
 or (select count(*) from auth.users)<>4
 or (select count(*) from public.punches)<>47 then
  raise exception 'Legacy inventory differs from reviewed snapshot; refresh backup and review mapping';
 end if;
 if exists(select 1 from public.organizations)
 or exists(select 1 from public.workplaces)
 or exists(select 1 from public.employee_workplaces)
 or exists(select 1 from public.manager_workplaces)
 or exists(select 1 from public.employees where organization_id is not null)
 or (select count(*) from public.user_roles)<>2 then
  raise exception 'Unexpected company, workplace or membership state; no automatic reassignment';
 end if;
 if (select count(*) from auth.users where lower(email)='w.ammari@outlook.com'
  and email_confirmed_at is not null)<>1 then
  raise exception 'Expected confirmed administrator identity is missing or ambiguous';
 end if;
 select id into administrator from auth.users where lower(email)='w.ammari@outlook.com'
  and email_confirmed_at is not null;
 if not exists(select 1 from public.user_roles where auth_user_id=administrator
  and role='manager' and organization_id is null) then
  raise exception 'Expected legacy manager membership changed; review before granting company administration';
 end if;
 if (select count(*) from public.user_roles r
  join auth.users u on u.id=r.auth_user_id and u.email_confirmed_at is not null
  join public.employees e on e.auth_user_id=r.auth_user_id
  where r.auth_user_id<>administrator and r.role='manager' and r.organization_id is null
   and e.is_active and e.invitation_status='Account Activated')<>1 then
  raise exception 'Additional legacy manager differs from reviewed test membership; no automatic access grant';
 end if;
 select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.auth_user_id)::text,'[]')) into before_other_roles
  from public.user_roles r where r.auth_user_id<>administrator;
 select md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id)::text,'[]')) into before_punches from public.punches p;
 select md5(coalesce(jsonb_agg(to_jsonb(e)-'organization_id'-'updated_at' order by e.id)::text,'[]')) into before_employees from public.employees e;
 select md5(coalesce(jsonb_agg(to_jsonb(u) order by u.id)::text,'[]')) into before_auth from auth.users u;

 insert into public.organizations(name) values('I Care Pharmacy') returning id into company;
 update public.employees set organization_id=company where organization_id is null;
 update public.user_roles set organization_id=company,role='admin' where auth_user_id=administrator;
 -- Review-only candidate location; activation and assignments are separate gates.
 insert into public.workplaces(organization_id,name,address,latitude,longitude,radius_metres,is_active)
 values(company,'I Care Pharmacy','11 Speedvale Ave E, Guelph, Ontario, Canada',43.5585125,-80.2676337,50,false);
 alter table public.employees validate constraint employees_company_required;
 alter table public.workplaces validate constraint workplaces_company_required;
 alter table public.employee_workplaces validate constraint employee_workplaces_company_required;

 if before_punches is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id)::text,'[]')) from public.punches p)
 or before_employees is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(e)-'organization_id'-'updated_at' order by e.id)::text,'[]')) from public.employees e)
 or before_auth is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(u) order by u.id)::text,'[]')) from auth.users u) then
  raise exception 'Unexpected employee, punch or Auth history change';
 end if;
 if before_other_roles is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.auth_user_id)::text,'[]'))
  from public.user_roles r where r.auth_user_id<>administrator) then
  raise exception 'Unexpected change to another legacy manager membership';
 end if;
end $$;
select jsonb_build_object(
 'company_count',(select count(*) from public.organizations),
 'company_employee_count',(select count(*) from public.employees where organization_id is not null),
 'administrator_count',(select count(*) from public.user_roles where role='admin' and organization_id is not null),
 'quarantined_manager_count',(select count(*) from public.user_roles where organization_id is null),
 'inactive_workplace_count',(select count(*) from public.workplaces where not is_active and radius_metres=50),
 'employee_assignments',(select count(*) from public.employee_workplaces),
 'punches',(select count(*) from public.punches),
 'will_commit',false
) as bootstrap_review;
rollback;
