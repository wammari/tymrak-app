import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/company-team.js";
import approvalHandler from "../api/manager-timecard-approvals.js";
import reopenHandler from "../api/manager-timecard-reopen.js";
import { PostgrestResponse } from "./_postgrest-response.mjs";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const MAIN = "99999999-9999-4999-8999-999999999999";
const WORKER_AUTH = "33333333-3333-4333-8333-333333333333";
const WORKER_EMPLOYEE = "a3333333-3333-4333-8333-333333333333";
const NEW_AUTH = "66666666-6666-4666-8666-666666666666";
const WORKPLACE = "c1111111-1111-4111-8111-111111111111";

function response() {
  return { statusCode: null, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
}
const json = (body, status = 200) => new PostgrestResponse(JSON.stringify(body), { status });

// A fake database and Auth for one company. `role` is the signed-in person's role.
function install({ role = "admin", grantResult = { success: true, role: "manager", created: true }, inviteStatus = 200, inviteBody, members } = {}) {
  const original = global.fetch, env = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  process.env.TYMRAK_MAIN_ADMIN_AUTH_USER_ID = MAIN;
  const calls = [];
  const team = members ?? [{ authUserId: ADMIN, email: "owner@a.test", role: "admin", status: "active", isYou: true, employee: null, name: "Olivia Owner", workplaces: [] }];
  global.fetch = async (url, options = {}) => {
    const u = String(url); const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: u, method: options.method || "GET", body });
    if (u.endsWith("/auth/v1/user")) return json({ id: ADMIN, email: "owner@a.test" });
    if (u.includes("/user_roles?")) return json([{ role, organization_id: COMPANY, organization: { name: "Company A", is_active: true } }]);
    if (u.endsWith("/rpc/manager_employee_scope")) return json({ employeeIds: [WORKER_EMPLOYEE] });
    if (u.endsWith("/rpc/company_team")) return json({ members: team });
    if (u.endsWith("/rpc/grant_company_access")) return json(grantResult);
    if (u.endsWith("/rpc/revoke_company_access")) return json({ success: true });
    if (u.includes("/workplaces?")) return json([{ id: WORKPLACE, name: "Main Street", is_active: true }]);
    if (u.includes("/organizations?id=")) return json([{ id: COMPANY, name: "Company A" }]);
    if (u.includes("/employees?") && u.includes("email=ilike.")) return json([]);
    if (u.includes(`/employees?id=eq.${WORKER_EMPLOYEE}`)) return json([{ id: WORKER_EMPLOYEE, auth_user_id: WORKER_AUTH, first_name: "Will", last_name: "Worker" }]);
    if (u.includes("/employees?") && u.includes("auth_user_id=not.is.null")) return json([
      { id: WORKER_EMPLOYEE, first_name: "Will", last_name: "Worker", email: "worker@a.test", auth_user_id: WORKER_AUTH },
      { id: "a1111111-1111-4111-8111-111111111111", first_name: "Olivia", last_name: "Owner", email: "owner@a.test", auth_user_id: ADMIN },
      { id: "a9999999-9999-4999-8999-999999999999", first_name: "Main", last_name: "Admin", email: "main@tymrak.test", auth_user_id: MAIN }
    ]);
    if (u.includes("/auth/v1/invite")) return new Response(JSON.stringify(inviteBody ?? { id: NEW_AUTH, email: "new@a.test" }), { status: inviteStatus });
    if (u.includes(`/auth/v1/admin/users/${NEW_AUTH}`)) return json({ id: NEW_AUTH, email: "new@a.test", invited_at: "2026-11-19T00:00:00Z",
      user_metadata: { first_name: "Nina", last_name: "New", company_name: "Company A", tymrak_access: "team" }, identities: [] });
    throw new Error(`Unexpected URL: ${u}`);
  };
  return { calls, rpcCalls: name => calls.filter(c => c.url.endsWith(`/rpc/${name}`)), restore() { global.fetch = original; process.env = env; } };
}
async function call(method, body) {
  const res = response();
  await handler({ method, headers: { authorization: "Bearer token" }, query: {}, body }, res);
  return res;
}

test("an admin sees the team, the workplaces, and employees who could be given access", async () => {
  const env = install();
  try {
    const res = await call("GET");
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.members.length, 1);
    assert.deepEqual(res.payload.workplaces, [{ id: WORKPLACE, name: "Main Street", isActive: true }]);
    assert.deepEqual(res.payload.employees.map(e => e.name), ["Will Worker"], "not people already on the team, not the Main Administrator");
    assert.equal(JSON.stringify(res.payload.employees).includes(WORKER_AUTH), false, "login ids stay on the server");
    assert.equal(env.rpcCalls("company_team")[0].body.p_hidden_user, MAIN);
  } finally { env.restore(); }
});

test("managers cannot see or change team access", async () => {
  const env = install({ role: "manager" });
  try {
    for (const [method, body] of [["GET"], ["POST", { kind: "employee", employeeId: WORKER_EMPLOYEE, role: "admin" }], ["PATCH", { authUserId: WORKER_AUTH, role: "admin" }], ["DELETE", { authUserId: WORKER_AUTH }]]) {
      const res = await call(method, body);
      assert.equal(res.statusCode, 403, method);
    }
    assert.equal(env.rpcCalls("grant_company_access").length + env.rpcCalls("revoke_company_access").length, 0);
  } finally { env.restore(); }
});

test("an existing employee is given manager access on their own login", async () => {
  const env = install();
  try {
    const res = await call("POST", { kind: "employee", employeeId: WORKER_EMPLOYEE, role: "manager", workplaceIds: [WORKPLACE, WORKPLACE] });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(env.rpcCalls("grant_company_access")[0].body, {
      p_actor: ADMIN, p_organization_id: COMPANY, p_auth_user_id: WORKER_AUTH, p_role: "manager", p_workplace_ids: [WORKPLACE], p_protected_user: MAIN
    });
    assert.equal(env.calls.some(c => c.url.includes("/auth/v1/invite")), false, "no new invitation");
  } finally { env.restore(); }
});

test("a new person gets a team invitation and their access is saved", async () => {
  const env = install({ grantResult: { success: true, role: "admin", created: true } });
  try {
    const res = await call("POST", { kind: "new", email: " New@A.test ", firstName: "Nina", lastName: "New", role: "admin" });
    assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
    const invite = env.calls.find(c => c.url.includes("/auth/v1/invite"));
    assert.equal(invite.body.email, "new@a.test");
    assert.equal(invite.body.data.tymrak_access, "team");
    assert.match(invite.url, /redirect_to=.*activate\.html/);
    assert.equal(env.rpcCalls("grant_company_access")[0].body.p_auth_user_id, NEW_AUTH);
  } finally { env.restore(); }
});

test("an email that already has a Tymrak login is not invited again", async () => {
  const env = install({ inviteStatus: 422, inviteBody: { msg: "A user with this email address has already been registered" } });
  try {
    const res = await call("POST", { kind: "new", email: "taken@a.test", firstName: "Tom", lastName: "Taken", role: "manager", workplaceIds: [WORKPLACE] });
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /already has a Tymrak login/);
    assert.equal(env.rpcCalls("grant_company_access").length, 0);
  } finally { env.restore(); }
});

test("if access can't be saved after an invitation, the admin is told not to resend", async () => {
  const env = install({ grantResult: { error: "invalid_workplace" } });
  try {
    const res = await call("POST", { kind: "new", email: "new@a.test", firstName: "Nina", lastName: "New", role: "manager", workplaceIds: [WORKPLACE] });
    assert.equal(res.statusCode, 500);
    assert.match(res.payload.error, /Don't send it again/);
  } finally { env.restore(); }
});

test("bad requests are refused before reaching the database", async () => {
  const env = install();
  try {
    for (const body of [
      { kind: "employee", employeeId: WORKER_EMPLOYEE, role: "payroll" },
      { kind: "employee", employeeId: WORKER_EMPLOYEE, role: "manager", workplaceIds: [] },
      { kind: "employee", employeeId: "not-an-id", role: "admin" },
      { kind: "new", email: "not-an-email", firstName: "A", lastName: "B", role: "admin" },
      { kind: "new", email: "ok@a.test", firstName: "", lastName: "B", role: "admin" },
      { kind: "unknown", role: "admin" }
    ]) {
      const res = await call("POST", body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    assert.equal(env.rpcCalls("grant_company_access").length, 0);
  } finally { env.restore(); }
});

test("database refusals become clear messages", async () => {
  const env = install({ grantResult: { error: "cannot_change_own_access" }, members: [{ authUserId: ADMIN, email: "o", role: "admin", workplaces: [] }] });
  try {
    const res = await call("PATCH", { authUserId: ADMIN, role: "manager", workplaceIds: [WORKPLACE] });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /can't change or remove your own access/);
  } finally { env.restore(); }
});

test("changing access only applies to people already on the team", async () => {
  const env = install();
  try {
    const res = await call("PATCH", { authUserId: WORKER_AUTH, role: "admin" });
    assert.equal(res.statusCode, 404);
    assert.equal(env.rpcCalls("grant_company_access").length, 0);
  } finally { env.restore(); }
});

test("removing access calls the database with the Main Administrator protected", async () => {
  const env = install();
  try {
    const res = await call("DELETE", { authUserId: WORKER_AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(env.rpcCalls("revoke_company_access")[0].body, { p_actor: ADMIN, p_organization_id: COMPANY, p_auth_user_id: WORKER_AUTH, p_protected_user: MAIN });
  } finally { env.restore(); }
});

// ---- Nobody approves or reopens their own timecard ------------------------------------
function installTimecards() {
  const original = global.fetch, env = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  const writes = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (options.method === "POST" && u.includes("/timecard_approvals")) { writes.push(u); return new Response(null, { status: 201 }); }
    if (options.method === "PATCH") { writes.push(u); return json([]); }
    if (u.endsWith("/auth/v1/user")) return json({ id: ADMIN });
    if (u.includes("/user_roles?")) return json([{ role: "admin", organization_id: COMPANY, organization: { name: "Company A", is_active: true } }]);
    if (u.includes("/organizations?id=")) return json([{ pay_frequency: "semi_monthly", pay_period_anchor: null }]);
    if (u.includes("/employees?")) return json([{ id: "self-employee", province: "ON", auth_user_id: ADMIN }]);
    if (u.includes("/timecard_approvals?")) return json([{ id: "approval-1", status: "approved" }]);
    throw new Error(`Unexpected URL: ${u}`);
  };
  return { writes, restore() { global.fetch = original; process.env = env; } };
}

test("an admin cannot approve their own timecard", async () => {
  const env = installTimecards();
  try {
    const res = response();
    await approvalHandler({ method: "POST", headers: { authorization: "Bearer token" }, body: { employeeIds: ["self-employee"], period: "2026-11-1" } }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.payload.error, /can't approve your own timecard/);
    assert.equal(env.writes.length, 0);
  } finally { env.restore(); }
});

test("an admin cannot reopen their own timecard", async () => {
  const env = installTimecards();
  try {
    const res = response();
    await reopenHandler({ method: "POST", headers: { authorization: "Bearer token" }, body: { employeeId: "self-employee", period: "2026-11-1" } }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.payload.error, /can't reopen your own timecard/);
    assert.equal(env.writes.length, 0);
  } finally { env.restore(); }
});

// ---- Pages -----------------------------------------------------------------------------
import fs from "node:fs";
const page = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
import { publicAssets } from "../cloudflare/public-assets.mjs";

test("team invitations finish on the activation page and go to the Manager Portal", () => {
  const html = page("activate.html");
  assert.match(html, /user_metadata\?\.tymrak_access === "team"/);
  assert.match(html, /portalLink\.href = "\/manager-login\.html"/);
  // The team branch returns before the employee completion request.
  assert.ok(html.indexOf('portalLink.href = "/manager-login.html"') < html.indexOf("await completeActivation();"));
});

test("the portal shows Team to admins only, and never offers approving one's own timecard", () => {
  const html = page("manager.html");
  assert.match(html, /id="teamLink" href="\/team\.html" hidden/);
  assert.match(html, /\$\("teamLink"\)\.hidden=data\.role!=="admin"/);
  assert.match(html, /checkbox\.disabled=card\.approvalStatus==="Approved"\|\|card\.isSelf===true/);
  assert.match(html, /if\(card\.isSelf===true\)\{/);
});

test("the Team page is published and checks for admin access", () => {
  assert.ok(publicAssets.includes("team.html"));
  const html = page("team.html");
  assert.match(html, /\/api\/company-team/);
  assert.match(html, /session\.role!=="admin"/);
  assert.doesNotMatch(html, /innerHTML/, "names and emails are written as text, never as HTML");
});
