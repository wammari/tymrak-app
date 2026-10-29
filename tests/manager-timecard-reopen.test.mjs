import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import approvalHandler from "../api/manager-timecard-approvals.js";
import reopenHandler from "../api/manager-timecard-reopen.js";

function response() {
  return { statusCode: null, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
}

function environment(role = "manager") {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  const approvals = [
    { id: "approval-1", employee_id: "employee-1", period_start: "2026-09-16", period_end: "2026-09-30", work_timezone: "America/Edmonton", status: "approved", approved_by: "first-manager", approved_at: "2026-10-01T00:00:00Z" },
    { id: "approval-2", employee_id: "employee-2", period_start: "2026-09-16", period_end: "2026-09-30", work_timezone: "America/Toronto", status: "approved", approved_by: "first-manager", approved_at: "2026-10-01T00:00:00Z" }
  ];
  const audit = [];
  global.fetch = async (url, options = {}) => {
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "acting-manager", email: "manager@example.com" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role }]));
    if (url.includes("/employees?") && url.includes("is_active=eq.true")) return new Response(JSON.stringify([{ id: "employee-1", province: "AB" }]));
    if (url.includes("/timecard_approvals?")) {
      let matches = approvals.filter(item => !url.includes("employee_id=eq.") || url.includes(`employee_id=eq.${item.employee_id}`));
      if (url.includes("employee_id=in.")) matches = matches.filter(item => url.includes(item.employee_id));
      if (url.includes("period_start=eq.")) matches = matches.filter(item => url.includes(`period_start=eq.${item.period_start}`) && url.includes(`period_end=eq.${item.period_end}`));
      if (options.method === "PATCH") {
        if (url.includes("status=eq.approved")) matches = matches.filter(item => item.status === "approved");
        if (url.includes("status=eq.reopened")) matches = matches.filter(item => item.status === "reopened");
        const changes = JSON.parse(options.body);
        for (const item of matches) {
          const oldStatus = item.status;
          Object.assign(item, changes);
          if (oldStatus !== item.status) audit.push({ employee_id: item.employee_id, period_start: item.period_start, period_end: item.period_end, work_timezone: item.work_timezone, action: item.status === "reopened" ? "reopened" : "re-approved", manager_user_id: item.status === "reopened" ? item.reopened_by : item.approved_by, occurred_at: item.status === "reopened" ? item.reopened_at : item.approved_at, reopen_reason: item.reopen_reason });
        }
        return new Response(options.headers.Prefer === "return=representation" ? JSON.stringify(matches) : null, { status: 200 });
      }
      return new Response(JSON.stringify(matches));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { approvals, audit, restore() { global.fetch = originalFetch; process.env = originalEnv; } };
}

async function reopen(body, headers = { authorization: "Bearer manager" }) {
  const res = response();
  await reopenHandler({ method: "POST", headers, body }, res);
  return res;
}

test("unauthenticated and employee users cannot reopen a timecard", async () => {
  let env = environment();
  try { assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2" }, {})).statusCode, 401); }
  finally { env.restore(); }
  env = environment("employee");
  try {
    assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2" })).statusCode, 403);
    assert.equal(env.approvals[0].status, "approved");
  } finally { env.restore(); }
});

test("manager reopens without a reason and records authenticated audit identity, time, and timezone", async () => {
  const env = environment();
  try {
    const res = await reopen({ employeeId: "employee-1", period: "2026-09-2", managerId: "untrusted-user" });
    assert.equal(res.statusCode, 200);
    assert.equal(env.approvals[0].status, "reopened");
    assert.equal(env.approvals[1].status, "approved");
    assert.deepEqual(env.audit.map(({ occurred_at, ...event }) => ({ ...event, hasTimestamp: /^\d{4}-\d{2}-\d{2}T/.test(occurred_at) })), [{
      employee_id: "employee-1", period_start: "2026-09-16", period_end: "2026-09-30",
      work_timezone: "America/Edmonton", action: "reopened", manager_user_id: "acting-manager",
      reopen_reason: null, hasTimestamp: true
    }]);
  } finally { env.restore(); }
});

test("blank optional reopen reason is normalized to null", async () => {
  const env = environment();
  try {
    const res = await reopen({ employeeId: "employee-1", period: "2026-09-2", reason: "   " });
    assert.equal(res.statusCode, 200);
    assert.equal(env.approvals[0].reopen_reason, null);
    assert.equal(env.audit[0].reopen_reason, null);
  } finally { env.restore(); }
});

test("approved period locks, reopen unlocks, and re-approval locks it again", async () => {
  const env = environment();
  const writable = () => env.approvals[0].status !== "approved";
  try {
    assert.equal(writable(), false);
    assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2" })).statusCode, 200);
    assert.equal(writable(), true);
    const res = response();
    await approvalHandler({ method: "POST", headers: { authorization: "Bearer manager" }, body: { employeeIds: ["employee-1"], period: "2026-09-2" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(writable(), false);
    assert.equal(env.audit.at(-1).action, "re-approved");
    assert.equal(env.audit.at(-1).manager_user_id, "acting-manager");
  } finally { env.restore(); }
});

test("audit migration preserves the database lock predicate and creates append-only transition history", () => {
  const original = fs.readFileSync(new URL("../supabase/migrations/202610040001_timecard_approvals.sql", import.meta.url), "utf8");
  const audit = fs.readFileSync(new URL("../supabase/migrations/202610040002_timecard_approval_audit.sql", import.meta.url), "utf8");
  assert.match(original, /a\.status = 'approved'/);
  assert.match(audit, /status in \('approved', 'reopened'\)/);
  assert.match(audit, /old\.status = 'approved' and new\.status = 'reopened'/);
  assert.match(audit, /old\.status = 'reopened' and new\.status = 'approved'/);
  assert.match(audit, /revoke all on table public\.timecard_approval_history from anon, authenticated/i);
  assert.match(audit, /before update or delete on public\.timecard_approval_history/i);
  assert.doesNotMatch(audit, /province/i);
});

test("follow-up migration makes reopen reasons optional without weakening actor and timestamp requirements", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202610040003_optional_timecard_reopen_reason.sql", import.meta.url), "utf8");
  assert.match(sql, /drop constraint if exists timecard_approvals_reopen_fields_check/i);
  assert.match(sql, /status = 'approved'[\s\S]+reopened_by is not null and reopened_at is not null/i);
  assert.doesNotMatch(sql, /btrim\(reopen_reason\)/i);
  assert.match(sql, /drop constraint if exists timecard_approval_history_reason_check/i);
  assert.match(sql, /\(action = 'reopened'\) or\s+\(action <> 'reopened' and reopen_reason is null\)/i);
});

test("manager UI uses confirmation-only reopen and spaces the timecard actions", () => {
  const html = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(html, /if\(!window\.confirm\(`/);
  assert.match(html, /action\.className="row-actions"/);
  for (const obsoleteIdentifier of [
    "submitReopen", "openReopen", "closeReopen", "reopenReason", "reopenModal", "reopenForm"
  ]) {
    assert.equal(html.includes(obsoleteIdentifier), false, `${obsoleteIdentifier} must not remain in manager.html`);
  }
  assert.doesNotMatch(html, /Reason for reopening/);
  assert.match(html, /JSON\.stringify\(\{employeeId:card\.employee\.id,period:selectedPeriodKey\}\)/);
});

test("corrective migration drops the exact obsolete constraint and preserves all other schema", () => {
  const original = fs.readFileSync(new URL("../supabase/migrations/202610040001_timecard_approvals.sql", import.meta.url), "utf8");
  const audit = fs.readFileSync(new URL("../supabase/migrations/202610040002_timecard_approval_audit.sql", import.meta.url), "utf8");
  const correction = fs.readFileSync(new URL("../supabase/migrations/202610070001_drop_obsolete_timecard_status_constraint.sql", import.meta.url), "utf8");
  assert.match(original, /constraint timecard_approvals_status check \(status = 'approved'\)/);
  assert.match(audit, /drop constraint if exists timecard_approvals_status_check;/);
  assert.match(audit, /add constraint timecard_approvals_status_check\s+check \(status in \('approved', 'reopened'\)\)/);
  const statements = correction.replace(/--[^\n]*/g, "").trim();
  assert.match(statements, /^alter table public\.timecard_approvals\s+drop constraint if exists timecard_approvals_status;$/i);
});

for (const operation of ["approval_lookup", "reopen_update"]) {
  test(`database failure logs safe diagnostics for ${operation} without exposing them to browser`, async () => {
    const env = environment();
    const underlyingFetch = global.fetch;
    const originalError = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args);
    global.fetch = async (url, options = {}) => {
      if (url.includes("/timecard_approvals?") &&
          (operation === "approval_lookup" || options.method === "PATCH")) {
        return new Response(JSON.stringify({
          code: "23514", message: 'violates check constraint "timecard_approvals_status" server-secret manager',
          details: "private row details", hint: "private hint"
        }), { status: 400 });
      }
      return underlyingFetch(url, options);
    };
    try {
      const result = await reopen({ employeeId: "employee-1", period: "2026-09-2" });
      assert.equal(result.statusCode, 500);
      assert.deepEqual(result.payload, { error: "Unable to reopen timecard" });
      assert.deepEqual(logs, [["Manager timecard database request failed", {
        operation, status: 400, code: "23514",
        message: 'violates check constraint "timecard_approvals_status" [REDACTED] [REDACTED]'
      }]]);
      assert.equal(env.approvals[0].status, "approved");
      assert.equal(env.audit.length, 0);
    } finally { console.error = originalError; env.restore(); }
  });
}

test("non-JSON database errors retain operation and HTTP status", async () => {
  const env = environment();
  const underlyingFetch = global.fetch;
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  global.fetch = async (url, options = {}) => url.includes("/timecard_approvals?") && options.method === "PATCH"
    ? new Response("private upstream error", { status: 503 }) : underlyingFetch(url, options);
  try {
    assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2" })).statusCode, 500);
    assert.deepEqual(logs[0][1], { operation: "reopen_update", status: 503, code: null, message: null });
  } finally { console.error = originalError; env.restore(); }
});
