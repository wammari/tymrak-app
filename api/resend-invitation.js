import { requireManager } from "./_manager-auth.js";
import {
  databaseHeaders, EMPLOYEE_SELECT, sendActivationInvite
} from "./_employee-management.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    const id = typeof req.body?.id === "string" && /^[A-Za-z0-9-]{1,128}$/.test(req.body.id)
      ? req.body.id : null;
    if (!id) return res.status(400).json({ error: "A valid employee ID is required" });
    const { supabaseUrl, secretKey } = authorization.configuration;
    const lookup = await fetch(
      `${supabaseUrl}/rest/v1/employees?id=eq.${encodeURIComponent(id)}&select=${EMPLOYEE_SELECT},auth_user_id&limit=2`,
      { headers: databaseHeaders(secretKey) }
    );
    if (!lookup.ok) throw new Error("Employee lookup failed");
    const records = await lookup.json();
    if (!Array.isArray(records) || records.length !== 1) {
      return res.status(records?.length ? 409 : 404).json({ error: "Employee record was not found or was not unique" });
    }
    const employee = records[0];
    if (employee.invitation_status === "Account Activated" || employee.activated_at) {
      return res.status(409).json({ error: "Activated employees cannot be sent another activation invitation" });
    }
    await sendActivationInvite(authorization.configuration, {
      email: employee.email, firstName: employee.first_name,
      lastName: employee.last_name, username: employee.username
    });
    const update = await fetch(
      `${supabaseUrl}/rest/v1/employees?id=eq.${encodeURIComponent(id)}&select=${EMPLOYEE_SELECT}`,
      {
        method: "PATCH",
        headers: databaseHeaders(secretKey, "return=representation"),
        body: JSON.stringify({ invitation_status: "Invitation Sent", invited_at: new Date().toISOString() })
      }
    );
    if (!update.ok) throw new Error("Invitation status update failed");
    const updated = await update.json();
    if (!Array.isArray(updated) || updated.length !== 1) throw new Error("Invitation status update was not unique");
    return res.status(200).json({ success: true, message: "Activation invitation resent successfully", employee: updated[0] });
  } catch (error) {
    console.error("Invitation resend failed", { errorName: error?.name || "Error" });
    return res.status(error?.status >= 400 && error.status < 500 ? error.status : 500)
      .json({ error: error?.status ? error.message : "Unable to resend invitation" });
  }
}
