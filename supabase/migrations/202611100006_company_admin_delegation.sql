-- Delegation is restricted to existing active company members and platform administrators.
-- Do not create Auth identities or invitations as a side effect.
create or replace function public.set_company_administrator(
 p_platform_admin uuid, p_organization_id uuid, p_member_email text, p_grant boolean
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_member uuid; v_current text; v_name text;
begin
 if not exists (select 1 from tymrak_private.platform_administrators where auth_user_id=p_platform_admin)
 then raise exception 'Main administrator required' using errcode='42501'; end if;
 if not exists (select 1 from public.organizations where id=p_organization_id and is_active=true)
 then raise exception 'Company unavailable' using errcode='22023'; end if;
 select id into v_member from auth.users where lower(email)=lower(btrim(p_member_email)) limit 1;
 if v_member is null then raise exception 'User must have an existing account' using errcode='22023'; end if;
 select role into v_current from public.user_roles
 where auth_user_id=v_member and organization_id=p_organization_id for update;
 if v_current is null then raise exception 'User must already belong to this company' using errcode='22023'; end if;
 if p_grant then
  update public.user_roles set role='admin' where auth_user_id=v_member and organization_id=p_organization_id;
 else
  if v_member=p_platform_admin then raise exception 'Cannot revoke main administrator membership' using errcode='42501'; end if;
  if v_current <> 'admin' then raise exception 'User is not a company administrator' using errcode='22023'; end if;
  update public.user_roles set role='manager' where auth_user_id=v_member and organization_id=p_organization_id;
 end if;
 return jsonb_build_object('organizationId',p_organization_id,'email',p_member_email,'role',case when p_grant then 'admin' else 'manager' end);
end $$;
revoke all on function public.set_company_administrator(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.set_company_administrator(uuid,uuid,text,boolean) to service_role;
