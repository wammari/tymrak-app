import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import employeesHandler from "../api/employees.js";
import invitationHandler from "../api/send-invitation.js";
import resendHandler from "../api/resend-invitation.js";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function responseRecorder() {
  return {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function request(method, body = {}, query = {}) {
  return {
    method, body, query,
    headers: { authorization: "Bearer manager-access-token" }
  };
}

function employee(overrides = {}) {
  return {
    id: "employee-1", first_name: "Ada", last_name: "Lovelace",
    email: "ada@example.com", username: "ada", mobile: null,
    position: "Engineer", department: "Technology", province: "AB",
    hire_date: null, invitation_status: "Invitation Sent",
    activated_at: null, is_active: true, ...overrides
  };
}

function input(overrides = {}) {
  return {
    firstName: "Ada", lastName: "Lovelace", email: "ada@example.com",
    username: "ada", mobile: "", position: "Engineer",
    department: "Technology", province: "AB", hireDate: "2026-10-01",
    isActive: true, ...overrides
  };
}

function installManagerFetch(operation) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "manager-id", email: "manager@example.com" }));
    }
    if (String(url).includes("/rest/v1/user_roles")) {
      return new Response(JSON.stringify([{ role: "manager" }]));
    }
    return operation(String(url), options, calls);
  };
  return calls;
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret-never-public";
  process.env.SITE_URL = "https://app.example.com";
});

test.afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test("anonymous users cannot access any employee-management API", async () => {
  for (const [handler, req] of [
    [employeesHandler, { method: "GET", headers: {}, query: {} }],
    [invitationHandler, { method: "POST", headers: {}, body: input() }],
    [resendHandler, { method: "POST", headers: {}, body: { id: "employee-1" } }]
  ]) {
    let called = false;
    global.fetch = async () => { called = true; throw new Error("must not fetch"); };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(called, false);
  }
});

test("ordinary employees cannot access employee-management APIs", async () => {
  global.fetch = async url => String(url).endsWith("/auth/v1/user")
    ? new Response(JSON.stringify({ id: "ordinary-employee" }))
    : new Response(JSON.stringify([{ role: "employee" }]));
  const res = responseRecorder();
  await employeesHandler(request("GET"), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.error, /Manager/);
});

test("a manager can list employees", async () => {
  const record = employee();
  installManagerFetch(async url => {
    assert.match(url, /employees\?select=/);
    return new Response(JSON.stringify([record]));
  });
  const res = responseRecorder();
  await employeesHandler(request("GET"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.employees, [record]);
});

test("a manager can create an active employee and send an invitation", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?") && options.method !== "POST") return new Response("[]");
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({ id: "auth-employee-1" }));
    if (url.endsWith("/rest/v1/employees") && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.is_active, true);
      assert.equal(body.hire_date, "2026-10-01");
      assert.equal(body.auth_user_id, "auth-employee-1");
      assert.equal(body.invitation_status, "Invitation Sent");
      return new Response(JSON.stringify([employee()]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await invitationHandler(request("POST", input()), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.success, true);
  assert.equal(calls.filter(call => call.url.includes("/auth/v1/invite")).length, 1);
});

for (const duplicateField of ["email", "username"]) {
  test(`duplicate ${duplicateField} is rejected before an invitation is sent`, async () => {
    const calls = installManagerFetch(async url => {
      if (url.includes(`/employees?${duplicateField}=`)) return new Response('[{"id":"existing"}]');
      if (url.includes("/employees?")) return new Response("[]");
      throw new Error(`Unexpected URL ${url}`);
    });
    const res = responseRecorder();
    await invitationHandler(request("POST", input()), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, new RegExp(duplicateField));
    assert.equal(calls.some(call => call.url.includes("/auth/v1/invite")), false);
  });
}

test("a manager edits exactly one employee and can save inactive status", async () => {
  let patchUrl;
  installManagerFetch(async (url, options) => {
    if (url.includes("/employees?") && options.method !== "PATCH") return new Response("[]");
    if (options.method === "PATCH") {
      patchUrl = url;
      const body = JSON.parse(options.body);
      assert.equal(body.is_active, false);
      assert.equal("auth_user_id" in body, false);
      assert.equal("invitation_status" in body, false);
      return new Response(JSON.stringify([employee({ is_active: false })]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await employeesHandler(request("PATCH", input({ isActive: false }), { id: "employee-1" }), res);
  assert.equal(res.statusCode, 200);
  assert.match(patchUrl, /employees\?id=eq\.employee-1/);
  assert.equal(res.payload.employee.is_active, false);
});

test("resending an invitation updates by ID and never creates an employee", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?id=eq.employee-1") && !options.method) {
      return new Response(JSON.stringify([employee({ auth_user_id: "auth-employee-1" })]));
    }
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({ id: "auth-employee-1" }));
    if (url.includes("/employees?id=eq.employee-1") && options.method === "PATCH") {
      return new Response(JSON.stringify([employee()]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.some(call => call.options.method === "POST" && call.url.endsWith("/rest/v1/employees")), false);
});

test("activated employees cannot be resent an activation invitation", async () => {
  const calls = installManagerFetch(async url => {
    if (url.includes("/employees?id=eq.employee-1")) {
      return new Response(JSON.stringify([employee({
        invitation_status: "Account Activated", activated_at: "2026-10-02T00:00:00Z"
      })]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(calls.some(call => call.url.includes("/auth/v1/invite")), false);
});

test("server credentials never appear in Manager Portal browser code", () => {
  const browserSource = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.doesNotMatch(browserSource, /SUPABASE_SECRET_KEY|server-secret-never-public|service_role/);
  assert.match(browserSource, /Authorization:`Bearer \$\{session\.access_token\}`/);
});
