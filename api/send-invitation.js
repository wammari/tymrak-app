import { requireManager } from "./_manager-auth.js";
import {
  databaseHeaders, findDuplicate, sendActivationInvite,
  toEmployeeRecord, validateEmployeeInput
} from "./_employee-management.js";

export const validateInvitationInput = validateEmployeeInput;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    const validation = validateEmployeeInput(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { supabaseUrl, secretKey } = authorization.configuration;
    const duplicate = await findDuplicate({
      supabaseUrl, secretKey, email: validation.input.email, username: validation.input.username
    });
    if (duplicate) return res.status(409).json({ error: `An employee with this ${duplicate} already exists` });

    const invite = await sendActivationInvite(authorization.configuration, validation.input);
    const employee = {
      ...toEmployeeRecord(validation.input),
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
    return res.status(201).json({
      success: true,
      message: "Employee added and activation invitation sent successfully",
      employee: records?.[0] || null
    });
  } catch (error) {
    console.error("TYMRAK invitation operation failed", { errorName: error?.name || "Error" });
    return res.status(error?.status >= 400 && error.status < 500 ? error.status : 500)
      .json({ error: error?.status ? error.message : "Unable to add employee" });
  }
}
