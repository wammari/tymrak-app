begin;

create table public.time_off_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  accrual_policy text not null default 'ontario_vacation' check (accrual_policy in ('ontario_vacation','manual')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.time_off_types(code,name,accrual_policy) values ('vacation','Vacation','ontario_vacation');

create table public.employee_time_off_settings (
  employee_id uuid not null references public.employees(id) on delete cascade,
  type_id uuid not null references public.time_off_types(id),
  annual_days_override numeric(5,1) check (annual_days_override is null or (annual_days_override>=0 and annual_days_override<=100)),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (employee_id,type_id)
);

create table public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  type_id uuid not null references public.time_off_types(id),
  start_date date not null,
  end_date date not null,
  start_half text not null default 'full' check (start_half in ('full','pm')),
  end_half text not null default 'full' check (end_half in ('full','am')),
  days numeric(5,1) not null check (days>0),
  note text check (note is null or length(note)<=500),
  status text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note)<=500),
  created_at timestamptz not null default now(),
  constraint time_off_dates_order check (end_date>=start_date)
);
create index time_off_requests_employee_idx on public.time_off_requests(employee_id,start_date desc);
create index time_off_requests_org_status_idx on public.time_off_requests(organization_id,status,start_date);

create table public.time_off_ledger (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id),
  type_id uuid not null references public.time_off_types(id),
  entry_date date not null,
  days numeric(5,1) not null check (days<>0),
  reason text not null check (reason in ('accrual','tier_upgrade','approved_request','request_cancelled','manual_adjustment')),
  request_id uuid references public.time_off_requests(id),
  entitlement_year int,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index time_off_ledger_employee_idx on public.time_off_ledger(employee_id,type_id);
create unique index time_off_ledger_one_accrual_per_year
  on public.time_off_ledger(employee_id,type_id,entitlement_year) where reason='accrual';
create unique index time_off_ledger_one_deduction_per_request
  on public.time_off_ledger(request_id) where reason='approved_request';
create unique index time_off_ledger_one_refund_per_request
  on public.time_off_ledger(request_id) where reason='request_cancelled';

alter table public.time_off_types enable row level security;
alter table public.employee_time_off_settings enable row level security;
alter table public.time_off_requests enable row level security;
alter table public.time_off_ledger enable row level security;
revoke all on public.time_off_types,public.employee_time_off_settings,public.time_off_requests,public.time_off_ledger
  from public,anon,authenticated;
grant select,insert,update on public.time_off_types,public.employee_time_off_settings,public.time_off_requests,public.time_off_ledger to service_role;
grant usage,select on all sequences in schema public to service_role;

create function tymrak_private.time_off_ledger_immutable() returns trigger
language plpgsql set search_path='' as $$
begin raise exception using errcode='P0001', message='The time off ledger is append-only.'; end $$;
revoke all on function tymrak_private.time_off_ledger_immutable() from public,anon,authenticated;
create trigger time_off_ledger_no_update before update or delete on public.time_off_ledger
  for each row execute function tymrak_private.time_off_ledger_immutable();
revoke update,delete on public.time_off_ledger from service_role;

create function tymrak_private.easter_sunday(y int) returns date
language plpgsql immutable set search_path='' as $$
declare a int:=y%19; b int:=y/100; c int:=y%100; d int:=b/4; e int:=b%4; f int:=(b+8)/25;
  g int:=(b-f+1)/3; h int:=(19*a+b-d-g+15)%30; i int:=c/4; k int:=c%4;
  l int:=(32+2*e+2*i-h-k)%7; m int:=(a+11*h+22*l)/451;
  mo int:=(h+l-7*m+114)/31; da int:=((h+l-7*m+114)%31)+1;
begin return make_date(y,mo,da); end $$;

create function tymrak_private.nth_weekday(y int,m int,dow int,n int) returns date
language sql immutable set search_path='' as $$
  select (make_date(y,m,1) + ((dow-extract(dow from make_date(y,m,1))::int+7)%7) + 7*(n-1))::date $$;

create function tymrak_private.is_ontario_holiday(d date) returns boolean
language plpgsql immutable set search_path='' as $$
declare y int:=extract(year from d)::int; victoria date;
begin
  victoria:=(make_date(y,5,25) - ((extract(dow from make_date(y,5,25))::int+6)%7 + case when extract(dow from make_date(y,5,25))=1 then 7 else 0 end))::date;
  return d in (
    make_date(y,1,1),
    tymrak_private.nth_weekday(y,2,1,3),
    tymrak_private.easter_sunday(y)-2,
    victoria,
    make_date(y,7,1),
    tymrak_private.nth_weekday(y,9,1,1),
    tymrak_private.nth_weekday(y,10,1,2),
    make_date(y,12,25),
    make_date(y,12,26)
  );
end $$;

create function tymrak_private.working_days(p_from date,p_to date) returns numeric
language sql immutable set search_path='' as $$
  select count(*)::numeric from generate_series(p_from,p_to,interval '1 day') g(d)
  where extract(isodow from g.d)<6 and not tymrak_private.is_ontario_holiday(g.d::date) $$;

create function tymrak_private.ontario_minimum_days(p_hire date,p_on date) returns numeric
language sql immutable set search_path='' as $$
  select case when p_hire is not null and p_on >= (p_hire + interval '5 years')::date then 15 else 10 end $$;

create function tymrak_private.entitlement_as_of(p_hire date,p_asof date,p_override numeric) returns numeric
language sql immutable set search_path='' as $$
  select greatest(coalesce(p_override,0), tymrak_private.ontario_minimum_days(p_hire,p_asof)) $$;

revoke all on function tymrak_private.easter_sunday(int),tymrak_private.nth_weekday(int,int,int,int),
  tymrak_private.is_ontario_holiday(date),tymrak_private.working_days(date,date),
  tymrak_private.ontario_minimum_days(date,date),tymrak_private.entitlement_as_of(date,date,numeric)
  from public,anon,authenticated;

commit;
