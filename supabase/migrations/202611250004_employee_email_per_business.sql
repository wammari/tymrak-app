-- One person can work for several businesses (202611250003), but employees.email was
-- still unique across ALL businesses, so adding an existing account to a second
-- business was refused. Emails are now unique within a business only (ignoring case).
begin;
alter table public.employees drop constraint if exists employees_email_key;
drop index if exists public.employees_email_key;
create unique index employees_company_email_unique
  on public.employees (organization_id, lower(email));
commit;
