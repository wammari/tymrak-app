// Shared timecard calculation. This one module is used by the server (api/_manager-timecards.js)
// and by the employee timecard page, so managers, employees and payroll always see the same
// regular, overtime and double-time hours. It has no imports so it runs in the browser and Node.

const HOUR = 3600000;

export function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const value = type => Number(parts.find(part => part.type === type).value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function dateKey(date, timeZone) {
  const value = dateParts(date, timeZone);
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

export function weekKey(dateString, weekStartDay = 0) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - Number(weekStartDay) + 7) % 7));
  return date.toISOString().slice(0, 10);
}

// Pair the chronological stream first, then assign a completed shift to its clock-in
// date. This intentionally avoids splitting an overnight shift at midnight.
// With options.now, a shift that is still open and started today keeps counting until
// now and is marked inProgress instead of missingPunch (used by the employee's own page).
export function buildShifts(punches, timeZone, options = {}) {
  const shifts = [];
  let shift = null;
  for (const punch of [...punches].sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at))) {
    const at = new Date(punch.punched_at).getTime();
    if (punch.punch_type === "clock_in") {
      if (shift) { closeOpen(shift); shifts.push({ ...shift, missingPunch: true }); }
      shift = { date: dateKey(new Date(at), timeZone), clockIn: punch.punched_at,
        clockOut: null, location: punch.location_name || "—", workedMilliseconds: 0, breakMilliseconds: 0,
        workStartedAt: at, breakStartedAt: null, punches: [punch], missingPunch: false };
    } else if (!shift) {
      shifts.push({ date: dateKey(new Date(at), timeZone), clockIn: null,
        clockOut: punch.punch_type === "clock_out" ? punch.punched_at : null,
        location: punch.location_name || "—", workedMilliseconds: 0, breakMilliseconds: 0,
        punches: [punch], missingPunch: true });
    } else {
      shift.punches.push(punch);
      if (punch.punch_type === "break_start" && shift.workStartedAt !== null) {
        shift.workedMilliseconds += Math.max(0, at - shift.workStartedAt);
        shift.workStartedAt = null; shift.breakStartedAt = at;
      } else if (punch.punch_type === "break_end" && shift.breakStartedAt !== null) {
        shift.breakMilliseconds += Math.max(0, at - shift.breakStartedAt);
        shift.breakStartedAt = null; shift.workStartedAt = at;
      } else if (punch.punch_type === "clock_out") {
        if (shift.workStartedAt !== null) shift.workedMilliseconds += Math.max(0, at - shift.workStartedAt);
        if (shift.breakStartedAt !== null) shift.breakMilliseconds += Math.max(0, at - shift.breakStartedAt);
        shift.clockOut = punch.punched_at;
        delete shift.workStartedAt; delete shift.breakStartedAt;
        shifts.push(shift); shift = null;
      }
    }
  }
  if (shift) {
    const now = options.now ? new Date(options.now).getTime() : null;
    if (now !== null && shift.date === dateKey(new Date(now), timeZone)) {
      if (shift.workStartedAt !== null) shift.workedMilliseconds += Math.max(0, now - shift.workStartedAt);
      if (shift.breakStartedAt !== null) shift.breakMilliseconds += Math.max(0, now - shift.breakStartedAt);
      delete shift.workStartedAt; delete shift.breakStartedAt;
      shifts.push({ ...shift, inProgress: true });
    } else {
      closeOpen(shift); shifts.push({ ...shift, missingPunch: true });
    }
  }
  return shifts;
}

function closeOpen(shift) { delete shift.workStartedAt; delete shift.breakStartedAt; }

// One record per work date: the shifts that started on that date, added together.
export function buildDailyRecords(punches, timeZone, options = {}) {
  const grouped = new Map();
  for (const shift of buildShifts(punches, timeZone, options)) {
    if (!grouped.has(shift.date)) grouped.set(shift.date, []);
    grouped.get(shift.date).push(shift);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, entries]) => ({
    date,
    clockIn: entries.find(entry => entry.clockIn)?.clockIn || null,
    clockOut: [...entries].reverse().find(entry => entry.clockOut)?.clockOut || null,
    location: [...new Set(entries.map(entry => entry.location).filter(value => value && value !== "—"))].join(", ") || "—",
    workedMilliseconds: entries.reduce((sum, entry) => sum + entry.workedMilliseconds, 0),
    breakMilliseconds: entries.reduce((sum, entry) => sum + (entry.breakMilliseconds || 0), 0),
    missingPunch: entries.some(entry => entry.missingPunch),
    inProgress: entries.some(entry => entry.inProgress),
    punches: entries.flatMap(entry => entry.punches).sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at))
  }));
}

// Exactly one rule must cover the whole pay period. A period that crosses a rule change
// is refused rather than calculated with the wrong rule.
export function selectOvertimeRuleForPeriod(overtimeRules, startKey, endKey) {
  const matchingRules = overtimeRules.filter(rule =>
    rule.effective_from <= endKey && (!rule.effective_to || rule.effective_to >= startKey));
  const coveringRules = matchingRules.filter(rule =>
    rule.effective_from <= startKey && (!rule.effective_to || rule.effective_to >= endKey));
  if (matchingRules.length === 0) throw new Error("No overtime rule applies to this pay period.");
  if (matchingRules.length !== 1 || coveringRules.length !== 1) {
    const error = new Error("This pay period crosses an overtime-rule effective-date boundary and cannot be calculated as a single timecard.");
    error.code = "OVERTIME_RULE_BOUNDARY";
    throw error;
  }
  return coveringRules[0];
}

function hours(value) {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) || number <= 0 ? 0 : number * HOUR;
}

// Weekly limit for one workweek, after any statutory holidays that fall in it.
// reduce_weekly_threshold: the limit drops by holiday_reduction_hours per holiday
// (or to holiday_week_threshold_hours when no reduction is set).
export function weeklyLimitForWeek(rule, holidayCount) {
  const weeklyLimit = hours(rule.weekly_threshold_hours);
  if (!weeklyLimit || !holidayCount || rule.holiday_rule !== "reduce_weekly_threshold") return weeklyLimit;
  const reduction = hours(rule.holiday_reduction_hours);
  if (reduction) return Math.max(0, weeklyLimit - reduction * holidayCount);
  return hours(rule.holiday_week_threshold_hours) || weeklyLimit;
}

// Splits each day's worked time into regular, overtime and double time.
// options.holidays: statutory holiday dates ("YYYY-MM-DD") for the employee's province.
// options.holidayHours: { "YYYY-MM-DD": milliseconds } of paid holiday time that counts
// toward the weekly limit (holiday_rule "count_holiday_as_hours", e.g. Quebec).
// Without holiday options the result is the same as before holidays were supported.
export function applyOvertime(days, rule, options = {}) {
  const records = days.map(day => ({ ...day, regularMilliseconds: day.workedMilliseconds,
    overtimeMilliseconds: 0, doubleTimeMilliseconds: 0 }));
  if (!rule) return records;
  const holidays = new Set(options.holidays || []);
  const holidayHours = options.holidayHours || {};
  const weekStartDay = rule.week_start_day ?? 0;
  const weeks = new Map();
  for (const record of records) {
    const key = weekKey(record.date, weekStartDay);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(record);
  }
  for (const [key, week] of weeks) {
    week.sort((a, b) => a.date.localeCompare(b.date));
    const weekDates = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(`${key}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    });
    const holidayCount = weekDates.filter(date => holidays.has(date)).length;
    const creditedHolidayTime = rule.holiday_rule === "count_holiday_as_hours"
      ? weekDates.reduce((sum, date) => sum + Math.max(0, Number(holidayHours[date]) || 0), 0) : 0;
    const weeklyLimit = rule.weekly_overtime_enabled ? weeklyLimitForWeek(rule, holidayCount) : 0;
    const dailyLimit = rule.daily_overtime_enabled ? hours(rule.daily_threshold_hours) : 0;
    const doubleTimeLimit = hours(rule.double_time_threshold_hours) && hours(rule.double_time_multiplier)
      ? hours(rule.double_time_threshold_hours) : 0;
    const dailyExcess = item => dailyLimit ? Math.max(0, item.workedMilliseconds - dailyLimit) : 0;
    const allocateWeekly = (items, regularOf) => {
      let regularRemaining = Math.max(0, weeklyLimit - creditedHolidayTime);
      for (const item of items) {
        const candidate = regularOf(item);
        item.regularMilliseconds = weeklyLimit ? Math.min(candidate, regularRemaining) : candidate;
        regularRemaining = Math.max(0, regularRemaining - item.regularMilliseconds);
        item.overtimeMilliseconds = item.workedMilliseconds - item.regularMilliseconds;
      }
    };
    const splitDaily = item => {
      item.overtimeMilliseconds = dailyExcess(item);
      item.regularMilliseconds = item.workedMilliseconds - item.overtimeMilliseconds;
    };
    const method = rule.calculation_method || "weekly_only";
    if (method === "daily_plus_weekly_no_double_count") {
      // Daily overtime first; then regular hours past the weekly limit also become
      // overtime. A daily-overtime hour is never counted again toward the weekly limit.
      allocateWeekly(week, item => item.workedMilliseconds - dailyExcess(item));
    } else if (method === "greater_daily_or_weekly") {
      const dailyTotal = week.reduce((sum, item) => sum + dailyExcess(item), 0);
      const worked = week.reduce((sum, item) => sum + item.workedMilliseconds, 0);
      const weeklyTotal = weeklyLimit ? Math.max(0, worked + creditedHolidayTime - weeklyLimit) : 0;
      if (dailyTotal > weeklyTotal) week.forEach(splitDaily);
      else if (weeklyTotal) allocateWeekly(week, item => item.workedMilliseconds);
    } else if (weeklyLimit) {
      allocateWeekly(week, item => item.workedMilliseconds);
    }
    // Double time: time past the daily double-time limit is paid at the double-time rate
    // instead of the overtime rate (e.g. British Columbia after 12 hours in a day).
    if (doubleTimeLimit) {
      for (const item of week) {
        const doubleTime = Math.min(item.overtimeMilliseconds, Math.max(0, item.workedMilliseconds - doubleTimeLimit));
        item.doubleTimeMilliseconds = doubleTime;
        item.overtimeMilliseconds -= doubleTime;
      }
    }
  }
  return records;
}

export function totalsFor(days) {
  const sum = field => days.reduce((total, day) => total + (day[field] || 0), 0);
  return { totalMilliseconds: sum("workedMilliseconds"), regularMilliseconds: sum("regularMilliseconds"),
    overtimeMilliseconds: sum("overtimeMilliseconds"), doubleTimeMilliseconds: sum("doubleTimeMilliseconds") };
}
