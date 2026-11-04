-- Read-only checks AFTER rehearsing both company and workplace migrations.
-- Do not run against an older schema without these tables/columns.
select r.auth_user_id,r.role,r.organization_id,
 count(m.workplace_id) as assigned_workplace_count
from public.user_roles r left join public.manager_workplaces m
 on m.manager_id=r.auth_user_id and m.organization_id=r.organization_id
where r.role in ('manager','admin')
group by r.auth_user_id,r.role,r.organization_id;

select count(*) as invalid_manager_workplace_links
from public.manager_workplaces m
join public.user_roles r on r.auth_user_id=m.manager_id
join public.workplaces w on w.id=m.workplace_id
where m.organization_id is distinct from r.organization_id
 or m.organization_id is distinct from w.organization_id;

select count(*) as invalid_employee_workplace_links
from public.employee_workplaces a
join public.employees e on e.id=a.employee_id
join public.workplaces w on w.id=a.workplace_id
where a.organization_id is distinct from e.organization_id
 or a.organization_id is distinct from w.organization_id;

select has_table_privilege('authenticated','public.manager_workplaces','INSERT') as browser_can_grant_access,
 has_function_privilege('authenticated','public.manager_employee_scope(uuid)','EXECUTE') as browser_can_call_scope,
 has_function_privilege('service_role','public.manager_employee_scope(uuid)','EXECUTE') as server_can_resolve_scope;
