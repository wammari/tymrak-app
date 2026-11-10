begin;
create table public.workplaces (
 id uuid primary key default gen_random_uuid(), name text not null check(length(btrim(name)) between 1 and 120),
 address text not null default '' check(length(address)<=300), latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180), radius_metres double precision not null check(radius_metres between 25 and 5000),
 is_active boolean not null default true, updated_at timestamptz not null default now()
);
create table public.employee_workplaces (
 employee_id uuid not null references public.employees(id), workplace_id uuid not null references public.workplaces(id),
 primary key(employee_id,workplace_id)
);
create index employee_workplaces_workplace_idx on public.employee_workplaces(workplace_id);
create table public.punch_location_verifications (
 punch_id bigint primary key references public.punches(id), workplace_id uuid not null references public.workplaces(id),
 workplace_name text not null, latitude double precision not null, longitude double precision not null,
 accuracy_metres double precision not null, distance_metres double precision not null,
 captured_at timestamptz not null, verified_at timestamptz not null default clock_timestamp()
);
create table public.workplace_change_history (
 id bigint generated always as identity primary key, manager_id uuid not null references auth.users(id),
 workplace_id uuid not null references public.workplaces(id), configuration jsonb not null, changed_at timestamptz not null default clock_timestamp()
);
create index punch_location_verifications_workplace_idx on public.punch_location_verifications(workplace_id);
create index workplace_change_history_workplace_idx on public.workplace_change_history(workplace_id);
create index workplace_change_history_manager_idx on public.workplace_change_history(manager_id);
alter table public.workplaces enable row level security;
alter table public.employee_workplaces enable row level security;
alter table public.punch_location_verifications enable row level security;
alter table public.workplace_change_history enable row level security;
revoke all on public.workplaces,public.employee_workplaces,public.punch_location_verifications,public.workplace_change_history from public,anon,authenticated;

-- Service-only manager RPC also rechecks the database role; assignments save atomically.
create function public.manage_workplaces(p_manager_id uuid,p_workplace jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid; chosen uuid[]; item public.workplaces%rowtype;
begin
 if not exists(select 1 from public.user_roles where auth_user_id=p_manager_id and role in ('manager','admin')) then
  return jsonb_build_object('error','manager_required'); end if;
 perform pg_advisory_xact_lock(84123001);
 if p_workplace is not null then
  w:=nullif(p_workplace->>'id','')::uuid;
  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into chosen from jsonb_array_elements_text(p_workplace->'employeeIds');
  if exists(select 1 from unnest(chosen) e(id) where not exists(select 1 from public.employees where id=e.id)) then
   return jsonb_build_object('error','employee_not_found'); end if;
  if w is null then
   insert into public.workplaces(name,address,latitude,longitude,radius_metres,is_active)
    values(p_workplace->>'name',p_workplace->>'address',(p_workplace->>'latitude')::float8,(p_workplace->>'longitude')::float8,
    (p_workplace->>'radiusMetres')::float8,(p_workplace->>'isActive')::boolean) returning id into w;
  else
   update public.workplaces set name=p_workplace->>'name',address=p_workplace->>'address',latitude=(p_workplace->>'latitude')::float8,
    longitude=(p_workplace->>'longitude')::float8,radius_metres=(p_workplace->>'radiusMetres')::float8,
    is_active=(p_workplace->>'isActive')::boolean,updated_at=clock_timestamp() where id=w;
   if not found then return jsonb_build_object('error','workplace_not_found');end if;
  end if;
  delete from public.employee_workplaces where workplace_id=w;
  insert into public.employee_workplaces(employee_id,workplace_id) select distinct unnest(chosen),w;
  insert into public.workplace_change_history(manager_id,workplace_id,configuration) values(p_manager_id,w,p_workplace);
 end if;
 return jsonb_build_object('workplaces',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from (
  select p.*,coalesce((select jsonb_agg(a.employee_id order by a.employee_id) from public.employee_workplaces a where a.workplace_id=p.id),'[]'::jsonb) as employee_ids from public.workplaces p) x));
end $$;
revoke all on function public.manage_workplaces(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.manage_workplaces(uuid,jsonb) to service_role;

create function public.record_geofenced_punch(p_auth_user_id uuid,p_punch_type text default null,p_request_id uuid default null,
 p_expected_last_id text default null,p_location jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare state jsonb; result jsonb; employee_id_value uuid; w public.workplaces%rowtype;
 lat float8; lon float8; accuracy float8; captured timestamptz; distance float8; matched_distance float8; matched public.workplaces%rowtype;
begin
 -- Serializes configuration changes with decisions so no assignment/radius race is possible.
 perform pg_advisory_xact_lock(84123001);
 state:=public.record_employee_punch(p_auth_user_id);
 if state ? 'error' or p_punch_type is null then return state;end if;
 select id into employee_id_value from public.employees where auth_user_id=p_auth_user_id;
 -- An already committed request can be retried even after its GPS reading expires.
 if exists(select 1 from public.employee_punch_requests where request_id=p_request_id) then
  return public.record_employee_punch(p_auth_user_id,p_punch_type,p_request_id,p_expected_last_id);end if;
 if p_location is null then return jsonb_build_object('error','location_required');end if;
 if jsonb_typeof(p_location->'latitude') is distinct from 'number' or jsonb_typeof(p_location->'longitude') is distinct from 'number'
  or jsonb_typeof(p_location->'accuracyMetres') is distinct from 'number' or jsonb_typeof(p_location->'capturedAt') is distinct from 'number' then
  return jsonb_build_object('error','invalid_location');end if;
 begin
  lat:=(p_location->>'latitude')::float8;lon:=(p_location->>'longitude')::float8;accuracy:=(p_location->>'accuracyMetres')::float8;
  captured:=to_timestamp((p_location->>'capturedAt')::float8/1000);
 exception when others then return jsonb_build_object('error','invalid_location');end;
 if not(lat between -90 and 90 and lon between -180 and 180 and accuracy between 0 and 1000000) then
  return jsonb_build_object('error','invalid_location');end if;
 if captured<clock_timestamp()-interval '30 seconds' or captured>clock_timestamp()+interval '5 seconds' then
  return jsonb_build_object('error','stale_location');end if;
 if accuracy>100 then return jsonb_build_object('error','inaccurate_location');end if;
 if not exists(select 1 from public.employee_workplaces a join public.workplaces p on p.id=a.workplace_id where a.employee_id=employee_id_value and p.is_active) then
  return jsonb_build_object('error','workplace_unassigned');end if;
 for w in select p.* from public.workplaces p join public.employee_workplaces a on a.workplace_id=p.id
  where a.employee_id=employee_id_value and p.is_active order by p.id loop
  distance:=2*6371008.8*asin(sqrt(least(1.0,power(sin(radians(w.latitude-lat)/2),2)+cos(radians(lat))*cos(radians(w.latitude))*power(sin(radians(w.longitude-lon)/2),2))));
  if distance+accuracy<=w.radius_metres and (matched.id is null or distance<matched_distance) then matched:=w;matched_distance:=distance;end if;
 end loop;
 if matched.id is null then return jsonb_build_object('error','outside_geofence');end if;
 result:=public.record_employee_punch(p_auth_user_id,p_punch_type,p_request_id,p_expected_last_id);
 if result->>'success'='true' then
  insert into public.punch_location_verifications(punch_id,workplace_id,workplace_name,latitude,longitude,accuracy_metres,distance_metres,captured_at)
   values((result->'punch'->>'id')::bigint,matched.id,matched.name,lat,lon,accuracy,matched_distance,captured);
 end if;
 return result;
end $$;
revoke all on function public.record_geofenced_punch(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_geofenced_punch(uuid,text,uuid,text,jsonb) to service_role;
-- Legacy deployments must not be able to bypass the new geofence endpoint.
revoke execute on function public.record_employee_punch(uuid,text,uuid,text) from service_role;
commit;
