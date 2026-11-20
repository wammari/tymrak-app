-- QuickBooks Online sync (first version).
-- A company admin connects the company's QuickBooks once; each Tymrak employee is matched
-- to a QuickBooks employee; approved timecards are sent as QuickBooks time entries. Once a
-- timecard has been sent (even partly), it is locked: it can no longer be reopened, and
-- corrections go into a later pay period. Only the server reads or writes these tables;
-- QuickBooks tokens are stored encrypted by the server (AES-256-GCM), never in plain text.
begin;

create table public.accounting_connections (
  organization_id uuid primary key references public.organizations(id),
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  realm_id text not null check (realm_id ~ '^[0-9]{1,32}$'),
  company_name text check (company_name is null or length(company_name) <= 200),
  environment text not null check (environment in ('sandbox', 'production')),
  -- The admin's answer to "Do you run payroll in QuickBooks Online?" (null until answered).
  -- Hours are only sent when it is true: businesses that pay people some other way
  -- (an accountant, another payroll provider) get nothing from time entries.
  runs_payroll boolean,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  connected_by uuid references auth.users(id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.accounting_connections is
  'One QuickBooks company per Tymrak company. Tokens are encrypted by the server.';

create table public.employee_accounting_links (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  external_id text not null check (external_id ~ '^[0-9]{1,32}$'),
  external_name text check (external_name is null or length(external_name) <= 200),
  matched_by text not null check (matched_by in ('email', 'name', 'manual')),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint employee_accounting_links_one_per_external unique (organization_id, provider, external_id)
);
comment on table public.employee_accounting_links is
  'Which QuickBooks employee each Tymrak employee is (matched by email, name or by hand).';

create table public.accounting_timecard_syncs (
  approval_id uuid primary key references public.timecard_approvals(id),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  realm_id text,
  status text not null check (status in ('sending', 'synced', 'failed')),
  -- Time entries created in QuickBooks: [{date, minutes, externalId}]. Never shrinks, so a
  -- retry only sends the days that are missing.
  entries jsonb not null default '[]'::jsonb check (jsonb_typeof(entries) = 'array'),
  -- Overtime and double time that were not sent, for the admin to enter in payroll.
  manual_hours jsonb not null default '[]'::jsonb check (jsonb_typeof(manual_hours) = 'array'),
  error text check (error is null or length(error) <= 500),
  attempted_by uuid references auth.users(id),
  attempted_at timestamptz not null default now(),
  synced_at timestamptz
);
create index accounting_timecard_syncs_org_idx on public.accounting_timecard_syncs (organization_id, status);
comment on table public.accounting_timecard_syncs is
  'Each approved timecard sent to QuickBooks, with the time entries created for it.';

alter table public.accounting_connections enable row level security;
alter table public.employee_accounting_links enable row level security;
alter table public.accounting_timecard_syncs enable row level security;
revoke all on public.accounting_connections, public.employee_accounting_links, public.accounting_timecard_syncs
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.accounting_connections, public.employee_accounting_links to service_role;
grant select, insert, update on public.accounting_timecard_syncs to service_role;

-- A timecard that has been sent to QuickBooks (or is being sent, or had any entries
-- created) cannot be reopened: QuickBooks would no longer match Tymrak.
create function tymrak_private.lock_synced_timecards() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'approved' and new.status is distinct from 'approved' and exists (
    select 1 from public.accounting_timecard_syncs s
    where s.approval_id = old.id
      and (s.status in ('sending', 'synced') or jsonb_array_length(s.entries) > 0)) then
    raise exception 'This timecard was sent to QuickBooks and is locked. Record any correction in the next pay period.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function tymrak_private.lock_synced_timecards() from public, anon, authenticated;
create trigger lock_synced_timecards
  before update on public.timecard_approvals
  for each row execute function tymrak_private.lock_synced_timecards();

commit;
