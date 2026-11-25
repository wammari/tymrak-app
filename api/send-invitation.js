import { requireManager } from "./_manager-auth.js";
import { parseRate } from "./_pay-rates.js";
import { todayKey } from "./_pay-schedule.js";
import { addedToBusinessEmail, sendEmail } from "./_email.js";
import { getSiteUrl } from "./_deployment-config.js";
import {
  databaseHeaders, findDuplicate, sendActivationInvite,
  toEmployeeRecord, validateEmployeeInput
} from "./_employee-management.js";

export const validateInvitationInput = validateEmployeeInput;

// The starting hourly rate; true when saved. Never blocks adding the employee.
async function savePayRate(supabaseUrl, secretKey, employeeId, authorization, hourlyRate, hireDate) {
  const saved = await fetch(`${supabaseUrl}/rest/v1/employee_pay_rates`, {
    method: "POST", headers: databaseHeaders(secretKey, "return=minimal"),
    body: JSON.stringify({ employee_id: employeeId, organization_id: authorization.organizationId, hourly_rate: hourlyRate,
      effective_from: hireDate || todayKey(), created_by: authorization.user.id })
  }).catch(() => null);
  return Boolean(saved?.ok);
}

export default async function handler(req, res) {
  let inviteIssued = false;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    if (authorization.role !== 'admin') return res.status(403).json({error:'Ask your company administrator to add and assign employees to a workplace.'});
    const validation = validateEmployeeInput(req.body, { allowAutoUsername: true });
    if (validation.error) return res.status(400).json({ error: validation.error });
    // Optional starting hourly rate (admins only, like this whole endpoint).
    const rateText = typeof req.body?.hourlyRate === "string" ? req.body.hourlyRate.trim() : req.body?.hourlyRate ?? "";
    const hourlyRate = rateText === "" ? null : parseRate(rateText);
    if (rateText !== "" && hourlyRate === null) return res.status(400).json({ error: "Enter an hourly rate between $0.01 and $9,999.99, or leave it empty." });
    const { supabaseUrl, secretKey } = authorization.configuration;
    // An email has one sign-in account. If it already has one (another business, or only
    // invited), inviting again would re-send that account's old invitation. Instead, ask the
    // admin first; once they confirm (addExisting), link the existing account to this
    // business: no new invitation, no new password. Nothing is sent before that.
    const accountLookup = await fetch(`${supabaseUrl}/rest/v1/rpc/auth_account_for_email`, {
      method: "POST", headers: databaseHeaders(secretKey), body: JSON.stringify({ p_email: validation.input.email })
    });
    if (!accountLookup.ok) throw new Error("Email check failed");
    const accountRows = await accountLookup.json();
    const existingAccount = Array.isArray(accountRows) && accountRows[0]?.auth_user_id ? accountRows[0] : null;
    if (existingAccount && req.body?.addExisting !== true) {
      return res.status(409).json({
        code: "email_in_use", canAddExisting: true,
        error: "This email already has a TYMRAK account. If this person also works for another business, you can add them to yours: they'll use the same email and password, and choose which business they're working for. Otherwise, use a different email."
      });
    }
    // No username given: take the company's next one (ICP-1001, ICP-1002, ...).
    if (!validation.input.username) {
      const generated = await fetch(`${supabaseUrl}/rest/v1/rpc/next_employee_username`, {
        method: "POST", headers: databaseHeaders(secretKey), body: JSON.stringify({ p_organization_id: authorization.organizationId })
      });
      const username = generated.ok ? await generated.json().catch(() => null) : null;
      if (typeof username !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error("Username could not be created");
      validation.input.username = username;
    }
    const duplicate = await findDuplicate({
      supabaseUrl, secretKey, organizationId: authorization.organizationId, email: validation.input.email, username: validation.input.username
    });
    if (duplicate) return res.status(409).json({ error: `An employee with this ${duplicate} already exists` });

    // Resolve the company name from the server-authorized organization, never from request body.
    const companyResponse = await fetch(
      `${supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(authorization.organizationId)}&is_active=eq.true&select=id,name`,
      { headers: databaseHeaders(secretKey) }
    );
    if (!companyResponse.ok) throw new Error("Unable to verify invitation company");
    const companies = await companyResponse.json();
    if (!Array.isArray(companies) || companies.length !== 1 ||
        companies[0]?.id !== authorization.organizationId ||
        typeof companies[0]?.name !== "string" || !companies[0].name.trim()) {
      return res.status(403).json({ error: "Active company could not be verified" });
    }
    if (existingAccount) {
      const linked = await fetch(
        `${supabaseUrl}/rest/v1/employees?organization_id=eq.${authorization.organizationId}&auth_user_id=eq.${encodeURIComponent(existingAccount.auth_user_id)}&select=id&limit=1`,
        { headers: databaseHeaders(secretKey) });
      if (!linked.ok) throw new Error("Existing employee check failed");
      if ((await linked.json()).length) return res.status(409).json({ error: "This person is already an employee of this business." });
      const now = new Date().toISOString();
      const saved = await fetch(`${supabaseUrl}/rest/v1/employees`, {
        method: "POST", headers: databaseHeaders(secretKey, "return=representation"),
        body: JSON.stringify({
          ...toEmployeeRecord(validation.input), organization_id: authorization.organizationId, auth_user_id: existingAccount.auth_user_id,
          invited_at: now,
          ...(existingAccount.activated ? { invitation_status: "Account Activated", activated_at: now } : { invitation_status: "Invitation Sent" })
        })
      });
      if (!saved.ok) {
        const details = await saved.json().catch(() => ({}));
        if (details?.code === "23505") {
          const clash = String(details.message || "");
          if (/username/.test(clash)) return res.status(409).json({ error: "An employee with this username already exists" });
          if (/company_email|auth_user_company/.test(clash)) return res.status(409).json({ error: "This person is already an employee of this business." });
          return res.status(409).json({ error: "This employee could not be added because some details are already in use. Please check the email and username." });
        }
        throw new Error("Linked employee could not be saved");
      }
      const [record] = await saved.json();
      const rateSaved = hourlyRate === null || await savePayRate(supabaseUrl, secretKey, record.id, authorization, hourlyRate, validation.input.hireDate);
      const mail = addedToBusinessEmail({ firstName: validation.input.firstName, companyName: companies[0].name, siteUrl: getSiteUrl(), activated: Boolean(existingAccount.activated) });
      const emailed = (await sendEmail({ to: validation.input.email, ...mail })).sent;
      return res.status(201).json({
        success: true, linkedExistingAccount: true, employee: record,
        message: `Employee added with username ${record.username}. They already had a TYMRAK account, so no new invitation was needed` +
          (emailed ? "; we emailed them that they've been added." : ". Let them know they've been added: they sign in with their usual email and password.") +
          (rateSaved ? "" : " The hourly rate couldn't be saved: set it on their timecard.")
      });
    }
    const invite = await sendActivationInvite(authorization.configuration, validation.input, companies[0].name);
    inviteIssued = true;
    const employee = {
      ...toEmployeeRecord(validation.input),
      organization_id: authorization.organizationId,
      auth_user_id: invite.id,
      invitation_status: "Invitation Sent",
      invited_at: new Date().toISOString()
    };
    const response = await fetch(`${supabaseUrl}/rest/v1/employees`, {
      method: "POST",
      headers: databaseHeaders(secretKey, "return=representation"),
      body: JSON.stringify(employee)
    });
    if (!response.ok) throw new Error("Employee record could not be saved after invitation");
    const records = await response.json();
    if (!Array.isArray(records) || records.length !== 1 || !records[0]?.id ||
        records[0].auth_user_id !== invite.id) {
      throw new Error("Invited employee record was not saved with the expected identity");
    }
    const rateSaved = hourlyRate === null || await savePayRate(supabaseUrl, secretKey, records[0].id, authorization, hourlyRate, validation.input.hireDate);
    return res.status(201).json({
      success: true,
      message: `Employee added with username ${records[0].username} and activation invitation sent successfully` +
        (rateSaved ? "" : ". The hourly rate couldn't be saved: set it on their timecard."),
      employee: records[0]
    });
  } catch (error) {
    console.error("TYMRAK invitation operation failed", { errorName: error?.name || "Error", inviteIssued });
    if (inviteIssued) {
      return res.status(500).json({
        error: "An invitation may have been sent, but the employee profile could not be verified. Do not retry or resend. Contact your administrator to reconcile the invitation and account link."
      });
    }
    return res.status(error?.status >= 400 && error.status < 500 ? error.status : 500)
      .json({ error: error?.status ? error.message : "Unable to add employee" });
  }
}
