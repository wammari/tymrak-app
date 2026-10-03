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
    Authorization: `Bearer ${secretKey}`,
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

export async function findDuplicate({ supabaseUrl, secretKey, email, username, excludeId }) {
  const headers = databaseHeaders(secretKey);
  const filters = [
    ["email", "eq", email, "email"],
    ["username", "ilike", username, "username"]
  ];
  for (const [column, operator, value, label] of filters) {
    let url = `${supabaseUrl}/rest/v1/employees?${column}=${operator}.${encodeURIComponent(value)}&select=id&limit=2`;
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
  const siteUrl = (process.env.SITE_URL || "https://tymrak.vercel.app").replace(/\/$/, "");
  return `${siteUrl}/activate.html`;
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
          username: employee.username
        }
      })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.msg || data?.message || "Unable to send activation invitation");
    error.status = response.status;
    throw error;
  }
  if (!data?.id) throw new Error("Invitation returned no authentication user ID");
  return data;
}
