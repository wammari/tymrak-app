-- Company codes and automatic employee usernames.
-- Every company gets a short, unique code made from its name (I Care Pharmacy -> ICP).
-- New employees get the username <code>-<number>, starting at 1001 (ICP-1001, ICP-1002, ...).
-- The number comes from a counter on the company row, taken in one atomic update, so two
-- admins adding people at the same moment can never get the same username. Usernames that
-- already exist are kept. Employees still sign in with their email.
begin;

alter table public.organizations
  add column company_code text,
  add column next_employee_number integer not null default 1001
    check (next_employee_number between 1 and 999999999);

-- A code from a name: initials of the first three words; with fewer words, more letters of
-- the first word (QB testing -> QBT, Shyftrak -> SHY). If taken, a number is added (ICP2).
create function tymrak_private.company_code_for(p_name text, p_exclude uuid default null)
returns text language plpgsql set search_path = '' as $$
declare
  words text[];
  base text := '';
  candidate text;
  n integer := 1;
begin
  words := array(select w from unnest(regexp_split_to_array(upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9 ]', '', 'g')), '\s+')) w where w <> '');
  if coalesce(array_length(words, 1), 0) = 0 then
    base := 'CO';
  elsif array_length(words, 1) >= 3 then
    base := left(words[1], 1) || left(words[2], 1) || left(words[3], 1);
  else
    base := left(words[1], 4 - array_length(words, 1));
    if array_length(words, 1) = 2 then base := base || left(words[2], 1); end if;
  end if;
  if length(base) < 2 then base := rpad(base, 2, 'X'); end if;
  candidate := base;
  while exists (select 1 from public.organizations o where o.company_code = candidate and o.id is distinct from p_exclude) loop
    n := n + 1;
    candidate := base || n;
  end loop;
  return candidate;
end $$;
revoke all on function tymrak_private.company_code_for(text, uuid) from public, anon, authenticated;

-- Existing companies, oldest first, so the first company keeps the plain code.
do $$
declare r record;
begin
  for r in select id, name from public.organizations order by created_at nulls last, id loop
    update public.organizations set company_code = tymrak_private.company_code_for(r.name, r.id) where id = r.id;
  end loop;
end $$;

alter table public.organizations
  alter column company_code set not null,
  add constraint organizations_company_code_format check (company_code ~ '^[A-Z0-9]{2,8}$'),
  add constraint organizations_company_code_key unique (company_code);

-- New companies get a code automatically.
create function tymrak_private.set_company_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.company_code is null or btrim(new.company_code) = '' then
    new.company_code := tymrak_private.company_code_for(new.name, new.id);
  else
    new.company_code := upper(btrim(new.company_code));
  end if;
  return new;
end $$;
revoke all on function tymrak_private.set_company_code() from public, anon, authenticated;
create trigger set_company_code before insert on public.organizations
  for each row execute function tymrak_private.set_company_code();

-- The next free username for a company (server only).
create function public.next_employee_username(p_organization_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_number integer;
  v_username text;
begin
  loop
    update public.organizations
       set next_employee_number = next_employee_number + 1
     where id = p_organization_id
    returning company_code, next_employee_number - 1 into v_code, v_number;
    if v_code is null then
      raise exception 'Company not found' using errcode = 'no_data_found';
    end if;
    v_username := v_code || '-' || v_number;
    exit when not exists (
      select 1 from public.employees e
       where e.organization_id = p_organization_id and lower(e.username) = lower(v_username));
  end loop;
  return v_username;
end $$;
revoke all on function public.next_employee_username(uuid) from public, anon, authenticated;
grant execute on function public.next_employee_username(uuid) to service_role;

commit;
