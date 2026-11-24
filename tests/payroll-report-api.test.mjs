import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import handler from "../api/payroll-report.js";
import { normalizePayTimeline, previousPayPeriod } from "../pay-periods.js";
import { requestedPayPeriod } from "../api/_pay-schedule.js";
import { PostgrestResponse } from "./_postgrest-response.mjs";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ADMIN = "11111111-1111-4111-8111-111111111111";
const schedule = normalizePayTimeline({ pay_frequency: "semi_monthly", pay_period_anchor: null });
const PERIOD = previousPayPeriod(requestedPayPeriod(null, schedule), schedule);
const json = (body, status = 200) => new PostgrestResponse(JSON.stringify(body), { status });
const response = () => ({ statusCode: null, payload: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } });

// Ten-hour days (Toronto) on the first five weekdays after the period starts: 50 hours.
function workWeek(employeeId, days = 5) {
  const punches = [], start = new Date(`${PERIOD.startKey}T12:00:00Z`);
  for (let d = 1; punches.length < days * 2; d++) {
    const day = new Date(start.getTime() + d * 86400000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const date = day.toISOString().slice(0, 10);
    punches.push({ id: `${employeeId}${date}i`, employee_id: employeeId, punch_type: "clock_in", punched_at: `${date}T13:00:00Z` },
      { id: `${employeeId}${date}o`, employee_id: employeeId, punch_type: "clock_out", punched_at: `${date}T23:00:00Z` });
  }
  return punches;
}

function install(role = "admin") {
  const original = global.fetch, env = { ...process.env }, calls = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  const employees = [
    { id: "e-ana", first_name: "Ana", last_name: "Lopez", email: "ana@shop.ca", province: "ON", is_active: true },
    { id: "e-sam", first_name: "Sam", last_name: "Lee", email: "sam@shop.ca", province: "ON", is_active: true },
    { id: "e-idle", first_name: "Ida", last_name: "Idle", email: "", province: "ON", is_active: true },
    { id: "e-pat", first_name: "Pat", last_name: "Former", email: "pat@shop.ca", province: "ON", is_active: false },
    { id: "e-gone", first_name: "Gail", last_name: "Gone", email: "", province: "ON", is_active: false },
    { id: "e-nun", first_name: "Nu", last_name: "Nunavut", email: "", province: "NU", is_active: true }
  ];
  const punches = [...workWeek("e-ana"), ...workWeek("e-sam", 2), ...workWeek("e-pat", 1), ...workWeek("e-nun", 1)];
  const approvals = [{ employee_id: "e-ana", approved_at: "2026-11-16T15:00:00Z" }, { employee_id: "e-pat", approved_at: "2026-11-16T15:00:00Z" }, { employee_id: "e-nun", approved_at: "2026-11-16T15:00:00Z" }];
  global.fetch = async (url, options = {}) => {
    const u = decodeURIComponent(String(url)); calls.push({ url: u, method: options.method || "GET" });
    if (u.endsWith("/auth/v1/user")) return json({ id: ADMIN, email: "owner@shop.ca" });
    if (u.includes("/user_roles?")) return json([{ role, organization_id: COMPANY, organization: { name: "Shop", is_active: true } }]);
    if (u.endsWith("/rpc/manager_employee_scope")) return json({ employeeIds: ["a1111111-1111-4111-8111-111111111111"] });
    if (u.includes("/organizations?id=")) return json([{ pay_frequency: "semi_monthly", pay_period_anchor: null, pay_schedule_changes: [] }]);
    if (u.includes("/employees?")) return json(employees);
    if (u.includes("/overtime_rules?")) return json([{ province_code: "ON", calculation_method: "weekly_only", weekly_overtime_enabled: true, weekly_threshold_hours: "44.00", daily_overtime_enabled: false, week_start_day: 0, effective_from: "2020-01-01", effective_to: null }]);
    if (u.includes("/punches?")) return json(punches);
    if (u.includes("/timecard_approvals?")) return json(approvals);
    if (u.includes("/employee_pay_rates?")) return json([{ employee_id: "e-ana", hourly_rate: "25.00", effective_from: "2020-01-01" }]);
    throw new Error(`Unexpected URL: ${u}`);
  };
  return { calls, restore() { global.fetch = original; process.env = env; } };
}
async function call(query = { period: PERIOD.key }) {
  const res = response();
  await handler({ method: "GET", headers: { authorization: "Bearer token" }, query }, res);
  return res;
}

test("only admins see the payroll report", async () => {
  const fake = install("manager");
  try {
    const res = await call();
    assert.equal(res.statusCode, 403);
    assert.equal(fake.calls.some(c => c.url.includes("/punches?")), false);
  } finally { fake.restore(); }
});

test("approved hours are split into regular, overtime and double time, company-wide", async () => {
  const fake = install();
  try {
    const res = await call();
    assert.equal(res.statusCode, 200);
    const rows = Object.fromEntries(res.payload.rows.map(r => [r.name, r]));
    assert.deepEqual([rows["Ana Lopez"].regularHours, rows["Ana Lopez"].overtimeHours, rows["Ana Lopez"].doubleTimeHours, rows["Ana Lopez"].totalHours], [44, 6, 0, 50]);
    assert.equal(rows["Ana Lopez"].approved, true);
    assert.equal(rows["Sam Lee"].approved, false, "not approved: listed but left out of totals");
    assert.equal(rows["Pat Former"].leftCompany, true, "someone who left still gets their final hours");
    assert.equal(rows["Gail Gone"], undefined, "people who left with no time aren't listed");
    assert.equal(rows["Ida Idle"].totalHours, 0);
    assert.match(rows["Nu Nunavut"].problem, /No overtime rule/);
    assert.equal(rows["Nu Nunavut"].totalHours, null);
    // Ana: 44 × $25 + 6 × $37.50 = $1,325. Pat has no rate yet.
    assert.deepEqual(res.payload.approvedTotals, { employees: 2, regularHours: 54, overtimeHours: 6, doubleTimeHours: 0, totalHours: 60, estimatedGross: 1325, withoutRate: 1 });
    assert.equal(rows["Ana Lopez"].pay.hourlyRate, 25);
    assert.equal(rows["Ana Lopez"].pay.overtimePay, 225);
    assert.equal(rows["Pat Former"].pay.hourlyRate, null);
    assert.equal(rows["Nu Nunavut"].pay, null);
    assert.equal(res.payload.notApproved, 1);
    assert.ok(fake.calls.every(c => !c.url.includes("manager_employee_scope")), "admins see the whole company");
  } finally { fake.restore(); }
});

test("future or made-up pay periods are refused", async () => {
  const fake = install();
  try {
    assert.equal((await call({ period: "2099-01-01" })).statusCode, 400);
    assert.equal((await call({ period: "nonsense" })).statusCode, 400);
  } finally { fake.restore(); }
});

test("the page keeps CSV cells safe from spreadsheet formulas and only exports approved timecards", () => {
  const page = fs.readFileSync(new URL("../payroll-report.html", import.meta.url), "utf8");
  assert.match(page, /\/\^\[=\+\\-@\\t\\r\]\//);
  assert.match(page, /report\.rows\.filter\(r=>r\.approved&&!r\.problem\)/);
  assert.doesNotMatch(page, /innerHTML/);
  const manager = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(manager, /\$\("payrollLink"\)\.hidden=data\.role!=="admin"/);
});
