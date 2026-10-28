-- Tenant schema prerequisite for PR #33.
-- Structural only: DO NOT automatically assign existing users or employees to a tenant.
-- Before production rollout, explicitly map and verify all existing users/employees
-- and workplace assignments; authorization intentionally fails closed otherwise.
create table if not exists public.organizations (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) between 1 and 120),
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);
alter table public.user_roles add column if not exists organization_id uuid references public.organizations(id);
alter table public.employees add column if not exists organization_id uuid references public.organizations(id);
create unique index if not exists user_roles_auth_user_company_unique on public.user_roles(auth_user_id,organization_id);
create unique index if not exists employees_id_company_unique on public.employees(id,organization_id);

create table if not exists public.workplaces (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) between 1 and 120),
 address text not null check (length(address) <= 300),
 latitude double precision not null check (latitude between -90 and 90),
 longitude double precision not null check (longitude between -180 and 180),
 radius_metres double precision not null default 50 check (radius_metres between 25 and 5000),
 is_active boolean not null default true,
 updated_at timestamptz not null default now(),
 organization_id uuid not null references public.organizations(id),
 constraint workplaces_id_company_unique unique(id,organization_id)
);
create table if not exists public.manager_workplaces (
 manager_id uuid not null,
 workplace_id uuid not null,
 organization_id uuid not null references public.organizations(id),
 primary key(manager_id,workplace_id),
 constraint manager_workplaces_manager_company_fk foreign key(manager_id,organization_id) references public.user_roles(auth_user_id,organization_id),
 constraint manager_workplaces_workplace_company_fk foreign key(workplace_id,organization_id) references public.workplaces(id,organization_id)
);
create table if not exists public.employee_workplaces (
 employee_id uuid not null references public.employees(id),
 workplace_id uuid not null references public.workplaces(id),
 organization_id uuid not null references public.organizations(id),
 primary key(employee_id,workplace_id),
 constraint employee_workplaces_employee_company_fk foreign key(employee_id,organization_id) references public.employees(id,organization_id),
 constraint employee_workplaces_workplace_company_fk foreign key(workplace_id,organization_id) references public.workplaces(id,organization_id)
);
create index if not exists manager_workplaces_org_idx on public.manager_workplaces(organization_id,workplace_id);
create index if not exists employee_workplaces_org_idx on public.employee_workplaces(organization_id,workplace_id);
create index if not exists employees_org_idx on public.employees(organization_id);
create index if not exists user_roles_org_idx on public.user_roles(organization_id);

alter table public.organizations enable row level security;
alter table public.workplaces enable row level security;
alter table public.manager_workplaces enable row level security;
alter table public.employee_workplaces enable row level security;
-- No client-facing policies: tenant metadata is accessed only via server-side authorization.
grant usage on schema public to service_role;
grant select on public.organizations, public.workplaces, public.manager_workplaces, public.employee_workplaces to service_role;
-- Existing roles/employees must retain their current privileges; server reads need SELECT.
grant select on public.user_roles, public.employees to service_role;
