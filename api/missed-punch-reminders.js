import crypto from "node:crypto";
import { getSupabaseConfiguration } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { normalizePayTimeline, payPeriodFor, previousPayPeriod } from "../pay-periods.js";
import { todayKey } from "./_pay-schedule.js";
import { findMissedPunches } from "./_missed-punches.js";
import { missedPunchesEmail, sendEmails } from "./_email.js";
import { getSiteUrl } from "./_deployment-config.js";

// Runs once each morning (Vercel scheduled job, see vercel.json). For every active business:
// finds missed punches in the current and previous pay period and emails them to its admins
// (everyone) and managers (only the people they manage). Nothing is sent when nothing is
// missing. Only Vercel can call it: the request must carry the CRON_SECRET.

const idList = ids => encodeURIComponent(`(${ids.map(id => `"${String(id).replaceAll('"', "")}"`).join(",")})`);

function authorized(req, secret) {
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(String(req.headers?.authorization || ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export async function runMissedPunchReminders(configuration, now = new Date(), siteUrl = getSiteUrl()) {
  const { supabaseUrl, secretKey } = configuration;
  const get = async path => {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: databaseHeaders(secretKey) });
    if (!response.ok) throw new Error(`Reminder query failed (${path.split("?")[0]})`);
    return response.json();
  };
  const emailOf = async userId => {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: databaseHeaders(secretKey) });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user?.email === "string" && user.email.includes("@") ? user.email : null;
  };
  const summary = { companies: 0, companiesWithIssues: 0, issues: 0, emails: 0, emailsSent: 0, failedCompanies: 0 };
  const companies = await get("organizations?is_active=eq.true&select=id,name,pay_frequency,pay_period_anchor,pay_schedule_changes(id,pay_frequency,pay_period_anchor,effective_from)");
  const today = todayKey(now);
  const messages = [];
  for (const company of companies) {
    summary.companies += 1;
    try {
      const schedule = normalizePayTimeline(company);
      const current = payPeriodFor(today, schedule);
      const periods = [previousPayPeriod(current, schedule), current];
      const employees = await get(`employees?organization_id=eq.${company.id}&select=id,first_name,last_name,province`);
      if (!employees.length) continue;
      const ids = idList(employees.map(e => e.id));
      const from = new Date(`${periods[0].startKey}T00:00:00Z`).getTime() - 2 * 86400000;
      const [punches, approvals] = await Promise.all([
        get(`punches?employee_id=in.${ids}&punched_at=gte.${encodeURIComponent(new Date(from).toISOString())}&select=id,employee_id,punch_type,punched_at&order=punched_at.asc,id.asc`),
        get(`timecard_approvals?employee_id=in.${ids}&status=eq.approved&period_start=gte.${periods[0].startKey}&select=employee_id,period_start`)
      ]);
      const approved = new Map();
      for (const a of approvals) { if (!approved.has(a.employee_id)) approved.set(a.employee_id, new Set()); approved.get(a.employee_id).add(a.period_start); }
      const issues = findMissedPunches({ employees, punches, approvedPeriodsByEmployee: approved, periods, now });
      if (!issues.length) continue;
      summary.companiesWithIssues += 1;
      summary.issues += issues.length;
      const roles = await get(`user_roles?organization_id=eq.${company.id}&role=in.(admin,manager)&select=auth_user_id,role`);
      const seen = new Set();
      for (const role of roles) {
        if (!role.auth_user_id || seen.has(role.auth_user_id)) continue;
        seen.add(role.auth_user_id);
        let mine = issues;
        if (role.role !== "admin") {
          const scope = await fetch(`${supabaseUrl}/rest/v1/rpc/manager_employee_scope`, {
            method: "POST", headers: databaseHeaders(secretKey), body: JSON.stringify({ p_manager_id: role.auth_user_id }) });
          const body = scope.ok ? await scope.json() : null;
          const allowed = new Set(Array.isArray(body?.employeeIds) ? body.employeeIds : []);
          mine = issues.filter(issue => allowed.has(issue.employeeId));
        }
        if (!mine.length) continue;
        const to = await emailOf(role.auth_user_id);
        if (!to) continue;
        messages.push({ to, ...missedPunchesEmail({ companyName: company.name, siteUrl, issues: mine, currentPeriodStart: current.startKey }) });
      }
    } catch (error) {
      summary.failedCompanies += 1;
      console.error("Missed punch reminder failed for a company", { errorName: error?.name || "Error" });
    }
  }
  summary.emails = messages.length;
  if (messages.length) summary.emailsSent = (await sendEmails(messages)).sent;
  return summary;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  if (!authorized(req, process.env.CRON_SECRET)) return res.status(401).json({ error: "Unauthorized" });
  const configuration = getSupabaseConfiguration();
  if (!configuration) return res.status(500).json({ error: "Server configuration unavailable" });
  try {
    const summary = await runMissedPunchReminders(configuration);
    console.info("Missed punch reminders", summary);
    return res.status(200).json(summary);
  } catch (error) {
    console.error("Missed punch reminders failed", { errorName: error?.name || "Error" });
    return res.status(500).json({ error: "Reminders failed" });
  }
}
