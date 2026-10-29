import { getBearerToken, getSupabaseConfiguration } from "./_manager-auth.js";
import { activationServerHeaders } from "./complete-activation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(["clock_in", "clock_out", "break_start", "break_end"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const config = getSupabaseConfiguration();
  if (!config) return res.status(500).json({ error: "Service unavailable" });

  const body = req.body || {};
  const { punchType, requestId, expectedLastId, location } = body;
  if (!TYPES.has(punchType) || !UUID.test(requestId || "") ||
      !(expectedLastId === null || (typeof expectedLastId === "string" && /^[0-9]+$/.test(expectedLastId))) ||
      !location || typeof location !== "object" ||
      !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90 ||
      !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180 ||
      !Number.isFinite(location.accuracy) || location.accuracy < 0 || location.accuracy > 100 ||
      !Number.isFinite(location.capturedAt) || Math.abs(Date.now() - location.capturedAt) > 30000) {
    // Return a non-sensitive validation category so staging can diagnose rejected requests.
    const reason = !TYPES.has(punchType) ? "invalid_punch_type" :
      !UUID.test(requestId || "") ? "invalid_request_id" :
      !(expectedLastId === null || (typeof expectedLastId === "string" && /^[0-9]+$/.test(expectedLastId))) ? "invalid_previous_punch_id" :
      !location || typeof location !== "object" ? "missing_location" :
      !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90 ||
      !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180 ? "invalid_coordinates" :
      !Number.isFinite(location.accuracy) || location.accuracy < 0 || location.accuracy > 100 ? "insufficient_location_accuracy" :
      !Number.isFinite(location.capturedAt) || Math.abs(Date.now() - location.capturedAt) > 30000 ? "stale_location_timestamp" :
      "invalid_request";
    return res.status(400).json({ error: "Valid punch, location and request state are required", code: reason });
  }

  const { supabaseUrl, secretKey } = config;
  try {
    const auth = await fetch(supabaseUrl + "/auth/v1/user", {
      headers: { apikey: secretKey, Authorization: "Bearer " + token }
    });
    if (!auth.ok) return res.status(auth.status >= 500 ? 503 : 401).json({ error: "Invalid session" });
    const user = await auth.json();
    if (!UUID.test(user?.id || "")) return res.status(401).json({ error: "Invalid session" });
    // Only the Auth-verified identity is forwarded. The database RPC enforces
    // workplace geofencing and punch state; never fall back to an unscoped insert.
    const result = await fetch(supabaseUrl + "/rest/v1/rpc/record_geofenced_punch", {
      method: "POST",
      headers: activationServerHeaders(secretKey),
      body: JSON.stringify({
        p_auth_user_id: user.id,
        p_punch_type: punchType,
        p_request_id: requestId,
        p_expected_last_id: expectedLastId,
        p_location: { latitude: location.latitude, longitude: location.longitude, accuracyMetres: location.accuracy, capturedAt: location.capturedAt }
      })
    });
    if (!result.ok) throw new Error("Punch RPC unavailable");
    const data = await result.json();
    if (data?.error) return res.status(409).json({ error: data.error });
    if (data?.success !== true) throw new Error("Invalid punch RPC response");
    return res.status(200).json(data);
  } catch (error) {
    console.error("Employee punch failed", { errorName: error?.name || "Error" });
    return res.status(500).json({ error: "Unable to record punch" });
  }
}
