begin;

create function tymrak_private.ensure_accrual(p_employee uuid,p_type uuid,p_year int) returns void
language plpgsql security definer set search_path='' as $$
declare emp public.employees%rowtype; ovr numeric; should_be numeric; have numeric; asof date;
begin
  select * into emp from public.employees where id=p_employee;
  if not found then return; end if;
  select annual_days_override into ovr from public.employee_time_off_settings where employee_id=p_employee and type_id=p_type;
  asof:=least(greatest(current_date,make_date(p_year,1,1)),make_date(p_year,12,31));
  should_be:=tymrak_private.entitlement_as_of(emp.hire_date,asof,ovr);
  select coalesce(sum(days),0) into have from public.time_off_ledger
    where employee_id=p_employee and type_id=p_type and entitlement_year=p_year and reason in ('accrual','tier_upgrade','manual_adjustment');
  if have=0 then
    insert into public.time_off_ledger(employee_id,type_id,entry_date,days,reason,entitlement_year)
      values(p_employee,p_type,make_date(p_year,1,1),should_be,'accrual',p_year)
      on conflict (employee_id,type_id,entitlement_year) where reason='accrual' do nothing;
  elsif should_be>have then
    insert into public.time_off_ledger(employee_id,type_id,entry_date,days,reason,entitlement_year)
      values(p_employee,p_type,current_date,should_be-have,'tier_upgrade',p_year);
  end if;
end $$;

create function tymrak_private.balance_for(p_employee uuid,p_type uuid,p_year int) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'year',p_year,
    'entitled',coalesce(sum(days) filter (where reason in ('accrual','tier_upgrade','manual_adjustment') and coalesce(entitlement_year,extract(year from entry_date)::int)=p_year),0),
    'used',-coalesce(sum(days) filter (where reason in ('approved_request','request_cancelled') and extract(year from entry_date)=p_year),0),
    'remaining',coalesce(sum(days) filter (where coalesce(entitlement_year,extract(year from entry_date)::int)=p_year),0))
  from public.time_off_ledger where employee_id=p_employee and type_id=p_type $$;

create function public.request_time_off(p_auth_user_id uuid,p_start date,p_end date,
  p_start_half text default 'full',p_end_half text default 'full',p_note text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare emp public.employees%rowtype; vac uuid; d numeric; bal numeric; rid uuid; yr int;
begin
  if (select count(*) from public.employees where auth_user_id=p_auth_user_id)<>1 then return jsonb_build_object('error','employee_unavailable'); end if;
  select * into emp from public.employees where auth_user_id=p_auth_user_id for update;
  if emp.is_active is distinct from true or emp.invitation_status is distinct from 'Account Activated' then
    return jsonb_build_object('error','employee_unavailable'); end if;
  if p_start is null or p_end is null or p_end<p_start then return jsonb_build_object('error','invalid_dates'); end if;
  if p_start<current_date then return jsonb_build_object('error','past_dates'); end if;
  if extract(year from p_start)<>extract(year from p_end) then return jsonb_build_object('error','spans_two_years'); end if;
  if p_start_half not in ('full','pm') or p_end_half not in ('full','am') then return jsonb_build_object('error','invalid_request'); end if;
  if p_start=p_end and (p_start_half='pm' and p_end_half='am') then return jsonb_build_object('error','invalid_request'); end if;
  select id into vac from public.time_off_types where code='vacation' and is_active;
  yr:=extract(year from p_start)::int;
  d:=tymrak_private.working_days(p_start,p_end);
  if p_start_half='pm' and extract(isodow from p_start)<6 and not tymrak_private.is_ontario_holiday(p_start) then d:=d-0.5; end if;
  if p_end_half='am' and (p_end<>p_start or p_start_half='full') and extract(isodow from p_end)<6 and not tymrak_private.is_ontario_holiday(p_end) then d:=d-0.5; end if;
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
end $$;

create function public.decide_time_off(p_manager_id uuid,p_request_id uuid,p_decision text,p_note text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.time_off_requests%rowtype; bal numeric; yr int;
begin
  if p_decision not in ('approved','declined') then return jsonb_build_object('error','invalid_request'); end if;
  select * into r from public.time_off_requests where id=p_request_id for update;
  if not found or not tymrak_private.manager_can_access_employee(p_manager_id,r.employee_id) then
    return jsonb_build_object('error','request_not_found'); end if;
  if r.status<>'pending' then return jsonb_build_object('error','not_pending'); end if;
  yr:=extract(year from r.start_date)::int;
  if p_decision='approved' then
    perform tymrak_private.ensure_accrual(r.employee_id,r.type_id,yr);
    bal:=(tymrak_private.balance_for(r.employee_id,r.type_id,yr)->>'remaining')::numeric;
    if r.days>bal then return jsonb_build_object('error','insufficient_balance','remaining',bal); end if;
    insert into public.time_off_ledger(employee_id,type_id,entry_date,days,reason,request_id,entitlement_year,created_by)
      values(r.employee_id,r.type_id,r.start_date,-r.days,'approved_request',r.id,yr,p_manager_id);
  end if;
  update public.time_off_requests set status=p_decision,decided_by=p_manager_id,decided_at=clock_timestamp(),
    decision_note=nullif(btrim(p_note),'') where id=r.id;
  return jsonb_build_object('success',true,'status',p_decision);
end $$;

create function public.cancel_time_off(p_auth_user_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.time_off_requests%rowtype; actor_is_employee boolean; yr int;
begin
  select * into r from public.time_off_requests where id=p_request_id for update;
  if not found then return jsonb_build_object('error','request_not_found'); end if;
  actor_is_employee:=exists(select 1 from public.employees where id=r.employee_id and auth_user_id=p_auth_user_id);
  if not actor_is_employee and not tymrak_private.manager_can_access_employee(p_auth_user_id,r.employee_id) then
    return jsonb_build_object('error','request_not_found'); end if;
  if r.status not in ('pending','approved') then return jsonb_build_object('error','not_cancellable'); end if;
  if actor_is_employee and r.status='approved' and r.start_date<=current_date then
    return jsonb_build_object('error','already_started'); end if;
  yr:=extract(year from r.start_date)::int;
  if r.status='approved' then
    insert into public.time_off_ledger(employee_id,type_id,entry_date,days,reason,request_id,entitlement_year,created_by)
      values(r.employee_id,r.type_id,current_date,r.days,'request_cancelled',r.id,yr,p_auth_user_id);
  end if;
  update public.time_off_requests set status='cancelled',decided_by=p_auth_user_id,decided_at=clock_timestamp() where id=r.id;
  return jsonb_build_object('success',true);
end $$;

create function public.employee_time_off(p_auth_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare emp public.employees%rowtype; vac uuid; yr int:=extract(year from current_date)::int;
begin
  if (select count(*) from public.employees where auth_user_id=p_auth_user_id)<>1 then return jsonb_build_object('error','employee_unavailable'); end if;
  select * into emp from public.employees where auth_user_id=p_auth_user_id;
  select id into vac from public.time_off_types where code='vacation';
  perform tymrak_private.ensure_accrual(emp.id,vac,yr);
  return jsonb_build_object('balance',tymrak_private.balance_for(emp.id,vac,yr),
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'startDate',q.start_date,'endDate',q.end_date,
      'startHalf',q.start_half,'endHalf',q.end_half,'days',q.days,'note',q.note,'status',q.status,'decisionNote',q.decision_note)
      order by q.start_date desc),'[]'::jsonb) from public.time_off_requests q where q.employee_id=emp.id));
end $$;

create function public.manager_time_off(p_manager_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare vac uuid; yr int:=extract(year from current_date)::int; org uuid; role_name text; emp_id uuid;
begin
  select r.organization_id,r.role into org,role_name from public.user_roles r join public.organizations o on o.id=r.organization_id and o.is_active
    where r.auth_user_id=p_manager_id and r.role in ('manager','admin') limit 1;
  if org is null then return jsonb_build_object('error','manager_required'); end if;
  select id into vac from public.time_off_types where code='vacation';
  for emp_id in select e.id from public.employees e where e.is_active and tymrak_private.manager_can_access_employee(p_manager_id,e.id) loop
    perform tymrak_private.ensure_accrual(emp_id,vac,yr);
  end loop;
  return jsonb_build_object(
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'employeeId',q.employee_id,
      'employeeName',e.first_name||' '||e.last_name,'startDate',q.start_date,'endDate',q.end_date,'startHalf',q.start_half,
      'endHalf',q.end_half,'days',q.days,'note',q.note,'status',q.status,'decisionNote',q.decision_note)
      order by (q.status='pending') desc,q.start_date),'[]'::jsonb)
      from public.time_off_requests q join public.employees e on e.id=q.employee_id
      where tymrak_private.manager_can_access_employee(p_manager_id,q.employee_id)),
    'balances',(select coalesce(jsonb_agg(jsonb_build_object('employeeId',e.id,'employeeName',e.first_name||' '||e.last_name,
      'hireDate',e.hire_date,'balance',bal_row.b) order by e.last_name,e.first_name),'[]'::jsonb)
      from public.employees e
      cross join lateral (select tymrak_private.balance_for(e.id,vac,yr) as b) bal_row
      where e.is_active and tymrak_private.manager_can_access_employee(p_manager_id,e.id)));
end $$;

create function public.set_time_off_entitlement(p_manager_id uuid,p_employee_id uuid,p_days numeric) returns jsonb
language plpgsql security definer set search_path='' as $$
declare vac uuid; emp public.employees%rowtype; yr int:=extract(year from current_date)::int; minimum numeric; current_total numeric; diff numeric;
begin
  if not tymrak_private.manager_can_access_employee(p_manager_id,p_employee_id) then return jsonb_build_object('error','employee_not_found'); end if;
  select * into emp from public.employees where id=p_employee_id;
  select id into vac from public.time_off_types where code='vacation';
  minimum:=tymrak_private.ontario_minimum_days(emp.hire_date,make_date(yr,12,31));
  if p_days is null or p_days<minimum then return jsonb_build_object('error','below_ontario_minimum','minimum',minimum); end if;
  if p_days>100 or (p_days*2)<>trunc(p_days*2) then return jsonb_build_object('error','invalid_request'); end if;
  insert into public.employee_time_off_settings(employee_id,type_id,annual_days_override,updated_by)
    values(p_employee_id,vac,p_days,p_manager_id)
    on conflict (employee_id,type_id) do update set annual_days_override=excluded.annual_days_override,updated_by=excluded.updated_by,updated_at=now();
  perform tymrak_private.ensure_accrual(p_employee_id,vac,yr);
  select coalesce(sum(days),0) into current_total from public.time_off_ledger
    where employee_id=p_employee_id and type_id=vac and reason in ('accrual','tier_upgrade','manual_adjustment') and entitlement_year=yr;
  diff:=p_days-current_total;
  if diff<>0 then
    insert into public.time_off_ledger(employee_id,type_id,entry_date,days,reason,entitlement_year,created_by)
      values(p_employee_id,vac,current_date,diff,'manual_adjustment',yr,p_manager_id);
  end if;
  return jsonb_build_object('success',true,'annualDays',p_days);
end $$;

revoke all on function public.request_time_off(uuid,date,date,text,text,text),
  public.decide_time_off(uuid,uuid,text,text),public.cancel_time_off(uuid,uuid),
  public.employee_time_off(uuid),public.manager_time_off(uuid),
  public.set_time_off_entitlement(uuid,uuid,numeric) from public,anon,authenticated;
grant execute on function public.request_time_off(uuid,date,date,text,text,text),
  public.decide_time_off(uuid,uuid,text,text),public.cancel_time_off(uuid,uuid),
  public.employee_time_off(uuid),public.manager_time_off(uuid),
  public.set_time_off_entitlement(uuid,uuid,numeric) to service_role;
revoke all on function tymrak_private.ensure_accrual(uuid,uuid,int),tymrak_private.balance_for(uuid,uuid,int) from public,anon,authenticated;

commit;
