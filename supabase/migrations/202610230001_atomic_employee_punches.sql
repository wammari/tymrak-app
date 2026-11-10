begin;

create index if not exists punches_employee_recorded_order_idx
  on public.punches(employee_id,punched_at desc,id desc);

-- Request receipts make an uncertain network retry safe. No browser access.
create table public.employee_punch_requests (
  request_id uuid primary key,
  employee_id uuid not null references public.employees(id),
  punch_type text not null check (punch_type in ('clock_in','clock_out','break_start','break_end')),
  response jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.employee_punch_requests enable row level security;
revoke all on public.employee_punch_requests from public, anon, authenticated;

create function public.record_employee_punch(
  p_auth_user_id uuid,
  p_punch_type text default null,
  p_request_id uuid default null,
  p_expected_last_id text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
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
  if (select count(*) from public.employees where auth_user_id=p_auth_user_id) <> 1 then
    return jsonb_build_object('error','employee_unavailable');
  end if;
  select * into employee from public.employees where auth_user_id=p_auth_user_id for update;
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
end $$;
revoke all on function public.record_employee_punch(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.record_employee_punch(uuid,text,uuid,text) to service_role;
-- Direct browser inserts would bypass state validation, timestamps and retries.
revoke insert on public.punches from public,anon,authenticated;
-- RLS does not protect TRUNCATE. Browsers do not need these table-level powers.
revoke truncate,trigger,references on public.employees,public.punches from public,anon,authenticated;
do $$
declare columns text;
begin
  select string_agg(quote_ident(attname),',') into columns from pg_catalog.pg_attribute
    where attrelid='public.punches'::regclass and attnum>0 and not attisdropped;
  execute 'revoke insert (' || columns || ') on public.punches from public,anon,authenticated';
end $$;
commit;
