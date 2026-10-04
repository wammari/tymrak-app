import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { getPayPeriodDateKeys, periodFromKey } from "./_manager-timecards.js";

const ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

async function readArray(response) {
  if (!response.ok) throw new Error("Timecard approval request failed");
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("Invalid timecard approval response");
  return value;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    const employeeId = req.body?.employeeId;
    if (typeof employeeId !== "string" || !ID_PATTERN.test(employeeId)) {
      return res.status(400).json({ error: "Select a valid employee" });
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length > 1000) return res.status(400).json({ error: "Reopen reason must be 1000 characters or fewer" });
    const period = periodFromKey(req.body?.period, new Date(), "America/Toronto");
    if (!period) return res.status(400).json({ error: "Select a valid current or previous pay period" });
    const { startKey, endKey } = getPayPeriodDateKeys(period);
    const { supabaseUrl, secretKey } = authorization.configuration;
    const base = `${supabaseUrl}/rest/v1/timecard_approvals?employee_id=eq.${encodeURIComponent(employeeId)}&period_start=eq.${startKey}&period_end=eq.${endKey}`;
    const existing = await readArray(await fetch(`${base}&select=id,status`, {
      headers: databaseHeaders(secretKey)
    }));
    if (!existing.length) return res.status(404).json({ error: "Approved timecard not found" });
    if (existing[0].status !== "approved") return res.status(409).json({ error: "Timecard is not currently approved" });

    const reopenedAt = new Date().toISOString();
    const updated = await readArray(await fetch(`${base}&status=eq.approved&select=id,employee_id,status,period_start,period_end,work_timezone,reopened_by,reopened_at,reopen_reason`, {
      method: "PATCH",
      headers: databaseHeaders(secretKey, "return=representation"),
      body: JSON.stringify({
        status: "reopened", reopened_by: authorization.user.id,
        reopened_at: reopenedAt, reopen_reason: reason || null, updated_at: reopenedAt
      })
    }));
    if (!updated.length) return res.status(409).json({ error: "Timecard approval changed; refresh and try again" });
    return res.status(200).json({ message: "Timecard reopened successfully", approval: updated[0] });
  } catch (error) {
    console.error("Manager timecard reopen failed", { errorName: error?.name || "Error", message: error?.message || null });
    return res.status(500).json({ error: "Unable to reopen timecard" });
  }
}
