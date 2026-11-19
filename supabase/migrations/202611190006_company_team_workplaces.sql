-- The Team page also needs the business's workplaces (to choose a manager's workplaces).
-- In production the server may not read the workplaces table directly (only through
-- database functions), so company_team() now returns them, after its admin check.
begin;

create or replace function public.company_team(p_actor uuid, p_organization_id uuid, p_hidden_user uuid)
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
      and r.auth_user_id is distinct from p_hidden_user), '[]'::jsonb),
    -- The business's workplaces, for choosing a manager's workplaces. The server cannot
    -- read the workplaces table directly in production, so they come from here.
    'workplaces', coalesce((
      select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'isActive', w.is_active) order by w.name)
      from public.workplaces w where w.organization_id = p_organization_id), '[]'::jsonb));
end $$;
revoke all on function public.company_team(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.company_team(uuid, uuid, uuid) to service_role;

commit;
