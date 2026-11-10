-- Phase 1: move only Le Delice's pilot employee and workplace to their own organization.
-- Execute after 202611100001_multi_company_membership.sql, in a single transaction.
DO $$
DECLARE
  old_org uuid := '5aee6ef9-b865-442b-a82c-6deaf2459d04';
  pastry_workplace uuid := 'cd7941a4-5de1-4262-a65a-1714905a9c37';
  pastry_employee uuid := '053c5b58-3c27-4c90-bee5-1939c187cc8f';
  admin_user uuid := '0bfba2af-ee44-47e5-ad08-d61a98992f55';
  new_org uuid;
BEGIN
  IF (SELECT count(*) FROM public.organizations WHERE id=old_org AND name='I Care Pharmacy') <> 1
     OR (SELECT count(*) FROM public.workplaces WHERE id=pastry_workplace AND organization_id=old_org AND name ILIKE '%delice%') <> 1
     OR (SELECT count(*) FROM public.employees WHERE id=pastry_employee AND organization_id=old_org AND lower(email)='info@ledelicepastryshop.com') <> 1
     OR (SELECT count(*) FROM public.employee_workplaces WHERE employee_id=pastry_employee AND workplace_id=pastry_workplace AND organization_id=old_org) <> 1
     OR (SELECT count(*) FROM public.user_roles WHERE auth_user_id=admin_user AND organization_id=old_org AND role='admin') <> 1
  THEN RAISE EXCEPTION 'Le Delice migration preconditions changed; no records moved'; END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE lower(name) = lower('Ledelice Pastry shop'))
  THEN RAISE EXCEPTION 'Le Delice organization already exists; manual review required'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_workplaces WHERE workplace_id=pastry_workplace AND employee_id<>pastry_employee)
     OR EXISTS (SELECT 1 FROM public.employee_workplaces WHERE employee_id=pastry_employee AND workplace_id<>pastry_workplace)
  THEN RAISE EXCEPTION 'Unexpected Le Delice workplace assignments; manual review required'; END IF;
  IF EXISTS (SELECT 1 FROM public.punches WHERE employee_id=pastry_employee)
     OR EXISTS (SELECT 1 FROM public.timecard_approvals WHERE employee_id=pastry_employee)
     OR EXISTS (SELECT 1 FROM public.timecard_approval_history WHERE employee_id=pastry_employee)
     OR EXISTS (SELECT 1 FROM public.employee_punch_requests WHERE employee_id=pastry_employee)
     OR EXISTS (SELECT 1 FROM public.punch_location_verifications WHERE workplace_id=pastry_workplace)
  THEN RAISE EXCEPTION 'Le Delice activity exists; review historical tenant ownership before migration'; END IF;
  INSERT INTO public.organizations(name,is_active) VALUES ('Ledelice Pastry shop',true) RETURNING id INTO new_org;
  DELETE FROM public.employee_workplaces WHERE employee_id=pastry_employee AND workplace_id=pastry_workplace AND organization_id=old_org;
  UPDATE public.employees SET organization_id=new_org WHERE id=pastry_employee AND organization_id=old_org;
  UPDATE public.workplaces SET organization_id=new_org WHERE id=pastry_workplace AND organization_id=old_org;
  INSERT INTO public.employee_workplaces(employee_id,workplace_id,organization_id) VALUES(pastry_employee,pastry_workplace,new_org);
  INSERT INTO public.user_roles(auth_user_id,organization_id,role) VALUES(admin_user,new_org,'admin');
  IF (SELECT count(*) FROM public.employee_workplaces WHERE employee_id=pastry_employee AND organization_id=new_org)<>1
    OR (SELECT count(*) FROM public.user_roles WHERE auth_user_id=admin_user)<>2
    OR (SELECT count(*) FROM public.employees WHERE organization_id=old_org AND lower(email)='mabawab@yahoo.com')<>1
  THEN RAISE EXCEPTION 'Le Delice postconditions failed; rolling back'; END IF;
END $$;
