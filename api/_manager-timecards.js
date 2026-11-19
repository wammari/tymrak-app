import { dateParts, dateKey, weekKey, buildShifts, buildDailyRecords, applyOvertime, totalsFor,
  selectOvertimeRuleForPeriod } from "../timecard-calculation.js";

// The calculation itself lives in ../timecard-calculation.js (shared with the employee
// timecard page). Re-exported here so existing imports keep working.
export { dateParts, dateKey, weekKey, buildShifts, buildDailyRecords, applyOvertime, totalsFor, selectOvertimeRuleForPeriod };

export const PROVINCE_TIME_ZONES = {
  AB: "America/Edmonton", BC: "America/Vancouver", SK: "America/Regina",
  MB: "America/Winnipeg", ON: "America/Toronto", QC: "America/Toronto",
  NB: "America/Moncton", NS: "America/Halifax", PE: "America/Halifax",
  NL: "America/St_Johns", NT: "America/Yellowknife", NU: "America/Iqaluit",
  YT: "America/Whitehorse"
};

export function zonedDate(year, month, day, timeZone, endOfDay = false) {
  const hour = endOfDay ? 23 : 0;
  const minute = endOfDay ? 59 : 0;
  const second = endOfDay ? 59 : 0;
  const millisecond = endOfDay ? 999 : 0;
  const guess = new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(guess).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const represented = Date.UTC(Number(fields.year), Number(fields.month) - 1,
    Number(fields.day), Number(fields.hour), Number(fields.minute), Number(fields.second), millisecond);
  return new Date(guess.getTime() - (represented - guess.getTime()));
}

export function getPayPeriod(year, month, half, timeZone = "America/Toronto") {
  const normalized = new Date(Date.UTC(year, month, 1));
  year = normalized.getUTCFullYear();
  month = normalized.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    year, month, half,
    key: `${year}-${String(month + 1).padStart(2, "0")}-${half}`,
    start: zonedDate(year, month, half === 1 ? 1 : 16, timeZone),
    end: zonedDate(year, month, half === 1 ? 15 : lastDay, timeZone, true)
  };
}

export function getCurrentPayPeriod(now = new Date(), timeZone = "America/Toronto") {
  const parts = dateParts(now, timeZone);
  return getPayPeriod(parts.year, parts.month - 1, parts.day <= 15 ? 1 : 2, timeZone);
}

export function getPreviousPayPeriod(period, timeZone = "America/Toronto") {
  return period.half === 2
    ? getPayPeriod(period.year, period.month, 1, timeZone)
    : getPayPeriod(period.year, period.month - 1, 2, timeZone);
}

export function getNextPayPeriod(period, timeZone = "America/Toronto") {
  return period.half === 1
    ? getPayPeriod(period.year, period.month, 2, timeZone)
    : getPayPeriod(period.year, period.month + 1, 1, timeZone);
}

export function getPayPeriodDateKeys(period) {
  const month = String(period.month + 1).padStart(2, "0");
  const lastDay = new Date(Date.UTC(period.year, period.month + 1, 0)).getUTCDate();
  return {
    startKey: `${period.year}-${month}-${period.half === 1 ? "01" : "16"}`,
    endKey: `${period.year}-${month}-${period.half === 1 ? "15" : String(lastDay).padStart(2, "0")}`
  };
}

export function periodFromKey(key, now = new Date(), timeZone = "America/Toronto") {
  const match = /^(\d{4})-(\d{2})-([12])$/.exec(key || "");
  if (!match) return null;
  const period = getPayPeriod(Number(match[1]), Number(match[2]) - 1, Number(match[3]), timeZone);
  return period.key <= getCurrentPayPeriod(now, timeZone).key ? period : null;
}

// Calendar dates of a period: periods from pay-periods.js carry startKey/endKey; the
// original semi-monthly period objects ({ year, month, half }) are still accepted.
export function periodDateKeys(period) {
  return period.startKey ? { startKey: period.startKey, endKey: period.endKey } : getPayPeriodDateKeys(period);
}

function zonedFromKey(key, timeZone, endOfDay = false) {
  return zonedDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)), timeZone, endOfDay);
}

// Exact start and end times of a period for an employee's time zone.
export function periodInstants(period, timeZone = "America/Toronto") {
  const { startKey, endKey } = periodDateKeys(period);
  return { start: zonedFromKey(startKey, timeZone), end: zonedFromKey(endKey, timeZone, true) };
}

export function summarizeEmployee(employee, punches, rule, period, options = {}) {
  const timeZone = PROVINCE_TIME_ZONES[employee.province] || "America/Toronto";
  const allDays = applyOvertime(buildDailyRecords(punches, timeZone), rule, options);
  const { startKey, endKey } = periodDateKeys(period);
  const days = allDays.filter(day => day.date >= startKey && day.date <= endKey);
  return { employee: { id: employee.id, first_name: employee.first_name, last_name: employee.last_name, province: employee.province },
    ...totalsFor(days),
    exceptionCount: days.filter(day => day.missingPunch).length, approvalStatus: "Not approved", days };
}

// Punches are loaded from the start of the workweek that contains the period's first day,
// so weekly overtime is right when a pay period starts mid-week.
export function calculationStart(period, weekStartDay = 0, timeZone = "America/Toronto") {
  const { startKey } = periodDateKeys(period);
  const noon = new Date(`${startKey}T12:00:00Z`);
  noon.setUTCDate(noon.getUTCDate() - ((noon.getUTCDay() - Number(weekStartDay) + 7) % 7));
  return zonedDate(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), timeZone);
}
