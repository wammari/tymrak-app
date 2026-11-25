import { getSiteUrl } from "./_deployment-config.js";
export const EMPLOYEE_SELECT = [
  "id", "first_name", "last_name", "email", "username", "mobile",
  "position", "department", "province", "hire_date", "invitation_status",
  "activated_at", "is_active", "termination_date", "termination_reason"
].join(",");

export const PROVINCES = new Set([
  "AB", "BC", "SK", "MB", "ON", "QC", "NB",
  "NS", "PE", "NL", "NT", "NU", "YT"
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Date.parse() rolls impossible dates (2026-02-30) over to the next month, so round-trip instead.
export const isRealDate = value => typeof value === "string" && DATE_PATTERN.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

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

export function validateEmployeeInput(body, { allowAutoUsername = false } = {}) {
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

  // When adding someone, an empty username means "create one" (see next_employee_username).
  if (!input.firstName || !input.lastName || !input.email ||
      (!input.username && !allowAutoUsername) || !input.province) {
    return { error: "First name, last name, email, username, and province are required" };
  }
  if (!EMAIL_PATTERN.test(input.email) || input.email.length > 254) {
    return { error: "Enter a valid email address" };
  }
  if (input.username && (!USERNAME_PATTERN.test(input.username) || input.username.length > 64)) {
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
  if (input.hireDate && !isRealDate(input.hireDate)) {
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

export function activationRedirect() {
  return `${getSiteUrl()}/activate.html`;
}

export async function prepareExistingInvitationIdentity(configuration, employee, companyName, expectedAuthUserId) {
  const headers = databaseHeaders(configuration.secretKey);
  const url = `${configuration.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(expectedAuthUserId)}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("Existing invitation identity lookup failed");
  const user = await response.json();
  const valid = user?.id === expectedAuthUserId &&
    user?.email?.trim().toLowerCase() === employee.email.trim().toLowerCase() &&
    Boolean(user.invited_at) &&
    !user.confirmed_at && !user.email_confirmed_at && !user.phone_confirmed_at && !user.last_sign_in_at &&
    (!Array.isArray(user.identities) || user.identities.every(identity =>
      !identity?.last_sign_in_at || (identity?.created_at && Date.parse(identity.last_sign_in_at) <= Date.parse(identity.created_at) + 1000))) &&
    user.user_metadata?.first_name === employee.firstName &&
    user.user_metadata?.last_name === employee.lastName &&
    user.user_metadata?.username === employee.username;
  if (!valid) {
    const error = new Error("Existing invitation identity requires administrator review; no invitation sent");
    error.status = 409;
    throw error;
  }
  // Preserve all unrelated metadata. Supabase Auth's invite endpoint does not
  // reliably overwrite user_metadata for previously invited users.
  const metadata = { ...user.user_metadata, company_name: companyName.trim() };
  const updatedResponse = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ user_metadata: metadata })
  });
  if (!updatedResponse.ok) throw new Error("Unable to prepare invitation company metadata");
  const verifiedResponse = await fetch(url, { headers });
  if (!verifiedResponse.ok) throw new Error("Unable to verify invitation company metadata");
  const verified = await verifiedResponse.json();
  if (verified?.id !== expectedAuthUserId ||
      verified?.email?.trim().toLowerCase() !== employee.email.trim().toLowerCase() ||
      verified?.user_metadata?.company_name !== companyName.trim() ||
      verified?.confirmed_at || verified?.email_confirmed_at || verified?.last_sign_in_at) {
    const error = new Error("Invitation metadata verification failed; no invitation sent");
    error.status = 409;
    throw error;
  }
}

// extraData adds invitation metadata (e.g. { tymrak_access: "team" } for admin and
// manager invitations); it is verified on the created account like the other fields.
export async function sendActivationInvite(configuration, employee, companyName, extraData = {}) {
  if (typeof companyName !== 'string' || !companyName.trim()) {
    throw new Error('Verified company name is required before sending an invitation');
  }
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
          company_name: companyName.trim(),
          ...extraData
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
    metadata.company_name === companyName.trim() &&
    Object.entries(extraData).every(([key, value]) => metadata[key] === value);
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

// Terminated employees cannot clock in or out but keep read-only access to their own history.
// The database enforces consistency (see 202611140001_employee_termination.sql).
export function validateTerminationInput(body, now = new Date()) {
  const date = body?.terminationDate;
  if (!isRealDate(date)) {
    return { error: "Enter a valid termination date" };
  }
  // Allow "today" in any time zone, but not further into the future.
  const latest = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date > latest) return { error: "The termination date cannot be in the future" };
  const reason = body?.reason == null ? "" : body.reason;
  if (typeof reason !== "string" || reason.trim().length > 500) {
    return { error: "The reason must be 500 characters or fewer" };
  }
  return { terminationDate: date, reason: reason.trim() || null };
}

export function terminationRecord({ terminationDate, reason }, now = new Date()) {
  return { is_active: false, termination_date: terminationDate, termination_reason: reason, terminated_at: now.toISOString() };
}

export function reactivationRecord() {
  return { is_active: true, termination_date: null, termination_reason: null, terminated_at: null };
}
