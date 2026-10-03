-- Phase 2 employee-management fields not present in the existing employee profile.
-- Safe to run against existing data: both fields are nullable and no rows change.
alter table public.employees
  add column if not exists mobile text,
  add column if not exists hire_date date;
