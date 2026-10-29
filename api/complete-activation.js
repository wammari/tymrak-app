import { getBearerToken, getSupabaseConfiguration } from "./_manager-auth.js";

// Modern secret keys belong only in apikey; legacy service-role JWTs also
// require Authorization. Never forward the employee JWT to privileged RPCs.
export function activationServerHeaders(secretKey) {
  return {
    apikey: secretKey,
    ...(secretKey.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${secretKey}` }),
    "Content-Type": "application/json"
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const accessToken = getBearerToken(req);
  if (!accessToken) return res.status(401).json({ error: "Authentication required" });
  const configuration = getSupabaseConfiguration();
  if (!configuration) {
    return res.status(500).json({ error: "Supabase environment variables are not configured" });
  }
  const { supabaseUrl, secretKey } = configuration;
  try {
    // Auth verifies the JWT remotely; browser-supplied IDs and JWT payloads
    // are never used as identity evidence.
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: secretKey, Authorization: `Bearer ${accessToken}` }
    });
    if (!userResponse.ok) {
      if (userResponse.status >= 500) throw new Error("Auth unavailable");
      return res.status(401).json({ error: "Invalid or expired activation session" });
    }
    const user = await userResponse.json();
    if (typeof user?.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
      return res.status(401).json({ error: "Invalid or expired activation session" });
    }
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/complete_employee_activation`, {
      method: "POST",
      headers: activationServerHeaders(secretKey),
      body: JSON.stringify({ p_auth_user_id: user.id })
    });
    if (!response.ok) throw new Error("Activation transaction failed");
    const result = await response.json();
    if (result?.outcome === "missing") {
      return res.status(404).json({ error: "No TYMRAK employee record was found for this account." });
    }
    if (result?.outcome === "duplicate") {
      return res.status(409).json({ error: "Multiple employee records map to this account. Please contact your manager." });
    }
    if (!["activated", "already_activated"].includes(result?.outcome)) {
      throw new Error("Invalid activation transaction response");
    }
    return res.status(200).json({
      success: true,
      alreadyActivated: result.outcome === "already_activated",
      message: "TYMRAK account activated successfully"
    });
  } catch (error) {
    // Do not log tokens, Auth bodies, employee records, or database responses.
    console.error("Complete activation failed", { errorName: error?.name || "Error" });
    return res.status(500).json({
      error: "TYMRAK could not complete activation. Your saved password is unchanged; please retry activation completion."
    });
  }
}

