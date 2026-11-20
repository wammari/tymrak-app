import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { loadPaySchedule, requestedPayPeriod } from "./_pay-schedule.js";
import { PROVINCE_TIME_ZONES, calculationStart, periodInstants, summarizeEmployee } from "./_manager-timecards.js";
import { nextPayPeriod, previousPayPeriod } from "../pay-periods.js";

// Payroll report for one pay period (company admins only): each person's regular,
// overtime and double time hours, worked out exactly like the manager timecards, for the
// business's accountant or payroll service. Covers the whole company, including people
// who left during the period, since their final pay still needs their hours.

const idList = ids => encodeURIComponent(`(${ids.map(id => `"${String(id).replaceAll('"', "")}"`).join(",")})`);
const hours = milliseconds => Math.round((milliseconds || 0) / 60000) / 60;

async function read(auth, path) {
  const { supabaseUrl, secretKey } = auth.configuration;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: databaseHeaders(secretKey) });
  if (!response.ok) {
    const error = new Error(`Payroll report query failed (${path.split("?")[0]})`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

export async function payrollReport(auth, periodKey, now = new Date()) {
  const schedule = await loadPaySchedule(auth);
  const period = requestedPayPeriod(periodKey || null, schedule, now);
  if (!period) return null;
  const current = requestedPayPeriod(null, schedule, now);
  const org = auth.organizationId;
  const everyone = await read(auth, `employees?organization_id=eq.${org}&select=id,first_name,last_name,email,province,is_active,termination_date&order=last_name.asc,first_name.asc,id.asc`);
  const rules = await read(auth, "overtime_rules?is_active=eq.true&is_default=eq.true&is_special_rule=eq.false&select=province_code,daily_threshold_hours,weekly_threshold_hours,daily_overtime_enabled,weekly_overtime_enabled,calculation_method,week_start_day,overtime_multiplier,double_time_threshold_hours,double_time_multiplier,holiday_rule,holiday_week_threshold_hours,holiday_reduction_hours,effective_from,effective_to");
  let punches = [], approvals = [];
  if (everyone.length) {
    const zone = person => PROVINCE_TIME_ZONES[person.province] || "America/Toronto";
    const earliest = Math.min(...everyone.map(p => calculationStart(period, 0, zone(p)).getTime()));
    const latest = Math.max(...everyone.map(p => periodInstants(period, zone(p)).end.getTime())) + 86400000;
    punches = await read(auth, `punches?employee_id=in.${idList(everyone.map(e => e.id))}&punched_at=gte.${encodeURIComponent(new Date(earliest).toISOString())}&punched_at=lte.${encodeURIComponent(new Date(latest).toISOString())}&select=id,employee_id,punch_type,punched_at,location_name&order=punched_at.asc,id.asc`);
    approvals = await read(auth, `timecard_approvals?employee_id=in.${idList(everyone.map(e => e.id))}&period_start=eq.${period.startKey}&period_end=eq.${period.endKey}&status=eq.approved&select=employee_id,approved_at`);
  }
  const rows = [];
  for (const person of everyone) {
    const own = punches.filter(p => p.employee_id === person.id);
    const approval = approvals.find(a => a.employee_id === person.id);
    // People who left are listed only when they have time or an approval in this period.
    if (!person.is_active && !own.length && !approval) continue;
    const applicable = rules.filter(rule => rule.province_code === person.province && rule.effective_from <= period.endKey && (!rule.effective_to || rule.effective_to >= period.startKey));
    const name = `${person.first_name || ""} ${person.last_name || ""}`.trim();
    const base = { employeeId: person.id, name, email: person.email || "", province: person.province || "",
      leftCompany: !person.is_active, approved: Boolean(approval), approvedAt: approval?.approved_at || null };
    if (own.length && applicable.length !== 1) {
      rows.push({ ...base, regularHours: null, overtimeHours: null, doubleTimeHours: null, totalHours: null, missingPunches: 0,
        problem: "No overtime rule is set up for this employee's province, so hours can't be worked out." });
      continue;
    }
    const summary = summarizeEmployee(person, own, own.length ? applicable[0] : null, period);
    rows.push({ ...base,
      regularHours: hours(summary.regularMilliseconds), overtimeHours: hours(summary.overtimeMilliseconds),
      doubleTimeHours: hours(summary.doubleTimeMilliseconds), totalHours: hours(summary.totalMilliseconds),
      missingPunches: summary.exceptionCount || 0, problem: null });
  }
  const approvedRows = rows.filter(r => r.approved && r.problem === null);
  const sum = field => Math.round(approvedRows.reduce((s, r) => s + r[field], 0) * 100) / 100;
  return {
    period: { key: period.key, startDate: period.startKey, endDate: period.endKey, current: period.key === current.key,
      previousKey: previousPayPeriod(period, schedule).key, nextKey: period.key === current.key ? null : nextPayPeriod(period, schedule).key },
    rows,
    approvedTotals: { employees: approvedRows.length, regularHours: sum("regularHours"), overtimeHours: sum("overtimeHours"), doubleTimeHours: sum("doubleTimeHours"), totalHours: sum("totalHours") },
    notApproved: rows.filter(r => !r.approved && (r.totalHours || r.problem)).length
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const auth = await requireManager(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (auth.role !== "admin") return res.status(403).json({ error: "Only this business's admins can see the payroll report." });
    const periodKey = Array.isArray(req.query?.period) ? req.query.period[0] : req.query?.period;
    const report = await payrollReport(auth, periodKey);
    if (!report) return res.status(400).json({ error: "Select a valid current or previous pay period" });
    return res.status(200).json(report);
  } catch (error) {
    console.error("Payroll report failed", { errorName: error?.name || "Error", status: error?.httpStatus || null });
    return res.status(500).json({ error: "The payroll report is unavailable right now. Please try again." });
  }
}
