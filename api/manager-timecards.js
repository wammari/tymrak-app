import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { PROVINCE_TIME_ZONES, calculationStart, getCurrentPayPeriod, getPayPeriod, getPayPeriodDateKeys, periodFromKey, summarizeEmployee } from "./_manager-timecards.js";

async function safeSupabaseError(response) {
  try {
    const body = await response.json();
    return {
      code: typeof body?.code === "string" ? body.code : null,
      message: typeof body?.message === "string"
        ? body.message
        : typeof body?.hint === "string"
          ? body.hint
          : null
    };
  } catch {
    return { code: null, message: null };
  }
}

async function query({ url, secretKey, stage, resource, queryName }) {
  const response = await fetch(url, { headers: databaseHeaders(secretKey) });
  if (!response.ok) {
    const details = await safeSupabaseError(response);
    console.error("Manager timecard Supabase request failed", {
      stage,
      resource,
      query: queryName,
      status: response.status,
      ...details
    });
    const error = new Error("Manager timecard query failed");
    error.diagnosticLogged = true;
    throw error;
  }
  const value = await response.json();
  if (!Array.isArray(value)) {
    console.error("Manager timecard Supabase response was invalid", {
      stage, resource, query: queryName, status: response.status
    });
    const error = new Error("Manager timecard query returned invalid data");
    error.diagnosticLogged = true;
    throw error;
  }
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
    const { startKey, endKey } = getPayPeriodDateKeys(period);

    const employees = await query({
      url: `${supabaseUrl}/rest/v1/employees?is_active=eq.true&select=id,first_name,last_name,province&order=last_name.asc,first_name.asc`,
      secretKey, stage: "employees_query", resource: "employees",
      queryName: "active_employee_timecard_fields"
    });
    const rules = await query({
      url: `${supabaseUrl}/rest/v1/overtime_rules?is_active=eq.true&is_default=eq.true&is_special_rule=eq.false&select=province_code,daily_threshold_hours,weekly_threshold_hours,daily_overtime_enabled,weekly_overtime_enabled,calculation_method,week_start_day,effective_from,effective_to`,
      secretKey, stage: "overtime_rules_query", resource: "overtime_rules",
      queryName: "default_jurisdiction_rules"
    });
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
      punches = await query({
        url: `${supabaseUrl}/rest/v1/punches?employee_id=in.${encodeURIComponent(ids)}&punched_at=gte.${encodeURIComponent(new Date(earliest).toISOString())}&punched_at=lte.${encodeURIComponent(new Date(latest).toISOString())}&select=id,employee_id,punch_type,punched_at,location_name&order=punched_at.asc`,
        secretKey, stage: "punches_query", resource: "punches",
        queryName: "employee_period_punches"
      });
    }
    const cards = employees.map(employee => {
      const employeePunches = punches.filter(punch => punch.employee_id === employee.id);
      const applicable = rules.filter(rule => rule.province_code === employee.province && rule.effective_from <= endKey && (!rule.effective_to || rule.effective_to >= startKey));
      // A rule is not needed to truthfully render an active employee with no time.
      // Previously, such an employee could make the entire manager list fail merely
      // because their jurisdiction did not yet have a configured overtime rule.
      if (employeePunches.length === 0) return summarizeEmployee(employee, [], null, period);
      if (applicable.length !== 1) {
        console.error("Manager timecard overtime rule resolution failed", {
          stage: "overtime_rule_resolution",
          resource: "overtime_rules",
          query: "default_jurisdiction_rules",
          employeeId: employee.id,
          province: employee.province || null,
          matchingRuleCount: applicable.length,
          period: period.key
        });
        const error = new Error("A unique overtime rule is required for each employee with punches");
        error.diagnosticLogged = true;
        throw error;
      }
      return summarizeEmployee(employee, employeePunches, applicable[0], period);
    });
    return res.status(200).json({
      period: {
        key: period.key,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        startDate: startKey,
        endDate: endKey,
        current: period.key === current.key
      },
      timecards: cards,
      approvalPersistence: false
    });
  } catch (error) {
    if (!error?.diagnosticLogged) {
      console.error("Manager timecard operation failed", {
        stage: "manager_timecards",
        errorName: error?.name || "Error",
        message: error?.message || null
      });
    }
    return res.status(500).json({ error: "Unable to load manager timecards" });
  }
}
