// Shared pay period calculation, used by the server and by the employee timecard page.
// It works on calendar dates ("YYYY-MM-DD") only; each caller turns a period's dates into
// exact times in the employee's own time zone. No imports, so it runs in Node and browsers.
//
// A business picks one schedule at sign-up (organizations.pay_frequency):
//   weekly        7-day periods, starting on pay_period_anchor and every 7 days from it
//   biweekly      14-day periods, starting on pay_period_anchor and every 14 days from it
//   semi_monthly  1st-15th and 16th-last day of the month (the original Tymrak schedule)
//   monthly       1st-last day of the month

export const PAY_FREQUENCIES = Object.freeze(["weekly", "biweekly", "semi_monthly", "monthly"]);
export const PAY_FREQUENCY_LABELS = Object.freeze({
  weekly: "Weekly", biweekly: "Every two weeks", semi_monthly: "Twice a month (1st–15th, 16th–end)", monthly: "Monthly"
});
export const DEFAULT_PAY_SCHEDULE = Object.freeze({ frequency: "semi_monthly", anchorDate: null });

const DAY = 86400000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEGACY_SEMI_MONTHLY_KEY = /^(\d{4})-(\d{2})-([12])$/;

export function isDateKey(value) {
  const match = DATE_KEY.exec(value || "");
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function toTime(key) { return Date.parse(`${key}T00:00:00Z`); }
function fromTime(time) { return new Date(time).toISOString().slice(0, 10); }
export function addDays(key, days) { return fromTime(toTime(key) + days * DAY); }
function lastDayOfMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

// Accepts an organizations row ({ pay_frequency, pay_period_anchor }) or a schedule
// ({ frequency, anchorDate }). A missing schedule means the original semi-monthly one.
export function normalizePaySchedule(value) {
  if (!value) return DEFAULT_PAY_SCHEDULE;
  const frequency = value.frequency ?? value.pay_frequency ?? DEFAULT_PAY_SCHEDULE.frequency;
  const anchorDate = value.anchorDate ?? value.pay_period_anchor ?? null;
  if (!PAY_FREQUENCIES.includes(frequency)) throw new Error("Unknown pay schedule");
  const needsAnchor = frequency === "weekly" || frequency === "biweekly";
  if (needsAnchor && !isDateKey(anchorDate)) throw new Error("Weekly and every-two-weeks pay schedules need a first period start date");
  return Object.freeze({ frequency, anchorDate: needsAnchor ? anchorDate : null });
}

function periodKey(schedule, startKey) {
  // Semi-monthly periods keep their original codes (e.g. "2026-11-2") so existing
  // links, approvals and tests are unchanged. Other schedules use the start date.
  if (schedule.frequency !== "semi_monthly") return startKey;
  return `${startKey.slice(0, 7)}-${startKey.slice(8) === "01" ? 1 : 2}`;
}

function build(schedule, startKey, endKey) {
  return Object.freeze({ key: periodKey(schedule, startKey), startKey, endKey, frequency: schedule.frequency });
}

// The pay period that contains the given date.
export function payPeriodFor(dateKey, scheduleInput) {
  const schedule = normalizePaySchedule(scheduleInput);
  if (!isDateKey(dateKey)) throw new Error("Invalid date");
  const year = Number(dateKey.slice(0, 4)), month = Number(dateKey.slice(5, 7)), day = Number(dateKey.slice(8, 10));
  const monthPrefix = dateKey.slice(0, 8);
  const last = String(lastDayOfMonth(year, month)).padStart(2, "0");
  if (schedule.frequency === "monthly") return build(schedule, `${monthPrefix}01`, `${monthPrefix}${last}`);
  if (schedule.frequency === "semi_monthly") {
    return day <= 15
      ? build(schedule, `${monthPrefix}01`, `${monthPrefix}15`)
      : build(schedule, `${monthPrefix}16`, `${monthPrefix}${last}`);
  }
  const length = schedule.frequency === "weekly" ? 7 : 14;
  const daysFromAnchor = Math.round((toTime(dateKey) - toTime(schedule.anchorDate)) / DAY);
  const offset = ((daysFromAnchor % length) + length) % length;
  const startKey = addDays(dateKey, -offset);
  return build(schedule, startKey, addDays(startKey, length - 1));
}

export function previousPayPeriod(period, schedule) { return payPeriodFor(addDays(period.startKey, -1), schedule); }
export function nextPayPeriod(period, schedule) { return payPeriodFor(addDays(period.endKey, 1), schedule); }

// Turns a period code back into a period. Returns null for codes that are not a real
// period of this schedule, or that are after the current period (todayKey's period).
export function payPeriodFromKey(key, scheduleInput, todayKey) {
  const schedule = normalizePaySchedule(scheduleInput);
  let startKey = null;
  const legacy = LEGACY_SEMI_MONTHLY_KEY.exec(key || "");
  if (legacy && schedule.frequency === "semi_monthly") startKey = `${legacy[1]}-${legacy[2]}-${legacy[3] === "1" ? "01" : "16"}`;
  else if (isDateKey(key)) startKey = key;
  if (!startKey || !isDateKey(startKey)) return null;
  const period = payPeriodFor(startKey, schedule);
  if (period.startKey !== startKey) return null;
  if (todayKey && period.startKey > payPeriodFor(todayKey, schedule).startKey) return null;
  return period;
}

export function describePaySchedule(scheduleInput) {
  const schedule = normalizePaySchedule(scheduleInput);
  const label = PAY_FREQUENCY_LABELS[schedule.frequency];
  return schedule.anchorDate ? `${label}, periods starting ${schedule.anchorDate}` : label;
}
