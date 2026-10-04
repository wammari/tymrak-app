export const PROVINCE_TIME_ZONES = {
  AB: "America/Edmonton", BC: "America/Vancouver", SK: "America/Regina",
  MB: "America/Winnipeg", ON: "America/Toronto", QC: "America/Toronto",
  NB: "America/Moncton", NS: "America/Halifax", PE: "America/Halifax",
  NL: "America/St_Johns", NT: "America/Yellowknife", NU: "America/Iqaluit",
  YT: "America/Whitehorse"
};

export function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const value = type => Number(parts.find(part => part.type === type).value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

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

export function periodFromKey(key, now = new Date(), timeZone = "America/Toronto") {
  const match = /^(\d{4})-(\d{2})-([12])$/.exec(key || "");
  if (!match) return null;
  const period = getPayPeriod(Number(match[1]), Number(match[2]) - 1, Number(match[3]), timeZone);
  return period.key <= getCurrentPayPeriod(now, timeZone).key ? period : null;
}

export function dateKey(date, timeZone) {
  const value = dateParts(date, timeZone);
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

// Pair the chronological stream first, then assign a completed shift to its clock-in
// date. This intentionally avoids splitting an overnight shift at midnight.
export function buildShifts(punches, timeZone) {
  const shifts = [];
  let shift = null;
  for (const punch of [...punches].sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at))) {
    const at = new Date(punch.punched_at).getTime();
    if (punch.punch_type === "clock_in") {
      if (shift) shifts.push({ ...shift, missingPunch: true });
      shift = { date: dateKey(new Date(at), timeZone), clockIn: punch.punched_at,
        clockOut: null, location: punch.location_name || "—", workedMilliseconds: 0,
        workStartedAt: at, breakStartedAt: null, punches: [punch], missingPunch: false };
    } else if (!shift) {
      shifts.push({ date: dateKey(new Date(at), timeZone), clockIn: null,
        clockOut: punch.punch_type === "clock_out" ? punch.punched_at : null,
        location: punch.location_name || "—", workedMilliseconds: 0, punches: [punch], missingPunch: true });
    } else {
      shift.punches.push(punch);
      if (punch.punch_type === "break_start" && shift.workStartedAt !== null) {
        shift.workedMilliseconds += Math.max(0, at - shift.workStartedAt);
        shift.workStartedAt = null; shift.breakStartedAt = at;
      } else if (punch.punch_type === "break_end" && shift.breakStartedAt !== null) {
        shift.breakStartedAt = null; shift.workStartedAt = at;
      } else if (punch.punch_type === "clock_out") {
        if (shift.workStartedAt !== null) shift.workedMilliseconds += Math.max(0, at - shift.workStartedAt);
        shift.clockOut = punch.punched_at;
        delete shift.workStartedAt; delete shift.breakStartedAt;
        shifts.push(shift); shift = null;
      }
    }
  }
  if (shift) { delete shift.workStartedAt; delete shift.breakStartedAt; shifts.push({ ...shift, missingPunch: true }); }
  return shifts;
}

function weekKey(dateString, weekStartDay = 0) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - Number(weekStartDay) + 7) % 7));
  return date.toISOString().slice(0, 10);
}

export function applyOvertime(shifts, rule) {
  const records = shifts.map(shift => ({ ...shift, regularMilliseconds: shift.workedMilliseconds, overtimeMilliseconds: 0 }));
  if (!rule) return records;
  const weeks = Map.groupBy ? Map.groupBy(records, item => weekKey(item.date, rule.week_start_day)) : records.reduce((map, item) => {
    const key = weekKey(item.date, rule.week_start_day); if (!map.has(key)) map.set(key, []); map.get(key).push(item); return map;
  }, new Map());
  for (const week of weeks.values()) {
    week.sort((a, b) => a.date.localeCompare(b.date));
    const dailyLimit = Number(rule.daily_threshold_hours || 0) * 3600000;
    const weeklyLimit = Number(rule.weekly_threshold_hours || 0) * 3600000;
    const dailyOvertime = rule.daily_overtime_enabled && dailyLimit
      ? week.reduce((sum, item) => sum + Math.max(0, item.workedMilliseconds - dailyLimit), 0) : 0;
    const weeklyOvertime = rule.weekly_overtime_enabled && weeklyLimit
      ? Math.max(0, week.reduce((sum, item) => sum + item.workedMilliseconds, 0) - weeklyLimit) : 0;
    if (rule.calculation_method === "greater_daily_or_weekly" && dailyOvertime > weeklyOvertime) {
      for (const item of week) item.overtimeMilliseconds = Math.max(0, item.workedMilliseconds - dailyLimit);
    } else if (weeklyOvertime) {
      let regularRemaining = weeklyLimit;
      for (const item of week) { item.regularMilliseconds = Math.min(item.workedMilliseconds, Math.max(0, regularRemaining)); regularRemaining -= item.regularMilliseconds; item.overtimeMilliseconds = item.workedMilliseconds - item.regularMilliseconds; }
    } else if (rule.daily_overtime_enabled && dailyLimit) {
      for (const item of week) item.overtimeMilliseconds = Math.max(0, item.workedMilliseconds - dailyLimit);
    }
    for (const item of week) item.regularMilliseconds = item.workedMilliseconds - item.overtimeMilliseconds;
  }
  return records;
}

export function summarizeEmployee(employee, punches, rule, period) {
  const timeZone = PROVINCE_TIME_ZONES[employee.province] || "America/Toronto";
  const employeePeriod = getPayPeriod(period.year, period.month, period.half, timeZone);
  const shifts = buildShifts(punches, timeZone);
  const grouped = new Map();
  for (const shift of shifts) {
    if (!grouped.has(shift.date)) grouped.set(shift.date, []);
    grouped.get(shift.date).push(shift);
  }
  const dailyRecords = [...grouped.entries()].map(([date, entries]) => ({
    date,
    clockIn: entries.find(entry => entry.clockIn)?.clockIn || null,
    clockOut: [...entries].reverse().find(entry => entry.clockOut)?.clockOut || null,
    location: [...new Set(entries.map(entry => entry.location).filter(value => value && value !== "—"))].join(", ") || "—",
    workedMilliseconds: entries.reduce((sum, entry) => sum + entry.workedMilliseconds, 0),
    missingPunch: entries.some(entry => entry.missingPunch),
    punches: entries.flatMap(entry => entry.punches).sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at))
  }));
  const allShifts = applyOvertime(dailyRecords, rule);
  const startKey = dateKey(employeePeriod.start, timeZone), endKey = dateKey(employeePeriod.end, timeZone);
  const days = allShifts.filter(shift => shift.date >= startKey && shift.date <= endKey);
  const total = days.reduce((sum, day) => sum + day.workedMilliseconds, 0);
  const overtime = days.reduce((sum, day) => sum + day.overtimeMilliseconds, 0);
  return { employee: { id: employee.id, first_name: employee.first_name, last_name: employee.last_name, province: employee.province },
    regularMilliseconds: total - overtime, overtimeMilliseconds: overtime, totalMilliseconds: total,
    exceptionCount: days.filter(day => day.missingPunch).length, approvalStatus: "Not approved", days };
}

export function calculationStart(period, weekStartDay = 0, timeZone = "America/Toronto") {
  const parts = dateParts(period.start, timeZone);
  const noon = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  noon.setUTCDate(noon.getUTCDate() - ((noon.getUTCDay() - Number(weekStartDay) + 7) % 7));
  return zonedDate(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), timeZone);
}
