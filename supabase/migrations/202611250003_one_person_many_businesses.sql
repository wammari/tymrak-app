-- One person, several businesses.
-- A sign-in account can now be an employee of more than one business (once per business).
-- Every employee-facing function takes an optional p_employee_id: the employee record the
-- person chose (one per business). With only one record nothing changes; with several and
-- no choice, functions answer 'choose_business' instead of guessing. Each business still
-- sees only its own record. Deleting an account at one business keeps the sign-in while
-- another business still employs the person.
begin;

-- 1. One record per person per business, instead of one record per person.
alter table public.employees drop constraint if exists employees_auth_user_id_key;
drop index if exists public.employees_auth_user_id_company_unique;
create unique index employees_auth_user_company_unique
  on public.employees (auth_user_id, organization_id) where auth_user_id is not null;

-- 2. Which employee record is this request about?
create function tymrak_private.employee_for_account(p_auth_user_id uuid, p_employee_id uuid,
  out employee_id uuid, out error text)
language plpgsql stable security definer set search_path = '' as $$
declare matches uuid[];
begin
  select array_agg(e.id order by e.id) into matches from public.employees e
   where e.auth_user_id = p_auth_user_id and (p_employee_id is null or e.id = p_employee_id);
  if coalesce(array_length(matches, 1), 0) = 1 then
    employee_id := matches[1];
  elsif p_employee_id is null and array_length(matches, 1) > 1 then
    error := 'choose_business';
  else
    error := 'employee_unavailable';
  end if;
end $$;
revoke all on function tymrak_private.employee_for_account(uuid, uuid) from public, anon, authenticated;

-- 3. The businesses a signed-in person works for (for the employee pages' business picker).
create function public.employee_businesses()
returns table (employee_id uuid, company_name text, is_active boolean, terminated boolean, activated boolean)
language sql stable security definer set search_path = '' as $$
  select e.id, o.name, e.is_active, e.termination_date is not null, e.invitation_status = 'Account Activated'
    from public.employees e join public.organizations o on o.id = e.organization_id
   where e.auth_user_id = (select auth.uid()) and o.is_active
   order by o.name, e.id
$$;
revoke all on function public.employee_businesses() from public, anon;
grant execute on function public.employee_businesses() to authenticated;

-- 4. Clocking in and out.
drop function public.record_geofenced_punch(uuid, text, uuid, text, jsonb);
drop function tymrak_private.record_geofenced_punch(uuid, text, uuid, text, jsonb);
drop function public.record_employee_punch(uuid, text, uuid, text);

create function public.record_employee_punch(p_auth_user_id uuid, p_punch_type text default null,
  p_request_id uuid default null, p_expected_last_id text default null, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  pick record;
  employee public.employees%rowtype;
  previous public.punches%rowtype;
  receipt public.employee_punch_requests%rowtype;
  inserted public.punches%rowtype;
  zone text;
  from_at timestamptz;
  active_at timestamptz;
  entries jsonb;
  result jsonb;
begin
  select * into pick from tymrak_private.employee_for_account(p_auth_user_id, p_employee_id);
  if pick.error is not null then return jsonb_build_object('error', pick.error); end if;
  select * into employee from public.employees where id = pick.employee_id for update;
  if employee.is_active is distinct from true or employee.invitation_status is distinct from 'Account Activated' then
    return jsonb_build_object('error','employee_unavailable');
  end if;
  if p_punch_type is not null then
    if p_request_id is null or p_punch_type not in ('clock_in','clock_out','break_start','break_end') then
      return jsonb_build_object('error','invalid_request');
    end if;
    select * into receipt from public.employee_punch_requests where request_id=p_request_id;
    if found then
      if receipt.employee_id<>employee.id or receipt.punch_type<>p_punch_type then
        return jsonb_build_object('error','request_conflict');
      end if;
      return receipt.response;
    end if;
  end if;
  select * into previous from public.punches where employee_id=employee.id
    order by punched_at desc,id desc limit 1;
  if p_punch_type is not null then
    if previous.id::text is distinct from p_expected_last_id then
      return jsonb_build_object('error','stale_state');
    end if;
    if not coalesce((
      ((previous.id is null or previous.punch_type='clock_out') and p_punch_type='clock_in') or
      (previous.punch_type in ('clock_in','break_end') and p_punch_type in ('clock_out','break_start')) or
      (previous.punch_type='break_start' and p_punch_type in ('clock_out','break_end'))
    ),false) then return jsonb_build_object('error','invalid_transition'); end if;
    if previous.punched_at>clock_timestamp() then
      return jsonb_build_object('error','future_punch');
    end if;
    -- Existing approval-lock and audit triggers still execute on this insert.
    insert into public.punches(employee_id,punch_type,punched_at,source)
      values(employee.id,p_punch_type,clock_timestamp(),'employee') returning * into inserted;
    result:=jsonb_build_object('success',true,'punch',jsonb_build_object(
      'id',inserted.id::text,'punch_type',inserted.punch_type,'punched_at',inserted.punched_at));
    insert into public.employee_punch_requests(request_id,employee_id,punch_type,response)
      values(p_request_id,employee.id,p_punch_type,result);
    return result;
  end if;
  zone:=case employee.province
    when 'AB' then 'America/Edmonton' when 'BC' then 'America/Vancouver'
    when 'SK' then 'America/Regina' when 'MB' then 'America/Winnipeg'
    when 'NB' then 'America/Moncton' when 'NS' then 'America/Halifax'
    when 'PE' then 'America/Halifax' when 'NL' then 'America/St_Johns'
    when 'NT' then 'America/Yellowknife' when 'NU' then 'America/Iqaluit'
    when 'YT' then 'America/Whitehorse' else 'America/Toronto' end;
  from_at:=date_trunc('day',clock_timestamp() at time zone zone) at time zone zone;
  if previous.punch_type in ('clock_in','break_start','break_end') then
    select max(punched_at) into active_at from public.punches
      where employee_id=employee.id and punch_type='clock_in';
    from_at:=least(from_at,coalesce(active_at,from_at));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id::text,'punch_type',p.punch_type,
    'punched_at',p.punched_at) order by p.punched_at,p.id),'[]'::jsonb) into entries
    from public.punches p where p.employee_id=employee.id and p.punched_at>=from_at;
  return jsonb_build_object('lastPunch',case when previous.id is null then null else
    jsonb_build_object('id',previous.id::text,'punch_type',previous.punch_type,'punched_at',previous.punched_at) end,
    'punches',entries,'timeZone',zone,'workDate',(clock_timestamp() at time zone zone)::date);
end $function$;
revoke all on function public.record_employee_punch(uuid, text, uuid, text, uuid) from public, anon, authenticated, service_role;

create function tymrak_private.record_geofenced_punch(p_auth_user_id uuid, p_punch_type text default null,
  p_request_id uuid default null, p_expected_last_id text default null, p_location jsonb default null, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare state jsonb; result jsonb; employee_id_value uuid; w public.workplaces%rowtype;
 lat float8; lon float8; accuracy float8; captured timestamptz; distance float8; matched_distance float8; matched public.workplaces%rowtype;
 pick record;
begin
 -- Serializes configuration changes with decisions so no assignment/radius race is possible.
 perform pg_advisory_xact_lock(84123001);
 state:=public.record_employee_punch(p_auth_user_id, p_employee_id => p_employee_id);
 if state ? 'error' or p_punch_type is null then return state;end if;
 select * into pick from tymrak_private.employee_for_account(p_auth_user_id, p_employee_id);
 employee_id_value := pick.employee_id;
 -- An already committed request can be retried even after its GPS reading expires.
 if exists(select 1 from public.employee_punch_requests where request_id=p_request_id) then
  return public.record_employee_punch(p_auth_user_id,p_punch_type,p_request_id,p_expected_last_id,p_employee_id);end if;
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
 result:=public.record_employee_punch(p_auth_user_id,p_punch_type,p_request_id,p_expected_last_id,p_employee_id);
 if result->>'success'='true' then
  insert into public.punch_location_verifications(punch_id,workplace_id,workplace_name,latitude,longitude,accuracy_metres,distance_metres,captured_at)
   values((result->'punch'->>'id')::bigint,matched.id,matched.name,lat,lon,accuracy,matched_distance,captured);
 end if;
 return result;
end $function$;
revoke all on function tymrak_private.record_geofenced_punch(uuid, text, uuid, text, jsonb, uuid) from public, anon, authenticated, service_role;

create function public.record_geofenced_punch(p_auth_user_id uuid, p_punch_type text default null,
  p_request_id uuid default null, p_expected_last_id text default null, p_location jsonb default null, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare pick record;
begin
 select * into pick from tymrak_private.employee_for_account(p_auth_user_id, p_employee_id);
 if pick.error is not null then return jsonb_build_object('error', pick.error); end if;
 if not exists(select 1 from public.employees e join public.organizations o on o.id=e.organization_id
  where e.id=pick.employee_id and o.is_active) then return jsonb_build_object('error','employee_unavailable');end if;
 if exists(select 1 from public.employee_workplaces a join public.employees e on e.id=a.employee_id
  join public.workplaces w on w.id=a.workplace_id where e.id=pick.employee_id
  and (a.organization_id is distinct from e.organization_id or w.organization_id is distinct from e.organization_id)) then
  return jsonb_build_object('error','workplace_unassigned');end if;
 return tymrak_private.record_geofenced_punch(p_auth_user_id,p_punch_type,p_request_id,p_expected_last_id,p_location,pick.employee_id);
end $function$;
revoke all on function public.record_geofenced_punch(uuid, text, uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_geofenced_punch(uuid, text, uuid, text, jsonb, uuid) to service_role;

-- 5. Time off (view and request; cancelling already names the request).
drop function public.employee_time_off(uuid);
create function public.employee_time_off(p_auth_user_id uuid, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare emp public.employees%rowtype; vac uuid; yr int:=extract(year from current_date)::int; pick record;
begin
  select * into pick from tymrak_private.employee_for_account(p_auth_user_id, p_employee_id);
  if pick.error is not null then return jsonb_build_object('error', pick.error); end if;
  select * into emp from public.employees where id=pick.employee_id;
  select id into vac from public.time_off_types where code='vacation';
  if not tymrak_private.province_enabled(emp.province) then
    return jsonb_build_object('supported',false,'province',emp.province,'balance',tymrak_private.balance_for(emp.id,vac,yr),'requests','[]'::jsonb);
  end if;
  perform tymrak_private.ensure_accrual(emp.id,vac,yr);
  return jsonb_build_object('supported',true,'province',emp.province,'balance',tymrak_private.balance_for(emp.id,vac,yr),
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'startDate',q.start_date,'endDate',q.end_date,
      'startHalf',q.start_half,'endHalf',q.end_half,'days',q.days,'note',q.note,'status',q.status,'decisionNote',q.decision_note)
      order by q.start_date desc),'[]'::jsonb) from public.time_off_requests q where q.employee_id=emp.id));
end $function$;
revoke all on function public.employee_time_off(uuid, uuid) from public, anon, authenticated;
grant execute on function public.employee_time_off(uuid, uuid) to service_role;

drop function public.request_time_off(uuid, date, date, text, text, text);
create function public.request_time_off(p_auth_user_id uuid, p_start date, p_end date, p_start_half text default 'full',
  p_end_half text default 'full', p_note text default null, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare emp public.employees%rowtype; vac uuid; d numeric; bal numeric; rid uuid; yr int; pick record;
begin
  select * into pick from tymrak_private.employee_for_account(p_auth_user_id, p_employee_id);
  if pick.error is not null then return jsonb_build_object('error', pick.error); end if;
  select * into emp from public.employees where id=pick.employee_id for update;
  if emp.is_active is distinct from true or emp.invitation_status is distinct from 'Account Activated' then
    return jsonb_build_object('error','employee_unavailable'); end if;
  if not tymrak_private.province_enabled(emp.province) then return jsonb_build_object('error','province_not_supported'); end if;
  if p_start is null or p_end is null or p_end<p_start then return jsonb_build_object('error','invalid_dates'); end if;
  if p_start<current_date then return jsonb_build_object('error','past_dates'); end if;
  if extract(year from p_start)<>extract(year from p_end) then return jsonb_build_object('error','spans_two_years'); end if;
  if p_start_half not in ('full','pm') or p_end_half not in ('full','am') then return jsonb_build_object('error','invalid_request'); end if;
  if p_start=p_end and (p_start_half='pm' and p_end_half='am') then return jsonb_build_object('error','invalid_request'); end if;
  select id into vac from public.time_off_types where code='vacation' and is_active;
  yr:=extract(year from p_start)::int;
  d:=tymrak_private.working_days(emp.province,p_start,p_end);
  if p_start_half='pm' and extract(isodow from p_start)<6 and not tymrak_private.is_public_holiday(emp.province,p_start) then d:=d-0.5; end if;
  if p_end_half='am' and (p_end<>p_start or p_start_half='full') and extract(isodow from p_end)<6 and not tymrak_private.is_public_holiday(emp.province,p_end) then d:=d-0.5; end if;
  if p_start=p_end and p_start_half='pm' and p_end_half='am' then d:=0; end if;
  if d<=0 then return jsonb_build_object('error','no_working_days'); end if;
  perform tymrak_private.ensure_accrual(emp.id,vac,yr);
  bal:=(tymrak_private.balance_for(emp.id,vac,yr)->>'remaining')::numeric
       - coalesce((select sum(days) from public.time_off_requests where employee_id=emp.id and type_id=vac and status='pending'
                   and extract(year from start_date)=yr),0);
  if d>bal then return jsonb_build_object('error','insufficient_balance','remaining',bal,'requested',d); end if;
  if exists(select 1 from public.time_off_requests where employee_id=emp.id and status in ('pending','approved')
            and start_date<=p_end and end_date>=p_start) then return jsonb_build_object('error','overlaps_existing'); end if;
  insert into public.time_off_requests(organization_id,employee_id,type_id,start_date,end_date,start_half,end_half,days,note)
    values(emp.organization_id,emp.id,vac,p_start,p_end,p_start_half,p_end_half,d,nullif(btrim(p_note),'')) returning id into rid;
  return jsonb_build_object('success',true,'requestId',rid,'days',d);
end $function$;
revoke all on function public.request_time_off(uuid, date, date, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.request_time_off(uuid, date, date, text, text, text, uuid) to service_role;

-- 6. The employee's own pay schedule (called from the browser), for the chosen business.
drop function public.employee_pay_schedule();
create function public.employee_pay_schedule(p_employee_id uuid default null)
returns table (pay_frequency text, pay_period_anchor date, effective_from date)
language sql stable security definer set search_path = '' as $$
  with mine as (
    select e.organization_id from public.employees e
     where e.auth_user_id = (select auth.uid()) and (p_employee_id is null or e.id = p_employee_id)
  ), chosen as (select organization_id from mine where (select count(*) from mine) = 1)
  select s.pay_frequency, s.pay_period_anchor, s.effective_from from (
    select o.pay_frequency, o.pay_period_anchor, null::date as effective_from
      from chosen c join public.organizations o on o.id = c.organization_id
    union all
    select p.pay_frequency, p.pay_period_anchor, p.effective_from
      from chosen c join public.pay_schedule_changes p on p.organization_id = c.organization_id
  ) s
  order by s.effective_from nulls first
$$;
revoke all on function public.employee_pay_schedule(uuid) from public, anon;
grant execute on function public.employee_pay_schedule(uuid) to authenticated;

-- 7. Activation turns on every business the person was added to.
create or replace function tymrak_private.complete_employee_activation(p_auth_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $function$
declare mapping_count bigint; changed bigint;
begin
  lock table public.employees in share row exclusive mode;
  select count(*) into mapping_count from public.employees where auth_user_id = p_auth_user_id;
  if mapping_count = 0 then return jsonb_build_object('outcome', 'missing'); end if;
  update public.employees set invitation_status = 'Account Activated', activated_at = now()
   where auth_user_id = p_auth_user_id and invitation_status is distinct from 'Account Activated' and activated_at is null;
  get diagnostics changed = row_count;
  return jsonb_build_object('outcome', case when changed > 0 then 'activated' else 'already_activated' end);
end $function$;

-- 8. Deleting an account at one business keeps the sign-in while another business employs them.
create or replace function public.anonymize_employee_account(p_organization_id uuid, p_employee_id uuid, p_processed_by uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  employee public.employees%rowtype;
  request public.account_deletion_requests%rowtype;
  existing text[];
  sets text[] := '{}';
  col text;
  keep_sign_in boolean;
begin
  select * into employee from public.employees
    where id = p_employee_id and organization_id = p_organization_id for update;
  if not found then return jsonb_build_object('error', 'employee_not_found'); end if;

  select * into request from public.account_deletion_requests
    where employee_id = p_employee_id and status in ('Pending','Anonymized') order by requested_at desc limit 1 for update;

  if found and request.status = 'Anonymized' then
    return jsonb_build_object('outcome', 'already_anonymized', 'authUserId', request.auth_user_id, 'requestId', request.id);
  end if;

  if request.id is null and employee.termination_date is null then
    return jsonb_build_object('error', 'not_terminated');
  end if;
  if employee.auth_user_id is not null and exists (
       select 1 from public.user_roles r where r.auth_user_id = employee.auth_user_id) then
    return jsonb_build_object('error', 'manager_account');
  end if;
  keep_sign_in := employee.auth_user_id is not null and exists (
    select 1 from public.employees e where e.auth_user_id = employee.auth_user_id and e.id <> employee.id);

  select array_agg(column_name::text) into existing from information_schema.columns
    where table_schema = 'public' and table_name = 'employees';

  foreach col in array array['first_name','last_name','email','username','mobile'] loop
    continue when not (col = any (coalesce(existing, '{}')));
    sets := sets || case col
      when 'first_name' then format('%I = %L', col, 'Former')
      when 'last_name'  then format('%I = %L', col, 'Employee')
      when 'email'      then format('%I = %L', col, 'deleted-' || p_employee_id || '@deleted.invalid')
      when 'username'   then format('%I = %L', col, 'deleted-' || p_employee_id)
      else format('%I = NULL', col)
    end;
  end loop;

  execute format(
    'update public.employees set %s, auth_user_id = NULL, is_active = false, ' ||
    'termination_date = coalesce(termination_date, current_date), ' ||
    'terminated_at = coalesce(terminated_at, now()), ' ||
    'termination_reason = %L where id = %L and organization_id = %L',
    array_to_string(sets, ', '), 'Personal details removed (account deletion)', p_employee_id, p_organization_id);

  -- When another business still employs the person, the sign-in stays: no auth user to delete.
  if request.id is null then
    insert into public.account_deletion_requests(organization_id, employee_id, auth_user_id, status, requested_by, processed_at, processed_by)
      values (p_organization_id, p_employee_id, case when keep_sign_in then null else employee.auth_user_id end, 'Anonymized', 'manager', now(), p_processed_by)
      returning id into request.id;
  else
    update public.account_deletion_requests
      set status = 'Anonymized', auth_user_id = case when keep_sign_in then null else employee.auth_user_id end, processed_at = now(), processed_by = p_processed_by
      where id = request.id;
  end if;

  return jsonb_build_object('outcome', 'anonymized', 'authUserId', case when keep_sign_in then null else employee.auth_user_id end,
    'requestId', request.id, 'signInKept', keep_sign_in);
end $function$;

-- 9. The sign-in account for an email (server only), for adding someone to a second business.
create function public.auth_account_for_email(p_email text)
returns table (auth_user_id uuid, activated boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, (u.email_confirmed_at is not null or u.confirmed_at is not null or u.last_sign_in_at is not null)
    from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1
$$;
revoke all on function public.auth_account_for_email(text) from public, anon, authenticated;
grant execute on function public.auth_account_for_email(text) to service_role;

commit;
