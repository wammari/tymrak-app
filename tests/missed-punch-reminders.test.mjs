import "./_test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import handler, { runMissedPunchReminders } from "../api/missed-punch-reminders.js";
import { findMissedPunches } from "../api/_missed-punches.js";
import { missedPunchesEmail } from "../api/_email.js";

// "Now" is Tue Nov 18, 2026, 06:30 in Toronto (11:30 UTC). Semi-monthly: current Nov 16–30, previous Nov 1–15.
const NOW = new Date("2026-11-18T11:30:00Z");
const PERIODS = [{ startKey: "2026-11-01", endKey: "2026-11-15" }, { startKey: "2026-11-16", endKey: "2026-11-30" }];
const p = (id, employee_id, punch_type, punched_at) => ({ id, employee_id, punch_type, punched_at });
const people = [
  { id: "ana", first_name: "Ana", last_name: "Lopez", province: "ON" },
  { id: "sam", first_name: "Sam", last_name: "Lee", province: "ON" },
  { id: "kim", first_name: "Kim", last_name: "Night", province: "ON" },
  { id: "old", first_name: "Olga", last_name: "Old", province: "ON" }
];
const punches = [
  // Ana: Nov 10 clocked in 9:00 and never out (previous period); Nov 17 complete.
  p(1, "ana", "clock_in", "2026-11-10T14:00:00Z"),
  p(2, "ana", "clock_in", "2026-11-17T14:00:00Z"), p(3, "ana", "clock_out", "2026-11-17T22:00:00Z"),
  // Sam: Nov 17 clock-out with no clock-in; working right now (clocked in today 6:00).
  p(4, "sam", "clock_out", "2026-11-17T22:05:00Z"),
  p(5, "sam", "clock_in", "2026-11-18T11:00:00Z"),
  // Kim: overnight shift started yesterday 22:00, still going at 6:30: not a problem yet.
  p(6, "kim", "clock_in", "2026-11-18T03:00:00Z"),
  // Olga: missing punch in October: too old to report.
  p(7, "old", "clock_in", "2026-10-20T14:00:00Z")
];

test("finds missing clock-outs and clock-ins, but not shifts that are still going or too old", () => {
  const issues = findMissedPunches({ employees: people, punches, periods: PERIODS, now: NOW });
  assert.deepEqual(issues.map(i => [i.name, i.date, i.problem, i.periodStart]), [
    ["Ana Lopez", "2026-11-10", "Clocked in at 9:00 a.m., no clock-out", "2026-11-01"],
    ["Sam Lee", "2026-11-17", "Clocked out at 5:05 p.m. with no clock-in", "2026-11-16"]
  ]);
});

test("an approved timecard isn't nagged about", () => {
  const approved = new Map([["ana", new Set(["2026-11-01"])]]);
  const issues = findMissedPunches({ employees: people, punches, approvedPeriodsByEmployee: approved, periods: PERIODS, now: NOW });
  assert.deepEqual(issues.map(i => i.name), ["Sam Lee"]);
});

test("an overnight shift is reported once it's been open for more than 16 hours", () => {
  const later = new Date("2026-11-18T20:00:00Z");
  const issues = findMissedPunches({ employees: people.filter(x => x.id === "kim"), punches, periods: PERIODS, now: later });
  assert.equal(issues.length, 1);
  assert.match(issues[0].problem, /no clock-out/);
});

function install({ roles, scope = { employeeIds: ["sam"] }, approvals = [] } = {}) {
  const originalFetch = global.fetch, originalEnv = { ...process.env };
  process.env.RESEND_API_KEY = "re_test";
  const batches = [], calls = [];
  global.fetch = async (raw, options = {}) => {
    const url = String(raw); calls.push(url);
    if (url.startsWith("https://api.resend.com/emails/batch")) { batches.push(JSON.parse(options.body)); return new Response("{}"); }
    if (url.includes("/organizations?is_active=eq.true")) return new Response(JSON.stringify([
      { id: "org-1", name: "I Care Pharmacy", pay_frequency: "semi_monthly", pay_period_anchor: null, pay_schedule_changes: [] },
      { id: "org-2", name: "Quiet Shop", pay_frequency: "semi_monthly", pay_period_anchor: null, pay_schedule_changes: [] }
    ]));
    if (url.includes("/employees?organization_id=eq.org-1")) return new Response(JSON.stringify(people));
    if (url.includes("/employees?organization_id=eq.org-2")) return new Response("[]");
    if (url.includes("/punches?")) return new Response(JSON.stringify(punches));
    if (url.includes("/timecard_approvals?")) return new Response(JSON.stringify(approvals));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify(roles));
    if (url.includes("/rpc/manager_employee_scope")) return new Response(JSON.stringify(scope));
    const user = /admin\/users\/([^/?]+)/.exec(url);
    if (user) return new Response(JSON.stringify({ id: user[1], email: `${user[1]}@example.com` }));
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { batches, calls, restore() { global.fetch = originalFetch; process.env = originalEnv; } };
}
const config = { supabaseUrl: "https://example.supabase.co", secretKey: "sb_secret_test" };

test("admins get every missed punch, managers only their own people, and quiet companies get nothing", async () => {
  const env = install({ roles: [
    { auth_user_id: "owner", role: "admin" }, { auth_user_id: "shift-lead", role: "manager" }, { auth_user_id: "other-lead", role: "manager" }
  ], scope: { employeeIds: ["sam"] } });
  try {
    const summary = await runMissedPunchReminders(config, NOW, "https://app.tymrak.com");
    assert.deepEqual(summary, { companies: 2, companiesWithIssues: 1, issues: 2, emails: 3, emailsSent: 3, failedCompanies: 0 });
    assert.equal(env.batches.length, 1, "one batch for everyone");
    const byTo = Object.fromEntries(env.batches[0].map(m => [m.to[0], m]));
    assert.match(byTo["owner@example.com"].subject, /^2 missed punches at I Care Pharmacy$/);
    assert.match(byTo["owner@example.com"].text, /Ana Lopez/);
    assert.match(byTo["owner@example.com"].text, /ended: review before running payroll/);
    assert.match(byTo["shift-lead@example.com"].subject, /^1 missed punch at/);
    assert.doesNotMatch(byTo["shift-lead@example.com"].text, /Ana/, "managers only hear about people they manage");
    assert.ok(env.calls.every(u => !u.includes("org-2") || !u.includes("/punches?")), "no punches loaded for a company without employees");
  } finally { env.restore(); }
});

test("nothing is sent when nothing is missing", async () => {
  const env = install({ roles: [{ auth_user_id: "owner", role: "admin" }],
    approvals: [{ employee_id: "ana", period_start: "2026-11-01" }, { employee_id: "sam", period_start: "2026-11-16" }] });
  try {
    const summary = await runMissedPunchReminders(config, NOW, "https://app.tymrak.com");
    assert.equal(summary.emails, 0);
    assert.equal(env.batches.length, 0);
  } finally { env.restore(); }
});

test("only Vercel's scheduler (with the secret) can run it", async () => {
  const originalEnv = { ...process.env };
  const run = async headers => {
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ method: "GET", headers }, res);
    return res.code;
  };
  try {
    delete process.env.CRON_SECRET;
    assert.equal(await run({ authorization: "Bearer anything" }), 401, "refused when no secret is set");
    process.env.CRON_SECRET = "a-long-random-cron-secret-value";
    assert.equal(await run({}), 401);
    assert.equal(await run({ authorization: "Bearer wrong" }), 401);
    assert.equal(await run({ authorization: "Bearer a-long-random-cron-secret-valuX" }), 401);
  } finally { process.env = originalEnv; }
});

test("it runs once a day from vercel.json, and the email is safe", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.crons, [{ path: "/api/missed-punch-reminders", schedule: "0 11 * * *" }]);
  const mail = missedPunchesEmail({ companyName: "A&B <Shop>", siteUrl: "https://app.tymrak.com", currentPeriodStart: "2026-11-16",
    issues: [{ name: "<i>Ana</i>", date: "2026-11-17", problem: "Clocked in at 9:00 a.m., no clock-out", periodStart: "2026-11-16", periodEnd: "2026-11-30" }] });
  assert.match(mail.html, /A&amp;B &lt;Shop&gt;/);
  assert.match(mail.html, /&lt;i&gt;Ana&lt;\/i&gt;/);
  assert.match(mail.text, /current pay period/);
  assert.match(mail.html, /manager\.html/);
});
