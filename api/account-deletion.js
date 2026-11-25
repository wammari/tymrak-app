import { CHOOSE_BUSINESS_MESSAGE, chosenEmployeeId } from "./_chosen-employee.js";
import { getBearerToken, getSupabaseConfiguration } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";

// Employee-facing: ask for the account to be deleted, see the status, or cancel the request.
// A manager or admin then processes it (api/employees.js, action "delete_account").
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const REAUTH_WINDOW_SECONDS = 10 * 60;

// The token was already verified by Supabase before this is called, so only its issue time is read.
export function tokenIssuedAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Number.isFinite(payload?.iat) ? payload.iat : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const config = getSupabaseConfiguration();
  if (!config) return res.status(503).json({ error: "TYMRAK configuration unavailable" });
  const { supabaseUrl, secretKey } = config;
  const headers = databaseHeaders(secretKey);
  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: secretKey, Authorization: `Bearer ${token}` } });
    if (!userResponse.ok) {
      if (userResponse.status >= 500) throw new Error("Auth unavailable");
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }
    const user = await userResponse.json();
    if (!uuid(user?.id)) return res.status(401).json({ error: "Invalid session" });

    const rolesResponse = await fetch(`${supabaseUrl}/rest/v1/user_roles?auth_user_id=eq.${user.id}&select=role&limit=1`, { headers });
    if (!rolesResponse.ok) throw new Error("Role lookup failed");
    if ((await rolesResponse.json()).length) {
      return res.status(403).json({ error: "Manager and admin accounts must ask another admin to remove their access." });
    }
    const employeeResponse = await fetch(`${supabaseUrl}/rest/v1/employees?auth_user_id=eq.${user.id}&select=id,organization_id`, { headers });
    if (!employeeResponse.ok) throw new Error("Employee lookup failed");
    const all = await employeeResponse.json();
    // People who work for several businesses ask for deletion at the business they chose.
    const employeeId = chosenEmployeeId(req);
    if (employeeId === null) return res.status(400).json({ error: "Invalid business choice" });
    const employees = employeeId ? all.filter(row => row.id === employeeId) : all;
    if (employees.length > 1) return res.status(409).json({ error: CHOOSE_BUSINESS_MESSAGE, code: "choose_business" });
    if (employees.length !== 1) return res.status(404).json({ error: "Employee account not found" });
    const employee = employees[0];

    const openRequest = async () => {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/account_deletion_requests?employee_id=eq.${employee.id}&status=in.(Pending,Anonymized)&select=id,status,requested_at&limit=1`, { headers });
      if (!response.ok) throw new Error("Deletion request lookup failed");
      return (await response.json())[0] || null;
    };

    if (req.method === "GET") {
      const current = await openRequest();
      return res.status(200).json({ request: current && { status: current.status, requestedAt: current.requested_at } });
    }

    if (req.method === "DELETE") {
      const cancelled = await fetch(
        `${supabaseUrl}/rest/v1/account_deletion_requests?employee_id=eq.${employee.id}&status=eq.Pending`,
        { method: "PATCH", headers: databaseHeaders(secretKey, "return=representation"), body: JSON.stringify({ status: "Cancelled" }) });
      if (!cancelled.ok) throw new Error("Deletion request cancel failed");
      return res.status(200).json({ success: true, request: null });
    }

    // POST: the person must have signed in again very recently (their password is the confirmation).
    const issuedAt = tokenIssuedAt(token);
    if (issuedAt === null || Date.now() / 1000 - issuedAt > REAUTH_WINDOW_SECONDS) {
      return res.status(401).json({ error: "Please confirm your password to continue.", code: "reauth_required" });
    }
    const existing = await openRequest();
    if (existing) return res.status(200).json({ success: true, request: { status: existing.status, requestedAt: existing.requested_at } });
    const created = await fetch(`${supabaseUrl}/rest/v1/account_deletion_requests`, {
      method: "POST", headers: databaseHeaders(secretKey, "return=representation"),
      body: JSON.stringify({ organization_id: employee.organization_id, employee_id: employee.id, auth_user_id: user.id, requested_by: "employee" })
    });
    if (!created.ok) {
      const details = await created.json().catch(() => ({}));
      if (details?.code === "23505") {
        const raced = await openRequest();
        if (raced) return res.status(200).json({ success: true, request: { status: raced.status, requestedAt: raced.requested_at } });
      }
      throw new Error("Deletion request failed");
    }
    const [row] = await created.json();
    return res.status(201).json({ success: true, request: { status: row.status, requestedAt: row.requested_at } });
  } catch {
    return res.status(503).json({ error: "Unable to process your request right now. Please try again." });
  }
}
