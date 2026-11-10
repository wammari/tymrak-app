-- Explicit company-scoped workplace RPC. Never infer a tenant from a multi-membership user.
create or replace function public.manage_workplaces_for_company(
 p_manager_id uuid, p_organization_id uuid, p_workplace jsonb default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare manager_role text; w uuid; chosen uuid[];
begin
 select r.role into manager_role from public.user_roles r
 join public.organizations o on o.id=r.organization_id and o.is_active
 where r.auth_user_id=p_manager_id and r.organization_id=p_organization_id
 and r.role in ('manager','admin');
 if manager_role is null then return jsonb_build_object('error','manager_required'); end if;
 perform pg_advisory_xact_lock(84123001);
 if p_workplace is not null then
   w:=nullif(p_workplace->>'id','')::uuid;
   if w is not null and manager_role<>'admin' and not exists (
     select 1 from public.manager_workplaces where manager_id=p_manager_id
       and workplace_id=w and organization_id=p_organization_id
   ) then return jsonb_build_object('error','workplace_not_found'); end if;
   select coalesce(array_agg(value::uuid),'{}'::uuid[]) into chosen
     from jsonb_array_elements_text(p_workplace->'employeeIds');
   if exists (
     select 1 from unnest(chosen) e(id) where not exists (
       select 1 from public.employees
       where id=e.id and organization_id=p_organization_id
       and tymrak_private.manager_can_access_employee(p_manager_id,e.id)
     )
   ) then return jsonb_build_object('error','employee_not_found'); end if;
   if w is null then
     insert into public.workplaces(organization_id,name,address,latitude,longitude,radius_metres,is_active)
     values(p_organization_id,p_workplace->>'name',p_workplace->>'address',
       (p_workplace->>'latitude')::float8,(p_workplace->>'longitude')::float8,
       (p_workplace->>'radiusMetres')::float8,(p_workplace->>'isActive')::boolean)
     returning id into w;
     if manager_role='manager' then
       insert into public.manager_workplaces(manager_id,workplace_id,organization_id)
       values(p_manager_id,w,p_organization_id);
     end if;
   else
     update public.workplaces set name=p_workplace->>'name',address=p_workplace->>'address',
       latitude=(p_workplace->>'latitude')::float8,longitude=(p_workplace->>'longitude')::float8,
       radius_metres=(p_workplace->>'radiusMetres')::float8,
       is_active=(p_workplace->>'isActive')::boolean,updated_at=clock_timestamp()
     where id=w and organization_id=p_organization_id;
     if not found then return jsonb_build_object('error','workplace_not_found'); end if;
   end if;
   delete from public.employee_workplaces where workplace_id=w and organization_id=p_organization_id;
   insert into public.employee_workplaces(employee_id,workplace_id,organization_id)
   select distinct unnest(chosen),w,p_organization_id;
   insert into public.workplace_change_history(manager_id,workplace_id,configuration)
   values(p_manager_id,w,p_workplace);
 end if;
 return jsonb_build_object('workplaces',(
   select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb)
   from (
     select p.*,coalesce((
       select jsonb_agg(a.employee_id order by a.employee_id)
       from public.employee_workplaces a
       where a.workplace_id=p.id and a.organization_id=p_organization_id
     ),'[]'::jsonb) as employee_ids
     from public.workplaces p where p.organization_id=p_organization_id
     and (manager_role='admin' or exists (
       select 1 from public.manager_workplaces m where m.manager_id=p_manager_id
       and m.workplace_id=p.id and m.organization_id=p_organization_id
     ))
   ) x
 ));
end $$;
revoke all on function public.manage_workplaces_for_company(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.manage_workplaces_for_company(uuid,uuid,jsonb) to service_role;
