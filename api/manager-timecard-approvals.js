import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { PROVINCE_TIME_ZONES, getPayPeriodDateKeys, periodFromKey } from "./_manager-timecards.js";

const ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

async function readArray(response, message) {
  if (!response.ok) throw new Error(message);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error(`${message}: invalid response`);
  return value;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    const employeeIds = [...new Set(Array.isArray(req.body?.employeeIds) ? req.body.employeeIds : [])]
      .filter(id => typeof id === "string" && ID_PATTERN.test(id));
    if (!employeeIds.length) return res.status(400).json({ error: "Select at least one employee to approve" });
    const period = periodFromKey(req.body?.period, new Date(), "America/Toronto");
    if (!period) return res.status(400).json({ error: "Select a valid current or previous pay period" });
    const { startKey, endKey } = getPayPeriodDateKeys(period);
    const { supabaseUrl, secretKey } = authorization.configuration;
    const ids = `(${employeeIds.map(id => `"${id}"`).join(",")})`;
    const employees = await readArray(await fetch(
      `${supabaseUrl}/rest/v1/employees?id=in.${encodeURIComponent(ids)}&is_active=eq.true&select=id,province`,
      { headers: databaseHeaders(secretKey) }
    ), "Approval employee validation failed");
    if (employees.length !== employeeIds.length) {
      return res.status(400).json({ error: "One or more selected employees are invalid or inactive" });
    }
    const now = new Date().toISOString();
    const employeesById = new Map(employees.map(employee => [employee.id, employee]));
    const existing = await readArray(await fetch(
      `${supabaseUrl}/rest/v1/timecard_approvals?employee_id=in.${encodeURIComponent(ids)}&period_start=eq.${startKey}&period_end=eq.${endKey}&select=id,employee_id,status`,
      { headers: databaseHeaders(secretKey) }
    ), "Existing timecard approval lookup failed");
    const existingByEmployee = new Map(existing.map(approval => [approval.employee_id, approval]));
    const records = employeeIds.filter(employeeId => !existingByEmployee.has(employeeId)).map(employeeId => ({
      employee_id: employeeId, period_start: startKey, period_end: endKey,
      work_timezone: PROVINCE_TIME_ZONES[employeesById.get(employeeId)?.province] || "America/Toronto",
      status: "approved", approved_by: authorization.user.id,
      approved_at: now, updated_at: now
    }));
    if (records.length) {
      const insert = await fetch(`${supabaseUrl}/rest/v1/timecard_approvals?on_conflict=employee_id,period_start,period_end`, {
          method: "POST", headers: databaseHeaders(secretKey, "resolution=ignore-duplicates,return=minimal"), body: JSON.stringify(records)
        });
      if (!insert.ok) throw new Error("Timecard approval insert failed");
    }
    for (const employeeId of employeeIds.filter(id => existingByEmployee.get(id)?.status === "reopened")) {
      const updated = await readArray(await fetch(
        `${supabaseUrl}/rest/v1/timecard_approvals?employee_id=eq.${encodeURIComponent(employeeId)}&period_start=eq.${startKey}&period_end=eq.${endKey}&status=eq.reopened`,
        { method: "PATCH", headers: databaseHeaders(secretKey, "return=representation"), body: JSON.stringify({
          status: "approved", approved_by: authorization.user.id, approved_at: now, updated_at: now,
          reopened_by: null, reopened_at: null, reopen_reason: null
        }) }
      ), "Timecard re-approval update failed");
      if (!updated.length) return res.status(409).json({ error: "Timecard approval changed; refresh and try again" });
    }
    const approvals = await readArray(await fetch(
      `${supabaseUrl}/rest/v1/timecard_approvals?employee_id=in.${encodeURIComponent(ids)}&period_start=eq.${startKey}&period_end=eq.${endKey}&select=id,employee_id,status,approved_by,approved_at,period_start,period_end,work_timezone`,
      { headers: databaseHeaders(secretKey) }
    ), "Approved timecard reload failed");
    if (approvals.length !== employeeIds.length || approvals.some(approval => approval.status !== "approved")) {
      throw new Error("Not all selected timecards were approved");
    }
    return res.status(200).json({ message: `${approvals.length} timecard${approvals.length === 1 ? "" : "s"} approved`, approvals });
  } catch (error) {
    console.error("Manager timecard approval failed", { errorName: error?.name || "Error", message: error?.message || null });
    return res.status(500).json({ error: "Unable to approve selected timecards" });
  }
}
