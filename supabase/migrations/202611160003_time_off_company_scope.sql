begin;

drop function public.decide_time_off(uuid,uuid,text,text);
drop function public.manager_time_off(uuid);
drop function public.set_time_off_entitlement(uuid,uuid,numeric);
drop function public.cancel_time_off(uuid,uuid);

create function public.decide_time_off(p_manager_id uuid,p_organization_id uuid,p_request_id uuid,p_decision text,p_note text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.time_off_requests%rowtype; bal numeric; yr int;
begin
  if p_decision not in ('approved','declined') then return jsonb_build_object('error','invalid_request'); end if;
  select * into r from public.time_off_requests where id=p_request_id and organization_id=p_organization_id for update;
  if not found or not tymrak_private.manager_can_access_employee(p_manager_id,r.employee_id)
     or not exists(select 1 from public.user_roles where auth_user_id=p_manager_id and organization_id=p_organization_id and role in ('manager','admin')) then
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

-- Employee cancels their own request.
create function public.cancel_time_off(p_auth_user_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.time_off_requests%rowtype; yr int;
begin
  select * into r from public.time_off_requests where id=p_request_id for update;
  if not found or not exists(select 1 from public.employees where id=r.employee_id and auth_user_id=p_auth_user_id) then
    return jsonb_build_object('error','request_not_found'); end if;
  if r.status not in ('pending','approved') then return jsonb_build_object('error','not_cancellable'); end if;
  if r.status='approved' and r.start_date<=current_date then return jsonb_build_object('error','already_started'); end if;
  yr:=extract(year from r.start_date)::int;
  if r.status='approved' then
    insert into public.time_off_ledger(employee_id,type_id,entry_date,days,reason,request_id,entitlement_year,created_by)
      values(r.employee_id,r.type_id,current_date,r.days,'request_cancelled',r.id,yr,p_auth_user_id);
  end if;
  update public.time_off_requests set status='cancelled',decided_by=p_auth_user_id,decided_at=clock_timestamp() where id=r.id;
  return jsonb_build_object('success',true);
end $$;

-- Manager cancels an approved/pending request in the selected company.
create function public.manager_cancel_time_off(p_manager_id uuid,p_organization_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.time_off_requests%rowtype; yr int;
begin
  select * into r from public.time_off_requests where id=p_request_id and organization_id=p_organization_id for update;
  if not found or not tymrak_private.manager_can_access_employee(p_manager_id,r.employee_id)
     or not exists(select 1 from public.user_roles where auth_user_id=p_manager_id and organization_id=p_organization_id and role in ('manager','admin')) then
    return jsonb_build_object('error','request_not_found'); end if;
  if r.status not in ('pending','approved') then return jsonb_build_object('error','not_cancellable'); end if;
  yr:=extract(year from r.start_date)::int;
  if r.status='approved' then
    insert into public.time_off_ledger(employee_id,type_id,entry_date,days,reason,request_id,entitlement_year,created_by)
      values(r.employee_id,r.type_id,current_date,r.days,'request_cancelled',r.id,yr,p_manager_id);
  end if;
  update public.time_off_requests set status='cancelled',decided_by=p_manager_id,decided_at=clock_timestamp() where id=r.id;
  return jsonb_build_object('success',true);
end $$;

create function public.manager_time_off(p_manager_id uuid,p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare vac uuid; yr int:=extract(year from current_date)::int; emp_id uuid;
begin
  if not exists(select 1 from public.user_roles r join public.organizations o on o.id=r.organization_id and o.is_active
    where r.auth_user_id=p_manager_id and r.organization_id=p_organization_id and r.role in ('manager','admin')) then
    return jsonb_build_object('error','manager_required'); end if;
  select id into vac from public.time_off_types where code='vacation';
  for emp_id in select e.id from public.employees e where e.organization_id=p_organization_id and e.is_active
      and tymrak_private.manager_can_access_employee(p_manager_id,e.id) loop
    perform tymrak_private.ensure_accrual(emp_id,vac,yr);
  end loop;
  return jsonb_build_object(
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'employeeId',q.employee_id,
      'employeeName',e.first_name||' '||e.last_name,'startDate',q.start_date,'endDate',q.end_date,'startHalf',q.start_half,
      'endHalf',q.end_half,'days',q.days,'note',q.note,'status',q.status,'decisionNote',q.decision_note)
      order by (q.status='pending') desc,q.start_date),'[]'::jsonb)
      from public.time_off_requests q join public.employees e on e.id=q.employee_id
      where q.organization_id=p_organization_id and tymrak_private.manager_can_access_employee(p_manager_id,q.employee_id)),
    'balances',(select coalesce(jsonb_agg(jsonb_build_object('employeeId',e.id,'employeeName',e.first_name||' '||e.last_name,
      'hireDate',e.hire_date,'balance',bal_row.b,
      'annualDays',tymrak_private.entitlement_as_of(e.hire_date,current_date,
        (select annual_days_override from public.employee_time_off_settings s where s.employee_id=e.id and s.type_id=vac)),
      'minimumDays',tymrak_private.ontario_minimum_days(e.hire_date,current_date)) order by e.last_name,e.first_name),'[]'::jsonb)
      from public.employees e
      cross join lateral (select tymrak_private.balance_for(e.id,vac,yr) as b) bal_row
      where e.organization_id=p_organization_id and e.is_active and tymrak_private.manager_can_access_employee(p_manager_id,e.id)));
end $$;

create function public.set_time_off_entitlement(p_manager_id uuid,p_organization_id uuid,p_employee_id uuid,p_days numeric) returns jsonb
language plpgsql security definer set search_path='' as $$
declare vac uuid; emp public.employees%rowtype; yr int:=extract(year from current_date)::int; minimum numeric; current_total numeric; diff numeric;
begin
  select * into emp from public.employees where id=p_employee_id and organization_id=p_organization_id;
  if not found or not tymrak_private.manager_can_access_employee(p_manager_id,p_employee_id)
     or not exists(select 1 from public.user_roles where auth_user_id=p_manager_id and organization_id=p_organization_id and role in ('manager','admin')) then
    return jsonb_build_object('error','employee_not_found'); end if;
  select id into vac from public.time_off_types where code='vacation';
  minimum:=tymrak_private.ontario_minimum_days(emp.hire_date,current_date);
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

revoke all on function public.decide_time_off(uuid,uuid,uuid,text,text),public.cancel_time_off(uuid,uuid),
  public.manager_cancel_time_off(uuid,uuid,uuid),public.manager_time_off(uuid,uuid),
  public.set_time_off_entitlement(uuid,uuid,uuid,numeric) from public,anon,authenticated;
grant execute on function public.decide_time_off(uuid,uuid,uuid,text,text),public.cancel_time_off(uuid,uuid),
  public.manager_cancel_time_off(uuid,uuid,uuid),public.manager_time_off(uuid,uuid),
  public.set_time_off_entitlement(uuid,uuid,uuid,numeric) to service_role;

commit;
