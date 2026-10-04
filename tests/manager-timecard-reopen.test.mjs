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
  try { assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2", reason: "Fix punch" }, {})).statusCode, 401); }
  finally { env.restore(); }
  env = environment("employee");
  try {
    assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2", reason: "Fix punch" })).statusCode, 403);
    assert.equal(env.approvals[0].status, "approved");
  } finally { env.restore(); }
});

test("blank reopen reason is rejected", async () => {
  const env = environment();
  try {
    assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2", reason: "   " })).statusCode, 400);
    assert.equal(env.approvals[0].status, "approved");
  } finally { env.restore(); }
});

test("manager reopens only the selected period and records authenticated audit identity, time, timezone, and reason", async () => {
  const env = environment();
  try {
    const res = await reopen({ employeeId: "employee-1", period: "2026-09-2", reason: "  Correct missed clock out  ", managerId: "untrusted-user" });
    assert.equal(res.statusCode, 200);
    assert.equal(env.approvals[0].status, "reopened");
    assert.equal(env.approvals[1].status, "approved");
    assert.deepEqual(env.audit.map(({ occurred_at, ...event }) => ({ ...event, hasTimestamp: /^\d{4}-\d{2}-\d{2}T/.test(occurred_at) })), [{
      employee_id: "employee-1", period_start: "2026-09-16", period_end: "2026-09-30",
      work_timezone: "America/Edmonton", action: "reopened", manager_user_id: "acting-manager",
      reopen_reason: "Correct missed clock out", hasTimestamp: true
    }]);
  } finally { env.restore(); }
});

test("approved period locks, reopen unlocks, and re-approval locks it again", async () => {
  const env = environment();
  const writable = () => env.approvals[0].status !== "approved";
  try {
    assert.equal(writable(), false);
    assert.equal((await reopen({ employeeId: "employee-1", period: "2026-09-2", reason: "Correction required" })).statusCode, 200);
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

test("approval migration constraint rejects null, empty, and whitespace-only reopen reasons", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202610040002_timecard_approval_audit.sql", import.meta.url), "utf8");
  const constraint = sql.match(/timecard_approvals_reopen_fields_check check \(([\s\S]*?)\n  \);/)?.[1] || "";
  assert.match(constraint, /status = 'approved'/);
  assert.match(constraint, /reopened_by is not null/);
  assert.match(constraint, /reopened_at is not null/);
  assert.match(constraint, /reopen_reason is not null and btrim\(reopen_reason\) <> ''/);

  const acceptsReopenedApproval = reason => reason !== null && reason.trim() !== "";
  assert.equal(acceptsReopenedApproval(null), false);
  assert.equal(acceptsReopenedApproval(""), false);
  assert.equal(acceptsReopenedApproval("   \t"), false);
  assert.equal(acceptsReopenedApproval("Correct missed clock out"), true);
});

test("history migration constraint accepts a reason only for reopened audit events", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202610040002_timecard_approval_audit.sql", import.meta.url), "utf8");
  const constraint = sql.match(/timecard_approval_history_reason_check check \(([\s\S]*?)\n  \)/)?.[1] || "";
  assert.match(constraint, /action = 'reopened' and reopen_reason is not null and\s+btrim\(reopen_reason\) <> ''/);
  assert.match(constraint, /action <> 'reopened' and reopen_reason is null/);

  const acceptsHistoryReason = (action, reason) => action === "reopened"
    ? reason !== null && reason.trim() !== ""
    : reason === null;
  assert.equal(acceptsHistoryReason("reopened", null), false);
  assert.equal(acceptsHistoryReason("reopened", ""), false);
  assert.equal(acceptsHistoryReason("reopened", "  \n"), false);
  assert.equal(acceptsHistoryReason("reopened", "Correct missed clock out"), true);
  assert.equal(acceptsHistoryReason("approved", null), true);
  assert.equal(acceptsHistoryReason("re-approved", "Unexpected reason"), false);
});
