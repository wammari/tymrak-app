import { requireManager } from "./_manager-auth.js";
import {
  EMPLOYEE_SELECT, databaseHeaders, findDuplicate,
  toEmployeeRecord, validateEmployeeInput
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
      const response = await fetch(
        `${supabaseUrl}/rest/v1/employees?select=${EMPLOYEE_SELECT}&order=last_name.asc,first_name.asc`,
        { headers: databaseHeaders(secretKey) }
      );
      if (!response.ok) throw new Error("Employee list query failed");
      const employees = await response.json();
      if (!Array.isArray(employees)) throw new Error("Employee list returned invalid data");
      return res.status(200).json({ employees });
    }

    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: "A valid employee ID is required" });
    const validation = validateEmployeeInput(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const duplicate = await findDuplicate({
      supabaseUrl, secretKey, email: validation.input.email,
      username: validation.input.username, excludeId: id
    });
    if (duplicate) return res.status(409).json({ error: `An employee with this ${duplicate} already exists` });

    const response = await fetch(
      `${supabaseUrl}/rest/v1/employees?id=eq.${encodeURIComponent(id)}&select=${EMPLOYEE_SELECT}`,
      {
        method: "PATCH",
        headers: databaseHeaders(secretKey, "return=representation"),
        body: JSON.stringify(toEmployeeRecord(validation.input))
      }
    );
    if (!response.ok) throw new Error("Employee update failed");
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
