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
