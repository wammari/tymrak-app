-- Apply this migration in the Supabase project before enabling manager access.
-- This table is intentionally separate from employees: authentication identity
-- and application authorization are explicit, server-verifiable concerns.

create table if not exists public.user_roles (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_roles_supported_role check (
    role in ('employee', 'manager', 'payroll', 'admin')
  )
);

alter table public.user_roles enable row level security;

-- Deliberately create no browser-facing policy. Manager authorization is read
-- by server-side functions with the Supabase secret/service key, which bypasses
-- RLS. Do not add a broad SELECT policy for authenticated users.

comment on table public.user_roles is
  'Server-managed application roles used for privileged TYMRAK authorization.';

-- Run this separately for each approved manager, replacing the UUID and role.
-- Obtain the UUID from Authentication > Users. Do not promote every employee.
--
-- insert into public.user_roles (auth_user_id, role)
-- values ('00000000-0000-0000-0000-000000000000', 'manager')
-- on conflict (auth_user_id) do update
-- set role = excluded.role, updated_at = now();

