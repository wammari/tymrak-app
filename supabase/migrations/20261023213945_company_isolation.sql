-- Candidate only. No automatic company assignment or production backfill.
begin;
create table public.organizations (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) between 1 and 120),
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);
alter table public.organizations enable row level security;
revoke all on public.organizations from public,anon,authenticated;
grant select,insert,update on public.organizations to service_role;
alter table public.user_roles add column organization_id uuid references public.organizations(id);
revoke all on public.user_roles from public,anon,authenticated;
grant select on public.user_roles to service_role;
alter table public.employees add column organization_id uuid references public.organizations(id);
alter table public.workplaces add column organization_id uuid references public.organizations(id);
-- NOT VALID retains legacy rows without guessing ownership, but requires a
-- reviewed company assignment for every new/updated record. Validate after backfill.
alter table public.employees add constraint employees_company_required check(organization_id is not null) not valid;
alter table public.workplaces add constraint workplaces_company_required check(organization_id is not null) not valid;
alter table public.employees add constraint employees_id_company_unique unique(id,organization_id);
alter table public.workplaces add constraint workplaces_id_company_unique unique(id,organization_id);
create index employees_company_idx on public.employees(organization_id,id);
create index workplaces_company_idx on public.workplaces(organization_id,id);
create index user_roles_company_idx on public.user_roles(organization_id);
-- Initial release keeps one employee record per Auth identity. Duplicate legacy
-- mappings stop migration for review rather than creating an ambiguous company.
create unique index if not exists employees_auth_user_id_company_unique on public.employees(auth_user_id) where auth_user_id is not null;
alter table public.employee_workplaces add column organization_id uuid references public.organizations(id);
alter table public.employee_workplaces add constraint employee_workplaces_company_required check(organization_id is not null) not valid;
alter table public.employee_workplaces add constraint employee_workplaces_employee_company_fk
 foreign key(employee_id,organization_id) references public.employees(id,organization_id);
alter table public.employee_workplaces add constraint employee_workplaces_workplace_company_fk
 foreign key(workplace_id,organization_id) references public.workplaces(id,organization_id);

create schema if not exists tymrak_private;
revoke all on schema tymrak_private from public,anon,authenticated;
grant usage on schema tymrak_private to authenticated;
create function tymrak_private.preserve_company() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.organization_id is distinct from old.organization_id then
  if old.organization_id is not null or current_user not in ('postgres','service_role','supabase_admin') then
   raise exception 'Company ownership cannot be reassigned';
  end if;
 end if;
 return new;
end $$;
revoke all on function tymrak_private.preserve_company() from public,anon,authenticated;
create trigger preserve_employee_company before update on public.employees for each row execute function tymrak_private.preserve_company();
create trigger preserve_workplace_company before update on public.workplaces for each row execute function tymrak_private.preserve_company();

-- Defense against legacy permissive browser policies. Managers use server APIs.
create function tymrak_private.own_active_company_employee(p_employee_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.employees e join public.organizations o on o.id=e.organization_id
  where e.id=p_employee_id and e.auth_user_id=(select auth.uid()) and o.is_active and e.is_active
   and e.invitation_status='Account Activated')
$$;
revoke all on function tymrak_private.own_active_company_employee(uuid) from public,anon,authenticated;
grant execute on function tymrak_private.own_active_company_employee(uuid) to authenticated;
create policy company_employee_boundary on public.employees as restrictive for all to authenticated
 using(tymrak_private.own_active_company_employee(id)) with check(tymrak_private.own_active_company_employee(id));
create policy company_punch_boundary on public.punches as restrictive for all to authenticated
 using(tymrak_private.own_active_company_employee(employee_id)) with check(tymrak_private.own_active_company_employee(employee_id));
-- Clocking, activation and management already have server endpoints. Retain
-- only authenticated personal reads, including against legacy column grants.
revoke all on public.employees,public.punches from public,anon,authenticated;
do $$
declare relation text; columns text;
begin
 foreach relation in array array['employees','punches'] loop
  select string_agg(quote_ident(attname),',') into columns from pg_catalog.pg_attribute
   where attrelid=('public.'||relation)::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s),insert (%s),update (%s),references (%s) on public.%I from public,anon,authenticated',columns,columns,columns,columns,relation);
 end loop;
end $$;
grant select on public.employees,public.punches to authenticated;

-- One server-managed company membership per manager identity, using existing
-- user_roles primary key. Global roles alone no longer authorize workplaces.
create or replace function public.manage_workplaces(p_manager_id uuid,p_workplace jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare company uuid; w uuid; chosen uuid[];
begin
 select r.organization_id into company from public.user_roles r join public.organizations o on o.id=r.organization_id
  where r.auth_user_id=p_manager_id and r.role in ('manager','admin') and o.is_active;
 if company is null then return jsonb_build_object('error','manager_required');end if;
 perform pg_advisory_xact_lock(84123001);
 if p_workplace is not null then
  w:=nullif(p_workplace->>'id','')::uuid;
  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into chosen from jsonb_array_elements_text(p_workplace->'employeeIds');
  if exists(select 1 from unnest(chosen) e(id) where not exists(select 1 from public.employees where id=e.id and organization_id=company)) then
   return jsonb_build_object('error','employee_not_found');end if;
  if w is null then
   insert into public.workplaces(organization_id,name,address,latitude,longitude,radius_metres,is_active)
   values(company,p_workplace->>'name',p_workplace->>'address',(p_workplace->>'latitude')::float8,(p_workplace->>'longitude')::float8,
    (p_workplace->>'radiusMetres')::float8,(p_workplace->>'isActive')::boolean) returning id into w;
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
   where a.workplace_id=p.id and a.organization_id=company),'[]'::jsonb) as employee_ids from public.workplaces p where p.organization_id=company) x));
end $$;
revoke all on function public.manage_workplaces(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.manage_workplaces(uuid,jsonb) to service_role;

-- Retain the tested punch implementation behind a service-only company gate.
-- Move the internal functions out of the exposed schema; close old entry points.
alter function public.record_geofenced_punch(uuid,text,uuid,text,jsonb) set schema tymrak_private;
revoke all on function tymrak_private.record_geofenced_punch(uuid,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.record_geofenced_punch(p_auth_user_id uuid,p_punch_type text default null,p_request_id uuid default null,
 p_expected_last_id text default null,p_location jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.employees e join public.organizations o on o.id=e.organization_id
  where e.auth_user_id=p_auth_user_id and o.is_active) then return jsonb_build_object('error','employee_unavailable');end if;
 if exists(select 1 from public.employee_workplaces a join public.employees e on e.id=a.employee_id
  join public.workplaces w on w.id=a.workplace_id where e.auth_user_id=p_auth_user_id
  and (a.organization_id is distinct from e.organization_id or w.organization_id is distinct from e.organization_id)) then
  return jsonb_build_object('error','workplace_unassigned');end if;
 return tymrak_private.record_geofenced_punch(p_auth_user_id,p_punch_type,p_request_id,p_expected_last_id,p_location);
end $$;
revoke all on function public.record_geofenced_punch(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_geofenced_punch(uuid,text,uuid,text,jsonb) to service_role;

alter function public.complete_employee_activation(uuid) set schema tymrak_private;
revoke all on function tymrak_private.complete_employee_activation(uuid) from public,anon,authenticated,service_role;
create function public.complete_employee_activation(p_auth_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.employees e join public.organizations o on o.id=e.organization_id
  where e.auth_user_id=p_auth_user_id and o.is_active) then return jsonb_build_object('outcome','missing');end if;
 return tymrak_private.complete_employee_activation(p_auth_user_id);
end $$;
revoke all on function public.complete_employee_activation(uuid) from public,anon,authenticated;
grant execute on function public.complete_employee_activation(uuid) to service_role;
commit;
