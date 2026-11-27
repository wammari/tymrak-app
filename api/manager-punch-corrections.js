import { requireManager } from "./_manager-auth.js";
import { canManageEmployee } from "./_manager-scope.js";
import { databaseHeaders } from "./_employee-management.js";
import { isDateKey } from "../pay-periods.js";

// Punch corrections by a business's admins (anyone) and managers (the people they manage).
//   POST { action: "add",    employeeId, punchType, date, time, reason }
//   POST { action: "change", employeeId, punchId, punchType, date, time, reason }
//   POST { action: "remove", employeeId, punchId, reason }
// date is YYYY-MM-DD and time HH:MM, both in the employee's own province time zone. The
// database function does the rest: approved timecards stay locked, nobody corrects their own
// punches, and every correction is kept with its before and after values and the reason.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(["clock_in", "clock_out", "break_start", "break_end"]);
const ACTIONS = new Set(["add", "change", "remove"]);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const PROBLEMS = {
  reason_required: [400, "Write a reason for the correction (3 to 500 characters)."],
  own_punches: [403, "You can't correct your own punches. Ask another manager or an admin."],
  employee_not_found: [404, "Employee not found."],
  punch_not_found: [404, "That punch no longer exists. Refresh the timecard and try again."],
  future_time: [400, "That time is in the future."],
  no_change: [400, "Nothing changed: the punch already has that type and time."],
  period_locked: [409, "This pay period is approved, so its punches are locked. Reopen the timecard first."],
  invalid_request: [400, "Check the punch type, date and time."]
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const auth = await requireManager(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const body = req.body || {};
    const { action, employeeId, punchId, punchType, date, time } = body;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!ACTIONS.has(action) || !UUID.test(String(employeeId || ""))) return res.status(400).json({ error: PROBLEMS.invalid_request[1] });
    if (!canManageEmployee(auth, employeeId)) return res.status(404).json({ error: PROBLEMS.employee_not_found[1] });
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: PROBLEMS.reason_required[1] });
    if (action !== "add" && !/^\d{1,18}$/.test(String(punchId ?? ""))) return res.status(400).json({ error: PROBLEMS.invalid_request[1] });
    if (action !== "remove" && (!TYPES.has(punchType) || !isDateKey(date) || date < "2000-01-01" || !TIME.test(String(time || "")))) {
      return res.status(400).json({ error: PROBLEMS.invalid_request[1] });
    }

    const { supabaseUrl, secretKey } = auth.configuration;
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/correct_punch`, {
      method: "POST", headers: databaseHeaders(secretKey),
      body: JSON.stringify({
        p_actor: auth.user.id, p_organization_id: auth.organizationId, p_employee_id: employeeId, p_action: action,
        p_punch_id: action === "add" ? null : String(punchId),
        p_punch_type: action === "remove" ? null : punchType,
        p_local_time: action === "remove" ? null : `${date} ${time}:00`,
        p_reason: reason, p_actor_label: typeof auth.user.email === "string" ? auth.user.email : null
      })
    });
    if (!response.ok) {
      console.error("Punch correction failed", { stage: "correct_punch", status: response.status });
      return res.status(500).json({ error: "The correction could not be saved. Please try again." });
    }
    const result = await response.json();
    if (result?.error) {
      const [status, message] = PROBLEMS[result.error] || [400, PROBLEMS.invalid_request[1]];
      return res.status(status).json({ error: message, code: result.error });
    }
    const done = { add: "Punch added", change: "Punch changed", remove: "Punch removed" }[action];
    return res.status(200).json({ success: true, message: `${done}. The correction and its reason are saved in the timecard history.`, punchId: result.punchId });
  } catch (error) {
    console.error("Punch correction failed", { stage: "manager_punch_corrections", errorName: error?.name || "Error" });
    return res.status(500).json({ error: "The correction could not be saved. Please try again." });
  }
}
