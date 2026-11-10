import { requireManager } from "./_manager-auth.js";
import {
  databaseHeaders, findDuplicate, sendActivationInvite,
  toEmployeeRecord, validateEmployeeInput
} from "./_employee-management.js";

export const validateInvitationInput = validateEmployeeInput;

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
    const validation = validateEmployeeInput(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { supabaseUrl, secretKey } = authorization.configuration;
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
    return res.status(201).json({
      success: true,
      message: "Employee added and activation invitation sent successfully",
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
