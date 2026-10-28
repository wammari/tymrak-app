-- Guelph pilot schema preparation. This migration is NOT applied to production.
-- Coordinates must be verified on site before a workplace is activated.
-- Server-controlled assignments prevent employees selecting another location.
create table if not exists public.workplaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  latitude double precision,
  longitude double precision,
  radius_meters integer not null default 50 check (radius_meters between 10 and 1000),
  max_accuracy_meters integer not null default 50 check (max_accuracy_meters between 5 and 200),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workplace_coordinates_valid check (
    (latitude is null and longitude is null and is_active = false) or
    (latitude between -90 and 90 and longitude between -180 and 180)
  )
);

create table if not exists public.employee_workplaces (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  workplace_id uuid not null references public.workplaces(id),
  assigned_at timestamptz not null default now()
);

alter table public.workplaces enable row level security;
alter table public.employee_workplaces enable row level security;
-- No client access policies: only trusted server-side service operations
-- can configure or read locations and employee assignments.

-- Do not add a live workplace row or revoke punch inserts until the
-- authenticated server endpoint is ready and verified end-to-end.
