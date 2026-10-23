-- Read-only metadata/preflight. Run before planning the company migration.
select table_name,column_name,data_type,is_nullable
from information_schema.columns where table_schema='public'
and table_name in ('employees','user_roles','workplaces','employee_workplaces','organizations')
order by table_name,ordinal_position;

select count(*) as duplicate_auth_identity_groups from (
 select auth_user_id from public.employees where auth_user_id is not null
 group by auth_user_id having count(*)>1
) duplicates;

select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies where schemaname='public' order by tablename,policyname;

select table_name,grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and grantee in ('anon','authenticated')
order by table_name,grantee,privilege_type;

select table_name,view_definition from information_schema.views where table_schema='public';

select n.nspname as schema,p.proname,p.prosecdef as security_definer,p.proacl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','tymrak_private') order by n.nspname,p.proname;
