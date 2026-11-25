import { databaseHeaders } from "./_employee-management.js";
import { PROVINCE_TIME_ZONES, calculationStart, periodInstants, summarizeEmployee } from "./_manager-timecards.js";

// Regular, overtime and double time hours for a few employees in one pay period, worked
// out exactly like the manager timecards and the payroll report. Used for notices, so it
// never throws: anyone whose hours can't be worked out is simply left out of the map.

const idList = ids => encodeURIComponent(`(${ids.map(id => `"${String(id).replaceAll('"', "")}"`).join(",")})`);
const toHours = milliseconds => Math.round((milliseconds || 0) / 60000) / 60;

export async function periodHours({ supabaseUrl, secretKey }, employees, period) {
  const result = new Map();
  if (!employees?.length) return result;
  try {
    const get = async path => {
      const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: databaseHeaders(secretKey) });
      if (!response.ok) throw new Error("hours lookup failed");
      return response.json();
    };
    const zone = person => PROVINCE_TIME_ZONES[person.province] || "America/Toronto";
    const earliest = Math.min(...employees.map(p => calculationStart(period, 0, zone(p)).getTime()));
    const latest = Math.max(...employees.map(p => periodInstants(period, zone(p)).end.getTime())) + 86400000;
    const [rules, punches] = await Promise.all([
      get("overtime_rules?is_active=eq.true&is_default=eq.true&is_special_rule=eq.false&select=province_code,daily_threshold_hours,weekly_threshold_hours,daily_overtime_enabled,weekly_overtime_enabled,calculation_method,week_start_day,overtime_multiplier,double_time_threshold_hours,double_time_multiplier,holiday_rule,holiday_week_threshold_hours,holiday_reduction_hours,effective_from,effective_to"),
      get(`punches?employee_id=in.${idList(employees.map(e => e.id))}&punched_at=gte.${encodeURIComponent(new Date(earliest).toISOString())}&punched_at=lte.${encodeURIComponent(new Date(latest).toISOString())}&select=id,employee_id,punch_type,punched_at&order=punched_at.asc,id.asc`)
    ]);
    for (const person of employees) {
      const own = punches.filter(p => p.employee_id === person.id);
      const applicable = rules.filter(rule => rule.province_code === person.province && rule.effective_from <= period.endKey && (!rule.effective_to || rule.effective_to >= period.startKey));
      if (own.length && applicable.length !== 1) continue;
      const summary = summarizeEmployee(person, own, own.length ? applicable[0] : null, period);
      result.set(person.id, {
        regular: toHours(summary.regularMilliseconds), overtime: toHours(summary.overtimeMilliseconds),
        doubleTime: toHours(summary.doubleTimeMilliseconds), total: toHours(summary.totalMilliseconds),
        days: summary.days || []
      });
    }
  } catch { /* notices go out without hours */ }
  return result;
}
