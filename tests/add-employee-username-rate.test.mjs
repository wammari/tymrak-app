import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import invitation from "../api/send-invitation.js";
import employees from "../api/employees.js";
import { validateEmployeeInput } from "../api/_employee-management.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ADMIN = "99999999-9999-4999-8999-999999999999";
const INVITED = "33333333-3333-4333-8333-333333333333";
let calls, role, nextNumber, rateFails, savedEmployee, invited, existingAccount, alreadyHere, emails;

test.beforeEach(t => {
  const originalFetch = global.fetch, originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  calls = []; role = "admin"; nextNumber = 1004; rateFails = false; savedEmployee = null; invited = null; existingAccount = null; alreadyHere = false; emails = [];
  process.env.RESEND_API_KEY = "re_test";
  global.fetch = async (raw, options = {}) => {
    const url = new URL(raw), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, url, method: options.method || "GET", body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-range": `0-${Math.max(0, (Array.isArray(value) ? value.length : 1) - 1)}/${Array.isArray(value) ? value.length : 1}` } });
    if (url.pathname === "/auth/v1/user") return json({ id: ADMIN });
    if (url.pathname === "/rest/v1/user_roles") return json([{ role, organization_id: COMPANY, organization: { is_active: true } }]);
    if (url.pathname === "/rest/v1/rpc/manager_employee_scope") return json({ employeeIds: [] });
    if (url.pathname === "/rest/v1/rpc/auth_account_for_email") { assert.equal(body.p_email.toLowerCase(), "harleen@example.com"); return json(existingAccount ? [existingAccount] : []); }
    if (url.hostname === "api.resend.com") { emails.push(body); return json({ id: "email-1" }); }
    if (url.pathname === "/rest/v1/rpc/next_employee_username") { assert.deepEqual(body, { p_organization_id: COMPANY }); return json(`ICP-${nextNumber++}`); }
    if (url.pathname === "/rest/v1/organizations") return json([{ id: COMPANY, name: "I Care Pharmacy", company_code: "ICP" }]);
    if (url.pathname === "/auth/v1/invite") { invited = body; return json({ id: INVITED, email: body.email, invited_at: "2026-11-25T12:00:00Z", user_metadata: body.data }); }
    if (url.pathname.startsWith("/auth/v1/admin/users/")) return json({ id: INVITED, email: invited?.email, invited_at: "2026-11-25T12:00:00Z", user_metadata: invited?.data || {} });
    if (url.pathname === "/rest/v1/employees") {
      if (options.method === "POST") { savedEmployee = { id: "55555555-5555-4555-8555-555555555555", ...body }; return json([savedEmployee]); }
      if (url.searchParams.has("auth_user_id")) return json(alreadyHere ? [{ id: "x" }] : []);
      return json([]);
    }
    if (url.pathname === "/rest/v1/account_deletion_requests") return json([]);
    if (url.pathname === "/rest/v1/employee_pay_rates") return rateFails ? json({ message: "nope" }, 500) : new Response(null, { status: 201 });
    throw new Error(`Unexpected ${options.method || "GET"} ${url.pathname}`);
  };
  t.after(() => { global.fetch = originalFetch; process.env = originalEnv; });
});

async function run(handler, method, body = {}) {
  const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method, headers: { authorization: "Bearer admin" }, body, query: {} }, res);
  return res;
}
const person = { firstName: "Harleen", lastName: "Kaur", email: "harleen@example.com", province: "ON", hireDate: "2026-12-01" };

test("an empty username is created from the company code before the invitation goes out", async () => {
  const res = await run(invitation, "POST", { ...person, username: "" });
  assert.equal(res.code, 201);
  assert.equal(res.body.employee.username, "ICP-1004");
  assert.match(res.body.message, /username ICP-1004/);
  const rpc = calls.findIndex(c => c.path === "/rest/v1/rpc/next_employee_username");
  const invite = calls.findIndex(c => c.path === "/auth/v1/invite");
  assert.ok(rpc >= 0 && rpc < invite, "username exists before the invitation is sent");
  assert.equal(calls[invite].body.data.username, "ICP-1004", "the invitation carries the new username");
  assert.equal(calls.some(c => c.path === "/rest/v1/employee_pay_rates"), false, "no rate given, none saved");
});

test("a username typed by the admin is kept", async () => {
  const res = await run(invitation, "POST", { ...person, username: "HarleenK" });
  assert.equal(res.code, 201);
  assert.equal(res.body.employee.username, "HarleenK");
  assert.equal(calls.some(c => c.path === "/rest/v1/rpc/next_employee_username"), false);
});

test("the starting hourly rate is saved from the hire date", async () => {
  const res = await run(invitation, "POST", { ...person, username: "", hourlyRate: "18.50" });
  assert.equal(res.code, 201);
  const saved = calls.find(c => c.path === "/rest/v1/employee_pay_rates");
  assert.deepEqual(saved.body, { employee_id: "55555555-5555-4555-8555-555555555555", organization_id: COMPANY, hourly_rate: 18.5, effective_from: "2026-12-01", created_by: ADMIN });
  const noHireDate = await run(invitation, "POST", { ...person, hireDate: "", username: "", hourlyRate: "20" });
  assert.equal(noHireDate.code, 201);
  assert.match(calls.filter(c => c.path === "/rest/v1/employee_pay_rates").at(-1).body.effective_from, /^\d{4}-\d{2}-\d{2}$/, "today when no hire date");
});

test("a bad rate is refused before anyone is invited", async () => {
  const res = await run(invitation, "POST", { ...person, username: "", hourlyRate: "eighteen" });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /hourly rate/);
  assert.equal(calls.some(c => c.path === "/auth/v1/invite" || c.path === "/rest/v1/rpc/next_employee_username"), false);
});

test("if the rate can't be saved, the employee is still added and the admin is told", async () => {
  rateFails = true;
  const res = await run(invitation, "POST", { ...person, username: "", hourlyRate: "18.50" });
  assert.equal(res.code, 201);
  assert.match(res.body.message, /hourly rate couldn't be saved/);
});

test("managers can't add employees or set rates", async () => {
  role = "manager";
  const res = await run(invitation, "POST", { ...person, username: "", hourlyRate: "99" });
  assert.equal(res.code, 403);
  assert.equal(calls.some(c => c.path === "/rest/v1/employee_pay_rates" || c.path === "/rest/v1/rpc/next_employee_username"), false);
});

test("editing an employee still needs a username", () => {
  assert.match(validateEmployeeInput({ ...person, username: "" }).error, /username/);
  assert.equal(validateEmployeeInput({ ...person, username: "" }, { allowAutoUsername: true }).error, undefined);
  assert.match(validateEmployeeInput({ ...person, username: "bad name!" }, { allowAutoUsername: true }).error, /Username may contain/);
});

test("the employee list tells the form the company code", async () => {
  const res = await run(employees, "GET");
  assert.equal(res.code, 200);
  assert.equal(res.body.companyCode, "ICP");
});

test("the Add Employee form lets the username be left empty and asks for a rate only when adding", () => {
  const page = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(page, /<input id="username" maxlength="64" autocomplete="off">/);
  assert.match(page, /\$\("username"\)\.required=!adding/);
  assert.match(page, /\$\("hourlyRateField"\)\.hidden=!adding/);
  assert.match(page, /\.\.\.\(editingId\?\{\}:\{hourlyRate:\$\("hourlyRate"\)\.value\.trim\(\)\}\)/);
});

const EXISTING = "77777777-7777-4777-8777-777777777777";
const sentAnything = () => calls.some(c => ["/rest/v1/rpc/next_employee_username", "/auth/v1/invite", "/rest/v1/employee_pay_rates"].includes(c.path) || (c.path === "/rest/v1/employees" && c.method === "POST") || c.url.hostname === "api.resend.com");

test("an email that already has a TYMRAK account asks the admin first, and sends nothing", async () => {
  existingAccount = { auth_user_id: EXISTING, activated: true };
  const res = await run(invitation, "POST", { ...person, email: "Harleen@Example.com", username: "", hourlyRate: "18" });
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "email_in_use");
  assert.equal(res.body.canAddExisting, true);
  assert.match(res.body.error, /already has a TYMRAK account/);
  assert.doesNotMatch(res.body.error, /QB|Pharmacy|Delice/i, "never says which business");
  assert.equal(sentAnything(), false);
});

test("once confirmed, the existing account is added to this business: no new invitation", async () => {
  existingAccount = { auth_user_id: EXISTING, activated: true };
  const res = await run(invitation, "POST", { ...person, username: "", hourlyRate: "18", addExisting: true });
  assert.equal(res.code, 201);
  assert.equal(res.body.linkedExistingAccount, true);
  assert.equal(calls.some(c => c.path === "/auth/v1/invite"), false, "no new invitation");
  const saved = calls.find(c => c.path === "/rest/v1/employees" && c.method === "POST").body;
  assert.equal(saved.auth_user_id, EXISTING);
  assert.equal(saved.organization_id, COMPANY);
  assert.equal(saved.invitation_status, "Account Activated", "they already have a working sign-in");
  assert.equal(saved.username, "ICP-1004");
  assert.ok(calls.some(c => c.path === "/rest/v1/employee_pay_rates"), "starting rate saved");
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to[0], "harleen@example.com");
  assert.match(emails[0].subject, /added to I Care Pharmacy/);
  assert.match(res.body.message, /emailed them/);
});

test("an existing account that never activated is added as waiting for activation", async () => {
  existingAccount = { auth_user_id: EXISTING, activated: false };
  const res = await run(invitation, "POST", { ...person, username: "HarleenK", addExisting: true });
  assert.equal(res.code, 201);
  assert.equal(calls.find(c => c.path === "/rest/v1/employees" && c.method === "POST").body.invitation_status, "Invitation Sent");
  assert.match(emails[0].text, /Finish activating/);
});

test("someone already employed by this business isn't added twice", async () => {
  existingAccount = { auth_user_id: EXISTING, activated: true };
  alreadyHere = true;
  const res = await run(invitation, "POST", { ...person, username: "", addExisting: true });
  assert.equal(res.code, 409);
  assert.match(res.body.error, /already an employee of this business/);
  assert.equal(calls.some(c => c.path === "/rest/v1/employees" && c.method === "POST"), false);
});

test("if the notice email can't be sent, the admin is asked to tell them", async () => {
  existingAccount = { auth_user_id: EXISTING, activated: true };
  delete process.env.RESEND_API_KEY;
  const res = await run(invitation, "POST", { ...person, username: "", addExisting: true });
  assert.equal(res.code, 201);
  assert.match(res.body.message, /Let them know they've been added/);
});
