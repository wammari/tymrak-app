-- Province-aware time off: vacation tiers and public holidays depend on the employee's province.
-- Provinces/territories without a verified policy stay disabled (enabled=false) until confirmed.
begin;

create table public.time_off_province_policies (
  province text primary key check (province ~ '^[A-Z]{2}$'),
  enabled boolean not null default false,
  note text
);
create table public.time_off_policy_tiers (
  province text not null references public.time_off_province_policies(province) on delete cascade,
  from_years int not null check (from_years >= 0),
  annual_days numeric(5,1) not null check (annual_days > 0),
  primary key (province, from_years)
);
alter table public.time_off_province_policies enable row level security;
alter table public.time_off_policy_tiers enable row level security;
revoke all on public.time_off_province_policies, public.time_off_policy_tiers from public, anon, authenticated;
grant select, insert, update on public.time_off_province_policies, public.time_off_policy_tiers to service_role;

-- Minimum annual vacation in working days (weeks x 5), tier applies from the anniversary.
insert into public.time_off_province_policies(province, enabled, note) values
 ('ON', true, 'ESA 2000: 2 weeks, 3 weeks at 5 years'),
 ('BC', true, 'Employment Standards Act: 2 weeks, 3 weeks at 5 years'),
 ('AB', true, 'Employment Standards Code: 2 weeks, 3 weeks at 5 consecutive years'),
 ('SK', true, 'Saskatchewan Employment Act: 3 weeks, 4 weeks at 10 years'),
 ('MB', true, 'Employment Standards Code: 2 weeks, 3 weeks at 5 years'),
 ('QC', true, 'Act respecting labour standards: 2 weeks, 3 weeks at 3 years'),
 ('NB', true, 'Employment Standards Act: 2 weeks, 3 weeks at 8 years'),
 ('NS', true, 'Labour Standards Code: 2 weeks, 3 weeks from the 9th year'),
 ('NL', true, 'Labour Standards Act: 2 weeks, 3 weeks at 15 years'),
 ('PE', false, 'Not confirmed from an official source yet'),
 ('YT', false, 'Not confirmed from an official source yet'),
 ('NT', false, 'Official sources disagree (5 or 6 years); not confirmed'),
 ('NU', false, 'Holiday list not confirmed from an official source yet');
insert into public.time_off_policy_tiers(province, from_years, annual_days) values
 ('ON',0,10),('ON',5,15),('BC',0,10),('BC',5,15),('AB',0,10),('AB',5,15),
 ('SK',0,15),('SK',10,20),('MB',0,10),('MB',5,15),('QC',0,10),('QC',3,15),
 ('NB',0,10),('NB',8,15),('NS',0,10),('NS',8,15),('NL',0,10),('NL',15,15);

-- Public holidays by province. Weekend observance is only modelled for Canada Day (AB, QC, SK).
create function tymrak_private.is_public_holiday(p_province text, d date) returns boolean
language plpgsql immutable set search_path='' as $$
declare
  y int := extract(year from d)::int;
  good_friday date := tymrak_private.easter_sunday(y) - 2;
  family date := tymrak_private.nth_weekday(y,2,1,3);
  victoria date := (make_date(y,5,25) - ((extract(dow from make_date(y,5,25))::int+6)%7
                    + case when extract(dow from make_date(y,5,25))=1 then 7 else 0 end))::date;
  aug_first_mon date := tymrak_private.nth_weekday(y,8,1,1);
  labour date := tymrak_private.nth_weekday(y,9,1,1);
  thanks date := tymrak_private.nth_weekday(y,10,1,2);
  canada date := make_date(y,7,1);
  new_year date := make_date(y,1,1);
  remembrance date := make_date(y,11,11);
  christmas date := make_date(y,12,25);
  truth date := make_date(y,9,30);
begin
  if p_province in ('AB','QC','SK') and extract(dow from canada)=0 then canada := canada + 1; end if;
  return case p_province
    when 'ON' then d in (new_year,family,good_friday,victoria,canada,labour,thanks,christmas,make_date(y,12,26))
    when 'BC' then d in (new_year,family,good_friday,victoria,canada,aug_first_mon,labour,truth,thanks,remembrance,christmas)
    when 'AB' then d in (new_year,family,good_friday,victoria,canada,labour,thanks,remembrance,christmas)
    when 'SK' then d in (new_year,family,good_friday,victoria,canada,aug_first_mon,labour,thanks,remembrance,christmas)
    when 'MB' then d in (new_year,family,good_friday,victoria,canada,labour,truth,thanks,christmas)
    when 'QC' then d in (new_year,good_friday,victoria,make_date(y,6,24),canada,labour,thanks,christmas)
    when 'NB' then d in (new_year,family,good_friday,canada,aug_first_mon,labour,remembrance,christmas)
    when 'NS' then d in (new_year,family,good_friday,canada,labour,christmas)
    when 'NL' then d in (new_year,good_friday,canada,labour,remembrance,christmas)
    else false end;
end $$;

create function tymrak_private.working_days(p_province text, p_from date, p_to date) returns numeric
language sql immutable set search_path='' as $$
  select count(*)::numeric from generate_series(p_from,p_to,interval '1 day') g(d)
  where extract(isodow from g.d)<6 and not tymrak_private.is_public_holiday(p_province, g.d::date) $$;

create function tymrak_private.province_enabled(p_province text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select enabled from public.time_off_province_policies where province = p_province), false) $$;

create function tymrak_private.policy_minimum_days(p_province text, p_hire date, p_on date) returns numeric
language sql stable security definer set search_path='' as $$
  select coalesce(max(t.annual_days), 0) from public.time_off_policy_tiers t
  where t.province = p_province
    and (t.from_years = 0 or (p_hire is not null and p_on >= (p_hire + make_interval(years => t.from_years))::date)) $$;

create function tymrak_private.entitlement_as_of(p_province text, p_hire date, p_asof date, p_override numeric) returns numeric
language sql stable security definer set search_path='' as $$
  select greatest(coalesce(p_override,0), tymrak_private.policy_minimum_days(p_province, p_hire, p_asof)) $$;

revoke all on function tymrak_private.is_public_holiday(text,date), tymrak_private.working_days(text,date,date),
  tymrak_private.province_enabled(text), tymrak_private.policy_minimum_days(text,date,date),
  tymrak_private.entitlement_as_of(text,date,date,numeric) from public, anon, authenticated;

create or replace function tymrak_private.ensure_accrual(p_employee uuid,p_type uuid,p_year int) returns void
language plpgsql security definer set search_path='' as $$
declare emp public.employees%rowtype; ovr numeric; should_be numeric; have numeric; asof date;
begin
  select * into emp from public.employees where id=p_employee;
  if not found or not tymrak_private.province_enabled(emp.province) then return; end if;
  select annual_days_override into ovr from public.employee_time_off_settings where employee_id=p_employee and type_id=p_type;
  asof:=least(greatest(current_date,make_date(p_year,1,1)),make_date(p_year,12,31));
  should_be:=tymrak_private.entitlement_as_of(emp.province,emp.hire_date,asof,ovr);
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

create or replace function public.request_time_off(p_auth_user_id uuid,p_start date,p_end date,
  p_start_half text default 'full',p_end_half text default 'full',p_note text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare emp public.employees%rowtype; vac uuid; d numeric; bal numeric; rid uuid; yr int;
begin
  if (select count(*) from public.employees where auth_user_id=p_auth_user_id)<>1 then return jsonb_build_object('error','employee_unavailable'); end if;
  select * into emp from public.employees where auth_user_id=p_auth_user_id for update;
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
end $$;

create or replace function public.employee_time_off(p_auth_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare emp public.employees%rowtype; vac uuid; yr int:=extract(year from current_date)::int;
begin
  if (select count(*) from public.employees where auth_user_id=p_auth_user_id)<>1 then return jsonb_build_object('error','employee_unavailable'); end if;
  select * into emp from public.employees where auth_user_id=p_auth_user_id;
  select id into vac from public.time_off_types where code='vacation';
  if not tymrak_private.province_enabled(emp.province) then
    return jsonb_build_object('supported',false,'province',emp.province,'balance',tymrak_private.balance_for(emp.id,vac,yr),'requests','[]'::jsonb);
  end if;
  perform tymrak_private.ensure_accrual(emp.id,vac,yr);
  return jsonb_build_object('supported',true,'province',emp.province,'balance',tymrak_private.balance_for(emp.id,vac,yr),
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'startDate',q.start_date,'endDate',q.end_date,
      'startHalf',q.start_half,'endHalf',q.end_half,'days',q.days,'note',q.note,'status',q.status,'decisionNote',q.decision_note)
      order by q.start_date desc),'[]'::jsonb) from public.time_off_requests q where q.employee_id=emp.id));
end $$;

create or replace function public.manager_time_off(p_manager_id uuid,p_organization_id uuid) returns jsonb
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
      'province',e.province,'hireDate',e.hire_date,'balance',bal_row.b,
      'annualDays',tymrak_private.entitlement_as_of(e.province,e.hire_date,current_date,
        (select annual_days_override from public.employee_time_off_settings s where s.employee_id=e.id and s.type_id=vac)),
      'minimumDays',tymrak_private.policy_minimum_days(e.province,e.hire_date,current_date)) order by e.last_name,e.first_name),'[]'::jsonb)
      from public.employees e
      cross join lateral (select tymrak_private.balance_for(e.id,vac,yr) as b) bal_row
      where e.organization_id=p_organization_id and e.is_active and tymrak_private.province_enabled(e.province)
        and tymrak_private.manager_can_access_employee(p_manager_id,e.id)),
    'unsupported',(select coalesce(jsonb_agg(jsonb_build_object('employeeName',e.first_name||' '||e.last_name,'province',e.province)
        order by e.last_name,e.first_name),'[]'::jsonb)
      from public.employees e
      where e.organization_id=p_organization_id and e.is_active and not tymrak_private.province_enabled(e.province)
        and tymrak_private.manager_can_access_employee(p_manager_id,e.id)));
end $$;

create or replace function public.set_time_off_entitlement(p_manager_id uuid,p_organization_id uuid,p_employee_id uuid,p_days numeric) returns jsonb
language plpgsql security definer set search_path='' as $$
declare vac uuid; emp public.employees%rowtype; yr int:=extract(year from current_date)::int; minimum numeric; current_total numeric; diff numeric;
begin
  select * into emp from public.employees where id=p_employee_id and organization_id=p_organization_id;
  if not found or not tymrak_private.manager_can_access_employee(p_manager_id,p_employee_id)
     or not exists(select 1 from public.user_roles where auth_user_id=p_manager_id and organization_id=p_organization_id and role in ('manager','admin')) then
    return jsonb_build_object('error','employee_not_found'); end if;
  if not tymrak_private.province_enabled(emp.province) then return jsonb_build_object('error','province_not_supported'); end if;
  select id into vac from public.time_off_types where code='vacation';
  minimum:=tymrak_private.policy_minimum_days(emp.province,emp.hire_date,current_date);
  if p_days is null or p_days<minimum then return jsonb_build_object('error','below_legal_minimum','minimum',minimum); end if;
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

-- The Ontario-only helpers are no longer used.
drop function tymrak_private.entitlement_as_of(date,date,numeric);
drop function tymrak_private.ontario_minimum_days(date,date);
drop function tymrak_private.working_days(date,date);
drop function tymrak_private.is_ontario_holiday(date);

commit;
