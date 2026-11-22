import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { parseRate } from "./_pay-rates.js";
import { isDateKey } from "../pay-periods.js";

// An employee's hourly rate history (company admins only).
//   GET  ?employeeId=          -> { rates: [{ hourlyRate, effectiveFrom, createdAt }] } (newest first)
//   POST { action: "set", employeeId, hourlyRate, effectiveFrom }  -> add (or correct) the rate starting that day
//   POST { action: "delete", employeeId, effectiveFrom }           -> remove a rate entered by mistake

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function db(auth, path, { method = "GET", body, prefer } = {}) {
  const { supabaseUrl, secretKey } = auth.configuration;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method, headers: databaseHeaders(secretKey, prefer), ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) {
    const error = new Error(`Pay rate query failed (${path.split("?")[0]})`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

async function companyEmployee(auth, employeeId) {
  if (!UUID.test(String(employeeId || ""))) return null;
  const rows = await db(auth, `employees?id=eq.${employeeId}&organization_id=eq.${auth.organizationId}&select=id&limit=1`);
  return rows?.[0] || null;
}

async function history(auth, employeeId) {
  const rows = await db(auth, `employee_pay_rates?employee_id=eq.${employeeId}&organization_id=eq.${auth.organizationId}&select=hourly_rate,effective_from,created_at&order=effective_from.desc`);
  return rows.map(row => ({ hourlyRate: Number(row.hourly_rate), effectiveFrom: row.effective_from, createdAt: row.created_at }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const auth = await requireManager(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (auth.role !== "admin") return res.status(403).json({ error: "Only this business's admins can see or change pay rates." });
    const employeeId = req.method === "GET" ? (Array.isArray(req.query?.employeeId) ? req.query.employeeId[0] : req.query?.employeeId) : req.body?.employeeId;
    if (!(await companyEmployee(auth, employeeId))) return res.status(404).json({ error: "Employee not found." });
    if (req.method === "GET") return res.status(200).json({ rates: await history(auth, employeeId) });

    const action = req.body?.action;
    const effectiveFrom = req.body?.effectiveFrom;
    if (!isDateKey(effectiveFrom) || effectiveFrom < "2000-01-01") return res.status(400).json({ error: "Choose the date the rate starts." });
    if (action === "set") {
      const hourlyRate = parseRate(req.body?.hourlyRate);
      if (hourlyRate === null) return res.status(400).json({ error: "Enter an hourly rate between $0.01 and $9,999.99." });
      await db(auth, "employee_pay_rates?on_conflict=employee_id,effective_from", {
        method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
        body: { employee_id: employeeId, organization_id: auth.organizationId, hourly_rate: hourlyRate, effective_from: effectiveFrom, created_by: auth.user.id, created_at: new Date().toISOString() }
      });
      return res.status(200).json({ success: true, rates: await history(auth, employeeId) });
    }
    if (action === "delete") {
      await db(auth, `employee_pay_rates?employee_id=eq.${employeeId}&organization_id=eq.${auth.organizationId}&effective_from=eq.${effectiveFrom}`, { method: "DELETE", prefer: "return=minimal" });
      return res.status(200).json({ success: true, rates: await history(auth, employeeId) });
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (error) {
    console.error("Pay rate request failed", { errorName: error?.name || "Error", status: error?.httpStatus || null });
    return res.status(500).json({ error: "Pay rates are unavailable right now. Please try again." });
  }
}
