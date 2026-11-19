import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAY_SCHEDULE, describePaySchedule, nextPayPeriod, normalizePaySchedule,
  payPeriodFor, payPeriodFromKey, previousPayPeriod
} from "../pay-periods.js";
import { getCurrentPayPeriod, getPayPeriodDateKeys } from "../api/_manager-timecards.js";

const weekly = { frequency: "weekly", anchorDate: "2026-11-02" };
const biweekly = { frequency: "biweekly", anchorDate: "2026-11-02" };
const monthly = { frequency: "monthly" };
const span = period => `${period.startKey}..${period.endKey}`;

test("semi-monthly periods match the original Tymrak periods on every day for four years", () => {
  for (let time = Date.UTC(2025, 0, 1); time < Date.UTC(2029, 0, 1); time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const original = getCurrentPayPeriod(new Date(time + 12 * 3600000), "UTC");
    const period = payPeriodFor(day, DEFAULT_PAY_SCHEDULE);
    assert.equal(period.key, original.key, day);
    assert.deepEqual({ startKey: period.startKey, endKey: period.endKey }, getPayPeriodDateKeys(original), day);
  }
});

test("weekly periods run 7 days from the start date, in both directions", () => {
  assert.equal(span(payPeriodFor("2026-11-18", weekly)), "2026-11-16..2026-11-22");
  assert.equal(span(payPeriodFor("2026-11-02", weekly)), "2026-11-02..2026-11-08");
  assert.equal(span(payPeriodFor("2026-11-01", weekly)), "2026-10-26..2026-11-01");
  assert.equal(span(payPeriodFor("2026-12-31", weekly)), "2026-12-28..2027-01-03");
});

test("every-two-weeks periods run 14 days from the start date", () => {
  assert.equal(span(payPeriodFor("2026-11-18", biweekly)), "2026-11-16..2026-11-29");
  assert.equal(span(payPeriodFor("2026-11-15", biweekly)), "2026-11-02..2026-11-15");
  assert.equal(span(payPeriodFor("2026-10-30", biweekly)), "2026-10-19..2026-11-01");
});

test("monthly periods cover the whole calendar month, including leap years", () => {
  assert.equal(span(payPeriodFor("2026-02-10", monthly)), "2026-02-01..2026-02-28");
  assert.equal(span(payPeriodFor("2028-02-29", monthly)), "2028-02-01..2028-02-29");
  assert.equal(span(payPeriodFor("2026-12-31", monthly)), "2026-12-01..2026-12-31");
});

test("previous and next periods meet with no gaps or overlaps for every schedule", () => {
  for (const schedule of [DEFAULT_PAY_SCHEDULE, weekly, biweekly, monthly]) {
    let period = payPeriodFor("2026-01-01", schedule);
    for (let step = 0; step < 60; step += 1) {
      const next = nextPayPeriod(period, schedule);
      const nextDay = new Date(Date.parse(`${period.endKey}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      assert.equal(next.startKey, nextDay, `${schedule.frequency} after ${span(period)}`);
      assert.deepEqual(previousPayPeriod(next, schedule), period);
      period = next;
    }
  }
});

test("period codes: original codes for semi-monthly, start dates for the rest", () => {
  assert.equal(payPeriodFor("2026-11-18", DEFAULT_PAY_SCHEDULE).key, "2026-11-2");
  assert.equal(payPeriodFor("2026-11-18", weekly).key, "2026-11-16");
  assert.equal(payPeriodFromKey("2026-11-2", DEFAULT_PAY_SCHEDULE, "2026-11-18").startKey, "2026-11-16");
  assert.equal(payPeriodFromKey("2026-11-16", DEFAULT_PAY_SCHEDULE, "2026-11-18").key, "2026-11-2");
  assert.equal(payPeriodFromKey("2026-11-09", weekly, "2026-11-18").key, "2026-11-09");
});

test("period codes that are not real periods, or are in the future, are refused", () => {
  assert.equal(payPeriodFromKey("2026-11-10", weekly, "2026-11-18"), null, "not a period start");
  assert.equal(payPeriodFromKey("2026-11-23", weekly, "2026-11-18"), null, "next week");
  assert.equal(payPeriodFromKey("2026-12-1", DEFAULT_PAY_SCHEDULE, "2026-11-18"), null, "next month");
  assert.equal(payPeriodFromKey("2026-11-2", weekly, "2026-11-18"), null, "semi-monthly code on a weekly company");
  assert.equal(payPeriodFromKey("2026-02-30", monthly, "2026-11-18"), null, "impossible date");
  assert.equal(payPeriodFromKey("", weekly, "2026-11-18"), null);
  assert.equal(payPeriodFromKey(undefined, weekly, "2026-11-18"), null);
});

test("schedules are validated", () => {
  assert.deepEqual(normalizePaySchedule(null), DEFAULT_PAY_SCHEDULE);
  assert.deepEqual(normalizePaySchedule({ pay_frequency: "weekly", pay_period_anchor: "2026-11-02" }), weekly);
  assert.deepEqual(normalizePaySchedule({ frequency: "monthly", anchorDate: "2026-11-02" }), { frequency: "monthly", anchorDate: null });
  assert.throws(() => normalizePaySchedule({ frequency: "fortnightly" }), /Unknown pay schedule/);
  assert.throws(() => normalizePaySchedule({ frequency: "biweekly" }), /first period start date/);
  assert.throws(() => normalizePaySchedule({ frequency: "weekly", anchorDate: "2026-13-01" }), /first period start date/);
  assert.match(describePaySchedule(biweekly), /Every two weeks, periods starting 2026-11-02/);
});

// ---- Schedule changes -----------------------------------------------------------------
import { allowedChangeDates, earliestChangeDate, normalizePayTimeline, payTimelineSummary, scheduleChangePreview, scheduleChangeProblem, scheduleOn } from "../pay-periods.js";

const switched = normalizePayTimeline({ pay_frequency: "semi_monthly", pay_period_anchor: null,
  pay_schedule_changes: [{ id: 7, pay_frequency: "biweekly", pay_period_anchor: "2027-01-01", effective_from: "2027-01-01" }] });

test("periods before a change keep the old schedule; periods from it use the new one", () => {
  assert.equal(span(payPeriodFor("2026-12-31", switched)), "2026-12-16..2026-12-31");
  assert.equal(payPeriodFor("2026-12-31", switched).key, "2026-12-2", "old periods keep their original codes");
  assert.equal(span(payPeriodFor("2027-01-01", switched)), "2027-01-01..2027-01-14");
  assert.equal(span(payPeriodFor("2027-01-20", switched)), "2027-01-15..2027-01-28");
  assert.equal(scheduleOn(switched, "2026-12-31").frequency, "semi_monthly");
  assert.equal(scheduleOn(switched, "2027-01-01").frequency, "biweekly");
});

test("moving back and forth across a change has no gaps or overlaps", () => {
  let period = payPeriodFor("2026-11-01", switched);
  for (let step = 0; step < 12; step += 1) {
    const next = nextPayPeriod(period, switched);
    assert.equal(next.startKey, new Date(Date.parse(`${period.endKey}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    assert.deepEqual(previousPayPeriod(next, switched), period);
    period = next;
  }
});

test("period codes are read with the schedule in effect on that date", () => {
  assert.equal(payPeriodFromKey("2026-12-2", switched, "2027-02-01").endKey, "2026-12-31");
  assert.equal(payPeriodFromKey("2027-01-15", switched, "2027-02-01").endKey, "2027-01-28");
  assert.equal(payPeriodFromKey("2027-01-1", switched, "2027-02-01"), null, "a twice-a-month code after the switch");
  assert.equal(payPeriodFromKey("2027-01-08", switched, "2027-02-01"), null, "not a two-week boundary");
});

test("a change must start on a future date the new schedule allows, in a period that has not started", () => {
  const semi = { pay_frequency: "semi_monthly", pay_period_anchor: null };
  const ok = change => scheduleChangeProblem(semi, change, "2026-11-19");
  assert.equal(ok({ frequency: "biweekly", effectiveFrom: "2027-01-01" }), null);
  assert.equal(ok({ frequency: "biweekly", effectiveFrom: "2026-12-16" }), null);
  assert.equal(ok({ frequency: "monthly", effectiveFrom: "2027-01-01" }), null);
  assert.match(ok({ frequency: "monthly", effectiveFrom: "2026-12-16" }), /its own pay periods/);
  assert.equal(ok({ frequency: "biweekly", effectiveFrom: "2026-12-10" }), null, "Dec 1–15 has not started, so it can end early");
  assert.match(ok({ frequency: "biweekly", effectiveFrom: "2026-11-25" }), /already started/, "Nov 16–30 has started");
  assert.match(ok({ frequency: "biweekly", effectiveFrom: "2026-11-16" }), /future date/);
  assert.match(ok({ frequency: "semi_monthly", effectiveFrom: "2027-01-01" }), /already uses/);
  assert.match(ok({ frequency: "yearly", effectiveFrom: "2027-01-01" }), /Choose the new pay schedule/);
  assert.match(scheduleChangeProblem(switched, { frequency: "monthly", effectiveFrom: "2027-03-01" }, "2026-11-19"), /Cancel it first/);
});

test("the offered start dates are exactly the allowed ones", () => {
  const semi = { pay_frequency: "semi_monthly", pay_period_anchor: null };
  assert.deepEqual(allowedChangeDates(semi, "monthly", "2026-11-19", 3), ["2026-12-01", "2027-01-01", "2027-02-01"]);
  assert.deepEqual(allowedChangeDates(semi, "weekly", "2026-11-19", 2), ["2026-12-01", "2026-12-02"], "weekly can start any day, which sets its weekday");
  assert.deepEqual(allowedChangeDates(switched, "monthly", "2026-11-19"), [], "nothing while a change is waiting");
  const weekly = { frequency: "weekly", anchorDate: "2026-11-02" };
  assert.deepEqual(allowedChangeDates(weekly, "monthly", "2026-11-19", 3), ["2026-12-01", "2027-01-01", "2027-02-01"]);
  for (const date of allowedChangeDates(weekly, "monthly", "2026-11-19")) {
    assert.equal(date.slice(8), "01");
    assert.equal(scheduleChangeProblem(weekly, { frequency: "monthly", effectiveFrom: date }, "2026-11-19"), null);
  }
});

test("the summary shows today's schedule and the change that is waiting", () => {
  const before = payTimelineSummary(switched, "2026-11-19");
  assert.equal(before.frequency, "semi_monthly");
  assert.deepEqual([before.upcomingChange.id, before.upcomingChange.effectiveFrom], [7, "2027-01-01"]);
  const after = payTimelineSummary(switched, "2027-01-05");
  assert.equal(after.frequency, "biweekly");
  assert.equal(after.upcomingChange, null);
  assert.equal(after.history.length, 2);
});

test("a change inside a future period ends that period early, and only that one", () => {
  const biweekly = { frequency: "biweekly", anchorDate: "2026-11-01" };
  const preview = scheduleChangePreview(biweekly, { frequency: "monthly", effectiveFrom: "2027-01-01" }, "2026-11-19");
  assert.deepEqual(preview.shortPeriod, { startKey: "2026-12-27", endKey: "2026-12-31", days: 5 });
  assert.deepEqual(preview.firstNewPeriod, { startKey: "2027-01-01", endKey: "2027-01-31" });
  const clean = scheduleChangePreview({ pay_frequency: "semi_monthly" }, { frequency: "biweekly", effectiveFrom: "2027-01-01" }, "2026-11-19");
  assert.equal(clean.shortPeriod, null, "Jan 1 already starts a twice-a-month period");
  assert.equal(scheduleChangePreview(biweekly, { frequency: "monthly", effectiveFrom: "2026-11-20" }, "2026-11-19"), null);
  const after = normalizePayTimeline({ ...biweekly, pay_schedule_changes: [{ pay_frequency: "monthly", pay_period_anchor: null, effective_from: "2027-01-01" }] });
  assert.equal(span(payPeriodFor("2026-12-26", after)), "2026-12-13..2026-12-26", "the period before is untouched");
  assert.equal(span(payPeriodFor("2026-12-29", after)), "2026-12-27..2026-12-31");
  assert.equal(span(nextPayPeriod(payPeriodFor("2026-12-29", after), after)), "2027-01-01..2027-01-31");
  assert.equal(payPeriodFromKey("2026-12-27", after, "2027-02-02").endKey, "2026-12-31");
});

test("the earliest change date is the day after the current pay period", () => {
  assert.equal(earliestChangeDate({ pay_frequency: "semi_monthly" }, "2026-11-19"), "2026-12-01");
  assert.equal(earliestChangeDate({ frequency: "biweekly", anchorDate: "2026-11-01" }, "2026-11-19"), "2026-11-29");
  assert.equal(earliestChangeDate(switched, "2026-11-19"), null, "not while a change is waiting");
});
