import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";

async function readJson(response) {
  return response.json().catch(() => null);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const auth = await requireManager(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const { supabaseUrl, secretKey } = auth.configuration;
    // This registry is protected from browser access. Never trust a client-supplied admin flag.
    const check = await fetch(
      `${supabaseUrl}/rest/v1/rpc/is_platform_administrator`,
      { method: "POST", headers: { ...databaseHeaders(secretKey), "Content-Type": "application/json" },
        body: JSON.stringify({ p_auth_user_id: auth.user.id }) }
    );
    if (!check.ok) return res.status(503).json({ error: "Administrator authorization unavailable" });
    if (await readJson(check) !== true) return res.status(403).json({ error: "Main administrator access required" });
    if (req.method === "GET") return res.status(200).json({ platformAdministrator: true });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (name.length < 2 || name.length > 120) return res.status(400).json({ error: "Company name must be 2–120 characters" });
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/create_managed_company`, {
      method: "POST", headers: { ...databaseHeaders(secretKey), "Content-Type": "application/json" },
      body: JSON.stringify({ p_name: name, p_platform_admin: auth.user.id })
    });
    if (!response.ok) {
      const details = await readJson(response);
      return res.status(details?.code === "23505" ? 409 : 500).json({
        error: details?.code === "23505" ? "A company with that name already exists" : "Unable to create company"
      });
    }
    const organizationId = await readJson(response);
    if (typeof organizationId !== "string") throw new Error("Invalid company creation result");
    return res.status(201).json({ organizationId, name });
  } catch (error) {
    console.error("Company management failed", { errorName: error?.name || "Error" });
    return res.status(500).json({ error: "Company management is temporarily unavailable" });
  }
}
