-- Enable one administrator to hold memberships in more than one organization.
-- Preserve the existing composite unique constraint referenced by manager_workplaces.
-- No employee or workplace data is moved by this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_roles'::regclass
      AND conname = 'user_roles_pkey'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (auth_user_id)'
  ) THEN
    ALTER TABLE public.user_roles DROP CONSTRAINT user_roles_pkey;
    ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_pkey
      PRIMARY KEY (auth_user_id, organization_id);
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_roles'::regclass
      AND conname = 'user_roles_pkey'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (auth_user_id, organization_id)'
  ) THEN
    RAISE EXCEPTION 'Unexpected user_roles primary key; manual review required';
  END IF;
END $$;
