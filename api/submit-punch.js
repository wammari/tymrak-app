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
    const sample = req.body?.location;
    const latitude = sample?.latitude;
    const longitude = sample?.longitude;
    const accuracy = sample?.accuracy;
    const sampledAt = sample?.sampledAt;
    if (![latitude, longitude, accuracy].every(Number.isFinite) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
        accuracy < 0 || typeof sampledAt !== "string" ||
        !Number.isFinite(Date.parse(sampledAt)) ||
        Math.abs(Date.now() - Date.parse(sampledAt)) > 30000) {
      return res.status(400).json({ error: "Fresh, valid GPS coordinates are required" });
    }
    const allowedTypes = new Set(["clock_in", "clock_out", "break_start", "break_end"]);
    if (!allowedTypes.has(req.body?.punchType)) {
      return res.status(400).json({ error: "Invalid punch type" });
    }
    // Server-side employee-to-workplace resolution and database-side
    // write lockout are not yet implemented. Refuse all writes until then.
    return res.status(503).json({
      error: "Secure workplace punch verification is not yet enabled"
    });
  } catch {
    return res.status(503).json({ error: "Punch verification temporarily unavailable" });
  }
}
