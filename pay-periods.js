// Shared pay period calculation, used by the server and by the employee timecard page.
// It works on calendar dates ("YYYY-MM-DD") only; each caller turns a period's dates into
// exact times in the employee's own time zone. No imports, so it runs in Node and browsers.
//
// A business picks a schedule at sign-up (organizations.pay_frequency). The Main
// Administrator can later change it from a future pay period (pay_schedule_changes);
// earlier periods always keep the schedule they had. Every function below accepts either
// one schedule or a company's whole schedule history (a "timeline").
//
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

// A company's schedules over time: the one chosen at sign-up (from: null), then each
// change from its effective date. Accepts a timeline, a single schedule, an organizations
// row with embedded pay_schedule_changes, or the rows of employee_pay_schedule().
export function normalizePayTimeline(input) {
  if (input && Array.isArray(input.segments)) return input;
  const rows = Array.isArray(input) ? input : [input, ...((input && input.pay_schedule_changes) || [])];
  const startOf = row => (row && (row.effective_from ?? row.effectiveFrom)) || null;
  const original = rows.find(row => row && !startOf(row)) ?? null;
  const changes = rows.filter(row => row && startOf(row)).map(row => {
    const from = startOf(row);
    if (!isDateKey(from)) throw new Error("Invalid pay schedule change date");
    return Object.freeze({ from, id: row.id ?? null, schedule: normalizePaySchedule(row) });
  }).sort((a, b) => a.from.localeCompare(b.from));
  return Object.freeze({ segments: Object.freeze([
    Object.freeze({ from: null, id: null, schedule: normalizePaySchedule(original) }), ...changes
  ]) });
}

function segmentIndexAt(timeline, dateKey) {
  let index = 0;
  timeline.segments.forEach((segment, position) => { if (segment.from && segment.from <= dateKey) index = position; });
  return index;
}

// The schedule in effect on a given date.
export function scheduleOn(input, dateKey) {
  const timeline = normalizePayTimeline(input);
  return timeline.segments[segmentIndexAt(timeline, dateKey)].schedule;
}

// The pay period that contains the given date, under the schedule in effect that day.
export function payPeriodFor(dateKey, scheduleInput) {
  if (!isDateKey(dateKey)) throw new Error("Invalid date");
  const timeline = normalizePayTimeline(scheduleInput);
  const index = segmentIndexAt(timeline, dateKey);
  const segment = timeline.segments[index], next = timeline.segments[index + 1];
  const period = periodUnder(dateKey, segment.schedule);
  // The last period before a change ends the day before the change: when the change date
  // is not one of the old schedule's period starts, that period is a short one.
  let { startKey, endKey } = period;
  if (segment.from && startKey < segment.from) startKey = segment.from;
  if (next && endKey >= next.from) endKey = addDays(next.from, -1);
  if (startKey === period.startKey && endKey === period.endKey) return period;
  return Object.freeze({ key: startKey === period.startKey ? period.key : startKey, startKey, endKey,
    frequency: segment.schedule.frequency, shortened: true });
}

function periodUnder(dateKey, schedule) {
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
  const schedule = normalizePayTimeline(scheduleInput);
  let startKey = null;
  const legacy = LEGACY_SEMI_MONTHLY_KEY.exec(key || "");
  if (legacy) {
    const candidate = `${legacy[1]}-${legacy[2]}-${legacy[3] === "1" ? "01" : "16"}`;
    if (isDateKey(candidate) && scheduleOn(schedule, candidate).frequency === "semi_monthly") startKey = candidate;
  } else if (isDateKey(key)) startKey = key;
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

// ---- Changing a schedule ---------------------------------------------------------------
// The same rules are enforced again by the database (change_company_pay_schedule), so a
// change can never move a period that has already started. If the change date falls
// inside a future period of the old schedule, that period ends early (a short period).

function startsPeriodUnder(dateKey, schedule) {
  return periodUnder(dateKey, schedule).startKey === dateKey;
}

function newScheduleFrom(frequency, effectiveFrom) {
  // Weekly and every-two-weeks periods are counted from the change date itself.
  return normalizePaySchedule({ frequency, anchorDate: frequency === "weekly" || frequency === "biweekly" ? effectiveFrom : null });
}

// The change waiting to start (effective after today), if any.
export function pendingScheduleChange(input, todayKey) {
  const last = normalizePayTimeline(input).segments.at(-1);
  return last.from && last.from > todayKey ? last : null;
}

// Why a change is not allowed, or null when it is.
export function scheduleChangeProblem(input, change, todayKey) {
  const timeline = normalizePayTimeline(input);
  const from = change && change.effectiveFrom;
  if (!PAY_FREQUENCIES.includes(change && change.frequency)) return "Choose the new pay schedule";
  if (!isDateKey(from)) return "Choose the date the new pay schedule starts";
  if (!isDateKey(todayKey) || from <= todayKey) return "A new pay schedule can only start on a future date";
  if (pendingScheduleChange(timeline, todayKey)) return "This company already has a pay schedule change waiting to start. Cancel it first.";
  const current = scheduleOn(timeline, addDays(from, -1));
  if (current.frequency === change.frequency) return "The company already uses this pay schedule";
  if (payPeriodFor(from, timeline).startKey <= todayKey) return "That date falls inside a pay period that has already started. Choose a date after it ends.";
  if (!startsPeriodUnder(from, newScheduleFrom(change.frequency, from))) return "The new pay schedule must start on the first day of one of its own pay periods";
  return null;
}

// The earliest date any change could start: the first day after the current pay period.
export function earliestChangeDate(input, todayKey) {
  const timeline = normalizePayTimeline(input);
  if (!isDateKey(todayKey) || pendingScheduleChange(timeline, todayKey)) return null;
  return addDays(payPeriodFor(todayKey, timeline).endKey, 1);
}

// What a change would do: the short period it creates (if any) and the first new period.
export function scheduleChangePreview(input, change, todayKey) {
  const timeline = normalizePayTimeline(input);
  if (scheduleChangeProblem(timeline, change, todayKey)) return null;
  const from = change.effectiveFrom;
  const last = payPeriodFor(addDays(from, -1), timeline);
  const natural = periodUnder(addDays(from, -1), scheduleOn(timeline, addDays(from, -1)));
  const newSchedule = newScheduleFrom(change.frequency, from);
  const first = periodUnder(from, newSchedule);
  const days = (start, end) => Math.round((toTime(end) - toTime(start)) / DAY) + 1;
  return {
    lastOldPeriod: { startKey: last.startKey, endKey: addDays(from, -1) },
    shortPeriod: natural.endKey >= from ? { startKey: last.startKey, endKey: addDays(from, -1), days: days(last.startKey, addDays(from, -1)) } : null,
    firstNewPeriod: { startKey: first.startKey, endKey: first.endKey }
  };
}

// The next dates a change to `frequency` could start on. Twice-a-month and monthly
// schedules can only start on the 1st (or 16th); weekly and every-two-weeks schedules can
// start on any day from the earliest date, which also sets the weekday periods start on.
export function allowedChangeDates(input, frequency, todayKey, count = 6, horizonDays = 730) {
  const timeline = normalizePayTimeline(input);
  const earliest = earliestChangeDate(timeline, todayKey);
  if (!earliest || !PAY_FREQUENCIES.includes(frequency)) return [];
  const dates = [], limit = addDays(todayKey, horizonDays);
  for (let date = earliest; dates.length < count && date <= limit; date = addDays(date, 1)) {
    if (!scheduleChangeProblem(timeline, { frequency, effectiveFrom: date }, todayKey)) dates.push(date);
  }
  return dates;
}

// What the company uses now and any change waiting to start, for display.
export function payTimelineSummary(input, todayKey) {
  const timeline = normalizePayTimeline(input);
  const current = scheduleOn(timeline, todayKey);
  const pending = pendingScheduleChange(timeline, todayKey);
  return {
    frequency: current.frequency, anchorDate: current.anchorDate, description: describePaySchedule(current),
    upcomingChange: pending ? { id: pending.id, effectiveFrom: pending.from, frequency: pending.schedule.frequency,
      description: describePaySchedule(pending.schedule) } : null,
    history: timeline.segments.map(segment => ({ id: segment.id, effectiveFrom: segment.from,
      frequency: segment.schedule.frequency, anchorDate: segment.schedule.anchorDate,
      description: describePaySchedule(segment.schedule) }))
  };
}
