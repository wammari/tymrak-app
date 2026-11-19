-- Company admins and managers ("team access").
-- The Main Administrator invites each company's first admin; a company admin can then
-- give admin or manager access to others in their own company. Managers only see the
-- employees at the workplaces they are given. All changes go through these functions,
-- which only the server can call; user_roles stays read-only for the server.
-- Nobody can approve or reopen their own timecard (enforced by a trigger).
begin;

-- True when the actor is an admin of this active company.
create function tymrak_private.is_company_admin(p_actor uuid, p_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles r join public.organizations o on o.id = r.organization_id
    where r.auth_user_id = p_actor and r.organization_id = p_organization_id
      and r.role = 'admin' and o.is_active)
$$;
revoke all on function tymrak_private.is_company_admin(uuid, uuid) from public, anon, authenticated;

-- Everyone with admin or manager access to a company, except p_hidden_user (the Main
-- Administrator, who has access to every company and is not shown to clients).
create function public.company_team(p_actor uuid, p_organization_id uuid, p_hidden_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not tymrak_private.is_company_admin(p_actor, p_organization_id) then
    return jsonb_build_object('error', 'admin_required');
  end if;
  return jsonb_build_object('members', coalesce((
    select jsonb_agg(jsonb_build_object(
      'authUserId', r.auth_user_id,
      'email', u.email,
      'role', r.role,
      'status', case when u.last_sign_in_at is null then 'invited' else 'active' end,
      'isYou', r.auth_user_id = p_actor,
      'employee', case when e.id is null then null else jsonb_build_object(
        'id', e.id, 'name', btrim(e.first_name || ' ' || e.last_name)) end,
      'name', coalesce(nullif(btrim(e.first_name || ' ' || e.last_name), ''),
        nullif(btrim(coalesce(u.raw_user_meta_data ->> 'first_name', '') || ' ' || coalesce(u.raw_user_meta_data ->> 'last_name', '')), '')),
      'workplaces', coalesce((
        select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name) order by w.name)
        from public.manager_workplaces m join public.workplaces w on w.id = m.workplace_id
        where m.manager_id = r.auth_user_id and m.organization_id = p_organization_id), '[]'::jsonb)
    ) order by r.role, lower(u.email))
    from public.user_roles r
    join auth.users u on u.id = r.auth_user_id
    left join public.employees e on e.auth_user_id = r.auth_user_id and e.organization_id = p_organization_id
    where r.organization_id = p_organization_id and r.role in ('admin', 'manager')
      and r.auth_user_id is distinct from p_hidden_user), '[]'::jsonb));
end $$;
revoke all on function public.company_team(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.company_team(uuid, uuid, uuid) to service_role;

-- Gives (or changes) admin or manager access. Managers get exactly the given workplaces.
create function public.grant_company_access(
  p_actor uuid, p_organization_id uuid, p_auth_user_id uuid, p_role text,
  p_workplace_ids uuid[], p_protected_user uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_current text;
  v_workplaces uuid[] := coalesce(p_workplace_ids, '{}');
begin
  if not tymrak_private.is_company_admin(p_actor, p_organization_id) then
    return jsonb_build_object('error', 'admin_required');
  end if;
  if p_role not in ('admin', 'manager') then return jsonb_build_object('error', 'invalid_role'); end if;
  if p_auth_user_id is null or not exists (select 1 from auth.users where id = p_auth_user_id) then
    return jsonb_build_object('error', 'user_not_found');
  end if;
  if p_auth_user_id = p_actor then return jsonb_build_object('error', 'cannot_change_own_access'); end if;
  if p_auth_user_id is not distinct from p_protected_user then return jsonb_build_object('error', 'protected_user'); end if;
  if p_role = 'manager' then
    if cardinality(v_workplaces) = 0 then return jsonb_build_object('error', 'workplace_required'); end if;
    if (select count(distinct w.id) from public.workplaces w
        where w.id = any(v_workplaces) and w.organization_id = p_organization_id) <> cardinality(array(select distinct unnest(v_workplaces))) then
      return jsonb_build_object('error', 'invalid_workplace');
    end if;
  end if;
  -- One change at a time per company, so two admins cannot both remove the last admin.
  perform 1 from public.organizations where id = p_organization_id for update;
  select role into v_current from public.user_roles
    where auth_user_id = p_auth_user_id and organization_id = p_organization_id;
  if v_current = 'admin' and p_role <> 'admin' and (select count(*) from public.user_roles
      where organization_id = p_organization_id and role = 'admin') <= 1 then
    return jsonb_build_object('error', 'last_admin');
  end if;
  insert into public.user_roles (auth_user_id, organization_id, role)
  values (p_auth_user_id, p_organization_id, p_role)
  on conflict (auth_user_id, organization_id) do update set role = excluded.role, updated_at = now();
  delete from public.manager_workplaces where manager_id = p_auth_user_id and organization_id = p_organization_id;
  if p_role = 'manager' then
    insert into public.manager_workplaces (manager_id, workplace_id, organization_id)
    select p_auth_user_id, w, p_organization_id from (select distinct unnest(v_workplaces) as w) x;
  end if;
  return jsonb_build_object('success', true, 'role', p_role, 'created', v_current is null);
end $$;
revoke all on function public.grant_company_access(uuid, uuid, uuid, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.grant_company_access(uuid, uuid, uuid, text, uuid[], uuid) to service_role;

-- Removes admin or manager access. The person's employee login (if any) is not touched.
create function public.revoke_company_access(
  p_actor uuid, p_organization_id uuid, p_auth_user_id uuid, p_protected_user uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_current text;
begin
  if not tymrak_private.is_company_admin(p_actor, p_organization_id) then
    return jsonb_build_object('error', 'admin_required');
  end if;
  if p_auth_user_id = p_actor then return jsonb_build_object('error', 'cannot_change_own_access'); end if;
  if p_auth_user_id is not distinct from p_protected_user then return jsonb_build_object('error', 'protected_user'); end if;
  perform 1 from public.organizations where id = p_organization_id for update;
  select role into v_current from public.user_roles
    where auth_user_id = p_auth_user_id and organization_id = p_organization_id;
  if v_current is null or v_current not in ('admin', 'manager') then return jsonb_build_object('error', 'not_a_member'); end if;
  if v_current = 'admin' and (select count(*) from public.user_roles
      where organization_id = p_organization_id and role = 'admin') <= 1 then
    return jsonb_build_object('error', 'last_admin');
  end if;
  delete from public.manager_workplaces where manager_id = p_auth_user_id and organization_id = p_organization_id;
  delete from public.user_roles where auth_user_id = p_auth_user_id and organization_id = p_organization_id;
  return jsonb_build_object('success', true);
end $$;
revoke all on function public.revoke_company_access(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_company_access(uuid, uuid, uuid, uuid) to service_role;

-- Nobody approves or reopens their own timecard: another manager or admin must do it.
create function tymrak_private.prevent_self_timecard_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select auth_user_id into v_owner from public.employees where id = new.employee_id;
  if v_owner is null then return new; end if;
  if new.status = 'approved' and new.approved_by = v_owner
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.approved_by is distinct from new.approved_by) then
    raise exception 'You can''t approve your own timecard. Another manager or admin must approve it.'
      using errcode = 'check_violation';
  end if;
  if new.status = 'reopened' and new.reopened_by = v_owner
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.reopened_by is distinct from new.reopened_by) then
    raise exception 'You can''t reopen your own timecard. Another manager or admin must reopen it.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function tymrak_private.prevent_self_timecard_decision() from public, anon, authenticated;
create trigger prevent_self_timecard_decision
  before insert or update on public.timecard_approvals
  for each row execute function tymrak_private.prevent_self_timecard_decision();

commit;
