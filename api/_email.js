// Tymrak's own notification emails (sign-in invitations go through Supabase instead).
// Sent with Resend from the same address as the invitations. Best effort: if email isn't
// configured or Resend is unavailable, the caller carries on and tells the admin.

const FROM = "TYMRAK <invite@tymrak.com>";
const escape = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

export async function sendEmail({ to, subject, html, text }, env = process.env) {
  const key = env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: "not_configured" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text })
    });
    return response.ok ? { sent: true } : { sent: false, reason: `status_${response.status}` };
  } catch {
    return { sent: false, reason: "unreachable" };
  }
}

// Several emails at once (for example, everyone whose timecard was just approved). Resend's
// batch endpoint takes up to 100 per request and counts each request once toward its rate
// limit. Best effort, like sendEmail: returns how many were accepted.
export async function sendEmails(messages, env = process.env) {
  const list = (messages || []).filter(m => m && m.to);
  const key = env.RESEND_API_KEY;
  if (!list.length) return { sent: 0, failed: 0 };
  if (!key) return { sent: 0, failed: list.length, reason: "not_configured" };
  let sent = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const response = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map(({ to, subject, html, text }) => ({ from: FROM, to: [to], subject, html, text })))
      });
      if (response.ok) sent += chunk.length;
    } catch { /* counted as failed below */ }
  }
  return { sent, failed: list.length - sent };
}

const frame = body => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#2b1d14">
<div style="background:#45210f;color:#fff;padding:22px 26px;border-radius:10px 10px 0 0"><div style="font-size:22px;font-weight:bold">TYMRAK</div><div style="color:#f0b840">Time. Tracked Right.</div></div>
<div style="background:#fff;border:1px solid #eadfd2;border-top:0;padding:24px 26px;border-radius:0 0 10px 10px;line-height:1.55">${body}</div></div>`;
const button = (href, label) => `<p><a href="${escape(href)}" style="display:inline-block;background:#8d5316;color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:bold">${escape(label)}</a></p>`;
const longDate = key => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
const hoursText = h => (Math.round((h || 0) * 100) / 100).toFixed(2);

// "Your timecard for <period> was approved": sent to the employee when a manager approves it.
// Hours are optional (left out if they couldn't be worked out). Pay is never included.
export function timecardApprovedEmail({ firstName, companyName, siteUrl, startDate, endDate, hours }) {
  const period = `${longDate(startDate)} to ${longDate(endDate)}`;
  const link = `${siteUrl}/timecard.html`;
  const lines = hours ? [["Regular", hours.regular], ["Overtime", hours.overtime], ["Double time", hours.doubleTime]]
    .filter(([label, value]) => label === "Regular" || value > 0).concat([["Total", hours.total]]) : [];
  const subject = `Your timecard was approved: ${period}`;
  const text = `Hello ${firstName || "there"},\n\n${companyName} approved your timecard for ${period}.\n\n` +
    (lines.length ? lines.map(([label, value]) => `${label}: ${hoursText(value)} hours`).join("\n") + "\n\n" : "") +
    `See the details: ${link}\n\nIf something looks wrong, talk to your manager.\n`;
  const table = lines.length ? `<table style="border-collapse:collapse;margin:8px 0 16px">${lines.map(([label, value]) =>
    `<tr><td style="padding:4px 18px 4px 0;${label === "Total" ? "font-weight:bold;border-top:1px solid #eadfd2" : ""}">${escape(label)}</td><td style="padding:4px 0;text-align:right;${label === "Total" ? "font-weight:bold;border-top:1px solid #eadfd2" : ""}">${hoursText(value)} hours</td></tr>`).join("")}</table>` : "";
  const html = frame(`<p style="margin-top:0"><strong>Hello ${escape(firstName || "there")},</strong></p>
<p><strong>${escape(companyName)}</strong> approved your timecard for <strong>${escape(period)}</strong>.</p>
${table}${button(link, "See my timecard")}
<p style="color:#716254;font-size:13px">If something looks wrong, talk to your manager. Hours are in decimals (7.50 = 7 hours 30 minutes).</p>`);
  return { subject, html, text };
}

// Morning reminder for admins and managers: punches that need fixing before payroll.
// issues: [{ name, date, problem, periodStart, periodEnd }] (already limited to people the
// recipient manages). currentPeriodStart marks which period is still running.
export function missedPunchesEmail({ companyName, siteUrl, issues, currentPeriodStart }) {
  const count = issues.length;
  const subject = `${count} missed ${count === 1 ? "punch" : "punches"} at ${companyName}`;
  const groups = [];
  for (const issue of issues) {
    let group = groups.find(g => g.start === issue.periodStart);
    if (!group) groups.push(group = { start: issue.periodStart, end: issue.periodEnd, items: [] });
    group.items.push(issue);
  }
  const heading = g => `${longDate(g.start)} to ${longDate(g.end)}` + (g.start === currentPeriodStart ? " (current pay period)" : " (ended: fix before running payroll)");
  const shortDay = key => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const link = `${siteUrl}/manager.html`;
  const text = `${companyName} has ${count} missed ${count === 1 ? "punch" : "punches"} to fix.\n\n` +
    groups.map(g => `${heading(g)}\n` + g.items.map(i => `- ${i.name}, ${shortDay(i.date)}: ${i.problem}`).join("\n")).join("\n\n") +
    `\n\nFix them in Timecards: open the employee's timecard, click the day and add the missing punch with a reason. ${link}\n\nTYMRAK checks every morning and only emails when something is missing.\n`;
  const cell = "padding:6px 10px 6px 0;border-bottom:1px solid #f0e8de;vertical-align:top";
  const html = frame(`<p style="margin-top:0"><strong>${escape(companyName)}</strong> has <strong>${count} missed ${count === 1 ? "punch" : "punches"}</strong> to fix.</p>
${groups.map(g => `<h3 style="font-size:15px;margin:18px 0 6px">${escape(heading(g))}</h3><table style="border-collapse:collapse;width:100%;font-size:14px">${g.items.map(i =>
  `<tr><td style="${cell}"><strong>${escape(i.name)}</strong></td><td style="${cell};white-space:nowrap">${escape(shortDay(i.date))}</td><td style="${cell}">${escape(i.problem)}</td></tr>`).join("")}</table>`).join("")}
${button(link, "Fix in Timecards")}
<p style="color:#716254;font-size:13px">In Timecards, open the employee's timecard, click the day and use <strong>+ Add a punch on this day</strong>. Check the time with the employee first; they see your reason on their timecard. TYMRAK checks every morning and only emails when something is missing.</p>`);
  return { subject, html, text };
}

// "You've been added to <business>": for someone who already has a TYMRAK sign-in.
export function addedToBusinessEmail({ firstName, companyName, siteUrl, activated }) {
  const signIn = `${siteUrl}/login.html`;
  const next = activated
    ? "Sign in with your usual email and password. If you work for more than one business, TYMRAK asks which one you're working for, and you can switch at any time."
    : "Finish activating your TYMRAK account using the invitation email you received earlier. Once you're in, you can choose which business you're working for.";
  const subject = `You've been added to ${companyName} on TYMRAK`;
  const text = `Hello ${firstName},\n\n${companyName} has added you as an employee on TYMRAK.\n\n${next}\n\n${activated ? `Sign in: ${signIn}\n\n` : ""}If you don't work for ${companyName}, contact them or reply to tymrak@outlook.com.\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#2b1d14">
<div style="background:#45210f;color:#fff;padding:22px 26px;border-radius:10px 10px 0 0"><div style="font-size:22px;font-weight:bold">TYMRAK</div><div style="color:#f0b840">Time. Tracked Right.</div></div>
<div style="background:#fff;border:1px solid #eadfd2;border-top:0;padding:24px 26px;border-radius:0 0 10px 10px;line-height:1.55">
<p style="margin-top:0"><strong>Hello ${escape(firstName)},</strong></p>
<p><strong>${escape(companyName)}</strong> has added you as an employee on TYMRAK.</p>
<p>${escape(next)}</p>
${activated ? `<p><a href="${escape(signIn)}" style="display:inline-block;background:#8d5316;color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:bold">Sign in to TYMRAK</a></p>` : ""}
<p style="color:#716254;font-size:13px">If you don't work for ${escape(companyName)}, contact them or email tymrak@outlook.com.</p>
</div></div>`;
  return { subject, html, text };
}
