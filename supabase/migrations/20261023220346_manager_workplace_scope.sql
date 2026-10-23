-- Candidate only: no automatic manager workplace assignment.
begin;
alter table public.user_roles add constraint user_roles_identity_company_unique unique(auth_user_id,organization_id);
create table public.manager_workplaces (
 manager_id uuid not null,
 workplace_id uuid not null,
 organization_id uuid not null references public.organizations(id),
 primary key(manager_id,workplace_id),
 foreign key(manager_id,organization_id) references public.user_roles(auth_user_id,organization_id),
 foreign key(workplace_id,organization_id) references public.workplaces(id,organization_id)
);
create index manager_workplaces_workplace_idx on public.manager_workplaces(workplace_id,manager_id);
alter table public.manager_workplaces enable row level security;
revoke all on public.manager_workplaces from public,anon,authenticated;
grant select,insert,update,delete on public.manager_workplaces to service_role;

create function tymrak_private.manager_can_access_employee(p_manager_id uuid,p_employee_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.user_roles r
 join public.organizations o on o.id=r.organization_id and o.is_active
 join public.employees e on e.organization_id=r.organization_id and e.id=p_employee_id
 where r.auth_user_id=p_manager_id and (r.role='admin' or (r.role='manager' and exists(
  select 1 from public.manager_workplaces m
  join public.workplaces w on w.id=m.workplace_id and w.organization_id=m.organization_id
  join public.employee_workplaces a on a.workplace_id=w.id and a.organization_id=m.organization_id
  where m.manager_id=p_manager_id and m.organization_id=r.organization_id and a.employee_id=e.id))))
$$;
revoke all on function tymrak_private.manager_can_access_employee(uuid,uuid) from public,anon,authenticated,service_role;

create function public.manager_employee_scope(p_manager_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.user_roles r join public.organizations o on o.id=r.organization_id
  where r.auth_user_id=p_manager_id and r.role in ('manager','admin') and o.is_active) then
  return jsonb_build_object('error','manager_required');end if;
 return jsonb_build_object('employeeIds',(select coalesce(jsonb_agg(e.id order by e.id),'[]'::jsonb)
  from public.employees e where tymrak_private.manager_can_access_employee(p_manager_id,e.id)));
end $$;
revoke all on function public.manager_employee_scope(uuid) from public,anon,authenticated;
grant execute on function public.manager_employee_scope(uuid) to service_role;

create or replace function public.manage_workplaces(p_manager_id uuid,p_workplace jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare company uuid; manager_role text; w uuid; chosen uuid[];
begin
 select r.organization_id,r.role into company,manager_role from public.user_roles r join public.organizations o on o.id=r.organization_id
  where r.auth_user_id=p_manager_id and r.role in ('manager','admin') and o.is_active;
 if company is null then return jsonb_build_object('error','manager_required');end if;
 perform pg_advisory_xact_lock(84123001);
 if p_workplace is not null then
  w:=nullif(p_workplace->>'id','')::uuid;
  if w is not null and manager_role<>'admin' and not exists(select 1 from public.manager_workplaces where manager_id=p_manager_id and workplace_id=w and organization_id=company) then
   return jsonb_build_object('error','workplace_not_found');end if;
  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into chosen from jsonb_array_elements_text(p_workplace->'employeeIds');
  if exists(select 1 from unnest(chosen) e(id) where not exists(select 1 from public.employees where id=e.id and organization_id=company and tymrak_private.manager_can_access_employee(p_manager_id,e.id))) then
   return jsonb_build_object('error','employee_not_found');end if;
  if w is null then
   insert into public.workplaces(organization_id,name,address,latitude,longitude,radius_metres,is_active)
   values(company,p_workplace->>'name',p_workplace->>'address',(p_workplace->>'latitude')::float8,(p_workplace->>'longitude')::float8,
    (p_workplace->>'radiusMetres')::float8,(p_workplace->>'isActive')::boolean) returning id into w;
   if manager_role='manager' then insert into public.manager_workplaces(manager_id,workplace_id,organization_id) values(p_manager_id,w,company);end if;
  else
   update public.workplaces set name=p_workplace->>'name',address=p_workplace->>'address',latitude=(p_workplace->>'latitude')::float8,
    longitude=(p_workplace->>'longitude')::float8,radius_metres=(p_workplace->>'radiusMetres')::float8,
    is_active=(p_workplace->>'isActive')::boolean,updated_at=clock_timestamp() where id=w and organization_id=company;
   if not found then return jsonb_build_object('error','workplace_not_found');end if;
  end if;
  delete from public.employee_workplaces where workplace_id=w and organization_id=company;
  insert into public.employee_workplaces(employee_id,workplace_id,organization_id) select distinct unnest(chosen),w,company;
  insert into public.workplace_change_history(manager_id,workplace_id,configuration) values(p_manager_id,w,p_workplace);
 end if;
 return jsonb_build_object('workplaces',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from (
  select p.*,coalesce((select jsonb_agg(a.employee_id order by a.employee_id) from public.employee_workplaces a
   where a.workplace_id=p.id and a.organization_id=company),'[]'::jsonb) as employee_ids from public.workplaces p where p.organization_id=company and (manager_role='admin' or exists(select 1 from public.manager_workplaces m where m.manager_id=p_manager_id and m.workplace_id=p.id and m.organization_id=company))) x));
end $$;
revoke all on function public.manage_workplaces(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.manage_workplaces(uuid,jsonb) to service_role;


commit;
