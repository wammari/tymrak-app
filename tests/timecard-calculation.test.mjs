import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOvertime, buildDailyRecords, buildShifts, totalsFor, weeklyLimitForWeek
} from "../timecard-calculation.js";
import { summarizeEmployee, getPayPeriod } from "../api/_manager-timecards.js";

const HOUR = 3600000;

// Rule shapes copied from the live overtime_rules table (Nov 2026).
const ON = { calculation_method: "weekly_only", weekly_overtime_enabled: true, weekly_threshold_hours: "44.00",
  daily_overtime_enabled: false, daily_threshold_hours: null, double_time_threshold_hours: null,
  double_time_multiplier: null, holiday_rule: "none", week_start_day: 0 };
const AB = { calculation_method: "greater_daily_or_weekly", weekly_overtime_enabled: true, weekly_threshold_hours: "44.00",
  daily_overtime_enabled: true, daily_threshold_hours: "8.00", double_time_threshold_hours: null,
  double_time_multiplier: null, holiday_rule: "none", week_start_day: 0 };
const BC = { calculation_method: "daily_plus_weekly_no_double_count", weekly_overtime_enabled: true,
  weekly_threshold_hours: "40.00", daily_overtime_enabled: true, daily_threshold_hours: "8.00",
  double_time_threshold_hours: "12.00", double_time_multiplier: "2.00", holiday_rule: "none", week_start_day: 0 };
const YT = { ...BC, double_time_threshold_hours: null, double_time_multiplier: null,
  holiday_rule: "reduce_weekly_threshold", holiday_week_threshold_hours: "32.00", holiday_reduction_hours: "8.00" };
const QC = { ...ON, weekly_threshold_hours: "40.00", holiday_rule: "count_holiday_as_hours" };

// Monday Nov 2, 2026 starts a Sunday-based week that began Sun Nov 1.
const day = (date, workedHours) => ({ date, workedMilliseconds: workedHours * HOUR });
const week = hoursList => hoursList.map((h, i) => day(`2026-11-0${i + 2}`, h));
const inHours = (records, field) => records.map(record => record[field] / HOUR);

test("Ontario: overtime only after 44 hours in the week, never daily", () => {
  const result = applyOvertime(week([10, 10, 10, 10, 10]), ON);
  assert.deepEqual(inHours(result, "regularMilliseconds"), [10, 10, 10, 10, 4]);
  assert.deepEqual(inHours(result, "overtimeMilliseconds"), [0, 0, 0, 0, 6]);
  assert.deepEqual(inHours(applyOvertime(week([12, 12]), ON), "overtimeMilliseconds"), [0, 0]);
});

test("Alberta: uses daily overtime when it is greater than weekly overtime", () => {
  const result = applyOvertime(week([12, 12, 12, 12]), AB);
  assert.deepEqual(inHours(result, "regularMilliseconds"), [8, 8, 8, 8]);
  assert.deepEqual(inHours(result, "overtimeMilliseconds"), [4, 4, 4, 4]);
});

test("Alberta: uses weekly overtime when it is greater than daily overtime", () => {
  const result = applyOvertime(week([8, 8, 8, 8, 8, 8]), AB);
  assert.deepEqual(inHours(result, "overtimeMilliseconds"), [0, 0, 0, 0, 0, 4]);
});

test("BC: daily overtime past 8 hours, weekly overtime past 40 regular hours, no double counting", () => {
  const daily = applyOvertime(week([10, 10, 10, 10, 10]), BC);
  assert.deepEqual(inHours(daily, "regularMilliseconds"), [8, 8, 8, 8, 8]);
  assert.deepEqual(inHours(daily, "overtimeMilliseconds"), [2, 2, 2, 2, 2]);
  const weekly = applyOvertime(week([8, 8, 8, 8, 8, 8]), BC);
  assert.deepEqual(inHours(weekly, "overtimeMilliseconds"), [0, 0, 0, 0, 0, 8]);
  const both = applyOvertime(week([12, 12, 12, 12, 8]), BC);
  assert.equal(totalsFor(both).regularMilliseconds / HOUR, 40);
  assert.equal(totalsFor(both).overtimeMilliseconds / HOUR, 16);
});

test("BC: time past 12 hours in a day is double time, not overtime", () => {
  const [result] = applyOvertime([day("2026-11-02", 14)], BC);
  assert.equal(result.regularMilliseconds / HOUR, 8);
  assert.equal(result.overtimeMilliseconds / HOUR, 4);
  assert.equal(result.doubleTimeMilliseconds / HOUR, 2);
  assert.equal(result.regularMilliseconds + result.overtimeMilliseconds + result.doubleTimeMilliseconds, 14 * HOUR);
});

test("Holiday week: Yukon's weekly limit drops from 40 to 32 hours", () => {
  assert.equal(weeklyLimitForWeek(YT, 0), 40 * HOUR);
  assert.equal(weeklyLimitForWeek(YT, 1), 32 * HOUR);
  const withHoliday = applyOvertime(week([8, 8, 8, 8, 8]), YT, { holidays: ["2026-11-06"] });
  assert.equal(totalsFor(withHoliday).overtimeMilliseconds / HOUR, 8);
  // Without a holiday calendar the result is unchanged from before holidays were supported.
  assert.equal(totalsFor(applyOvertime(week([8, 8, 8, 8, 8]), YT)).overtimeMilliseconds, 0);
});

test("Holiday hours: Quebec counts paid holiday time toward the 40-hour limit", () => {
  const result = applyOvertime(week([9, 9, 9, 9]), QC, { holidayHours: { "2026-11-06": 8 * HOUR } });
  assert.equal(totalsFor(result).regularMilliseconds / HOUR, 32);
  assert.equal(totalsFor(result).overtimeMilliseconds / HOUR, 4);
});

test("No rule means every hour is regular", () => {
  const result = applyOvertime(week([14]), null);
  assert.equal(result[0].regularMilliseconds, 14 * HOUR);
  assert.equal(result[0].overtimeMilliseconds + result[0].doubleTimeMilliseconds, 0);
});

test("Breaks are not paid and overnight shifts stay on their clock-in date", () => {
  const [record] = buildDailyRecords([
    { punch_type: "clock_in", punched_at: "2026-11-02T20:00:00Z" },
    { punch_type: "break_start", punched_at: "2026-11-02T23:00:00Z" },
    { punch_type: "break_end", punched_at: "2026-11-03T00:00:00Z" },
    { punch_type: "clock_out", punched_at: "2026-11-03T05:00:00Z" }
  ], "UTC");
  assert.equal(record.date, "2026-11-02");
  assert.equal(record.workedMilliseconds, 8 * HOUR);
  assert.equal(record.breakMilliseconds, 1 * HOUR);
});

test("An open shift counts until now on the employee page, and is a missing punch for payroll", () => {
  const punches = [{ punch_type: "clock_in", punched_at: "2026-11-02T13:00:00Z" }];
  const [live] = buildShifts(punches, "UTC", { now: "2026-11-02T16:00:00Z" });
  assert.equal(live.inProgress, true);
  assert.equal(live.missingPunch, false);
  assert.equal(live.workedMilliseconds, 3 * HOUR);
  const [payroll] = buildShifts(punches, "UTC");
  assert.equal(payroll.missingPunch, true);
  assert.equal(payroll.workedMilliseconds, 0);
  const [nextDay] = buildShifts(punches, "UTC", { now: "2026-11-03T16:00:00Z" });
  assert.equal(nextDay.missingPunch, true);
});

test("Manager timecards and the employee page get the same numbers from the same punches", () => {
  const punches = [];
  for (let date = 2; date <= 13; date += 1) {
    const d = String(date).padStart(2, "0");
    punches.push({ punch_type: "clock_in", punched_at: `2026-11-${d}T13:00:00Z` },
      { punch_type: "clock_out", punched_at: `2026-11-${d}T23:30:00Z` });
  }
  const employee = { id: "e1", first_name: "Test", last_name: "Person", province: "ON" };
  for (const rule of [ON, AB, BC]) {
    const manager = summarizeEmployee(employee, punches, rule, getPayPeriod(2026, 10, 1, "America/Toronto"));
    const page = applyOvertime(buildDailyRecords(punches, "America/Toronto"), rule)
      .filter(record => record.date >= "2026-11-01" && record.date <= "2026-11-15");
    const pageTotals = totalsFor(page);
    for (const field of ["totalMilliseconds", "regularMilliseconds", "overtimeMilliseconds", "doubleTimeMilliseconds"]) {
      assert.equal(manager[field], pageTotals[field], `${rule.calculation_method} ${field}`);
    }
    assert.equal(manager.regularMilliseconds + manager.overtimeMilliseconds + manager.doubleTimeMilliseconds,
      manager.totalMilliseconds);
  }
});
