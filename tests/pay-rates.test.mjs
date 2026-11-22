import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { estimatePay, parseRate, rateOn } from "../api/_pay-rates.js";
import payRatesHandler from "../api/manager-pay-rates.js";
import timecardsHandler from "../api/manager-timecards.js";
import { PostgrestResponse } from "./_postgrest-response.mjs";

const H = 3600000;
const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ADMIN = "11111111-1111-4111-8111-111111111111";
const ANA = "a1111111-1111-4111-8111-111111111111", OTHER = "b2222222-2222-4222-8222-222222222222";
const json = (body, status = 200) => new PostgrestResponse(JSON.stringify(body), { status });
const response = () => ({ statusCode: null, payload: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } });

test("the rate that applies is the latest one started on or before the day", () => {
  const rates = [{ effective_from: "2026-01-01", hourly_rate: "18.00" }, { effective_from: "2026-11-05", hourly_rate: "20.00" }];
  assert.equal(rateOn(rates, "2025-12-31"), null);
  assert.equal(rateOn(rates, "2026-11-04").hourly_rate, "18.00");
  assert.equal(rateOn(rates, "2026-11-05").hourly_rate, "20.00");
});

test("estimated pay uses each day's rate and the province's overtime multipliers", () => {
  const rates = [{ effective_from: "2026-01-01", hourly_rate: "18.00" }, { effective_from: "2026-11-05", hourly_rate: "20.00" }];
  const days = [
    { date: "2026-11-03", regularMilliseconds: 8 * H, overtimeMilliseconds: 0, doubleTimeMilliseconds: 0 },   // 8 × 18 = 144
    { date: "2026-11-06", regularMilliseconds: 4 * H, overtimeMilliseconds: 6 * H, doubleTimeMilliseconds: 0 }, // 4 × 20 + 6 × 30 = 260
    { date: "2026-11-07", regularMilliseconds: 0, overtimeMilliseconds: 0, doubleTimeMilliseconds: 1.5 * H }   // 1.5 × 40 = 60
  ];
  const pay = estimatePay(days, rates, { overtime_multiplier: "1.50", double_time_multiplier: "2.00" }, { endKey: "2026-11-15" });
  assert.deepEqual(pay, {
    hourlyRate: 20, rateSince: "2026-11-05", rateChangedInPeriod: true, overtimeMultiplier: 1.5, doubleTimeMultiplier: 2,
    regularPay: 224, overtimePay: 180, doubleTimePay: 60, estimatedGross: 464, hoursWithoutRate: 0
  });
});

test("hours before the first rate are left out and reported", () => {
  const pay = estimatePay([{ date: "2026-11-02", regularMilliseconds: 7.5 * H }, { date: "2026-11-10", regularMilliseconds: 8 * H }],
    [{ effective_from: "2026-11-09", hourly_rate: "17.60" }], null, { endKey: "2026-11-15" });
  assert.equal(pay.estimatedGross, 140.8);
  assert.equal(pay.hoursWithoutRate, 7.5);
  assert.equal(pay.overtimeMultiplier, 1.5, "defaults when no rule");
  assert.equal(estimatePay([], [], null, { endKey: "2026-11-15" }).hourlyRate, null);
});

test("rates are checked", () => {
  assert.equal(parseRate("18.5"), 18.5);
  assert.equal(parseRate("$22.75"), 22.75);
  for (const bad of ["0", "-5", "abc", "18.555", "10000", "", null]) assert.equal(parseRate(bad), null, String(bad));
});

// ---- API ------------------------------------------------------------------------------
function install(role = "admin") {
  const original = global.fetch, env = { ...process.env }, calls = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  let rates = [{ employee_id: ANA, organization_id: COMPANY, hourly_rate: "18.00", effective_from: "2026-01-01", created_at: "2026-01-01T00:00:00Z" }];
  global.fetch = async (url, options = {}) => {
    const u = decodeURIComponent(String(url)), method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ u, method, body });
    if (u.endsWith("/auth/v1/user")) return json({ id: ADMIN });
    if (u.includes("/user_roles?")) return json([{ role, organization_id: COMPANY, organization: { name: "Shop", is_active: true } }]);
    if (u.endsWith("/rpc/manager_employee_scope")) return json({ employeeIds: [ANA] });
    if (u.includes("/organizations?id=")) return json([{ pay_frequency: "semi_monthly", pay_period_anchor: null, pay_schedule_changes: [] }]);
    if (u.includes("/employees?id=eq.")) return json(u.includes(`id=eq.${ANA}`) && u.includes(`organization_id=eq.${COMPANY}`) ? [{ id: ANA }] : []);
    if (u.includes("/employees?")) return json([{ id: ANA, first_name: "Ana", last_name: "Lopez", province: "ON", auth_user_id: null }]);
    if (u.includes("/overtime_rules?")) return json([{ province_code: "ON", calculation_method: "weekly_only", weekly_overtime_enabled: true, weekly_threshold_hours: "44.00", daily_overtime_enabled: false, week_start_day: 0, overtime_multiplier: "1.50", double_time_multiplier: "2.00", effective_from: "2020-01-01", effective_to: null }]);
    if (u.includes("/punches?")) return json([
      { id: 1, employee_id: ANA, punch_type: "clock_in", punched_at: "2026-11-02T14:00:00Z" },
      { id: 2, employee_id: ANA, punch_type: "clock_out", punched_at: "2026-11-02T22:00:00Z" }
    ]);
    if (u.includes("/timecard_approvals?")) return json([]);
    if (u.includes("/employee_pay_rates")) {
      if (method === "POST") { rates = rates.filter(r => !(r.employee_id === body.employee_id && r.effective_from === body.effective_from)).concat({ ...body, hourly_rate: String(body.hourly_rate) }); return new Response(null, { status: 201 }); }
      if (method === "DELETE") { const day = /effective_from=eq\.([\d-]+)/.exec(u)[1]; rates = rates.filter(r => r.effective_from !== day); return new Response(null, { status: 204 }); }
      return json([...rates].sort((a, b) => u.includes("effective_from.desc") ? b.effective_from.localeCompare(a.effective_from) : a.effective_from.localeCompare(b.effective_from)));
    }
    throw new Error(`Unexpected URL: ${method} ${u}`);
  };
  return { calls, rates: () => rates, restore() { global.fetch = original; process.env = env; } };
}
async function call(handler, method, { query = {}, body } = {}) {
  const res = response();
  await handler({ method, headers: { authorization: "Bearer token" }, query, body }, res);
  return res;
}

test("managers can't see or change pay rates", async () => {
  const fake = install("manager");
  try {
    assert.equal((await call(payRatesHandler, "GET", { query: { employeeId: ANA } })).statusCode, 403);
    assert.equal((await call(payRatesHandler, "POST", { body: { action: "set", employeeId: ANA, hourlyRate: "99", effectiveFrom: "2026-11-01" } })).statusCode, 403);
    assert.equal(fake.calls.some(c => c.u.includes("employee_pay_rates")), false);
    const timecards = await call(timecardsHandler, "GET");
    assert.equal(timecards.statusCode, 200);
    assert.equal(timecards.payload.showPay, false);
    assert.equal(timecards.payload.timecards.some(card => "pay" in card), false);
    assert.doesNotMatch(JSON.stringify(timecards.payload), /hourly|estimatedGross/i);
  } finally { fake.restore(); }
});

test("admins see each timecard's rate and estimated pay", async () => {
  const fake = install();
  try {
    const res = await call(timecardsHandler, "GET", { query: { period: "2026-11-01" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.showPay, true);
    const pay = res.payload.timecards[0].pay;
    assert.equal(pay.hourlyRate, 18);
    assert.equal(pay.estimatedGross, 144, "8 hours at $18");
    assert.ok(fake.calls.some(c => c.u.includes("/employee_pay_rates?") && c.u.includes(`organization_id=eq.${COMPANY}`)));
  } finally { fake.restore(); }
});

test("admins set, correct and remove rates for their own employees only", async () => {
  const fake = install();
  try {
    const set = await call(payRatesHandler, "POST", { body: { action: "set", employeeId: ANA, hourlyRate: "20.5", effectiveFrom: "2026-11-05" } });
    assert.equal(set.statusCode, 200);
    assert.deepEqual(set.payload.rates.map(r => [r.effectiveFrom, r.hourlyRate]), [["2026-11-05", 20.5], ["2026-01-01", 18]]);
    const saved = fake.calls.find(c => c.method === "POST" && c.u.includes("employee_pay_rates"));
    assert.match(saved.u, /on_conflict=employee_id,effective_from/);
    assert.deepEqual({ ...saved.body, created_at: "x" }, { employee_id: ANA, organization_id: COMPANY, hourly_rate: 20.5, effective_from: "2026-11-05", created_by: ADMIN, created_at: "x" });
    assert.equal((await call(payRatesHandler, "POST", { body: { action: "set", employeeId: ANA, hourlyRate: "abc", effectiveFrom: "2026-11-05" } })).statusCode, 400);
    assert.equal((await call(payRatesHandler, "POST", { body: { action: "set", employeeId: ANA, hourlyRate: "20", effectiveFrom: "soon" } })).statusCode, 400);
    assert.equal((await call(payRatesHandler, "POST", { body: { action: "set", employeeId: OTHER, hourlyRate: "20", effectiveFrom: "2026-11-05" } })).statusCode, 404, "another company's employee");
    const removed = await call(payRatesHandler, "POST", { body: { action: "delete", employeeId: ANA, effectiveFrom: "2026-11-05" } });
    assert.deepEqual(removed.payload.rates.map(r => r.effectiveFrom), ["2026-01-01"]);
  } finally { fake.restore(); }
});

// ---- Database ---------------------------------------------------------------------------
test("pay rates are server-only, one per start date, and removed with the employee", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      create table public.organizations(id uuid primary key);
      create table public.employees(id uuid primary key, organization_id uuid);
      insert into public.organizations values('${COMPANY}'); insert into public.employees values('${ANA}','${COMPANY}');`);
    await db.exec(fs.readFileSync(new URL("../supabase/migrations/202611220001_employee_pay_rates.sql", import.meta.url), "utf8"));
    const grants = await db.query(`select grantee, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where table_name='employee_pay_rates' and grantee<>'postgres' group by grantee`);
    assert.deepEqual(grants.rows, [{ grantee: "service_role", p: "DELETE,INSERT,SELECT,UPDATE" }]);
    const rls = await db.query(`select relrowsecurity from pg_class where relname='employee_pay_rates'`);
    assert.equal(rls.rows[0].relrowsecurity, true);
    await db.exec(`insert into public.employee_pay_rates(employee_id, organization_id, hourly_rate, effective_from) values('${ANA}','${COMPANY}',18,'2026-01-01')`);
    await assert.rejects(db.exec(`insert into public.employee_pay_rates(employee_id, organization_id, hourly_rate, effective_from) values('${ANA}','${COMPANY}',19,'2026-01-01')`), /one_per_day/);
    await assert.rejects(db.exec(`insert into public.employee_pay_rates(employee_id, organization_id, hourly_rate, effective_from) values('${ANA}','${COMPANY}',0,'2026-02-01')`), /check/);
    await db.exec(`delete from public.employees where id='${ANA}'`);
    assert.equal((await db.query(`select count(*)::int n from public.employee_pay_rates`)).rows[0].n, 0);
  } finally { await db.close(); }
});

test("the Manager Portal only shows pay to admins", () => {
  const page = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(page, /showPay=data\.showPay===true/);
  assert.match(page, /\.\.\.\(showPay\?payCells\(card\):\[\]\)/);
  assert.match(page, /panel\.hidden=!showPay;if\(!showPay\)return;/);
});
