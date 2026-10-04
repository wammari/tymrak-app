import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/manager-timecards.js";
import {
  applyOvertime, buildShifts, getCurrentPayPeriod, getPreviousPayPeriod,
  periodFromKey, summarizeEmployee
} from "../api/_manager-timecards.js";

function response() {
  return { statusCode: null, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
}

async function withEnvironment(role, callback) {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-only-secret";
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1", email: "manager@example.com" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role }]));
    if (url.includes("/employees?")) return new Response(JSON.stringify([]));
    if (url.includes("/overtime_rules?")) return new Response(JSON.stringify([]));
    throw new Error(`Unexpected URL: ${url}`);
  };
  try { await callback(calls); } finally { global.fetch = originalFetch; process.env = originalEnv; }
}

test("anonymous manager-timecard access is rejected", async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const res = response();
    await handler({ method: "GET", headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(called, false);
  } finally { global.fetch = originalFetch; }
});

test("ordinary employees cannot access manager timecards", async () => {
  await withEnvironment("employee", async () => {
    const res = response();
    await handler({ method: "GET", headers: { authorization: "Bearer employee" }, query: {} }, res);
    assert.equal(res.statusCode, 403);
  });
});

for (const role of ["manager", "admin"]) {
  test(`${role} can access manager timecards`, async () => {
    await withEnvironment(role, async calls => {
      const res = response();
      await handler({ method: "GET", headers: { authorization: `Bearer ${role}` }, query: {} }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.payload.timecards, []);
      assert.equal(calls.some(call => call.url.includes("/employees?")), true);
    });
  });
}

test("semi-monthly current, previous, and month-end periods are timezone safe", () => {
  const current = getCurrentPayPeriod(new Date("2026-10-04T18:00:00Z"), "America/Edmonton");
  assert.equal(current.key, "2026-10-1");
  assert.equal(current.start.toISOString(), "2026-10-01T06:00:00.000Z");
  assert.equal(current.end.toISOString(), "2026-10-16T05:59:59.999Z");
  const previous = getPreviousPayPeriod(current, "America/Edmonton");
  assert.equal(previous.key, "2026-09-2");
  assert.equal(previous.end.toISOString(), "2026-10-01T05:59:59.999Z");
  assert.equal(periodFromKey("2028-02-2", new Date("2028-03-01T12:00:00Z"), "America/Edmonton").end.toISOString(), "2028-03-01T06:59:59.999Z");
  assert.equal(periodFromKey("2026-10-2", new Date("2026-10-04T18:00:00Z"), "America/Edmonton"), null);
});

const albertaRule = { daily_threshold_hours: 8, weekly_threshold_hours: 44,
  daily_overtime_enabled: true, weekly_overtime_enabled: true,
  calculation_method: "greater_daily_or_weekly", week_start_day: 0 };

test("active employee with no punches remains in summary with zero hours", () => {
  const period = getCurrentPayPeriod(new Date("2026-10-04T18:00:00Z"), "America/Edmonton");
  const summary = summarizeEmployee({ id: "e1", first_name: "No", last_name: "Punches", province: "AB" }, [], albertaRule, period);
  assert.equal(summary.totalMilliseconds, 0);
  assert.equal(summary.exceptionCount, 0);
  assert.deepEqual(summary.days, []);
});

test("API does not require an overtime rule for an employee with no punches", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-only-secret";
  global.fetch = async url => {
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "manager-1" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role: "manager" }]));
    if (url.includes("/employees?")) return new Response(JSON.stringify([
      { id: "employee-1", first_name: "No", last_name: "Punches", province: "YT" }
    ]));
    if (url.includes("/overtime_rules?")) return new Response(JSON.stringify([]));
    if (url.includes("/punches?")) return new Response(JSON.stringify([]));
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const res = response();
    await handler({ method: "GET", headers: { authorization: "Bearer manager" }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.timecards[0].totalMilliseconds, 0);
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("Supabase failures log safe structured query diagnostics", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const originalEnv = { ...process.env };
  const logs = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret-must-not-be-logged";
  console.error = (...values) => logs.push(values);
  global.fetch = async url => {
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "manager-1" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role: "manager" }]));
    if (url.includes("/employees?")) return new Response(JSON.stringify({
      code: "42703", message: "column employees.province does not exist"
    }), { status: 400 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const res = response();
    await handler({ method: "GET", headers: { authorization: "Bearer access-token-must-not-be-logged" }, query: {} }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(logs.at(-1), [
      "Manager timecard Supabase request failed",
      {
        stage: "employees_query", resource: "employees",
        query: "active_employee_timecard_fields", status: 400,
        code: "42703", message: "column employees.province does not exist"
      }
    ]);
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, /server-secret-must-not-be-logged/);
    assert.doesNotMatch(serialized, /access-token-must-not-be-logged/);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    process.env = originalEnv;
  }
});

test("incomplete sequence is a Missing Punch exception", () => {
  const shifts = buildShifts([{ id: "p1", punch_type: "clock_in", punched_at: "2026-10-02T14:00:00Z" }], "America/Edmonton");
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].missingPunch, true);
});

test("Alberta twelve-hour shift is eight regular and four overtime", () => {
  const shifts = buildShifts([
    { punch_type: "clock_in", punched_at: "2026-10-02T14:00:00Z" },
    { punch_type: "clock_out", punched_at: "2026-10-03T02:00:00Z" }
  ], "America/Edmonton");
  const [calculated] = applyOvertime(shifts, albertaRule);
  assert.equal(calculated.workedMilliseconds, 12 * 3600000);
  assert.equal(calculated.regularMilliseconds, 8 * 3600000);
  assert.equal(calculated.overtimeMilliseconds, 4 * 3600000);
});

test("overnight punches are paired before grouping on the clock-in date", () => {
  const [shift] = buildShifts([
    { punch_type: "clock_in", punched_at: "2026-10-03T04:00:00Z" },
    { punch_type: "clock_out", punched_at: "2026-10-03T12:00:00Z" }
  ], "America/Edmonton");
  assert.equal(shift.date, "2026-10-02");
  assert.equal(shift.workedMilliseconds, 8 * 3600000);
  assert.equal(shift.missingPunch, false);
});
