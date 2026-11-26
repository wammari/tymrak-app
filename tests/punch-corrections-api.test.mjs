import "./_test-environment.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/manager-punch-corrections.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANA = "33333333-3333-4333-8333-333333333333", BOB = "44444444-4444-4444-8444-444444444444";

function install({ role = "admin", scope = [ANA], result = { success: true, punchId: "77" }, rpcStatus = 200 } = {}) {
  const originalFetch = global.fetch, originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  const rpcCalls = [];
  global.fetch = async (raw, options = {}) => {
    const url = String(raw);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "lead", email: "lead@example.com" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role, organization_id: COMPANY, organization: { is_active: true } }]));
    if (url.includes("/rpc/manager_employee_scope")) return new Response(JSON.stringify({ employeeIds: scope }));
    if (url.endsWith("/rpc/correct_punch")) { rpcCalls.push(JSON.parse(options.body)); return new Response(JSON.stringify(result), { status: rpcStatus }); }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { rpcCalls, restore() { global.fetch = originalFetch; process.env = originalEnv; } };
}

async function post(body) {
  const res = { setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
  await handler({ method: "POST", headers: { authorization: "Bearer token" }, body }, res);
  return res;
}

const add = { action: "add", employeeId: ANA, punchType: "clock_out", date: "2026-11-17", time: "17:05", reason: "Forgot to clock out" };

test("adding a punch sends the local date and time, the reason and who did it", async () => {
  const env = install();
  try {
    const res = await post(add);
    assert.equal(res.statusCode, 200);
    assert.match(res.payload.message, /^Punch added\./);
    assert.deepEqual(env.rpcCalls[0], { p_actor: "lead", p_organization_id: COMPANY, p_employee_id: ANA, p_action: "add",
      p_punch_id: null, p_punch_type: "clock_out", p_local_time: "2026-11-17 17:05:00", p_reason: "Forgot to clock out", p_actor_label: "lead@example.com" });
  } finally { env.restore(); }
});

test("change and remove name the punch; remove needs no time", async () => {
  const env = install();
  try {
    assert.equal((await post({ ...add, action: "change", punchId: 41, punchType: "clock_in", time: "08:30" })).statusCode, 200);
    assert.equal((await post({ action: "remove", employeeId: ANA, punchId: "41", reason: "Duplicate punch" })).statusCode, 200);
    assert.equal(env.rpcCalls[0].p_punch_id, "41");
    assert.deepEqual([env.rpcCalls[1].p_action, env.rpcCalls[1].p_punch_type, env.rpcCalls[1].p_local_time], ["remove", null, null]);
  } finally { env.restore(); }
});

test("managers can only correct the people they manage", async () => {
  const env = install({ role: "manager", scope: [ANA] });
  try {
    assert.equal((await post(add)).statusCode, 200);
    const other = await post({ ...add, employeeId: BOB });
    assert.equal(other.statusCode, 404);
    assert.equal(env.rpcCalls.length, 1, "never reaches the database for someone outside their scope");
  } finally { env.restore(); }
});

test("bad input is refused before the database", async () => {
  const env = install();
  try {
    for (const body of [
      { ...add, reason: " no" }, { ...add, reason: "x".repeat(501) }, { ...add, action: "edit" }, { ...add, employeeId: "ana" },
      { ...add, punchType: "lunch" }, { ...add, date: "2026-02-30" }, { ...add, time: "25:00" }, { ...add, time: "9:5" },
      { ...add, action: "change" }, { action: "remove", employeeId: ANA, punchId: "1; drop", reason: "Duplicate" }
    ]) assert.equal((await post(body)).statusCode, 400, JSON.stringify(body));
    assert.equal(env.rpcCalls.length, 0);
  } finally { env.restore(); }
});

test("database refusals become clear messages", async () => {
  const cases = [["period_locked", 409, /approved.*Reopen the timecard first/], ["own_punches", 403, /your own punches/],
    ["future_time", 400, /in the future/], ["punch_not_found", 404, /no longer exists/], ["no_change", 400, /Nothing changed/]];
  for (const [error, status, message] of cases) {
    const env = install({ result: { error } });
    try {
      const res = await post(add);
      assert.equal(res.statusCode, status, error);
      assert.match(res.payload.error, message);
      assert.equal(res.payload.code, error);
    } finally { env.restore(); }
  }
  const env = install({ rpcStatus: 500, result: { message: "boom" } });
  try {
    const res = await post(add);
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(res.payload.error, /boom/);
  } finally { env.restore(); }
});
