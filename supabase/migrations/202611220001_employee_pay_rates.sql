-- Hourly pay rates, with history. Only a business's admins see or set them (through the
-- server); managers and employees never see rates, including their own. Each rate applies
-- from its start date until the next one, so past pay periods keep the rate that applied
-- then. Kept apart from public.employees so no employee-facing query can ever read it.
begin;

create table public.employee_pay_rates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  hourly_rate numeric(8,2) not null check (hourly_rate > 0 and hourly_rate < 10000),
  currency text not null default 'CAD' check (currency = 'CAD'),
  effective_from date not null check (effective_from >= date '2000-01-01'),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint employee_pay_rates_one_per_day unique (employee_id, effective_from)
);
create index employee_pay_rates_org_idx on public.employee_pay_rates (organization_id);
create index employee_pay_rates_created_by_idx on public.employee_pay_rates (created_by);
comment on table public.employee_pay_rates is
  'Hourly pay rate history. Admin-only through the server; never readable by employees or managers.';

alter table public.employee_pay_rates enable row level security;
revoke all on public.employee_pay_rates from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.employee_pay_rates to service_role;

commit;
