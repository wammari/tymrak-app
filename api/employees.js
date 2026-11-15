import { anonymizeAndDeleteAccount } from "./_account-deletion.js";
import { requireManager } from "./_manager-auth.js";
import { databaseRows } from "./_database-pages.js";
import {canManageEmployee, employeeScopeFilter} from './_manager-scope.js';
import {
  EMPLOYEE_SELECT, databaseHeaders, findDuplicate,
  reactivationRecord, terminationRecord, toEmployeeRecord, validateEmployeeInput, validateTerminationInput
} from "./_employee-management.js";

function employeeId(req) {
  const value = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : null;
}

export default async function handler(req, res) {
  if (!new Set(["GET", "PATCH"]).has(req.method)) {
    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    const { supabaseUrl, secretKey } = authorization.configuration;

    if (req.method === "GET") {
      const employees = await databaseRows(
        `${supabaseUrl}/rest/v1/employees?organization_id=eq.${authorization.organizationId}${employeeScopeFilter(authorization)}&select=${EMPLOYEE_SELECT}&order=last_name.asc,first_name.asc,id.asc`,
        databaseHeaders(secretKey)
      );
      if (!Array.isArray(employees)) throw new Error("Employee list returned invalid data");
      // Show which employees have asked for their account to be deleted.
      let requests = [];
      try {
        requests = await databaseRows(
          `${supabaseUrl}/rest/v1/account_deletion_requests?organization_id=eq.${authorization.organizationId}&status=in.(Pending,Anonymized)&select=employee_id,requested_at,status`,
          databaseHeaders(secretKey)
        );
      } catch (error) {
        // Optional extra: never let it break the employee list (e.g. migration not applied yet).
        console.error("Deletion request lookup failed", { message: error?.message });
      }
      const open = new Map((Array.isArray(requests) ? requests : []).map(request => [request.employee_id, request]));
      for (const employee of employees) {
        const request = open.get(employee.id);
        employee.deletion_requested_at = request?.requested_at ?? null;
        employee.deletion_status = request?.status ?? null;
      }
      return res.status(200).json({ employees });
    }

    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: "A valid employee ID is required" });
    if (!canManageEmployee(authorization, id)) return res.status(404).json({error:'Employee not found'});
    const action = req.body?.action;
    if (action === "delete_account") {
      // Irreversible: personal details are removed, hours are kept. Requires explicit confirmation.
      if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirmation is required to delete this account" });
      const outcome = await anonymizeAndDeleteAccount(authorization.configuration,
        { organizationId: authorization.organizationId, employeeId: id, processedBy: authorization.user.id });
      if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) });
      return res.status(200).json({ success: true, message: "Personal details removed and sign-in account deleted. Their timecard history was kept." });
    }
    if (action === "terminate" || action === "reactivate") {
      let record;
      if (action === "terminate") {
        const termination = validateTerminationInput(req.body);
        if (termination.error) return res.status(400).json({ error: termination.error });
        record = terminationRecord(termination);
      } else {
        record = reactivationRecord();
      }
      const changed = await fetch(
        `${supabaseUrl}/rest/v1/employees?id=eq.${encodeURIComponent(id)}&organization_id=eq.${authorization.organizationId}&select=${EMPLOYEE_SELECT}`,
        { method: "PATCH", headers: databaseHeaders(secretKey, "return=representation"), body: JSON.stringify(record) }
      );
      if (!changed.ok) throw new Error("Employee status update failed");
      const rows = await changed.json();
      if (!Array.isArray(rows) || rows.length !== 1) {
        return res.status(rows?.length ? 409 : 404).json({ error: "Employee record was not found or was not unique" });
      }
      return res.status(200).json({
        success: true, employee: rows[0],
        message: action === "terminate" ? "Employee terminated. They can no longer clock in but can view past timecards." : "Employee reactivated."
      });
    }
    const validation = validateEmployeeInput(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const duplicate = await findDuplicate({
      supabaseUrl, secretKey, organizationId: authorization.organizationId, scopeFilter: employeeScopeFilter(authorization), email: validation.input.email,
      username: validation.input.username, excludeId: id
    });
    if (duplicate) return res.status(409).json({ error: `An employee with this ${duplicate} already exists` });

    const response = await fetch(
      `${supabaseUrl}/rest/v1/employees?id=eq.${encodeURIComponent(id)}&organization_id=eq.${authorization.organizationId}&select=${EMPLOYEE_SELECT}`,
      {
        method: "PATCH",
        headers: databaseHeaders(secretKey, "return=representation"),
        body: JSON.stringify(toEmployeeRecord(validation.input))
      }
    );
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      if (details?.code === "23514") {
        return res.status(409).json({ error: "This employee is terminated. Use Reactivate to restore their access." });
      }
      throw new Error("Employee update failed");
    }
    const records = await response.json();
    if (!Array.isArray(records) || records.length !== 1) {
      return res.status(records?.length ? 409 : 404).json({ error: "Employee record was not found or was not unique" });
    }
    return res.status(200).json({ success: true, message: "Employee updated successfully", employee: records[0] });
  } catch (error) {
    console.error("Employee management operation failed", { errorName: error?.name || "Error" });
    return res.status(500).json({ error: "Unable to complete employee operation" });
  }
}
