-- Punch corrections by admins and managers.
-- A manager can add a missing punch, change a punch's type or time, or remove a mistaken
-- punch, always with a reason. Every correction is kept in punch_corrections with the
-- before and after values, who made it and when. Approved timecards stay locked (the
-- existing punches trigger refuses changes inside an approved period), nobody corrects
-- their own punches, and times are entered in the employee's own province time zone.
-- Only the server calls correct_punch, after checking the manager may manage that
-- employee. Employees read the corrections of their own punches with my_punch_corrections.
begin;

create table public.punch_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  punch_id bigint,
  action text not null check (action in ('added', 'changed', 'removed')),
  before_type text check (before_type in ('clock_in', 'clock_out', 'break_start', 'break_end')),
  before_at timestamptz,
  after_type text check (after_type in ('clock_in', 'clock_out', 'break_start', 'break_end')),
  after_at timestamptz,
  before_location text,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  corrected_by uuid not null,
  corrected_by_label text,
  corrected_at timestamptz not null default clock_timestamp(),
  check ((action = 'added' and before_at is null and after_at is not null)
      or (action = 'changed' and before_at is not null and after_at is not null)
      or (action = 'removed' and before_at is not null and after_at is null))
);
create index punch_corrections_employee_time on public.punch_corrections (employee_id, corrected_at desc);
create index punch_corrections_punch on public.punch_corrections (punch_id);
alter table public.punch_corrections enable row level security;
revoke all on public.punch_corrections from public, anon, authenticated;
grant select, insert on public.punch_corrections to service_role;

create function tymrak_private.province_time_zone(p_province text)
returns text language sql immutable set search_path = '' as $$
  select case p_province
    when 'AB' then 'America/Edmonton' when 'BC' then 'America/Vancouver'
    when 'SK' then 'America/Regina' when 'MB' then 'America/Winnipeg'
    when 'NB' then 'America/Moncton' when 'NS' then 'America/Halifax'
    when 'PE' then 'America/Halifax' when 'NL' then 'America/St_Johns'
    when 'NT' then 'America/Yellowknife' when 'NU' then 'America/Iqaluit'
    when 'YT' then 'America/Whitehorse' else 'America/Toronto' end
$$;

create function public.correct_punch(
  p_actor uuid, p_organization_id uuid, p_employee_id uuid, p_action text,
  p_punch_id bigint default null, p_punch_type text default null, p_local_time timestamp default null,
  p_reason text default null, p_actor_label text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  employee public.employees%rowtype;
  old_punch public.punches%rowtype;
  new_punch public.punches%rowtype;
  zone text;
  at_time timestamptz;
  reason text := btrim(coalesce(p_reason, ''));
  location text;
begin
  if p_actor is null or p_organization_id is null or p_employee_id is null
     or p_action not in ('add', 'change', 'remove') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if char_length(reason) < 3 or char_length(reason) > 500 then
    return jsonb_build_object('error', 'reason_required');
  end if;
  -- Locks the employee row, so a correction and the employee's own clock button never interleave.
  select * into employee from public.employees
   where id = p_employee_id and organization_id = p_organization_id for update;
  if not found then return jsonb_build_object('error', 'employee_not_found'); end if;
  if employee.auth_user_id = p_actor then return jsonb_build_object('error', 'own_punches'); end if;
  zone := tymrak_private.province_time_zone(employee.province);

  if p_action in ('change', 'remove') then
    select * into old_punch from public.punches where id = p_punch_id and employee_id = employee.id;
    if not found then return jsonb_build_object('error', 'punch_not_found'); end if;
  end if;
  if p_action in ('add', 'change') then
    if p_punch_type is null or p_punch_type not in ('clock_in', 'clock_out', 'break_start', 'break_end') or p_local_time is null then
      return jsonb_build_object('error', 'invalid_request');
    end if;
    at_time := p_local_time at time zone zone;
    if at_time > clock_timestamp() + interval '1 minute' then return jsonb_build_object('error', 'future_time'); end if;
    if p_action = 'change' and old_punch.punch_type = p_punch_type
       and date_trunc('minute', old_punch.punched_at) = date_trunc('minute', at_time) then
      return jsonb_build_object('error', 'no_change');
    end if;
  end if;

  begin
    if p_action = 'add' then
      insert into public.punches(employee_id, punch_type, punched_at, source)
        values (employee.id, p_punch_type, at_time, 'manager') returning * into new_punch;
    elsif p_action = 'change' then
      update public.punches set punch_type = p_punch_type, punched_at = at_time
       where id = old_punch.id returning * into new_punch;
    else
      select v.workplace_name into location from public.punch_location_verifications v where v.punch_id = old_punch.id;
      delete from public.punch_location_verifications where punch_id = old_punch.id;
      delete from public.punches where id = old_punch.id;
    end if;
  exception when sqlstate 'P0001' then
    if sqlerrm like '%approved and locked%' then return jsonb_build_object('error', 'period_locked'); end if;
    raise;
  end;

  insert into public.punch_corrections(organization_id, employee_id, punch_id, action, before_type, before_at,
    after_type, after_at, before_location, reason, corrected_by, corrected_by_label)
  values (employee.organization_id, employee.id, coalesce(new_punch.id, old_punch.id),
    case p_action when 'add' then 'added' when 'change' then 'changed' else 'removed' end,
    old_punch.punch_type, old_punch.punched_at, new_punch.punch_type, new_punch.punched_at,
    coalesce(location, old_punch.location_name), reason, p_actor, nullif(btrim(coalesce(p_actor_label, '')), ''));

  return jsonb_build_object('success', true, 'punchId', coalesce(new_punch.id, old_punch.id)::text,
    'punchedAt', coalesce(new_punch.punched_at, old_punch.punched_at), 'timeZone', zone);
end $function$;
revoke all on function public.correct_punch(uuid, uuid, uuid, text, bigint, text, timestamp, text, text) from public, anon, authenticated;
grant execute on function public.correct_punch(uuid, uuid, uuid, text, bigint, text, timestamp, text, text) to service_role;

-- The signed-in employee's own corrections in a date range (in their time zone). With
-- several businesses, p_employee_id picks one; otherwise it must be their only record.
create function public.my_punch_corrections(p_from date, p_to date, p_employee_id uuid default null)
returns table (punch_id text, action text, before_type text, before_at timestamptz, after_type text,
  after_at timestamptz, reason text, corrected_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with mine as (
    select e.id, e.province from public.employees e
     where e.auth_user_id = (select auth.uid()) and (p_employee_id is null or e.id = p_employee_id)
  ), chosen as (select * from mine where (select count(*) from mine) = 1)
  select c.punch_id::text, c.action, c.before_type, c.before_at, c.after_type, c.after_at, c.reason, c.corrected_at
    from public.punch_corrections c join chosen on chosen.id = c.employee_id
   where (coalesce(c.after_at, c.before_at) at time zone tymrak_private.province_time_zone(chosen.province))::date
         between p_from and p_to
      or (c.before_at at time zone tymrak_private.province_time_zone(chosen.province))::date between p_from and p_to
   order by c.corrected_at
$$;
revoke all on function public.my_punch_corrections(date, date, uuid) from public, anon;
grant execute on function public.my_punch_corrections(date, date, uuid) to authenticated;

commit;
