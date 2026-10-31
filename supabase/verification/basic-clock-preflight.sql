-- READ ONLY. Run independently in each intended Supabase project.
-- Record the project reference from its dashboard before running this query.
select current_database(), current_user;
select table_name,column_name,data_type,column_default,is_nullable
from information_schema.columns
where table_schema='public' and table_name in ('employees','punches')
order by table_name,ordinal_position;
select c.relname,c.relrowsecurity,c.relforcerowsecurity
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
('employees','punches','user_roles','timecard_approvals','timecard_approval_history','employee_punch_requests');
select tablename,policyname,roles,cmd,qual,with_check from pg_policies
where schemaname='public' order by tablename,policyname;
select table_name,grantee,privilege_type from information_schema.table_privileges
where table_schema='public' and table_name in ('employees','punches','user_roles','employee_punch_requests')
order by table_name,grantee,privilege_type;
select table_name,column_name,grantee,privilege_type from information_schema.column_privileges
where table_schema='public' and table_name='punches' order by column_name,grantee;
select c.relname,con.conname,pg_get_constraintdef(con.oid)
from pg_constraint con join pg_class c on c.oid=con.conrelid
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('employees','punches','timecard_approvals');
select event_object_table,trigger_name,action_statement from information_schema.triggers
where event_object_schema='public' order by event_object_table,trigger_name;
select to_regprocedure('public.complete_employee_activation(uuid)') as activation_function,
 to_regprocedure('public.record_employee_punch(uuid,text,uuid,text)') as punch_function;
-- Post-migration: expected false for both browser roles' INSERT and RPC EXECUTE,
-- true for service-role RPC EXECUTE. Inspect column grants above too.
select role_name,
 has_table_privilege(role_name,'public.punches','INSERT') as can_insert_punches
from (values ('anon'),('authenticated'),('service_role')) r(role_name);
