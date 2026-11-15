import "./_test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import employeesHandler from "../api/employees.js";
import accountDeletion, { tokenIssuedAt } from "../api/account-deletion.js";
import { routes } from "../cloudflare/worker.mjs";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";

function responseRecorder() {
  return { headers: {}, setHeader(n, v) { this.headers[n] = v; }, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenIssued = secondsAgo => `${b64({ alg: "HS256" })}.${b64({ sub: USER, iat: Math.floor(Date.now() / 1000) - secondsAgo })}.sig`;
const employeeRequest = (method, secondsAgo = 30) => ({ method, headers: { authorization: `Bearer ${tokenIssued(secondsAgo)}` }, query: {}, body: {} });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
// Paged lists must carry a Content-Range total, exactly like PostgREST sends.
const page = value => new Response(JSON.stringify(value), { status: 200, headers: { "content-range": `0-${Math.max(value.length - 1, 0)}/${value.length}` } });

test.beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret-never-public";
  process.env.SITE_URL = "https://app.example.com";
});
test.afterEach(() => { global.fetch = originalFetch; process.env = { ...originalEnv }; });

// Employee-facing endpoint: fake Supabase with just enough behaviour.
function employeeFake({ roles = [], open = null, createStatus = 201, employees = [{ id: EMPLOYEE, organization_id: ORG }] } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    url = String(url); calls.push({ url, options });
    if (url.endsWith("/auth/v1/user")) return json({ id: USER, email: "ada@example.com" });
    if (url.includes("/rest/v1/user_roles")) return json(roles);
    if (url.includes("/rest/v1/employees?")) return json(employees);
    if (url.includes("/rest/v1/account_deletion_requests")) {
      if (options.method === "POST") return createStatus === 201 ? json([{ status: "Pending", requested_at: "2026-11-14T12:00:00Z" }], 201) : json({ code: "23505" }, 409);
      if (options.method === "PATCH") return json([]);
      return json(open ? [open] : []);
    }
    throw new Error("unexpected " + url);
  };
  return calls;
}

test("token issue time is read from the verified token, and garbage yields null", () => {
  assert.equal(typeof tokenIssuedAt(tokenIssued(5)), "number");
  for (const bad of ["", "abc", "a.b.c", "a.e30.c"]) assert.equal(tokenIssuedAt(bad), null);
});

test("requesting deletion needs a very recent sign-in (password confirmation)", async () => {
  const calls = employeeFake();
  const res = responseRecorder();
  await accountDeletion(employeeRequest("POST", 3600), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, "reauth_required");
  assert.equal(calls.filter(c => c.options.method === "POST").length, 0);
});

test("a freshly signed-in employee creates one request, scoped to their own record", async () => {
  const calls = employeeFake();
  const res = responseRecorder();
  await accountDeletion(employeeRequest("POST"), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.request.status, "Pending");
  const created = calls.find(c => c.options.method === "POST");
  assert.deepEqual(JSON.parse(created.options.body), { organization_id: ORG, employee_id: EMPLOYEE, auth_user_id: USER, requested_by: "employee" });
});

test("asking twice is harmless and returns the existing request", async () => {
  const calls = employeeFake({ open: { id: "r1", status: "Pending", requested_at: "2026-11-01T00:00:00Z" } });
  const res = responseRecorder();
  await accountDeletion(employeeRequest("POST"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter(c => c.options.method === "POST").length, 0);
});

test("manager and admin sign-ins cannot use the self-service request", async () => {
  employeeFake({ roles: [{ role: "admin" }] });
  const res = responseRecorder();
  await accountDeletion(employeeRequest("POST"), res);
  assert.equal(res.statusCode, 403);
});

test("status and cancel only touch this employee's pending request", async () => {
  const calls = employeeFake({ open: { id: "r1", status: "Pending", requested_at: "2026-11-01T00:00:00Z" } });
  const status = responseRecorder();
  await accountDeletion(employeeRequest("GET", 99999), status);
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.request.status, "Pending");
  const cancel = responseRecorder();
  await accountDeletion(employeeRequest("DELETE", 99999), cancel);
  assert.equal(cancel.statusCode, 200);
  const patch = calls.find(c => c.options.method === "PATCH");
  assert.match(patch.url, new RegExp(`employee_id=eq\\.${EMPLOYEE}&status=eq\\.Pending`));
});

test("no token, wrong method and expired session are rejected", async () => {
  employeeFake();
  let res = responseRecorder();
  await accountDeletion({ method: "GET", headers: {}, query: {} }, res); assert.equal(res.statusCode, 401);
  res = responseRecorder(); await accountDeletion({ method: "PUT", headers: {}, query: {} }, res); assert.equal(res.statusCode, 405);
  global.fetch = async () => json({}, 401);
  res = responseRecorder(); await accountDeletion(employeeRequest("GET"), res); assert.equal(res.statusCode, 401);
});

// Manager-facing action in /api/employees
function managerFake({ anonymize = { outcome: "anonymized", authUserId: USER, requestId: "req-1" }, authDelete = 200, list = [] } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    url = String(url); calls.push({ url, options });
    if (url.endsWith("/auth/v1/user")) return json({ id: "manager-id", email: "manager@example.com" });
    if (url.includes("/rest/v1/user_roles")) return json([{ role: "admin", organization_id: ORG, organization: { is_active: true } }]);
    if (url.includes("/rest/v1/organizations?")) return json([{ id: ORG, name: "I Care Pharmacy" }]);
    if (url.includes("/rpc/anonymize_employee_account")) return json(anonymize);
    if (url.includes("/auth/v1/admin/users/") && options.method === "DELETE") return new Response(null, { status: authDelete });
    if (url.includes("/rpc/complete_account_deletion")) return new Response(null, { status: 204 });
    if (url.includes("/rest/v1/account_deletion_requests")) return page(list);
    if (url.includes("/rest/v1/employees?")) return page([{ id: "employee-1", first_name: "Ada", last_name: "L", email: "a@x.com" }]);
    throw new Error("unexpected " + url);
  };
  return calls;
}
const managerRequest = (body, method = "PATCH") => ({ method, body, query: { id: "employee-1" }, headers: { authorization: "Bearer manager-access-token" } });

test("a manager deletes an account: anonymize, delete the sign-in, then mark complete (in that order)", async () => {
  const calls = managerFake();
  const res = responseRecorder();
  await employeesHandler(managerRequest({ action: "delete_account", confirm: true }), res);
  assert.equal(res.statusCode, 200);
  const order = calls.map(c => c.url).filter(u => /anonymize_employee_account|admin\/users|complete_account_deletion/.test(u));
  assert.match(order[0], /anonymize_employee_account/); assert.match(order[1], new RegExp(`admin/users/${USER}`)); assert.match(order[2], /complete_account_deletion/);
  const rpc = calls.find(c => /anonymize_employee_account/.test(c.url));
  assert.deepEqual(JSON.parse(rpc.options.body), { p_organization_id: ORG, p_employee_id: "employee-1", p_processed_by: "manager-id" });
});

test("deletion needs explicit confirmation and never runs without it", async () => {
  const calls = managerFake();
  for (const body of [{ action: "delete_account" }, { action: "delete_account", confirm: "yes" }, { action: "delete_account", confirm: false }]) {
    const res = responseRecorder(); await employeesHandler(managerRequest(body), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.filter(c => /anonymize_employee_account/.test(c.url)).length, 0);
});

test("if the sign-in cannot be deleted the manager is told to retry and the request is NOT marked complete", async () => {
  const calls = managerFake({ authDelete: 500 });
  const res = responseRecorder();
  await employeesHandler(managerRequest({ action: "delete_account", confirm: true }), res);
  assert.equal(res.statusCode, 502); assert.equal(res.payload.code, "auth_pending");
  assert.equal(calls.filter(c => /complete_account_deletion/.test(c.url)).length, 0);
});

test("a sign-in that is already gone (404) still completes the deletion", async () => {
  const calls = managerFake({ authDelete: 404 });
  const res = responseRecorder(); await employeesHandler(managerRequest({ action: "delete_account", confirm: true }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter(c => /complete_account_deletion/.test(c.url)).length, 1);
});

test("database refusals map to clear errors and never touch the sign-in account", async () => {
  for (const [error, status] of [["not_terminated", 409], ["manager_account", 409], ["employee_not_found", 404]]) {
    const calls = managerFake({ anonymize: { error } });
    const res = responseRecorder(); await employeesHandler(managerRequest({ action: "delete_account", confirm: true }), res);
    assert.equal(res.statusCode, status, error);
    assert.equal(calls.filter(c => /admin\/users/.test(c.url)).length, 0);
  }
});

test("a retry after partial failure skips straight to the sign-in deletion", async () => {
  const calls = managerFake({ anonymize: { outcome: "already_anonymized", authUserId: USER, requestId: "req-1" } });
  const res = responseRecorder(); await employeesHandler(managerRequest({ action: "delete_account", confirm: true }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter(c => /admin\/users/.test(c.url) && c.options.method === "DELETE").length, 1);
});

test("manager list shows who asked for deletion, and still loads if the new table is missing", async () => {
  managerFake({ list: [{ employee_id: "employee-1", requested_at: "2026-11-10T00:00:00Z", status: "Pending" }] });
  let res = responseRecorder(); await employeesHandler({ method: "GET", query: {}, headers: { authorization: "Bearer t" } }, res);
  assert.equal(res.payload.employees[0].deletion_requested_at, "2026-11-10T00:00:00Z");
  const original = global.fetch;
  global.fetch = async (url, options) => String(url).includes("account_deletion_requests") ? json({ code: "42P01" }, 404) : original(url, options);
  res = responseRecorder(); await employeesHandler({ method: "GET", query: {}, headers: { authorization: "Bearer t" } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.payload.employees[0].deletion_requested_at, null);
});

test("the endpoint is registered on Cloudflare, the UI is published, and both employee pages and the manager page use it", () => {
  assert.ok(routes["/api/account-deletion"]);
  const assets = fs.readFileSync(new URL("../cloudflare/public-assets.mjs", import.meta.url), "utf8");
  assert.match(assets, /account-deletion-ui\.js/);
  for (const page of ["employee.html", "timecard.html"]) {
    const html = fs.readFileSync(new URL("../" + page, import.meta.url), "utf8");
    assert.match(html, /import \{ mountAccountDeletion \} from "\.\/account-deletion-ui\.js"/); assert.match(html, /mountAccountDeletion\(\{ supabase \}\)/);
  }
  const manager = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(manager, /action:"delete_account",confirm:true/); assert.match(manager, /Delete personal data/); assert.match(manager, /endsWith\("@deleted\.invalid"\)/);
  const ui = fs.readFileSync(new URL("../account-deletion-ui.js", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /innerHTML/);
});
