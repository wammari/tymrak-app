import { getBearerToken, getSupabaseConfiguration } from "./_manager-auth.js";

// Server-side submission path for future pilot rollout. This endpoint fails
// closed until the per-employee workplace assignment and direct-insert lockout
// are deployed. Do not use the service key to insert unverified punches.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const config = getSupabaseConfiguration();
  if (!config) return res.status(503).json({ error: "Punch verification unavailable" });
  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: config.secretKey, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: "Invalid or expired session" });
    const user = await response.json();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(user?.id || "")) {
      return res.status(401).json({ error: "Invalid session" });
    }
    // Identity is verified, but site configuration and tamper-resistant
    // enforcement have not been deployed. Never fall back to direct insert.
    return res.status(503).json({
      error: "Secure workplace punch verification is not yet enabled"
    });
  } catch {
    return res.status(503).json({ error: "Punch verification temporarily unavailable" });
  }
}
