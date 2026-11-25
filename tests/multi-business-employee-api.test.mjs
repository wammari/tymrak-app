import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import punch from "../api/employee-punch.js";
import timeOff from "../api/employee-time-off.js";
import deletion from "../api/account-deletion.js";
import { chosenEmployeeId } from "../api/_chosen-employee.js";
import { addedToBusinessEmail, sendEmail } from "../api/_email.js";
import { businessHeaders, chosenBusiness } from "../employee-business.js";

const USER = "11111111-1111-4111-8111-111111111111";
const ICARE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ALZAEEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let calls, rpcResult, employees;

test.beforeEach(t => {
  const originalFetch = global.fetch, env = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  calls = []; rpcResult = { lastPunch: null, punches: [], timeZone: "America/Toronto", workDate: "2026-11-25" };
  employees = [{ id: ICARE, organization_id: "o1" }, { id: ALZAEEM, organization_id: "o2" }];
  global.fetch = async (raw, options = {}) => {
    const url = new URL(raw), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, url, body });
    const json = value => new Response(JSON.stringify(value));
    if (url.pathname === "/auth/v1/user") return json({ id: USER });
    if (url.pathname.startsWith("/rest/v1/rpc/")) return json(typeof rpcResult === "function" ? rpcResult(body) : rpcResult);
    if (url.pathname === "/rest/v1/user_roles") return json([]);
    if (url.pathname === "/rest/v1/employees") return json(employees);
    if (url.pathname === "/rest/v1/account_deletion_requests") return json([]);
    throw new Error(`Unexpected ${url.pathname}`);
  };
  t.after(() => { global.fetch = originalFetch; process.env = env; });
});

async function run(handler, method, { headers = {}, body, query = {} } = {}) {
  const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method, headers: { authorization: "Bearer token", ...headers }, body, query }, res);
  return res;
}
const chosen = id => ({ "x-tymrak-employee-id": id });

test("the chosen business is read from the request, and nonsense is refused", () => {
  assert.equal(chosenEmployeeId({ headers: {} }), undefined);
  assert.equal(chosenEmployeeId({ headers: chosen(ICARE) }), ICARE);
  assert.equal(chosenEmployeeId({ headers: chosen("not-an-id") }), null);
});

test("clocking passes the chosen business to the database", async () => {
  const res = await run(punch, "GET", { headers: chosen(ALZAEEM) });
  assert.equal(res.code, 200);
  assert.equal(calls.find(c => c.path === "/rest/v1/rpc/record_geofenced_punch").body.p_employee_id, ALZAEEM);
  assert.equal((await run(punch, "GET", { headers: chosen("bad") })).code, 400);
});

test("with several businesses and no choice, the employee is asked to choose", async () => {
  rpcResult = { error: "choose_business" };
  const clock = await run(punch, "GET");
  assert.equal(clock.code, 409);
  assert.equal(clock.body.code, "choose_business");
  assert.match(clock.body.error, /more than one business/);
  assert.equal("p_employee_id" in calls.find(c => c.path === "/rest/v1/rpc/record_geofenced_punch").body, false, "nothing guessed");
  const off = await run(timeOff, "GET");
  assert.equal(off.code, 409);
  assert.equal(off.body.code, "choose_business");
});

test("time off views and requests are for the chosen business", async () => {
  rpcResult = body => body.p_start ? { success: true, requestId: "r", days: 1 } : { balance: { remaining: 3 }, requests: [] };
  assert.equal((await run(timeOff, "GET", { headers: chosen(ICARE) })).code, 200);
  assert.equal(calls.find(c => c.path === "/rest/v1/rpc/employee_time_off").body.p_employee_id, ICARE);
  const asked = await run(timeOff, "POST", { headers: chosen(ICARE), body: { startDate: "2026-12-21", endDate: "2026-12-21" } });
  assert.equal(asked.code, 200);
  assert.equal(calls.find(c => c.path === "/rest/v1/rpc/request_time_off").body.p_employee_id, ICARE);
});

test("account deletion is asked for at the chosen business", async () => {
  const unchosen = await run(deletion, "GET");
  assert.equal(unchosen.code, 409);
  assert.equal(unchosen.body.code, "choose_business");
  const ok = await run(deletion, "GET", { headers: chosen(ALZAEEM) });
  assert.equal(ok.code, 200);
  assert.ok(calls.some(c => c.path === "/rest/v1/account_deletion_requests" && c.url.searchParams.get("employee_id") === `eq.${ALZAEEM}`));
  assert.equal((await run(deletion, "GET", { headers: chosen("77777777-7777-4777-8777-777777777777") })).code, 404, "not one of their records");
  employees = [{ id: ICARE, organization_id: "o1" }];
  assert.equal((await run(deletion, "GET")).code, 200, "one business: nothing to choose");
});

test("the added-to-business email is plain, safe and only sent when configured", async () => {
  const mail = addedToBusinessEmail({ firstName: "<Ana>", companyName: "Al Zaeem & Co", siteUrl: "https://app.tymrak.com", activated: true });
  assert.equal(mail.subject, "You've been added to Al Zaeem & Co on TYMRAK");
  assert.match(mail.html, /&lt;Ana&gt;/);
  assert.match(mail.html, /Al Zaeem &amp; Co/);
  assert.match(mail.text, /https:\/\/app\.tymrak\.com\/login\.html/);
  assert.deepEqual(await sendEmail({ to: "a@b.c", ...mail }, {}), { sent: false, reason: "not_configured" });
});

test("the employee pages remember one business per person and send it with requests", () => {
  const list = [{ employee_id: ICARE, company_name: "I Care" }, { employee_id: ALZAEEM, company_name: "Al Zaeem" }];
  assert.equal(chosenBusiness([list[0]], USER), list[0], "one business: chosen automatically");
  assert.equal(chosenBusiness(list, USER), null, "several and nothing remembered: ask");
  assert.deepEqual(businessHeaders(ALZAEEM), { "x-tymrak-employee-id": ALZAEEM });
  assert.deepEqual(businessHeaders(null), {});
  const cors = fs.readFileSync(new URL("../cloudflare/adapter.mjs", import.meta.url), "utf8");
  assert.match(cors, /'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Tymrak-Employee-Id'/);
});
