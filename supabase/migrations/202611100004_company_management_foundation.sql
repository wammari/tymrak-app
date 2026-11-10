-- Company-management foundation. Main-admin identity is held server-side, not in editable JWT metadata.
create table if not exists tymrak_private.platform_administrators (
 auth_user_id uuid primary key references auth.users(id) on delete restrict,
 created_at timestamptz not null default now()
);
revoke all on tymrak_private.platform_administrators from public, anon, authenticated;
insert into tymrak_private.platform_administrators(auth_user_id)
values ('0bfba2af-ee44-47e5-ad08-d61a98992f55')
on conflict do nothing;

-- Single transaction for company creation and initial admin membership.
-- Only the service backend can execute, after independently validating the caller.
create or replace function tymrak_private.create_managed_company(
 p_name text, p_platform_admin uuid
) returns uuid language plpgsql security invoker
set search_path = '' as $$
declare v_id uuid;
begin
 if not exists (select 1 from tymrak_private.platform_administrators where auth_user_id=p_platform_admin)
 then raise exception 'Not a platform administrator' using errcode='42501'; end if;
 if p_name is null or length(btrim(p_name)) < 2 or length(btrim(p_name)) > 120
 then raise exception 'Invalid company name' using errcode='22023'; end if;
 if exists (select 1 from public.organizations where lower(btrim(name))=lower(btrim(p_name)))
 then raise exception 'Company name already exists' using errcode='23505'; end if;
 insert into public.organizations(name) values (btrim(p_name)) returning id into v_id;
 insert into public.user_roles(auth_user_id,organization_id,role)
 values (p_platform_admin,v_id,'admin');
 return v_id;
end $$;
revoke all on function tymrak_private.create_managed_company(text,uuid) from public, anon, authenticated;
