import { getBearerToken, getSupabaseConfiguration } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const configuration = getSupabaseConfiguration();
  const designatedId = process.env.TYMRAK_MAIN_ADMIN_AUTH_USER_ID;
  const token = getBearerToken(req);
  if (!configuration || !UUID.test(designatedId || "")) {
    return res.status(503).json({ error: "Main Administrator provisioning is not configured" });
  }
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const { supabaseUrl, secretKey, publishableKey } = configuration;
  const identity = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${token}` }
  });
  if (!identity.ok) return res.status(401).json({ error: "Invalid or expired session" });
  const user = await identity.json();
  if (user.id !== designatedId) return res.status(403).json({ error: "Main Administrator access required" });

  const headers = databaseHeaders(secretKey);
  const memberships = await fetch(
    `${supabaseUrl}/rest/v1/user_roles?auth_user_id=eq.${encodeURIComponent(user.id)}&role=eq.admin&select=organization_id&limit=1`,
    { headers }
  );
  if (!memberships.ok) return res.status(502).json({ error: "Administrator verification unavailable" });
  const assigned = await memberships.json();
  if (!Array.isArray(assigned) || !assigned.length) return res.status(403).json({ error: "Administrator membership required" });
  const activeMembership = await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(assigned[0].organization_id)}&is_active=eq.true&select=id&limit=1`, { headers });
  if (!activeMembership.ok) return res.status(502).json({ error: "Administrator membership verification unavailable" });
  if (!(await activeMembership.json()).length) return res.status(403).json({ error: "Active administrator membership required" });

  if (req.method === "GET") {
    const response = await fetch(`${supabaseUrl}/rest/v1/organizations?select=id,name,is_active,created_at&order=name.asc`, { headers });
    if (!response.ok) return res.status(502).json({ error: "Unable to list companies" });
    return res.status(200).json({ companies: await response.json() });
  }

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 2 || name.length > 150) return res.status(400).json({ error: "Company name must be 2–150 characters" });
  const duplicate = await fetch(
    `${supabaseUrl}/rest/v1/organizations?select=id&name=ilike.${encodeURIComponent(name)}&limit=1`,
    { headers }
  );
  if (!duplicate.ok) return res.status(502).json({ error: "Unable to verify company name" });
  if ((await duplicate.json()).length) return res.status(409).json({ error: "A company with this name already exists" });

  const created = await fetch(`${supabaseUrl}/rest/v1/organizations`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ name, is_active: true })
  });
  if (!created.ok) return res.status(502).json({ error: "Unable to create company" });
  const [company] = await created.json();
  if (!UUID.test(company?.id || "")) return res.status(502).json({ error: "Invalid company creation response" });

  const assignedRole = await fetch(`${supabaseUrl}/rest/v1/user_roles`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ auth_user_id: user.id, organization_id: company.id, role: "admin" })
  });
  if (!assignedRole.ok) {
    console.error("Company created without administrator membership; manual reconciliation required", { companyId: company.id });
    return res.status(502).json({ error: "Company created but administrator assignment needs review. Do not retry; contact support.", companyId: company.id });
  }
  return res.status(201).json({ company });
}
