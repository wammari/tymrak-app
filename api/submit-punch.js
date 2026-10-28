import { getBearerToken, getSupabaseConfiguration } from "./_manager-auth.js";

// A position's reported accuracy is a radius, not proof of physical presence.
export function distanceMeters(aLat, aLon, bLat, bLon) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLon = radians(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) *
    Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function serviceHeaders(secretKey) {
  return {
    apikey: secretKey,
    ...(secretKey.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${secretKey}` })
  };
}

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
    // Resolve the employee from the verified JWT identity, never from a
    // browser-supplied employee ID. Lookups use a server-only credential.
    const headers = serviceHeaders(config.secretKey);
    const employeesResponse = await fetch(`${config.supabaseUrl}/rest/v1/employees?auth_user_id=eq.${encodeURIComponent(user.id)}&select=id,is_active,invitation_status`, { headers });
    if (!employeesResponse.ok) throw new Error("Employee lookup failed");
    const employees = await employeesResponse.json();
    if (!Array.isArray(employees) || employees.length !== 1 ||
        !employees[0].is_active || employees[0].invitation_status !== "Account Activated") {
      return res.status(403).json({ error: "Active employee account required" });
    }
    const employeeId = employees[0].id;
    const assignmentResponse = await fetch(`${config.supabaseUrl}/rest/v1/employee_workplaces?employee_id=eq.${encodeURIComponent(employeeId)}&select=workplace_id,workplaces(latitude,longitude,radius_meters,max_accuracy_meters,is_active)`, { headers });
    if (!assignmentResponse.ok) throw new Error("Workplace lookup failed");
    const assignments = await assignmentResponse.json();
    const workplace = assignments?.length === 1 ? assignments[0]?.workplaces : null;
    if (!workplace?.is_active || ![workplace.latitude, workplace.longitude].every(Number.isFinite)) {
      return res.status(403).json({ error: "No active workplace assigned" });
    }
    if (accuracy > workplace.max_accuracy_meters) {
      return res.status(422).json({ error: "GPS accuracy is too low. Retry near a window." });
    }
    if (distanceMeters(latitude, longitude, workplace.latitude, workplace.longitude) > workplace.radius_meters) {
      return res.status(403).json({ error: "Outside your authorized workplace area" });
    }
    // Do not write punches until direct INSERT is locked down and an atomic
    // server-controlled insert path has been reviewed and deployed.
    return res.status(503).json({
      error: "Secure workplace punch verification is not yet enabled"
    });
  } catch {
    return res.status(503).json({ error: "Punch verification temporarily unavailable" });
  }
}
