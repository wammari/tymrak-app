# Employee termination (added 14 November 2026)

**Behaviour**
- A manager/admin chooses **Terminate** on an employee (date + optional reason). The employee is marked inactive for clocking.
- Terminated employees cannot clock in, clock out or take breaks (enforced in the database: `record_geofenced_punch` returns `employee_unavailable`).
- They can still sign in and read **only their own** employee record and historical timecards (read-only; every write stays blocked).
- **Reactivate** clears the termination and restores clocking. Rows are never deleted, so history is kept.
- Plain *Inactive* (no termination date) is unchanged and still blocks all access.

**Deploy order**
1. Apply `supabase/migrations/202611140001_employee_termination.sql` to staging, then production. It adds `termination_date`, `termination_reason`, `terminated_at`, a consistency constraint, and replaces the two `FOR ALL` restrictive policies with per-command policies (reads allow terminated employees; writes still require an active employee).
2. Deploy the app. If the app is deployed first, Terminate fails until the columns exist.
3. Test on staging: terminate a test employee, confirm they cannot clock in but can open My Timecard, then reactivate.

**Note:** `employee.html` already selected an `employment_status` column that is not defined in these migrations (it was probably added to the live database by hand). This feature deliberately does not use it. Consider adding it to the migrations so a rebuilt database matches production.
