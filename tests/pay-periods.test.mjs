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
