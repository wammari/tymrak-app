# Account deletion (added 14 November 2026)

**Rules (agreed defaults)**
- An employee asks from **Delete my account** (employee clock page and My Timecard), confirming with their password. Terminated employees can ask too.
- A manager or admin processes it with **Delete personal data** (a manager can also do this for a *terminated* employee without a request).
- Processing **removes personal details but keeps the hours**: name becomes "Former Employee"; email and username become unique placeholders (`deleted-<id>@deleted.invalid`); mobile is cleared; the sign-in account is deleted. Punches stay linked for payroll/audit. Job title, department, province and hire date are kept (needed for overtime rules).
- Manager and admin sign-ins are refused here (their approvals and audit history are tied to them); remove their access first.
- No automatic purge. Records are kept until the company decides otherwise (confirm the retention period with your accountant or lawyer).
- Requests show "Deletion requested" in the manager list. The employee is told a manager will process it within 30 days; this is a promise in the UI text, not an automatic timer.

**Deploy order**
1. Apply `202611140001_employee_termination.sql`, then `202611140002_account_deletion.sql` to **staging**, then production. Take a backup first.
2. Deploy the app. (If the app goes first, the manager list still loads; deletion requests simply do not appear until the table exists.)
3. Staging test: sign in as a test employee, request deletion (wrong password must fail), see it in the manager list, process it, confirm the old login no longer works and the hours still appear in the manager's timecards under "Former Employee".

**Retry safety:** if the sign-in account cannot be deleted, the manager sees a retry message; pressing the button again only repeats the sign-in deletion.
