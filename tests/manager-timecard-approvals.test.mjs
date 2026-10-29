import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import approvalHandler from "../api/manager-timecard-approvals.js";
import timecardsHandler from "../api/manager-timecards.js";

function response() {
  return { statusCode: null, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
}

function installEnvironment(role = "manager") {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  const approvals = [];
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", email: "manager@example.com" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role, organization_id: "11111111-1111-4111-8111-111111111111" }]));
    if (url.includes("/organizations?")) return new Response(JSON.stringify([{id:"11111111-1111-4111-8111-111111111111"}]));
    if (url.includes("/manager_workplaces?")) return new Response(JSON.stringify([{workplace_id:"66666666-6666-4666-8666-666666666666"}]));
    if (url.includes("/workplaces?")) return new Response(JSON.stringify([{id:"66666666-6666-4666-8666-666666666666"}]));
    if (url.includes("/employee_workplaces?")) return new Response(JSON.stringify([{employee_id:"44444444-4444-4444-8444-444444444444",workplace_id:"66666666-6666-4666-8666-666666666666"},{employee_id:"55555555-5555-4555-8555-555555555555",workplace_id:"66666666-6666-4666-8666-666666666666"}]));
    if (url.includes("/employees?") && url.includes("select=id,organization_id")) return new Response(JSON.stringify([{id:"44444444-4444-4444-8444-444444444444",organization_id:"11111111-1111-4111-8111-111111111111"},{id:"55555555-5555-4555-8555-555555555555",organization_id:"11111111-1111-4111-8111-111111111111"}]));
    if (url.includes("/employees?") && url.includes("is_active=eq.true") && url.includes("select=id")) {
      return new Response(JSON.stringify([
        { id: "44444444-4444-4444-8444-444444444444", province: "AB" },
        { id: "55555555-5555-4555-8555-555555555555", province: "ON" }
      ]));
    }
    if (url.includes("/timecard_approvals") && options.method === "POST") {
      for (const record of JSON.parse(options.body)) {
        if (!approvals.some(value => value.employee_id === record.employee_id && value.period_start === record.period_start && value.period_end === record.period_end)) {
          approvals.push({ id: `approval-${approvals.length + 1}`, ...record });
        }
      }
      return new Response(null, { status: 201 });
    }
    if (url.includes("/timecard_approvals?")) return new Response(JSON.stringify(approvals));
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { approvals, requests, restore() { global.fetch = originalFetch; process.env = originalEnv; } };
}

test("invalid ID in approval batch rejects all records without partial approval", async () => {
  const environment = installEnvironment();
  try {
    const res = response();
    await approvalHandler({ method: "POST", headers: { authorization: "Bearer manager" },
      body: { employeeIds: ["44444444-4444-4444-8444-444444444444", { bad: "id" }], period: "2026-09-2" } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(environment.approvals.length, 0);
    assert.equal(environment.requests.some(({ url }) => url.includes("/timecard_approvals")), false);
  } finally { environment.restore(); }
});

test("ordinary employees cannot approve timecards", async () => {
  const environment = installEnvironment("employee");
  try {
    const res = response();
    await approvalHandler({ method: "POST", headers: { authorization: "Bearer employee" }, body: { employeeIds: ["44444444-4444-4444-8444-444444444444"], period: "2026-09-2" } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(environment.approvals.length, 0);
  } finally { environment.restore(); }
});

test("manager approval persists canonical dates, approver, timestamp, and is idempotent", async () => {
  const environment = installEnvironment();
  try {
    const request = { method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeIds: ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"], period: "2026-09-2" } };
    const first = response();
    await approvalHandler(request, first);
    assert.equal(first.statusCode, 200);
    assert.equal(first.payload.approvals.length, 2);
    assert.equal(environment.approvals.length, 2);
    for (const approval of environment.approvals) {
      assert.equal(approval.period_start, "2026-09-16");
      assert.equal(approval.period_end, "2026-09-30");
      assert.equal(approval.approved_by, "33333333-3333-4333-8333-333333333333");
      assert.equal(approval.status, "approved");
      assert.match(approval.approved_at, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(environment.approvals[0].work_timezone, "America/Edmonton");
    assert.equal(environment.approvals[1].work_timezone, "America/Toronto");
    const originalApproval = { ...environment.approvals[0] };
    const retry = response();
    await approvalHandler(request, retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(environment.approvals.length, 2);
    assert.deepEqual(environment.approvals[0], originalApproval);
    assert.equal(environment.requests.some(({ options }) => options.headers?.Prefer === "resolution=ignore-duplicates,return=minimal"), true);
  } finally { environment.restore(); }
});

test("manager timecards return a persisted approval as Approved", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  global.fetch = async url => {
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "33333333-3333-4333-8333-333333333333" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role: "manager", organization_id: "11111111-1111-4111-8111-111111111111" }]));
    if (url.includes("/organizations?")) return new Response(JSON.stringify([{id:"11111111-1111-4111-8111-111111111111"}]));
    if (url.includes("/manager_workplaces?")) return new Response(JSON.stringify([{workplace_id:"66666666-6666-4666-8666-666666666666"}]));
    if (url.includes("/workplaces?")) return new Response(JSON.stringify([{id:"66666666-6666-4666-8666-666666666666"}]));
    if (url.includes("/employee_workplaces?")) return new Response(JSON.stringify([{employee_id:"44444444-4444-4444-8444-444444444444",workplace_id:"66666666-6666-4666-8666-666666666666"},{employee_id:"55555555-5555-4555-8555-555555555555",workplace_id:"66666666-6666-4666-8666-666666666666"}]));
    if (url.includes("/employees?") && url.includes("select=id,organization_id")) return new Response(JSON.stringify([{id:"44444444-4444-4444-8444-444444444444",organization_id:"11111111-1111-4111-8111-111111111111"},{id:"55555555-5555-4555-8555-555555555555",organization_id:"11111111-1111-4111-8111-111111111111"}]));
    if (url.includes("/employees?")) return new Response(JSON.stringify([{ id: "44444444-4444-4444-8444-444444444444", first_name: "Ada", last_name: "Lovelace", province: "AB" }]));
    if (url.includes("/overtime_rules?")) return new Response(JSON.stringify([]));
    if (url.includes("/punches?")) return new Response(JSON.stringify([]));
    if (url.includes("/timecard_approvals?")) return new Response(JSON.stringify([{ id: "approval-1", employee_id: "44444444-4444-4444-8444-444444444444", status: "approved", approved_by: "33333333-3333-4333-8333-333333333333", approved_at: "2026-10-15T20:00:00Z", period_start: "2026-10-01", period_end: "2026-10-15" }]));
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const res = response();
    await timecardsHandler({ method: "GET", headers: { authorization: "Bearer manager" }, query: { period: "2026-10-1" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.timecards[0].approvalStatus, "Approved");
    assert.equal(res.payload.timecards[0].approval.approved_by, "33333333-3333-4333-8333-333333333333");
  } finally { global.fetch = originalFetch; process.env = originalEnv; }
});

test("approval migration enforces uniqueness and blocks all punch mutations only inside approved local dates", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202610040001_timecard_approvals.sql", import.meta.url), "utf8");
  assert.match(sql, /unique \(employee_id, period_start, period_end\)/i);
  assert.match(sql, /before insert or update or delete on public\.punches/i);
  assert.match(sql, /work_timezone text not null/i);
  assert.match(sql, /target_punched_at at time zone a\.work_timezone/i);
  assert.doesNotMatch(sql, /employee_work_timezone\(province_code/i);
  assert.match(sql, /if exists[\s\S]+raise exception/i);
  assert.match(sql, /return new;/i);
});
