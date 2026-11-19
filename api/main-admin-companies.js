import { getBearerToken, getSupabaseConfiguration } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { normalizePaySchedule } from "../pay-periods.js";

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
    const response = await fetch(`${supabaseUrl}/rest/v1/organizations?select=id,name,is_active,created_at,pay_frequency,pay_period_anchor&order=name.asc`, { headers });
    if (!response.ok) return res.status(502).json({ error: "Unable to list companies" });
    return res.status(200).json({ companies: await response.json() });
  }

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 2 || name.length > 150) return res.status(400).json({ error: "Company name must be 2–150 characters" });
  // The pay schedule is chosen once, here, and is locked in the database afterwards.
  if (typeof req.body?.payFrequency !== "string" || !req.body.payFrequency) return res.status(400).json({ error: "Choose a pay schedule" });
  let schedule;
  try {
    schedule = normalizePaySchedule({ frequency: req.body.payFrequency, anchorDate: req.body.payPeriodAnchor || null });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const duplicate = await fetch(
    `${supabaseUrl}/rest/v1/organizations?select=id&name=ilike.${encodeURIComponent(name)}&limit=1`,
    { headers }
  );
  if (!duplicate.ok) return res.status(502).json({ error: "Unable to verify company name" });
  if ((await duplicate.json()).length) return res.status(409).json({ error: "A company with this name already exists" });

  // The company and its first administrator (the Main Administrator) are saved in one
  // database transaction, so a company can never be left without an administrator.
  const created = await fetch(`${supabaseUrl}/rest/v1/rpc/create_company_with_admin`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_name: name, p_pay_frequency: schedule.frequency,
      p_pay_period_anchor: schedule.anchorDate, p_admin_user_id: user.id
    })
  });
  if (!created.ok) {
    console.error("Company creation failed; nothing was saved", { status: created.status });
    return res.status(502).json({ error: "Unable to create company. Nothing was saved, so you can try again." });
  }
  const rows = await created.json();
  const company = Array.isArray(rows) ? rows[0] : rows;
  if (!UUID.test(company?.id || "")) return res.status(502).json({ error: "Invalid company creation response" });
  return res.status(201).json({ company });
}
