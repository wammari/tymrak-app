import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { PROVINCE_TIME_ZONES, calculationStart, getCurrentPayPeriod, getPayPeriod, periodFromKey, summarizeEmployee } from "./_manager-timecards.js";

async function query(url, secretKey) {
  const response = await fetch(url, { headers: databaseHeaders(secretKey) });
  if (!response.ok) throw new Error("Manager timecard query failed");
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("Manager timecard query returned invalid data");
  return value;
}

export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    const { supabaseUrl, secretKey } = authorization.configuration;
    const current = getCurrentPayPeriod(new Date(), "America/Toronto");
    const requested = Array.isArray(req.query?.period) ? req.query.period[0] : req.query?.period;
    const period = requested ? periodFromKey(requested, new Date(), "America/Toronto") : current;
    if (!period) return res.status(400).json({ error: "Select a valid current or previous pay period" });
    const month = String(period.month + 1).padStart(2, "0");
    const startKey = `${period.year}-${month}-${period.half === 1 ? "01" : "16"}`;
    const lastDay = new Date(Date.UTC(period.year, period.month + 1, 0)).getUTCDate();
    const endKey = `${period.year}-${month}-${period.half === 1 ? "15" : String(lastDay).padStart(2, "0")}`;

    const employees = await query(`${supabaseUrl}/rest/v1/employees?is_active=eq.true&select=id,first_name,last_name,province&order=last_name.asc,first_name.asc`, secretKey);
    const rules = await query(`${supabaseUrl}/rest/v1/overtime_rules?is_active=eq.true&is_default=eq.true&is_special_rule=eq.false&select=province_code,daily_threshold_hours,weekly_threshold_hours,daily_overtime_enabled,weekly_overtime_enabled,calculation_method,week_start_day,effective_from,effective_to`, secretKey);
    const employeeIds = employees.map(employee => employee.id);
    let punches = [];
    if (employeeIds.length) {
      const earliest = Math.min(...employees.map(employee => {
        const zone = PROVINCE_TIME_ZONES[employee.province] || "America/Toronto";
        return calculationStart(getPayPeriod(period.year, period.month, period.half, zone), 0, zone).getTime();
      }));
      const latest = Math.max(...employees.map(employee => {
        const zone = PROVINCE_TIME_ZONES[employee.province] || "America/Toronto";
        return getPayPeriod(period.year, period.month, period.half, zone).end.getTime();
      })) + 24 * 60 * 60 * 1000;
      const ids = `(${employeeIds.map(id => `"${String(id).replaceAll('"', '')}"`).join(",")})`;
      punches = await query(`${supabaseUrl}/rest/v1/punches?employee_id=in.${encodeURIComponent(ids)}&punched_at=gte.${encodeURIComponent(new Date(earliest).toISOString())}&punched_at=lte.${encodeURIComponent(new Date(latest).toISOString())}&select=id,employee_id,punch_type,punched_at,location_name&order=punched_at.asc`, secretKey);
    }
    const cards = employees.map(employee => {
      const applicable = rules.filter(rule => rule.province_code === employee.province && rule.effective_from <= endKey && (!rule.effective_to || rule.effective_to >= startKey));
      if (applicable.length !== 1) throw new Error("A unique overtime rule is required for each employee and pay period");
      return summarizeEmployee(employee, punches.filter(punch => punch.employee_id === employee.id), applicable[0], period);
    });
    return res.status(200).json({ period: { key: period.key, start: period.start.toISOString(), end: period.end.toISOString(), current: period.key === current.key }, timecards: cards, approvalPersistence: false });
  } catch (error) {
    console.error("Manager timecard operation failed", { errorName: error?.name || "Error" });
    return res.status(500).json({ error: "Unable to load manager timecards" });
  }
}
