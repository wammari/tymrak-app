import { getSiteUrl } from "./_deployment-config.js";
export const EMPLOYEE_SELECT = [
  "id", "first_name", "last_name", "email", "username", "mobile",
  "position", "department", "province", "hire_date", "invitation_status",
  "activated_at", "is_active"
].join(",");

export const PROVINCES = new Set([
  "AB", "BC", "SK", "MB", "ON", "QC", "NB",
  "NS", "PE", "NL", "NT", "NU", "YT"
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function databaseHeaders(secretKey, prefer) {
  return {
    apikey: secretKey,
    ...(secretKey.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${secretKey}` }),
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
}

export function validateEmployeeInput(body) {
  const input = {
    firstName: cleanString(body?.firstName),
    lastName: cleanString(body?.lastName),
    email: cleanString(body?.email).toLowerCase(),
    username: cleanString(body?.username),
    mobile: cleanString(body?.mobile),
    position: cleanString(body?.position),
    department: cleanString(body?.department),
    province: cleanString(body?.province).toUpperCase(),
    hireDate: cleanString(body?.hireDate),
    isActive: body?.isActive === undefined ? true : body.isActive
  };

  if (!input.firstName || !input.lastName || !input.email ||
      !input.username || !input.province) {
    return { error: "First name, last name, email, username, and province are required" };
  }
  if (!EMAIL_PATTERN.test(input.email) || input.email.length > 254) {
    return { error: "Enter a valid email address" };
  }
  if (!USERNAME_PATTERN.test(input.username) || input.username.length > 64) {
    return { error: "Username may contain only letters, numbers, periods, underscores, and hyphens" };
  }
  if (input.firstName.length > 100 || input.lastName.length > 100 ||
      input.mobile.length > 40 || input.position.length > 150 ||
      input.department.length > 150) {
    return { error: "One or more fields exceed the allowed length" };
  }
  if (!PROVINCES.has(input.province)) {
    return { error: "Select a valid province" };
  }
  if (input.hireDate && (!DATE_PATTERN.test(input.hireDate) ||
      Number.isNaN(Date.parse(`${input.hireDate}T00:00:00Z`)))) {
    return { error: "Enter a valid hire date" };
  }
  if (typeof input.isActive !== "boolean") {
    return { error: "Active status must be true or false" };
  }
  return { input };
}

export function toEmployeeRecord(input) {
  return {
    first_name: input.firstName,
    last_name: input.lastName,
    email: input.email,
    username: input.username,
    mobile: input.mobile || null,
    position: input.position || null,
    department: input.department || null,
    province: input.province,
    hire_date: input.hireDate || null,
    is_active: input.isActive
  };
}

export async function findDuplicate({ supabaseUrl, secretKey, organizationId, scopeFilter = '', email, username, excludeId }) {
  if (!organizationId) throw new Error("Company membership required");
  const headers = databaseHeaders(secretKey);
  const filters = [
    ["email", "eq", email, "email"],
    // Escape SQL LIKE wildcards so valid usernames containing "_" compare literally.
    ["username", "ilike", username.replace(/[\\%_]/g, "\\$&"), "username"]
  ];
  for (const [column, operator, value, label] of filters) {
    let url = `${supabaseUrl}/rest/v1/employees?organization_id=eq.${organizationId}${scopeFilter}&${column}=${operator}.${encodeURIComponent(value)}&select=id&limit=2`;
    if (excludeId) url += `&id=neq.${encodeURIComponent(excludeId)}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error("Employee duplicate check failed");
    const records = await response.json();
    if (!Array.isArray(records)) throw new Error("Employee duplicate check returned invalid data");
    if (records.length) return label;
  }
  return null;
}

export async function verifiedCompanyName(configuration, organizationId) {
  if (!/^[0-9a-f-]{36}$/i.test(organizationId || "")) throw new Error("A valid company is required");
  const response = await fetch(
    `${configuration.supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(organizationId)}&is_active=eq.true&select=id,name&limit=2`,
    { headers: databaseHeaders(configuration.secretKey) }
  );
  if (!response.ok) throw new Error("Company lookup failed");
  const rows = await response.json();
  const name = Array.isArray(rows) && rows.length === 1 ? cleanString(rows[0]?.name) : "";
  if (!name) {
    const error = new Error("Company name is missing or company is inactive; invitation was not sent");
    error.status = 409;
    throw error;
  }
  return name;
}

export function activationRedirect() {
  return `${getSiteUrl()}/activate.html`;
}

export async function sendActivationInvite(configuration, employee) {
  const response = await fetch(
    `${configuration.supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(activationRedirect())}`,
    {
      method: "POST",
      headers: databaseHeaders(configuration.secretKey),
      body: JSON.stringify({
        email: employee.email,
        data: {
          first_name: employee.firstName,
          last_name: employee.lastName,
          username: employee.username,
          organization_name: employee.companyName
        }
      })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const alreadyRegistered = [400, 422].includes(response.status) && /already (been )?registered|already exists|user_already_exists/i.test([data?.msg, data?.message, data?.error_description, data?.error, data?.code].filter(Boolean).join(" "));
    const error = new Error(alreadyRegistered
      ? "This email already has a sign-in account. No invitation was sent. An administrator must verify account ownership and the employee account link before retrying; do not delete or recreate the account."
      : (data?.msg || data?.message || "Unable to send activation invitation"));
    error.status = alreadyRegistered ? 409 : response.status;
    throw error;
  }
  // The invite endpoint may return a partial user representation even when
  // the invitation has been issued. Verify against the authoritative admin
  // user record before deciding whether it is safe to create an employee.
  // Never use an email-only lookup, and never infer identity from the request.
  const id = typeof data?.id === "string" ? data.id : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    const error = new Error("Auth invitation returned no verifiable user identity. An invitation may have been sent; administrator review required.");
    error.status = 409;
    throw error;
  }
  const responseIdentityUnsafe = Boolean(
    data?.confirmed_at || data?.email_confirmed_at || data?.phone_confirmed_at ||
    data?.last_sign_in_at ||
    (Array.isArray(data?.identities) && data.identities.some(identity => identity?.last_sign_in_at && (!identity?.created_at || Date.parse(identity.last_sign_in_at) > Date.parse(identity.created_at) + 1000))) ||
    (typeof data?.email === "string" && data.email.trim() &&
      data.email.trim().toLowerCase() !== employee.email.trim().toLowerCase())
  );
  if (responseIdentityUnsafe) {
    const error = new Error("Auth returned a confirmed, previously signed-in or mismatched account. No employee account link was created. An invitation email may have been sent; administrator review required.");
    error.status = 409;
    throw error;
  }
  const verify = await fetch(`${configuration.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    headers: databaseHeaders(configuration.secretKey)
  });
  const verified = verify.ok ? await verify.json().catch(() => null) : null;
  const normalizedEmail = typeof verified?.email === "string" ? verified.email.trim().toLowerCase() : "";
  const metadata = verified?.user_metadata || {};
  const priorIdentitySignIn = Array.isArray(verified?.identities) &&
    verified.identities.some(identity => identity?.last_sign_in_at && (!identity?.created_at || Date.parse(identity.last_sign_in_at) > Date.parse(identity.created_at) + 1000));
  const safe = verified?.id === id &&
    normalizedEmail === employee.email.trim().toLowerCase() &&
    Boolean(verified.invited_at) &&
    !verified.confirmed_at && !verified.email_confirmed_at &&
    !verified.phone_confirmed_at && !verified.last_sign_in_at &&
    !priorIdentitySignIn &&
    metadata.first_name === employee.firstName &&
    metadata.last_name === employee.lastName &&
    metadata.username === employee.username &&
    metadata.organization_name === employee.companyName;
  if (!safe) {
    const error = new Error(
      "Auth invitation identity could not be verified as a new, unconfirmed invited account. " +
      "No employee account link was created. An invitation email may have been sent; " +
      "do not retry, delete, or relink the identity without an administrator review."
    );
    error.status = 409;
    throw error;
  }
  return verified;
}
