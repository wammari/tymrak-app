import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import handler, { validateRange, yearEarlier } from "../api/hours-report.js";
import { addDays, payPeriodFor, normalizePayTimeline } from "../pay-periods.js";
import { PostgrestResponse } from "./_postgrest-response.mjs";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ADMIN = "11111111-1111-4111-8111-111111111111";
const ANA = "a1111111-1111-4111-8111-111111111111", SAM = "a2222222-2222-4222-8222-222222222222", PAT = "a3333333-3333-4333-8333-333333333333";
const schedule = normalizePayTimeline({ pay_frequency: "semi_monthly", pay_period_anchor: null });
const json = (body, status = 200) => new PostgrestResponse(JSON.stringify(body), { status });
const response = () => ({ statusCode: null, payload: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } });

// Nine-hour weekdays (45 a week: 44 regular + 1 overtime in Ontario).
function weekdays(employeeId, from, to) {
  const punches = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    punches.push({ id: `${employeeId}${day}i`, employee_id: employeeId, punch_type: "clock_in", punched_at: `${day}T13:00:00Z` },
      { id: `${employeeId}${day}o`, employee_id: employeeId, punch_type: "clock_out", punched_at: `${day}T22:00:00Z` });
  }
  return punches;
}
function approvedPeriods(employeeId, from, to) {
  const rows = [];
  for (let p = payPeriodFor(from, schedule); p.startKey <= to; p = payPeriodFor(addDays(p.endKey, 1), schedule)) rows.push({ employee_id: employeeId, period_start: p.startKey, period_end: p.endKey });
  return rows;
}

function install(role = "admin") {
  const original = global.fetch, env = { ...process.env }, calls = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  const employees = [
    { id: ANA, first_name: "Ana", last_name: "Lopez", province: "ON", is_active: true },
    { id: SAM, first_name: "Sam", last_name: "Lee", province: "ON", is_active: true },
    { id: PAT, first_name: "Pat", last_name: "Former", province: "ON", is_active: false }
  ];
  // More than 1,000 punches in all, so the report has to read them in pages.
  const punches = [...weekdays(PAT, "2025-01-01", "2025-12-31"), ...weekdays(ANA, "2025-10-01", "2026-11-20"), ...weekdays(SAM, "2026-11-02", "2026-11-13")]
    .sort((a, b) => a.punched_at.localeCompare(b.punched_at) || a.id.localeCompare(b.id));
  const approvals = [...approvedPeriods(ANA, "2025-10-01", "2026-11-15"), ...approvedPeriods(PAT, "2025-01-01", "2025-12-31")];
  global.fetch = async url => {
    const u = decodeURIComponent(String(url)); calls.push(u);
    const page = rows => { const limit = Number(/limit=(\d+)/.exec(u)?.[1] ?? rows.length), offset = Number(/offset=(\d+)/.exec(u)?.[1] ?? 0); return json(rows.slice(offset, offset + limit)); };
    if (u.endsWith("/auth/v1/user")) return json({ id: ADMIN });
    if (u.includes("/user_roles?")) return json([{ role, organization_id: COMPANY, organization: { name: "Shop", is_active: true } }]);
    if (u.endsWith("/rpc/manager_employee_scope")) return json({ employeeIds: [ANA] });
    if (u.includes("/organizations?id=")) return json([{ pay_frequency: "semi_monthly", pay_period_anchor: null, pay_schedule_changes: [] }]);
    if (u.includes("/employees?")) return json(employees);
    if (u.includes("/overtime_rules?")) return json([{ province_code: "ON", calculation_method: "weekly_only", weekly_overtime_enabled: true, weekly_threshold_hours: "44.00", daily_overtime_enabled: false, week_start_day: 0, effective_from: "2020-01-01", effective_to: null }]);
    if (u.includes("/punches?") && u.includes("select=punched_at&")) return json([{ punched_at: punches[0].punched_at }]);
    if (u.includes("/punches?")) return page(punches);
    if (u.includes("/timecard_approvals?")) return page(approvals);
    throw new Error(`Unexpected URL: ${u}`);
  };
  return { calls, punches, restore() { global.fetch = original; process.env = env; } };
}
async function call(query) {
  const res = response();
  await handler({ method: "GET", headers: { authorization: "Bearer token" }, query }, res);
  return res;
}

test("only admins see the hours report", async () => {
  const fake = install("manager");
  try { assert.equal((await call({ from: "2026-11-01", to: "2026-11-15" })).statusCode, 403); } finally { fake.restore(); }
});

test("a range is compared with the same dates a year earlier, approved hours only", async () => {
  const fake = install();
  try {
    assert.ok(fake.punches.length > 1000);
    const res = await call({ from: "2026-11-01", to: "2026-11-15" });
    assert.equal(res.statusCode, 200);
    const r = res.payload;
    assert.deepEqual(r.previous, { from: "2025-11-01", to: "2025-11-15" });
    // Ana: two 45-hour weeks = 88 regular + 2 overtime. Sam's hours aren't approved.
    assert.deepEqual(r.totals, { employees: 1, regularHours: 88, overtimeHours: 2, doubleTimeHours: 0, totalHours: 90 });
    assert.equal(r.unapprovedHours, 90);
    // The year before: Ana 90 and Pat (who has since left) 90.
    assert.deepEqual(r.previousTotals, { employees: 2, regularHours: 176, overtimeHours: 4, doubleTimeHours: 0, totalHours: 180 });
    const rows = Object.fromEntries(r.employees.map(e => [e.name, e]));
    assert.equal(rows["Ana Lopez"].current.totalHours, 90);
    assert.equal(rows["Ana Lopez"].previous.totalHours, 90);
    assert.equal(rows["Pat Former"].leftCompany, true);
    assert.equal(rows["Pat Former"].current.totalHours, 0);
    assert.equal(rows["Pat Former"].previous.totalHours, 90);
    assert.equal(rows["Sam Lee"], undefined, "no approved hours in either range");
    assert.deepEqual(r.months, [{ month: "2026-11", current: { regularHours: 88, overtimeHours: 2, doubleTimeHours: 0, totalHours: 90 }, previous: { regularHours: 176, overtimeHours: 4, doubleTimeHours: 0, totalHours: 180 } }]);
    assert.equal(r.firstRecord, "2025-01-01");
    assert.ok(fake.calls.some(u => u.includes("/punches?") && u.includes("offset=1000")), "punches were read in pages");
  } finally { fake.restore(); }
});

test("a range that starts or ends mid-week still uses the whole week for overtime", async () => {
  const fake = install();
  try {
    // Nov 5 (Thu) to Nov 10 (Tue): Thu 9, Fri 8 + 1 overtime (the 45th hour of the week), Mon 9, Tue 9.
    const r = (await call({ from: "2026-11-05", to: "2026-11-10", compare: "false" })).payload;
    assert.deepEqual(r.totals, { employees: 1, regularHours: 35, overtimeHours: 1, doubleTimeHours: 0, totalHours: 36 });
    assert.equal(r.previous, null);
    assert.equal(r.previousTotals, null);
  } finally { fake.restore(); }
});

test("a long range adds up month by month across pay periods", async () => {
  const fake = install();
  try {
    const r = (await call({ from: "2025-01-01", to: "2025-12-31", compare: "false" })).payload;
    assert.equal(r.months.length, 12);
    const sum = r.months.reduce((s, m) => s + m.current.totalHours, 0);
    assert.equal(Math.round(sum * 100) / 100, r.totals.totalHours);
    assert.equal(r.employees.find(e => e.name === "Pat Former").current.totalHours, 261 * 9, "every 2025 weekday at 9 hours");
  } finally { fake.restore(); }
});

test("dates are checked", () => {
  assert.equal(validateRange("2026-11-10", "2026-11-01", "2026-11-22"), "The start date must be before the end date.");
  assert.equal(validateRange("2026-12-01", "2026-12-31", "2026-11-22"), "The start date can't be in the future.");
  assert.equal(validateRange("2023-01-01", "2026-11-01", "2026-11-22"), "Choose a range of two years or less.");
  assert.equal(validateRange("nonsense", "2026-11-01", "2026-11-22"), "Choose a start and end date.");
  assert.equal(validateRange("2026-01-01", "2026-12-31", "2026-11-22"), null, "an end date in the future is allowed and trimmed to today");
  assert.equal(yearEarlier("2028-02-29"), "2027-02-28");
});

test("the page is admin-only, safe and linked from the Manager Portal", () => {
  const page = fs.readFileSync(new URL("../hours-report.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /innerHTML/);
  assert.match(page, /needsCompanyChoice\(session\)/);
  assert.match(page, /\/\^\[=\+\\-@\\t\\r\]\//, "CSV cells are formula-safe");
  const manager = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(manager, /\$\("hoursLink"\)\.hidden=data\.role!=="admin"/);
});
