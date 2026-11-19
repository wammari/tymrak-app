import { databaseHeaders } from "./_employee-management.js";
import { dateKey } from "../timecard-calculation.js";
import { normalizePayTimeline, payPeriodFor, payPeriodFromKey } from "../pay-periods.js";

// Pay periods are named by the business's own calendar. Like the original semi-monthly
// code, "today" is taken in Toronto time; each employee's exact period start and end
// times are still worked out in their own province's time zone.
export const PAY_PERIOD_CALENDAR_TIME_ZONE = "America/Toronto";

export function todayKey(now = new Date()) {
  return dateKey(now, PAY_PERIOD_CALENDAR_TIME_ZONE);
}

// Reads the signed-in manager's company schedule history (the sign-up schedule plus any
// changes). Never guesses: if it cannot be read, timecards are not shown, because a wrong
// schedule would mean wrong pay periods.
export async function loadPaySchedule(authorization) {
  const { supabaseUrl, secretKey } = authorization.configuration;
  const response = await fetch(
    `${supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(authorization.organizationId)}&select=pay_frequency,pay_period_anchor,pay_schedule_changes(id,pay_frequency,pay_period_anchor,effective_from)&limit=1`,
    { headers: databaseHeaders(secretKey) }
  );
  if (!response.ok) {
    console.error("Company pay schedule lookup failed", { stage: "pay_schedule", status: response.status });
    const error = new Error("Company pay schedule unavailable");
    error.diagnosticLogged = true;
    throw error;
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Company pay schedule not found");
  return normalizePayTimeline(rows[0]);
}

// The period a request asks for (or the current one when none is given). Returns null for
// a code that is not a real period of this schedule, or a future period.
export function requestedPayPeriod(key, schedule, now = new Date()) {
  const today = todayKey(now);
  return key ? payPeriodFromKey(key, schedule, today) : payPeriodFor(today, schedule);
}
