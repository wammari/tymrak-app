import { databaseHeaders } from "./_employee-management.js";

// Deleting a person's account removes their personal details but keeps the hours they worked:
// the database anonymizes the employee row (see 202611140002_account_deletion.sql), then the
// sign-in account is deleted here. Safe to retry: a repeat only re-attempts the sign-in deletion.
export async function anonymizeAndDeleteAccount(configuration, { organizationId, employeeId, processedBy }) {
  const { supabaseUrl, secretKey } = configuration;
  const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/anonymize_employee_account`, {
    method: "POST", headers: databaseHeaders(secretKey),
    body: JSON.stringify({ p_organization_id: organizationId, p_employee_id: employeeId, p_processed_by: processedBy })
  });
  if (!rpc.ok) throw new Error("Account anonymization failed");
  const result = await rpc.json();
  if (result?.error) {
    const messages = {
      employee_not_found: [404, "Employee not found"],
      not_terminated: [409, "Terminate this employee first, or wait for their own deletion request."],
      manager_account: [409, "Manager and admin accounts cannot be deleted here. Remove their access first."]
    };
    const [status, error] = messages[result.error] || [409, "This account cannot be deleted"];
    return { ok: false, status, error };
  }
  if (!result?.requestId) throw new Error("Account anonymization returned invalid data");

  if (result.authUserId) {
    const removal = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(result.authUserId)}`, {
      method: "DELETE", headers: databaseHeaders(secretKey)
    }).catch(() => null);
    if (!removal || (!removal.ok && removal.status !== 404)) {
      return {
        ok: false, status: 502, code: "auth_pending",
        error: "Personal details were removed, but the sign-in account could not be deleted yet. Press Delete personal data again to retry."
      };
    }
  }
  const complete = await fetch(`${supabaseUrl}/rest/v1/rpc/complete_account_deletion`, {
    method: "POST", headers: databaseHeaders(secretKey), body: JSON.stringify({ p_request_id: result.requestId })
  });
  if (!complete.ok) throw new Error("Account deletion could not be marked complete");
  return { ok: true };
}
