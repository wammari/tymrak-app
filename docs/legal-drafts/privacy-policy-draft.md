# TYMRAK Privacy Policy (DRAFT for legal review)

> **Not legal advice and not yet publishable.** This draft was written from what the product actually stores and which
> services it uses on 19 November 2026. A lawyer who knows Canadian privacy law must review it before it is published
> or linked from the App Store.

## Notes for the reviewer (delete before publishing)

Facts the draft relies on, so they can be checked:

- Database and sign-in are hosted by Supabase in **Canada (ca-central-1)**. The web app is served by Vercel; static and
  edge processing may occur outside Canada. Email is sent through Resend. Confirm where each provider processes data
  and whether a cross-border statement is needed (including for Quebec, Law 25).
- There is **no advertising, no third-party analytics and no tracking** in the app.
- Location is read **only when an employee taps a clock button**, never in the background.
- There is **no automatic deletion**. Records stay until the employer decides otherwise. The in-app deletion text promises
  a manager will process a request within 30 days (a UI promise, not an automatic timer).
- Time Off (vacation requests, notes, balances and decisions) was added in November 2026 and is covered below.
- **QuickBooks Online** (added November 2026, section 7). Only a company admin can connect it. Tymrak reads the QuickBooks
  company name and its active employees (name and email) to match people, and writes one time entry per employee per day
  (date and regular hours, not billable). It never reads bank, invoice, customer or pay information. The Intuit sign-in
  tokens are stored encrypted (AES-256-GCM) and only the server can read them. Disconnecting revokes access at Intuit.
  Intuit requires a public link to this policy before the integration can be used by real customers.

Open items for the owner and lawyer:

1. Legal company name, mailing address, support email, and the named person responsible for privacy.
2. Whether TYMRAK is a service provider to each employer (assumed below) and what the customer agreement says about it.
3. Retention periods that fit employment-records rules in each province (hours, time off, termination).
4. Quebec requirements (Law 25): privacy officer contact, transparency about location data, and consent wording.
5. Breach notification process and contact.
6. Age wording (workers aged 14 to 17).
7. Effective date.

---

# Privacy Policy

**Effective date:** [DATE]
**Operator:** [LEGAL COMPANY NAME] ("TYMRAK", "we", "us")
**Address:** [MAILING ADDRESS]
**Privacy contact:** [NAME / TITLE], [SUPPORT EMAIL]

## 1. What this policy covers

TYMRAK is a time-tracking service for employers and their employees. It includes the website at tymrak.com, the web
portal at app.tymrak.com and the TYMRAK mobile app. This policy explains what personal information we handle, why, who
can see it, and the choices you have.

**Who is in charge of the information.** Your employer (the company that invited you to TYMRAK) decides what employee
information is entered and how it is used for payroll, scheduling and time off. TYMRAK provides the service and handles the
information on the employer's behalf. For questions about your hours, time off or employment, contact your employer.
For questions about how TYMRAK handles information, contact us using the details above.

## 2. What we collect

| What | Examples | Where it comes from |
|---|---|---|
| Account details | Name, email address, username, mobile number (optional) | Your employer when they invite you, and you when you activate your account |
| Sign-in details | Your password (stored only in protected, hashed form), sign-in and session records | You |
| Employment details | Position, department, province of work, hire date, employment status, termination date and reason | Your employer |
| Time records | Clock in and clock out times, the source of each entry, notes added to an entry | You, or a manager correcting a record |
| Location at clock time | Your device's latitude, longitude and accuracy at the moment you tap a clock button, and the name of the workplace it matched | Your device, with your permission |
| Workplace details | Workplace name, address, map position and the allowed distance (geofence) | Your employer's managers |
| Time off | Vacation request dates (full or half days), any note you write, the status, the manager's decision and note, and your balance | You and your manager |
| Timecard approvals | Pay period, approval status, who approved or reopened it and when, and any reason given | Your managers |
| Accounting connection (only if your employer connects QuickBooks Online) | Which QuickBooks company is connected, which QuickBooks employee you were matched to, and which of your approved hours were sent there | Your employer's admin and QuickBooks |
| Account deletion requests | That you asked for deletion, when, and when it was processed | You and your manager |
| Technical records | Basic server logs such as IP address, device and browser type, and error records | Automatically |

We do not collect your location at any other time, and we do not track you in the background.

## 3. Location

When you tap **Clock in** or **Clock out**, TYMRAK asks your device for your precise location once, so your employer can see
that the entry was made at the workplace. Your device asks for your permission first. If you decline, you cannot clock
at a workplace that requires a location check. We store the coordinates with that time entry. We do not use location for
advertising or for any purpose other than verifying clock entries.

## 4. How we use information

- To provide the service: sign-in, clocking, timecards, approvals, time off and balances.
- To let employers and managers run payroll preparation, scheduling and time off.
- To send account emails, such as invitations, activation links and password resets.
- To keep the service secure, prevent misuse and fix problems.
- To meet legal obligations.

We do not sell personal information. We do not show advertising. We do not use third-party analytics or tracking tools in the app.

## 5. Who can see your information

- **Your employer's managers and administrators**, within the employees and workplaces assigned to them. They can see your time
  records, clock locations, time-off requests and balances, and employment details.
- **You**, for your own records.
- **Your employer's accounting software**, only if your employer connects it (section 7). Your approved hours are then sent
  to your employer's own QuickBooks Online company.
- **TYMRAK staff and contractors**, only as needed to run, secure and support the service, under confidentiality duties.
- **Other employers cannot see your information.** Each company's data is kept separate.
- **Legal and safety.** We may disclose information when the law requires it, or to protect rights and safety.

## 6. Service providers

We use these providers to run TYMRAK. They handle information only to provide their service to us:

| Provider | What it does |
|---|---|
| Supabase | Database and sign-in. The TYMRAK database is hosted in Canada. |
| Vercel | Hosts and serves the web app. |
| Resend | Sends account emails (invitations, activation and password reset). |
| Intuit (QuickBooks Online) | Only for employers who connect it: receives approved regular hours to the employer's own QuickBooks company. Intuit's own privacy policy covers information once it is in QuickBooks. |
| OpenStreetMap, Photon (Komoot) and unpkg | Show the map and address search to managers setting up workplaces. Your clock locations are not sent to these services. A manager's address search text and the map area they view are, along with the manager's IP address. |

[REVIEWER: confirm where Vercel and Resend process data and add a cross-border statement if needed.]

## 7. Accounting software (QuickBooks Online)

If your employer chooses to connect QuickBooks Online, an administrator of your employer signs in to Intuit and gives TYMRAK
permission to work with that one QuickBooks company. Then:

- **What TYMRAK reads from QuickBooks:** the company name and the list of active employees (name and email), only so your
  employer can match each TYMRAK employee to the right QuickBooks employee.
- **What TYMRAK sends to QuickBooks:** after a manager approves a timecard, one entry per day with the date and your regular
  hours. Overtime and double time are shown to your employer to enter in payroll themselves. Nothing is sent before approval.
- **What TYMRAK never touches:** bank details, pay rates, paycheques, invoices, customers and any other QuickBooks records.
- **Security:** the sign-in tokens Intuit gives us are stored encrypted and are only used by our servers. Your employer can
  disconnect at any time from TYMRAK or from QuickBooks; we then stop all access and revoke the tokens.
- Once your hours are in QuickBooks, your employer and Intuit's own terms and privacy policy govern them there.

## 8. How long we keep information

TYMRAK does not delete records automatically. Employers decide how long records are kept, and employment-records laws may
require them to keep hours and time-off records for a period. Records are kept until the employer asks us to remove them or
until the account is deleted as described in section 9. [REVIEWER: set retention wording.]

## 9. Deleting your account

You can ask for your account to be deleted from **Delete my account** in the employee pages. A manager processes the request,
and we aim to do so within 30 days. When it is processed, your name becomes "Former Employee", your email and username are
replaced with placeholders, your mobile number is cleared and your sign-in is removed. Your hours stay linked to the placeholder
so your employer's payroll and audit records remain complete. Your position, department, province and hire date are kept
because they are needed to apply overtime and vacation rules. Managers and administrators are removed by another administrator.

## 10. Your choices and rights

You can ask us, through your employer or directly, to:

- see the personal information we hold about you;
- correct information that is wrong (your employer can correct time records);
- delete your account (section 9);
- withdraw location permission in your device settings (you will not be able to clock at a workplace that requires a location check).

Depending on where you live, you may have further rights under federal or provincial privacy law, including the right to
complain to a privacy regulator, such as the Office of the Privacy Commissioner of Canada. [REVIEWER: add provincial wording,
including Quebec.]

## 11. Security

Information travels over encrypted connections. Access is limited by role, and each company's data is kept separate in the
database. We apply updates and review access. No system is perfectly secure, and we will tell affected people and the
employer promptly if a breach puts personal information at risk of significant harm, as the law requires.

## 12. Children

TYMRAK is for working people and the employers who manage them. It is not directed at children. Workers under 18 should use it
only as their employer directs, and we do not knowingly collect information from anyone who is not an employee or manager
of an employer using TYMRAK.

## 13. Changes to this policy

If we make a material change, we will update the effective date and tell account holders, for example by email or inside the app.

## 14. Contact

[LEGAL COMPANY NAME]
[MAILING ADDRESS]
[SUPPORT EMAIL]
