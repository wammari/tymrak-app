# Company isolation candidate

This draft is stacked on PR #26 (which depends on #25). Production is unchanged.
The company and workplace migrations were applied to isolated staging on 24 October 2026.
No paid service was added.

## Confirmed workplace access rule

The owner confirmed that all existing employees belong to one company, that employees
may work at multiple workplaces, and that managers must see only employees assigned
to the workplaces they manage. The owner supplied company name I Care Pharmacy and
designated w.ammari@outlook.com as its company administrator and pharmacy manager.
No other existing manager is automatically assigned workplaces.

## Staging configuration — 24 October 2026

Application commit 3ca8a2ef9b353abe4a11035a377bb9c9d5e97ebc is Ready on stable staging
https://tymrak-staging.vercel.app, deployment AWpzat3DYowhMiuitdkcp4Q8EHmW.
The public configuration was verified to target the staging Supabase project.
The browser currently shows Manager Login, so authenticated UI acceptance is pending.

The confirmed existing staging Auth account w.ammari@outlook.com now has the admin role
for I Care Pharmacy and an explicit manager_workplaces link to the existing ICare Pharmacy
workplace. Existing company test employees were mapped to the company. All three test
employees and 22 punches were retained; no employee/workplace assignments were created.
The owner clarified that these existing employees are test accounts and plans to invite
two real pharmacy employees separately. Do not delete the tests or assume they are staff.

All three company constraints were validated after the staging mapping. Live SQL checks
confirmed the administrator's company/workplace access, denial of the old unassigned
manager account, and denial of browser manager-assignment writes. Existing security
advisor warnings about rls_auto_enable EXECUTE and leaked-password protection are unchanged;
the service-only tables intentionally have no browser policies. Hosted manager UI,
external-recipient invitation delivery and mobile geofence acceptance still require testing.
No production role, company data, employee records, schema or deployment was changed.

Migration 20261023220346_manager_workplace_scope.sql adds server-controlled
manager_workplaces assignments with same-company foreign keys. A regular manager's
employee scope is resolved from live database assignments on every request. No assigned
workplaces means an empty employee list. Removing an assignment removes access on the
next request. A failed scope lookup never falls back to a company-wide list.
Workplace deactivation affects clocking eligibility, while existing manager assignments
continue to govern personnel access until explicitly removed.

The restriction covers employee lists/updates, duplicate checks, invitation resending,
timecards, approval/reopening and workplace lists/edits/employee reassignment. Managers
cannot acquire hidden employees by submitting their IDs to a workplace. An employee
assigned to two workplaces is visible to both assigned managers. Timecards include the
visible employee's complete company timecard; this change restricts employee visibility,
not individual punches to a particular location.

Company administrators retain company-wide setup access. Adding new employees requires
this administrator role, so regular managers cannot create unassigned employees outside
their workplace scope. The Add Employee action is hidden for managers and its API is
also protected. Managers can resend invitations for already assigned employees. Existing
manager accounts are not automatically promoted to administrators. Before rollout,
explicitly identify the company administrator and provision manager/workplace assignments
through the reviewed server/database administration process. There is no browser endpoint
for managers to grant themselves existing workplace access. Creating a new empty workplace
as a manager assigns that newly created workplace to its creator; it does not expose any
additional employees.

## Implemented boundary

An organization is an employer/customer. Existing server-managed user_roles becomes
the explicit manager membership by adding organization_id. One manager identity has
one company in this first version; a global manager/admin role alone grants no access.
The manager identity is verified with Auth, and its role, company ID and active company
are read from the database for every API request. Editable Auth metadata and submitted
organization/role fields cannot choose a company.

Employee list/update/duplicate checks/invite/resend and manager timecards are scoped
to the verified company. Approval/reopening validates employee ownership before child
table access. The workplace RPC checks the manager company again inside SQL, filters
its results, and rejects foreign employee/workplace IDs. Composite foreign keys reject
cross-company workplace assignments independently of the API.

Clocking and activation retain their tested implementations behind service-only company
gates. Suspended and unassigned companies fail closed. The internal functions are moved
to a private schema and revoked from browser and service roles. Employee personal reads
have restrictive ownership/company policies in addition to existing permissive policies.
Browser DML and anonymous reads on employees/punches are revoked, including column grants.
Historical punches, receipts and audit records are retained under their immutable parent
employee/workplace ownership. Organizations and role membership have no browser access.

No real records are automatically assigned to a company. Existing employees/workplaces
receive null company IDs; they remain quarantined until reviewed mapping is supplied.
NOT VALID constraints retain these legacy rows while requiring a company on new or
updated rows. Company ownership cannot later be changed through ordinary updates.
The unique Auth mapping is enforced; this initial version does not support the same
employee Auth identity working for several employers. Existing username/email uniqueness
is preserved. This is not a public self-service company onboarding system.

## Reporting fix

Employee and manager timecard reads page through PostgREST results with an exact count,
stable ordering and company/employee predicates retained on every page. Missing counts,
empty incomplete pages, count changes, later HTTP failures and results above 100,000 rows
fail instead of returning a partial result. This prevents the ordinary API row cap from
silently omitting punches. It is not a transactional snapshot across several HTTP reads;
recheck a report if employees or historical punches are edited during reporting.
Very large employee-ID filters, the global geofence lock and hosted concurrency still
need load validation before promising capacity for many clients.

## Required migration rehearsal

1. Verify #25 and #26 migrations and compatible schema. Run the read-only
   supabase/verification/company-isolation-preflight.sql. Review unexpected tables,
   views, policies, public RPCs and legacy duplicates instead of guessing their purpose.
2. Take and restore-test a complete private backup. Do not put backup data, database
   passwords, Auth exports or server keys into this repository.
3. Obtain an explicit legacy mapping: organization names and the employee IDs,
   workplace IDs and manager Auth UUIDs belonging to each. Unknown rows stay quarantined.
   Do not infer membership from email domain, department or a global admin role.
4. Rehearse the company migration and reviewed mapping transaction on a disposable
   database. No seed/backfill is embedded in this candidate. Assign each employee and
   workplace once, set user_roles.organization_id explicitly, and set assignment
   organization IDs only where both parents have the same verified organization.
   Resolve mismatches; do not delete evidence or bypass foreign keys to force a mapping.
5. Validate employees_company_required, workplaces_company_required and
   employee_workplaces_company_required after mapping. Confirm zero unassigned in-scope
   records and no cross-company assignments. Unassigned legacy records must be explicitly
   excluded from a release until reviewed; validation will continue to fail otherwise.
6. Exercise two synthetic companies end-to-end on an isolated hosted candidate: manager
   lists/updates/invites/resends, approvals/reopen, locations/assignments, employee activation,
   login/recovery and every punch type. Try guessed foreign IDs and direct browser calls.
   Confirm existing overnight/retry/approval-lock behavior. Run advisors after hosted DDL.
7. Retire all old unscoped deployments and rotate their privileged API credentials during
   the controlled cutover. Old deployment snapshots holding a still-valid service key can
   bypass new API filters because service_role bypasses RLS. Updating only the current
   domain while old unique deployment URLs keep working is not sufficient isolation.
   Provision the replacement credential securely to the exact new release; never expose
   it to the browser. Do not change credentials or shut down live deployments casually.
8. Deploy compatible code and mapped schema together during maintenance. Confirm company
   membership before opening access. Code-only rollback is unsafe after the migration;
   use a reviewed forward repair or verified restore plan.

## Release gates outside this PR

- Production customer SMTP and external-recipient delivery are not yet verified.
- A verified manual backup/restore is still absent.
- Current Vercel Hobby is restricted to personal/non-commercial usage; a commercial
  release must use suitable hosting. No upgrade or free-host migration is performed here.
- Live manager map and mobile inside/outside geofence acceptance remain pending.
- A single-company pilot can precede broad rollout only with verified data isolation,
  operational gates, and commercially suitable hosting. Do not onboard multiple unrelated
  clients to the currently deployed app.

## Verification

The full local suite includes executable PostgreSQL tests for same-company success,
cross-company list/edit/assignment denial, foreign keys, immutable ownership, suspended
company denial, quarantined legacy records, restrictive browser reads, internal RPC
privileges and activation gates. API tests cover forged company fields and foreign IDs
for employee updates, invitations, approval/reopening and timecards. Paging tests cover
lower server row caps, complete reads, absent counts and later-page failures.
These do not replace hosted acceptance, a backup restore or a load test.
