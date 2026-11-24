import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { loadPaySchedule, todayKey as torontoToday } from "./_pay-schedule.js";
import { PROVINCE_TIME_ZONES, periodInstants, summarizeEmployee } from "./_manager-timecards.js";
import { addDays, isDateKey, payPeriodFor } from "../pay-periods.js";
import { dayPay } from "./_pay-rates.js";

// Hours report for any date range (company admins only), compared with the same dates a
// year earlier. Hours come from approved timecards only and are worked out exactly like
// payroll: each pay period overlapping the range is calculated whole (so weekly overtime is
// right), then only the days inside the range are counted.

export const MAX_RANGE_DAYS = 731; // two years
const PAGE = 1000; // the database returns at most this many rows per request
const DAY = 86400000;
const idList = ids => encodeURIComponent(`(${ids.map(id => `"${String(id).replaceAll('"', "")}"`).join(",")})`);
const hours = ms => Math.round((ms || 0) / 36000) / 100; // two decimals
const RULE_FIELDS = "province_code,daily_threshold_hours,weekly_threshold_hours,daily_overtime_enabled,weekly_overtime_enabled,calculation_method,week_start_day,overtime_multiplier,double_time_threshold_hours,double_time_multiplier,holiday_rule,holiday_week_threshold_hours,holiday_reduction_hours,effective_from,effective_to";

async function read(auth, path) {
  const { supabaseUrl, secretKey } = auth.configuration;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: databaseHeaders(secretKey) });
  if (!response.ok) {
    const error = new Error(`Hours report query failed (${path.split("?")[0]})`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

async function readAll(auth, path) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await read(auth, `${path}&limit=${PAGE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

// Same dates one year earlier (Feb 29 becomes Feb 28).
export function yearEarlier(key) {
  const year = Number(key.slice(0, 4)) - 1, month = key.slice(5, 7), day = Number(key.slice(8, 10));
  const last = new Date(Date.UTC(year, Number(month), 0)).getUTCDate();
  return `${year}-${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

export function validateRange(from, to, todayKey) {
  if (!isDateKey(from) || !isDateKey(to)) return "Choose a start and end date.";
  if (from > to) return "The start date must be before the end date.";
  if (from > todayKey) return "The start date can't be in the future.";
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return "Choose a range of two years or less.";
  return null;
}

function periodsCovering(from, to, schedule) {
  const periods = [];
  for (let period = payPeriodFor(from, schedule); period.startKey <= to; period = payPeriodFor(addDays(period.endKey, 1), schedule)) periods.push(period);
  return periods;
}

const emptyTotals = () => ({ regularMs: 0, overtimeMs: 0, doubleTimeMs: 0, totalMs: 0, payCents: 0, unpricedMs: 0 });
function add(target, day, pay) {
  target.payCents += pay.cents;
  target.unpricedMs += pay.unpricedMs;
  target.regularMs += day.regularMilliseconds || 0;
  target.overtimeMs += day.overtimeMilliseconds || 0;
  target.doubleTimeMs += day.doubleTimeMilliseconds || 0;
  target.totalMs += (day.regularMilliseconds || 0) + (day.overtimeMilliseconds || 0) + (day.doubleTimeMilliseconds || 0);
}
const asHours = t => ({ regularHours: hours(t.regularMs), overtimeHours: hours(t.overtimeMs), doubleTimeHours: hours(t.doubleTimeMs), totalHours: hours(t.totalMs),
  estimatedGross: Math.round(t.payCents) / 100, hoursWithoutRate: hours(t.unpricedMs) });

// Approved hours for one date range, per employee and per month.
export function rangeHours({ from, to, schedule, employees, punches, rules, approvals, payRates = [] }) {
  const approved = new Set(approvals.map(a => `${a.employee_id}|${a.period_start}|${a.period_end}`));
  const periods = periodsCovering(from, to, schedule);
  const byEmployee = new Map(), byMonth = new Map(), problems = new Set();
  const totals = emptyTotals();
  let unapprovedMs = 0;
  for (const person of employees) {
    const zone = PROVINCE_TIME_ZONES[person.province] || "America/Toronto";
    const own = punches.filter(p => p.employee_id === person.id);
    if (!own.length) continue;
    for (const period of periods) {
      const { start, end } = periodInstants(period, zone);
      // Punches for the period plus the week before it (weekly overtime) and the day after (overnight shifts).
      const window = own.filter(p => { const t = Date.parse(p.punched_at); return t >= start.getTime() - 7 * DAY && t <= end.getTime() + DAY; });
      if (!window.some(p => { const t = Date.parse(p.punched_at); return t >= start.getTime() && t <= end.getTime(); })) continue;
      const applicable = rules.filter(r => r.province_code === person.province && r.effective_from <= period.endKey && (!r.effective_to || r.effective_to >= period.startKey));
      if (applicable.length !== 1) { problems.add(`${person.first_name} ${person.last_name}`.trim()); continue; }
      const summary = summarizeEmployee(person, window, applicable[0], period);
      const days = summary.days.filter(day => day.date >= from && day.date <= to);
      if (!approved.has(`${person.id}|${period.startKey}|${period.endKey}`)) {
        for (const day of days) unapprovedMs += (day.regularMilliseconds || 0) + (day.overtimeMilliseconds || 0) + (day.doubleTimeMilliseconds || 0);
        continue;
      }
      if (!byEmployee.has(person.id)) byEmployee.set(person.id, emptyTotals());
      const ownRates = payRates.filter(rate => rate.employee_id === person.id);
      for (const day of days) {
        const pay = dayPay(day, ownRates, applicable[0]);
        add(byEmployee.get(person.id), day, pay);
        add(totals, day, pay);
        const month = day.date.slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, emptyTotals());
        add(byMonth.get(month), day, pay);
      }
    }
  }
  const employeesWithHours = [...byEmployee.values()].filter(t => t.totalMs > 0).length;
  return {
    from, to,
    totals: { employees: employeesWithHours, ...asHours(totals) },
    byEmployee: new Map([...byEmployee].map(([id, t]) => [id, asHours(t)])),
    byMonth: new Map([...byMonth].map(([month, t]) => [month, asHours(t)])),
    unapprovedHours: hours(unapprovedMs),
    problems: [...problems]
  };
}

function monthsOf(from, to) {
  const months = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)); `${y}-${String(m).padStart(2, "0")}` <= to.slice(0, 7); m === 12 ? (y++, m = 1) : m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return months;
}
const previousMonth = month => `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;

export async function hoursReport(auth, { from, to, compare = true }, now = new Date()) {
  const todayKey = torontoToday(now);
  const problem = validateRange(from, to, todayKey);
  if (problem) return { error: problem };
  const end = to > todayKey ? todayKey : to;
  const prevFrom = yearEarlier(from), prevTo = yearEarlier(end);
  const schedule = await loadPaySchedule(auth);
  const org = auth.organizationId;
  const employees = await read(auth, `employees?organization_id=eq.${org}&select=id,first_name,last_name,email,province,is_active&order=last_name.asc,first_name.asc,id.asc`);
  const rules = await read(auth, `overtime_rules?is_active=eq.true&is_default=eq.true&is_special_rule=eq.false&select=${RULE_FIELDS}`);
  const result = { range: { from, to: end, trimmed: end !== to }, previous: compare ? { from: prevFrom, to: prevTo } : null, firstRecord: null };
  if (!employees.length) return { ...result, totals: rangeTotalsEmpty(), previousTotals: compare ? rangeTotalsEmpty() : null, employees: [], months: [], unapprovedHours: 0, problems: [] };

  const ids = idList(employees.map(e => e.id));
  const loadFrom = compare ? prevFrom : from;
  const allPeriods = [...periodsCovering(loadFrom, end, schedule)];
  const first = allPeriods[0], last = allPeriods.at(-1);
  const punchStart = new Date(Date.parse(`${first.startKey}T00:00:00Z`) - 9 * DAY).toISOString();
  const punchEnd = new Date(Date.parse(`${last.endKey}T00:00:00Z`) + 3 * DAY).toISOString();
  const punches = await readAll(auth, `punches?employee_id=in.${ids}&punched_at=gte.${encodeURIComponent(punchStart)}&punched_at=lte.${encodeURIComponent(punchEnd)}&select=id,employee_id,punch_type,punched_at,location_name&order=punched_at.asc,id.asc`);
  const approvals = await readAll(auth, `timecard_approvals?employee_id=in.${ids}&status=eq.approved&period_end=gte.${first.startKey}&period_start=lte.${last.endKey}&select=employee_id,period_start,period_end&order=period_start.asc,employee_id.asc`);
  const payRates = await read(auth, `employee_pay_rates?organization_id=eq.${org}&effective_from=lte.${end}&select=employee_id,hourly_rate,effective_from&order=effective_from.asc`);
  const firstPunch = await read(auth, `punches?employee_id=in.${ids}&select=punched_at&order=punched_at.asc&limit=1`);
  result.firstRecord = firstPunch[0]?.punched_at?.slice(0, 10) || null;

  const current = rangeHours({ from, to: end, schedule, employees, punches, rules, approvals, payRates });
  const before = compare ? rangeHours({ from: prevFrom, to: prevTo, schedule, employees, punches, rules, approvals, payRates }) : null;
  const zero = { regularHours: 0, overtimeHours: 0, doubleTimeHours: 0, totalHours: 0, estimatedGross: 0, hoursWithoutRate: 0 };
  const rows = employees
    .filter(person => current.byEmployee.has(person.id) || before?.byEmployee.has(person.id))
    .map(person => ({
      employeeId: person.id, name: `${person.first_name || ""} ${person.last_name || ""}`.trim(), province: person.province || "",
      leftCompany: !person.is_active,
      current: current.byEmployee.get(person.id) || zero,
      previous: compare ? (before.byEmployee.get(person.id) || zero) : null
    }))
    .sort((a, b) => b.current.totalHours - a.current.totalHours || a.name.localeCompare(b.name));
  const months = monthsOf(from, end).map(month => ({
    month, current: current.byMonth.get(month) || zero, previous: compare ? (before.byMonth.get(previousMonth(month)) || zero) : null
  }));
  return {
    ...result,
    totals: current.totals, previousTotals: compare ? before.totals : null,
    employees: rows, months,
    unapprovedHours: current.unapprovedHours,
    problems: [...new Set([...current.problems, ...(before?.problems || [])])]
  };
}
const rangeTotalsEmpty = () => ({ employees: 0, regularHours: 0, overtimeHours: 0, doubleTimeHours: 0, totalHours: 0, estimatedGross: 0, hoursWithoutRate: 0 });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const auth = await requireManager(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (auth.role !== "admin") return res.status(403).json({ error: "Only this business's admins can see the hours report." });
    const q = name => (Array.isArray(req.query?.[name]) ? req.query[name][0] : req.query?.[name]) || "";
    const report = await hoursReport(auth, { from: q("from"), to: q("to"), compare: q("compare") !== "false" });
    if (report.error) return res.status(400).json({ error: report.error });
    return res.status(200).json(report);
  } catch (error) {
    console.error("Hours report failed", { errorName: error?.name || "Error", status: error?.httpStatus || null });
    return res.status(500).json({ error: "The hours report is unavailable right now. Please try again." });
  }
}
