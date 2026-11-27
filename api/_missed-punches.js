import { buildShifts, dateKey } from "../timecard-calculation.js";
import { PROVINCE_TIME_ZONES } from "./_manager-timecards.js";

// Finds punches that need a manager's attention before payroll: shifts with no clock-out
// (or a clock-out with no clock-in), in the current and the previous pay period.
// - A shift that is still going is not a problem: one started today (in the employee's
//   own time zone) or within the last OPEN_SHIFT_GRACE_HOURS (overnight shifts) is skipped.
// - Timecards that are already approved for a period are skipped: they've been reviewed.

export const OPEN_SHIFT_GRACE_HOURS = 16;

const timeOfDay = (iso, timeZone) => new Date(iso).toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });

export function findMissedPunches({ employees, punches, approvedPeriodsByEmployee = new Map(), periods, now = new Date() }) {
  const issues = [];
  const earliest = periods.reduce((min, p) => (p.startKey < min ? p.startKey : min), periods[0].startKey);
  for (const person of employees) {
    const own = punches.filter(p => p.employee_id === person.id);
    if (!own.length) continue;
    const timeZone = PROVINCE_TIME_ZONES[person.province] || "America/Toronto";
    const shifts = buildShifts(own, timeZone, { now });
    shifts.forEach((shift, index) => {
      if (!shift.missingPunch || shift.date < earliest) return;
      const lastAndOpen = index === shifts.length - 1 && shift.clockIn && !shift.clockOut;
      if (lastAndOpen && now.getTime() - new Date(shift.clockIn).getTime() < OPEN_SHIFT_GRACE_HOURS * 3600000) return;
      const period = periods.find(p => shift.date >= p.startKey && shift.date <= p.endKey);
      if (!period || approvedPeriodsByEmployee.get(person.id)?.has(period.startKey)) return;
      const problem = !shift.clockIn
        ? `Clocked out at ${timeOfDay(shift.clockOut || shift.punches[0].punched_at, timeZone)} with no clock-in`
        : `Clocked in at ${timeOfDay(shift.clockIn, timeZone)}, no clock-out`;
      issues.push({ employeeId: person.id, name: `${person.first_name || ""} ${person.last_name || ""}`.trim() || "Employee",
        date: shift.date, problem, periodStart: period.startKey, periodEnd: period.endKey });
    });
  }
  return issues.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
}

export { dateKey };
