import "./_test-environment.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import approvalHandler from "../api/manager-timecard-approvals.js";
import reopenHandler from "../api/manager-timecard-reopen.js";
import timecardsHandler from "../api/manager-timecards.js";
import { payPeriodFor } from "../pay-periods.js";
import { todayKey } from "../api/_pay-schedule.js";
import { PostgrestResponse } from "./_postgrest-response.mjs";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WEEKLY = { pay_frequency: "weekly", pay_period_anchor: "2026-11-02" };

function response() {
  return { statusCode: null, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
}

// A fake database for one company with the given pay schedule row.
function install(scheduleRow, { scheduleStatus = 200 } = {}) {
  const originalFetch = global.fetch, originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  const approvals = [], requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/auth/v1/user")) return new PostgrestResponse(JSON.stringify({ id: "manager-id" }));
    if (url.includes("/user_roles?")) return new PostgrestResponse(JSON.stringify([{ role: "admin", organization_id: COMPANY, organization: { is_active: true } }]));
    if (url.includes("/organizations?id=")) return new PostgrestResponse(JSON.stringify(scheduleRow ? [scheduleRow] : []), { status: scheduleStatus });
    if (url.includes("/employees?") && url.includes("select=id,province")) return new PostgrestResponse(JSON.stringify([{ id: "employee-1", province: "ON" }]));
    if (url.includes("/employees?") && url.includes("select=id&")) return new PostgrestResponse(JSON.stringify([{ id: "employee-1" }]));
    if (url.includes("/employees?")) return new PostgrestResponse(JSON.stringify([{ id: "employee-1", first_name: "Ada", last_name: "Lovelace", province: "ON" }]));
    if (url.includes("/overtime_rules?")) return new PostgrestResponse(JSON.stringify([{ province_code: "ON", calculation_method: "weekly_only", weekly_overtime_enabled: true, weekly_threshold_hours: "44.00", daily_overtime_enabled: false, week_start_day: 0, effective_from: "2026-01-01", effective_to: null }]));
    if (url.includes("/punches?")) return new PostgrestResponse(JSON.stringify([
      { employee_id: "employee-1", punch_type: "clock_in", punched_at: "2026-11-09T14:00:00Z" },
      { employee_id: "employee-1", punch_type: "clock_out", punched_at: "2026-11-09T22:00:00Z" },
      { employee_id: "employee-1", punch_type: "clock_in", punched_at: "2026-11-16T14:00:00Z" },
      { employee_id: "employee-1", punch_type: "clock_out", punched_at: "2026-11-16T20:00:00Z" }
    ]));
    if (url.includes("/timecard_approvals") && options.method === "POST") { approvals.push(...JSON.parse(options.body)); return new PostgrestResponse(null, { status: 201 }); }
    if (url.includes("/employee_pay_rates?")) return new PostgrestResponse("[]");
    if (url.includes("/timecard_approvals?")) return new PostgrestResponse(JSON.stringify(url.includes("select=id,employee_id,status,approved_by") ? approvals.map((record, index) => ({ id: `approval-${index + 1}`, ...record })) : []));
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { approvals, requests, restore() { global.fetch = originalFetch; process.env = originalEnv; } };
}

async function getTimecards(period) {
  const res = response();
  await timecardsHandler({ method: "GET", headers: { authorization: "Bearer manager" }, query: period ? { period } : {} }, res);
  return res;
}

test("a weekly company's manager timecards show its weekly period and move a week at a time", async () => {
  const env = install(WEEKLY);
  try {
    const current = payPeriodFor(todayKey(), { frequency: "weekly", anchorDate: "2026-11-02" });
    const res = await getTimecards();
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.period.startDate, current.startKey);
    assert.equal(res.payload.period.endDate, current.endKey);
    assert.equal(res.payload.period.current, true);
    assert.equal(res.payload.period.nextKey, null);
    assert.equal(res.payload.paySchedule.frequency, "weekly");
    const lastWeek = await getTimecards(res.payload.period.previousKey);
    assert.equal(lastWeek.statusCode, 200);
    assert.equal(Date.parse(current.startKey) - Date.parse(lastWeek.payload.period.startDate), 7 * 86400000);
    assert.equal(lastWeek.payload.period.nextKey, current.key);
  } finally { env.restore(); }
});

test("hours are counted only inside the selected weekly period", async () => {
  const env = install(WEEKLY);
  try {
    const res = await getTimecards("2026-11-09");
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.period.startDate, "2026-11-09");
    assert.equal(res.payload.period.endDate, "2026-11-15");
    assert.equal(res.payload.timecards[0].totalMilliseconds, 8 * 3600000);
  } finally { env.restore(); }
});

test("approving a weekly period saves that week's start and end dates", async () => {
  const env = install(WEEKLY);
  try {
    const res = response();
    await approvalHandler({ method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeIds: ["employee-1"], period: "2026-11-09" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(env.approvals.length, 1);
    assert.equal(env.approvals[0].period_start, "2026-11-09");
    assert.equal(env.approvals[0].period_end, "2026-11-15");
  } finally { env.restore(); }
});

test("a weekly company refuses period codes from another schedule, or mid-week dates", async () => {
  const env = install(WEEKLY);
  try {
    for (const period of ["2026-11-1", "2026-11-10"]) {
      const approve = response();
      await approvalHandler({ method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeIds: ["employee-1"], period } }, approve);
      assert.equal(approve.statusCode, 400, period);
      const reopen = response();
      await reopenHandler({ method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeId: "employee-1", period } }, reopen);
      assert.equal(reopen.statusCode, 400, period);
      assert.equal((await getTimecards(period)).statusCode, 400, period);
    }
    assert.equal(env.approvals.length, 0);
  } finally { env.restore(); }
});

test("approving or reopening needs a named period, never a silent default", async () => {
  const env = install(WEEKLY);
  try {
    const approve = response();
    await approvalHandler({ method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeIds: ["employee-1"] } }, approve);
    assert.equal(approve.statusCode, 400);
    const reopen = response();
    await reopenHandler({ method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeId: "employee-1" } }, reopen);
    assert.equal(reopen.statusCode, 400);
  } finally { env.restore(); }
});

test("timecards are not shown with a guessed schedule when the schedule cannot be read", async () => {
  for (const [row, options] of [[null, {}], [WEEKLY, { scheduleStatus: 500 }], [{ pay_frequency: "biweekly", pay_period_anchor: null }, {}]]) {
    const env = install(row, options);
    try {
      const res = await getTimecards();
      assert.equal(res.statusCode, 500);
      assert.equal(env.requests.some(request => request.url.includes("/punches?")), false);
    } finally { env.restore(); }
  }
});

test("after a schedule change, managers see old periods under the old schedule and new ones under the new", async () => {
  const env = install({ pay_frequency: "semi_monthly", pay_period_anchor: null,
    pay_schedule_changes: [{ id: 1, pay_frequency: "biweekly", pay_period_anchor: "2026-11-16", effective_from: "2026-11-16" }] });
  try {
    const before = await getTimecards("2026-11-1");
    assert.equal(before.statusCode, 200);
    assert.deepEqual([before.payload.period.startDate, before.payload.period.endDate], ["2026-11-01", "2026-11-15"]);
    assert.equal(before.payload.period.nextKey, "2026-11-16", "the next period is the first two-week one");
    const after = await getTimecards("2026-11-16");
    assert.equal(after.statusCode, 200);
    assert.deepEqual([after.payload.period.startDate, after.payload.period.endDate], ["2026-11-16", "2026-11-29"]);
    assert.equal(after.payload.period.previousKey, "2026-11-1");
    assert.equal((await getTimecards("2026-11-2")).statusCode, 400, "the old second-half code no longer exists");
    const approve = response();
    await approvalHandler({ method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeIds: ["employee-1"], period: "2026-11-16" } }, approve);
    assert.equal(approve.statusCode, 200);
    assert.deepEqual([env.approvals[0].period_start, env.approvals[0].period_end], ["2026-11-16", "2026-11-29"]);
  } finally { env.restore(); }
});
