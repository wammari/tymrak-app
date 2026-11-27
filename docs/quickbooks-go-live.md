# QuickBooks Online: going live with real customers

Status on 20 November 2026: the integration works end to end on production with the **sandbox** (test) company:
connect, payroll question, matching, sending approved regular hours, and locking sent timecards. Real customers need the
**production** keys, which Intuit unlocks after the checklist below.

## 1. Before Intuit's checklist (owner)

1. **Publish a privacy policy and terms of use** at public addresses, for example:
   - `https://tymrak.com/privacy`
   - `https://tymrak.com/terms`

   Drafts are in `docs/legal-drafts/` and need the legal company name, address, contact and a lawyer's review first.
2. Support email for Intuit and customers: `info@tymrak.com` (shown in every page's footer and set as the reply-to address on emails).

## 2. Intuit production checklist (developer.intuit.com, Tymrak app, Keys & credentials, Production)

### App details

| Intuit asks for | Answer |
|---|---|
| Verify your developer profile and email | Done in the Intuit account. |
| End-user license agreement URL | `https://tymrak.com/terms`, once published |
| Privacy policy URL | `https://tymrak.com/privacy`, once published |
| Host domain | `app.tymrak.com` |
| Launch URL | `https://app.tymrak.com/manager-login.html` |
| Connect/Reconnect URL | `https://app.tymrak.com/quickbooks.html` |
| Disconnect URL | `https://app.tymrak.com/quickbooks.html`. After a disconnect on Intuit's side, this page shows that QuickBooks must be reconnected. |
| Category | Time tracking (and Payroll, if offered) |
| Regulated industries | None. Tymrak stores hours and employment details only, with no health, financial account or card data. Confirm if a customer is in a regulated field. |

### Compliance questions (typical; answer truthfully as they appear)

- **QuickBooks data stored:**
  - the company name and realm ID
  - the encrypted OAuth tokens (AES-256-GCM)
  - for each matched employee, the QuickBooks employee ID and name
  - the IDs of time entries created

  Nothing else.
- **Scopes:** `com.intuit.quickbooks.accounting` only.
- **What Tymrak writes:** TimeActivity records (non-billable regular hours), only after a manager approves a timecard.
- **Where data is stored:** Supabase (Canada, ca-central-1); app served by Vercel.
- **Security:**
  - HTTPS only
  - tokens encrypted at rest with a key held only in server settings
  - row-level security, with the accounting tables readable only by the server
  - admin-only access to the connection
  - signed, 10-minute OAuth state tied to the admin and company
  - tokens revoked on disconnect
- **Multi-factor sign-in for staff accounts** (Intuit, Vercel, Supabase, GitHub): turn it on if it isn't already.

## 3. Switch to production (after Intuit approves)

1. In Intuit, Production tab: add the redirect URI `https://app.tymrak.com/quickbooks.html`.
2. In Vercel (tymrak, Production), replace:
   - `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET` with the **production** keys
   - `QUICKBOOKS_ENVIRONMENT` with `production`

   Keep `QUICKBOOKS_TOKEN_KEY` as it is.
3. Redeploy.
4. Disconnect QB testing (sandbox). Sandbox connections don't work with production keys.
5. In the Development settings, remove the Playground redirect URI (`https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`).
6. First real customer: connect, answer the payroll question, match, and send one pay period together. Check the
   entries in their QuickBooks before they run payroll.

## 4. Open decision: overtime in QuickBooks payroll

Tymrak sends **regular hours only** and lists overtime and double time for the admin to enter in QuickBooks payroll.
The Canadian sandbox has no payroll, so we couldn't test whether QuickBooks Online Payroll (Canada) can receive overtime
as a separate pay type from time entries. Check with the first customer who runs payroll in QuickBooks:

- If QuickBooks only ever treats time entries as regular hours, keep the current approach.
- If it can take overtime (for example, through a separate service item or pay type), add an option to send overtime too.

## 5. Test data cleanup (whenever)

The production company **QB testing** holds the sandbox test:
- two employees
- 20 punches with the note "QuickBooks sandbox test" (Nov 2–6, 2026)
- two approved and sent timecards for Nov 1–14

Those two timecards are locked by design. The simplest cleanup is to delete the whole QB testing company once it's no
longer useful.
