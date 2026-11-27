import "./_test-environment.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/manager-timecard-approvals.js";
import { timecardApprovedEmail } from "../api/_email.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ON_RULE = { province_code: "ON", daily_threshold_hours: null, weekly_threshold_hours: 44, daily_overtime_enabled: false, weekly_overtime_enabled: true,
  calculation_method: "weekly", week_start_day: 0, overtime_multiplier: 1.5, double_time_threshold_hours: null, double_time_multiplier: null,
  holiday_rule: null, holiday_week_threshold_hours: null, holiday_reduction_hours: null, effective_from: "2020-01-01", effective_to: null };

// Ana worked 5 × 10h in the week of Nov 2 (Toronto, 9:00–19:00 = 14:00–00:00 UTC): 44 regular + 6 overtime.
const anaPunches = ["02", "03", "04", "05", "06"].flatMap((day, i) => [
  { id: i * 2 + 1, employee_id: "e-ana", punch_type: "clock_in", punched_at: `2026-11-${day}T14:00:00Z` },
  { id: i * 2 + 2, employee_id: "e-ana", punch_type: "clock_out", punched_at: `2026-11-${day}T24:00:00Z`.replace(/(\d\d)T24/, (_, d) => `${String(Number(d) + 1).padStart(2, "0")}T00`) }
]);

function install({ existing = [], resendFails = false, key = "re_test" } = {}) {
  const originalFetch = global.fetch, originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  if (key) process.env.RESEND_API_KEY = key; else delete process.env.RESEND_API_KEY;
  const approvals = existing.map(a => ({ ...a })), batches = [];
  global.fetch = async (raw, options = {}) => {
    const url = String(raw);
    if (url.startsWith("https://api.resend.com/emails/batch")) {
      batches.push(JSON.parse(options.body));
      return new Response(resendFails ? "{}" : JSON.stringify({ data: [] }), { status: resendFails ? 500 : 200 });
    }
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "approver" }));
    if (url.includes("/user_roles?")) return new Response(JSON.stringify([{ role: "admin", organization_id: COMPANY, organization: { is_active: true } }]));
    if (url.includes("/organizations?id=") && url.includes("select=name")) return new Response(JSON.stringify([{ name: "I Care Pharmacy" }]));
    if (url.includes("/organizations?id=")) return new Response(JSON.stringify([{ pay_frequency: "semi_monthly", pay_period_anchor: null }]));
    if (url.includes("/employees?")) return new Response(JSON.stringify([
      { id: "e-ana", province: "ON", first_name: "Ana", email: "ana@example.com" },
      { id: "e-gone", province: "ON", first_name: "Former", email: "deleted-x@deleted.invalid" },
      { id: "e-noemail", province: "ON", first_name: "Sam", email: null }
    ].filter(e => decodeURIComponent(url).includes(`"${e.id}"`))));
    if (url.includes("/overtime_rules?")) return new Response(JSON.stringify([ON_RULE]));
    if (url.includes("/punches?")) return new Response(JSON.stringify(anaPunches));
    if (url.includes("/employee_pay_rates?")) return new Response("[]");
    if (url.includes("/timecard_approvals") && options.method === "POST") {
      for (const r of JSON.parse(options.body)) approvals.push({ id: `a-${approvals.length}`, ...r });
      return new Response(null, { status: 201 });
    }
    if (url.includes("/timecard_approvals") && options.method === "PATCH") {
      const target = approvals.find(a => decodeURIComponent(url).includes(a.employee_id) && a.status === "reopened");
      if (target) Object.assign(target, JSON.parse(options.body));
      return new Response(JSON.stringify(target ? [target] : []));
    }
    if (url.includes("/timecard_approvals?")) return new Response(JSON.stringify(approvals));
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { approvals, batches, restore() { global.fetch = originalFetch; process.env = originalEnv; } };
}

async function approve(employeeIds) {
  const res = { setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
  await handler({ method: "POST", headers: { authorization: "Bearer admin" }, body: { employeeIds, period: "2026-11-01" } }, res);
  return res;
}

test("approving a timecard emails the employee their hours (and never pay)", async () => {
  const env = install();
  try {
    const res = await approve(["e-ana"]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.emailed, 1);
    assert.match(res.payload.message, /1 timecard approved\. 1 employee was emailed\./);
    assert.equal(env.batches.length, 1);
    const [mail] = env.batches[0];
    assert.deepEqual(mail.to, ["ana@example.com"]);
    assert.equal(mail.from, "TYMRAK <invite@tymrak.com>");
    assert.equal(mail.reply_to, "info@tymrak.com", "replies go to the support mailbox");
    assert.match(mail.subject, /approved: November 1, 2026 to November 15, 2026/);
    assert.match(mail.text, /I Care Pharmacy approved your timecard/);
    assert.match(mail.text, /Regular: 44\.00 hours\nOvertime: 6\.00 hours\nTotal: 50\.00 hours/);
    assert.match(mail.text, /\/timecard\.html/);
    assert.doesNotMatch(mail.text + mail.html, /\$|rate|pay\b/i);
  } finally { env.restore(); }
});

test("deleted or missing emails are skipped, and an already approved timecard isn't emailed again", async () => {
  const env = install({ existing: [{ id: "a-old", employee_id: "e-ana", period_start: "2026-11-01", period_end: "2026-11-15", status: "approved" }] });
  try {
    const res = await approve(["e-ana", "e-gone", "e-noemail"]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.emailed, 0);
    assert.equal(env.batches.length, 0);
    assert.match(res.payload.message, /^3 timecards approved$/);
  } finally { env.restore(); }
});

test("re-approving a reopened timecard emails again", async () => {
  const env = install({ existing: [{ id: "a-old", employee_id: "e-ana", period_start: "2026-11-01", period_end: "2026-11-15", status: "reopened" }] });
  try {
    const res = await approve(["e-ana"]);
    assert.equal(res.statusCode, 200);
    assert.equal(env.batches.flat().length, 1);
  } finally { env.restore(); }
});

test("an email problem never blocks the approval", async () => {
  for (const options of [{ resendFails: true }, { key: null }]) {
    const env = install(options);
    try {
      const res = await approve(["e-ana"]);
      assert.equal(res.statusCode, 200, JSON.stringify(options));
      assert.equal(res.payload.emailed, 0);
      assert.equal(env.approvals[0].status, "approved");
    } finally { env.restore(); }
  }
});

test("the email escapes names and works without hours", () => {
  const mail = timecardApprovedEmail({ firstName: "<b>Ana</b>", companyName: "Tom & Jerry's", siteUrl: "https://app.tymrak.com", startDate: "2026-11-16", endDate: "2026-11-30", hours: null });
  assert.match(mail.html, /&lt;b&gt;Ana&lt;\/b&gt;/);
  assert.match(mail.html, /Tom &amp; Jerry&#39;s/);
  assert.doesNotMatch(mail.text, /hours\n/);
  assert.match(mail.subject, /November 16, 2026 to November 30, 2026/);
});
