import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import handler from "../api/quickbooks.js";
import { decryptSecret, quickBooksConfig, signState, tokenRecord } from "../api/_quickbooks.js";
import { normalizePayTimeline, previousPayPeriod } from "../pay-periods.js";
import { requestedPayPeriod } from "../api/_pay-schedule.js";
import { PostgrestResponse } from "./_postgrest-response.mjs";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const ANA = "a1111111-1111-4111-8111-111111111111", SAM = "a2222222-2222-4222-8222-222222222222", LEFT = "a3333333-3333-4333-8333-333333333333";
const KEY = crypto.randomBytes(32).toString("base64");
const schedule = normalizePayTimeline({ pay_frequency: "semi_monthly", pay_period_anchor: null });
const PERIOD = previousPayPeriod(requestedPayPeriod(null, schedule), schedule);
const json = (body, status = 200) => new PostgrestResponse(JSON.stringify(body), { status });

function response() {
  return { statusCode: null, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
}

// A ten-hour day (Toronto time) on each working day of the first full week of the period.
function workWeek(employeeId) {
  const punches = [];
  const start = new Date(`${PERIOD.startKey}T12:00:00Z`);
  for (let d = 0; punches.length < 10; d++) {
    const day = new Date(start.getTime() + d * 86400000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6 || d < 1) continue;
    const date = day.toISOString().slice(0, 10);
    punches.push({ id: `${employeeId}-${date}-in`, employee_id: employeeId, punch_type: "clock_in", punched_at: `${date}T13:00:00Z` },
      { id: `${employeeId}-${date}-out`, employee_id: employeeId, punch_type: "clock_out", punched_at: `${date}T23:00:00Z` });
  }
  return punches;
}

// Fake Supabase + Intuit for one company. State is kept so several calls can be chained.
function install({ role = "admin", configured = true, connected = true, links = [], syncs = [], batchFails = () => false, qbEmployees } = {}) {
  const original = global.fetch, env = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  process.env.SITE_URL = "https://app.tymrak.com";
  if (configured) Object.assign(process.env, { QUICKBOOKS_CLIENT_ID: "client", QUICKBOOKS_CLIENT_SECRET: "secret", QUICKBOOKS_TOKEN_KEY: KEY });
  else for (const k of ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_TOKEN_KEY"]) delete process.env[k];
  const config = configured ? quickBooksConfig(process.env) : null;
  const state = {
    connection: connected && config ? { organization_id: COMPANY, realm_id: "9130", company_name: "Ana's Bakery", environment: "sandbox", connected_at: "2026-11-01T00:00:00Z",
      ...tokenRecord(config, { access_token: "access", refresh_token: "refresh", expires_in: 3600 }) } : null,
    links: links.map(l => ({ organization_id: COMPANY, external_name: null, matched_by: "manual", ...l })),
    syncs: new Map(syncs.map(s => [s.approval_id, { organization_id: COMPANY, realm_id: "9130", entries: [], manual_hours: [], error: null, attempted_at: new Date().toISOString(), ...s }])),
    batches: [], revoked: [], nextId: 500
  };
  const people = qbEmployees ?? [
    { Id: "7", DisplayName: "Ana Lopez", GivenName: "Ana", FamilyName: "Lopez", PrimaryEmailAddr: { Address: "ana@bakery.ca" } },
    { Id: "8", DisplayName: "Sam Lee", GivenName: "Sam", FamilyName: "Lee" },
    { Id: "9", DisplayName: "Pat Former", GivenName: "Pat", FamilyName: "Former" }
  ];
  const employees = [
    { id: ANA, first_name: "Ana", last_name: "Lopez", email: "ana@bakery.ca", province: "ON", is_active: true },
    { id: SAM, first_name: "Sam", last_name: "Lee", email: "sam@bakery.ca", province: "ON", is_active: true },
    { id: LEFT, first_name: "Pat", last_name: "Former", email: "pat@bakery.ca", province: "ON", is_active: false }
  ];
  const approvals = [{ id: "ap-ana", employee_id: ANA }, { id: "ap-sam", employee_id: SAM }, { id: "ap-left", employee_id: LEFT }];
  const punches = [...workWeek(ANA), ...workWeek(SAM), ...workWeek(LEFT)];
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const u = decodeURIComponent(String(url)), method = options.method || "GET";
    const body = options.body && typeof options.body === "string" && options.body.startsWith("{") ? JSON.parse(options.body) : null;
    calls.push({ url: u, method, body, headers: options.headers });
    // Supabase
    if (u.endsWith("/auth/v1/user")) return json({ id: ADMIN, email: "owner@bakery.ca" });
    if (u.includes("/user_roles?")) return json([{ role, organization_id: COMPANY, organization: { name: "Ana's Bakery", is_active: true } }]);
    if (u.endsWith("/rpc/manager_employee_scope")) return json({ employeeIds: [ANA] });
    if (u.includes("/organizations?id=")) return json([{ pay_frequency: "semi_monthly", pay_period_anchor: null, pay_schedule_changes: [] }]);
    if (u.includes("/employees?")) return json(employees.filter(e => !u.includes("is_active=eq.true") || e.is_active));
    if (u.includes("/timecard_approvals?")) return json(approvals);
    if (u.includes("/overtime_rules?")) return json([{ province_code: "ON", calculation_method: "weekly_only", weekly_overtime_enabled: true, weekly_threshold_hours: "44.00", daily_overtime_enabled: false, week_start_day: 0, effective_from: "2020-01-01", effective_to: null }]);
    if (u.includes("/punches?")) return json(punches);
    if (u.includes("/accounting_connections")) {
      if (method === "GET") return json(state.connection ? [state.connection] : []);
      if (method === "POST") { state.connection = { ...state.connection, ...body }; return new Response(null, { status: 201 }); }
      if (method === "PATCH") { Object.assign(state.connection, body); return new Response(null, { status: 204 }); }
      if (method === "DELETE") { state.connection = null; return new Response(null, { status: 204 }); }
    }
    if (u.includes("/employee_accounting_links")) {
      if (method === "GET") return json(state.links);
      if (method === "POST") { state.links = state.links.filter(l => l.employee_id !== body.employee_id).concat(body); return new Response(null, { status: 201 }); }
      if (method === "DELETE") { const one = u.match(/employee_id=eq\.([0-9a-f-]+)/); state.links = one ? state.links.filter(l => l.employee_id !== one[1]) : []; return new Response(null, { status: 204 }); }
    }
    if (u.includes("/accounting_timecard_syncs")) {
      if (method === "POST") {
        if (state.syncs.has(body.approval_id)) return json([]);
        state.syncs.set(body.approval_id, { ...body }); return json([{ ...body }], 201);
      }
      const id = u.match(/approval_id=eq\.([\w-]+)/)?.[1];
      if (method === "GET") return json(id ? [state.syncs.get(id)].filter(Boolean) : [...state.syncs.values()]);
      if (method === "PATCH") {
        const row = state.syncs.get(id);
        if (!row || (u.includes("status=eq.failed") && row.status !== "failed") || (u.includes("status=eq.sending") && row.status !== "sending")) return json([]);
        if (u.includes("attempted_at=lt.") && !(row.attempted_at < u.match(/attempted_at=lt\.([^&]+)/)[1])) return json([]);
        Object.assign(row, structuredClone(body)); return json([{ ...row }]);
      }
    }
    // Intuit
    if (u.includes("/oauth2/v1/tokens/bearer")) return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600, x_refresh_token_expires_in: 8640000 }));
    if (u.includes("/oauth2/tokens/revoke")) { state.revoked.push(JSON.parse(options.body).token); return new Response("{}"); }
    if (u.includes("/companyinfo/")) return new Response(JSON.stringify({ CompanyInfo: { CompanyName: "Ana's Bakery QB" } }));
    if (u.includes("/query?")) return new Response(JSON.stringify({ QueryResponse: { Employee: people } }));
    if (u.includes("/batch?")) {
      state.batches.push(body.BatchItemRequest.map(i => i.TimeActivity));
      return new Response(JSON.stringify({ BatchItemResponse: body.BatchItemRequest.map((item, n) => batchFails(item.TimeActivity, n)
        ? { bId: item.bId, Fault: { Error: [{ Message: "Something went wrong" }] } } : { bId: item.bId, TimeActivity: { Id: String(state.nextId++) } }) }));
    }
    throw new Error(`Unexpected URL: ${method} ${u}`);
  };
  return { state, calls, config, restore() { global.fetch = original; process.env = env; } };
}

async function call(method, body, query = {}) {
  const res = response();
  await handler({ method, headers: { authorization: "Bearer token" }, query, body }, res);
  return res;
}

test("only the business's admins can use QuickBooks", async () => {
  const fake = install({ role: "manager" });
  try {
    for (const res of [await call("GET"), await call("POST", { action: "connect" })]) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.error, "Only this business's admins can manage QuickBooks.");
    }
    assert.equal(fake.calls.some(c => c.url.includes("accounting_")), false);
  } finally { fake.restore(); }
});

test("before Tymrak's Intuit keys are added, the page says so and nothing can be sent", async () => {
  const fake = install({ configured: false });
  try {
    const page = await call("GET");
    assert.equal(page.statusCode, 200);
    assert.equal(page.payload.configured, false);
    assert.equal(page.payload.connection, null);
    const sent = await call("POST", { action: "sync", period: PERIOD.key });
    assert.equal(sent.statusCode, 503);
  } finally { fake.restore(); }
});

test("connecting signs the request to this admin and company, and stores tokens encrypted", async () => {
  const fake = install({ connected: false, links: [{ employee_id: ANA, external_id: "7" }] });
  try {
    const started = await call("POST", { action: "connect" });
    assert.equal(started.statusCode, 200);
    const stateValue = new URL(started.payload.url).searchParams.get("state");

    const forged = signState({ organizationId: COMPANY, userId: "someone-else" }, fake.config.key);
    const refused = await call("POST", { action: "complete", code: "auth-code", state: forged, realmId: "9130" });
    assert.equal(refused.statusCode, 400);
    assert.equal(fake.state.connection, null);
    assert.equal((await call("POST", { action: "complete", code: "auth-code", state: stateValue, realmId: "91; drop" })).statusCode, 400);

    const done = await call("POST", { action: "complete", code: "auth-code", state: stateValue, realmId: "9130" });
    assert.equal(done.statusCode, 200);
    assert.equal(done.payload.companyName, "Ana's Bakery QB");
    const saved = fake.state.connection;
    assert.equal(saved.realm_id, "9130");
    assert.equal(saved.connected_by, ADMIN);
    assert.doesNotMatch(JSON.stringify(saved), /fresh-access|fresh-refresh/);
    assert.equal(decryptSecret(saved.refresh_token_encrypted, fake.config.key), "fresh-refresh");
    const exchange = fake.calls.find(c => c.url.includes("tokens/bearer"));
    assert.match(String(exchange.url), /oauth\.platform\.intuit\.com/);
    assert.equal(fake.state.links.length, 1, "same company: matches are kept");

    // Connecting a different QuickBooks company clears the old matches.
    await call("POST", { action: "complete", code: "auth-code-2", state: signState({ organizationId: COMPANY, userId: ADMIN }, fake.config.key), realmId: "4620" });
    assert.equal(fake.state.connection.realm_id, "4620");
    assert.equal(fake.state.links.length, 0);
  } finally { fake.restore(); }
});

test("disconnecting revokes the QuickBooks token and removes the connection", async () => {
  const fake = install();
  try {
    assert.equal((await call("POST", { action: "disconnect" })).statusCode, 200);
    assert.deepEqual(fake.state.revoked, ["refresh"]);
    assert.equal(fake.state.connection, null);
  } finally { fake.restore(); }
});

test("employees are matched automatically or by hand, one QuickBooks person each", async () => {
  const fake = install();
  try {
    const page = await call("GET", undefined, { period: PERIOD.key });
    assert.deepEqual(page.payload.suggestions.map(s => [s.employeeId, s.externalId, s.matchedBy]), [[ANA, "7", "email"], [SAM, "8", "name"]]);
    assert.deepEqual(page.payload.employees.map(e => e.id), [ANA, SAM], "only current employees are listed for matching");

    const auto = await call("POST", { action: "auto_match" });
    assert.equal(auto.payload.matched, 2);
    assert.deepEqual(fake.state.links.map(l => [l.employee_id, l.external_id, l.matched_by]), [[ANA, "7", "email"], [SAM, "8", "name"]]);

    const taken = await call("POST", { action: "match", employeeId: SAM, externalId: "7" });
    assert.equal(taken.statusCode, 409);
    assert.equal((await call("POST", { action: "match", employeeId: SAM, externalId: "999" })).statusCode, 400);
    assert.equal((await call("POST", { action: "match", employeeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", externalId: "8" })).statusCode, 404);

    assert.equal((await call("POST", { action: "match", employeeId: SAM, externalId: null })).statusCode, 200);
    assert.deepEqual(fake.state.links.map(l => l.employee_id), [ANA]);
    assert.equal((await call("POST", { action: "match", employeeId: SAM, externalId: "8" })).statusCode, 200);
    assert.equal(fake.state.links.find(l => l.employee_id === SAM).matched_by, "manual");
  } finally { fake.restore(); }
});

test("sending creates one regular-hours entry per day, lists overtime, and never sends twice", async () => {
  const fake = install({ links: [{ employee_id: ANA, external_id: "7" }, { employee_id: LEFT, external_id: "9" }] });
  try {
    const sent = await call("POST", { action: "sync", period: PERIOD.key });
    assert.equal(sent.statusCode, 200);
    const byName = Object.fromEntries(sent.payload.results.map(r => [r.employeeName, r]));
    assert.equal(byName["Ana Lopez"].status, "synced");
    assert.equal(byName["Ana Lopez"].entriesSent, 5);
    assert.equal(byName["Ana Lopez"].manualHours.reduce((s, h) => s + h.minutes, 0), 6 * 60, "50 hours in a 44-hour week: 6 hours overtime");
    assert.equal(byName["Pat Former"].status, "synced", "someone who left still gets their last approved timecard sent");
    assert.equal(byName["Sam Lee"].status, "failed");
    assert.match(byName["Sam Lee"].message, /Not matched/);

    const anaEntries = fake.state.batches.flat().filter(a => a.EmployeeRef.value === "7");
    assert.equal(anaEntries.reduce((s, a) => s + a.Hours * 60 + a.Minutes, 0), 44 * 60, "only regular hours are sent");
    assert.ok(anaEntries.every(a => a.NameOf === "Employee" && a.BillableStatus === "NotBillable" && a.TxnDate >= PERIOD.startKey && a.TxnDate <= PERIOD.endKey));
    assert.equal(fake.state.syncs.get("ap-ana").status, "synced");
    assert.equal(fake.state.syncs.get("ap-ana").entries.length, 5);
    assert.equal(fake.state.syncs.get("ap-sam").status, "failed");

    const batchesBefore = fake.state.batches.length;
    const again = await call("POST", { action: "sync", period: PERIOD.key });
    assert.equal(again.payload.results.find(r => r.employeeName === "Ana Lopez").message, "Already sent.");
    assert.equal(fake.state.batches.length, batchesBefore, "nothing sent twice");

    const page = await call("GET", undefined, { period: PERIOD.key });
    const cards = Object.fromEntries(page.payload.timecards.map(c => [c.employeeName, c]));
    assert.equal(cards["Ana Lopez"].status, "synced");
    assert.equal(cards["Ana Lopez"].entriesSent, 5);
    assert.equal(cards["Sam Lee"].status, "failed");
    assert.equal(cards["Pat Former"].employeeName, "Pat Former");
  } finally { fake.restore(); }
});

test("a partly failed send is retried for the missing days only", async () => {
  let failOnce = true;
  const fake = install({ links: [{ employee_id: ANA, external_id: "7" }], batchFails: (_, n) => n === 2 && failOnce });
  try {
    const first = await call("POST", { action: "sync", period: PERIOD.key });
    const ana = first.payload.results.find(r => r.employeeName === "Ana Lopez");
    assert.equal(ana.status, "failed");
    assert.equal(ana.entriesSent, 4);
    assert.equal(fake.state.syncs.get("ap-ana").entries.length, 4);
    failOnce = false;
    const retry = await call("POST", { action: "sync", period: PERIOD.key });
    assert.equal(retry.payload.results.find(r => r.employeeName === "Ana Lopez").status, "synced");
    const lastAna = fake.state.batches.at(-1).filter(a => a.EmployeeRef.value === "7");
    assert.equal(lastAna.length, 1, "only the missing day is sent again");
    assert.equal(fake.state.syncs.get("ap-ana").entries.length, 5);
  } finally { fake.restore(); }
});

test("a timecard someone else is sending right now is skipped", async () => {
  const fake = install({ links: [{ employee_id: ANA, external_id: "7" }],
    syncs: [{ approval_id: "ap-ana", employee_id: ANA, status: "sending", attempted_at: new Date().toISOString() }] });
  try {
    const sent = await call("POST", { action: "sync", period: PERIOD.key });
    const ana = sent.payload.results.find(r => r.employeeName === "Ana Lopez");
    assert.equal(ana.status, "skipped");
    assert.match(ana.message, /Someone else/);
    assert.equal(fake.state.batches.flat().some(a => a.EmployeeRef.value === "7"), false);
  } finally { fake.restore(); }
});

test("future or made-up pay periods are refused", async () => {
  const fake = install();
  try {
    assert.equal((await call("POST", { action: "sync", period: "2099-01-01" })).statusCode, 400);
    assert.equal((await call("POST", { action: "sync" })).statusCode, 400);
    assert.equal((await call("GET", undefined, { period: "nonsense" })).statusCode, 400);
  } finally { fake.restore(); }
});
