import {
  getSupabaseConfiguration,
  requireManager
} from "./_manager-auth.js";

const PROVINCES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "ON",
  "PE", "QC", "SK", "NT", "NU", "YT", "FED"
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function validateInvitationInput(body) {
  const input = {
    email: cleanString(body?.email).toLowerCase(),
    firstName: cleanString(body?.firstName),
    lastName: cleanString(body?.lastName),
    username: cleanString(body?.username),
    position: cleanString(body?.position),
    department: cleanString(body?.department),
    province: cleanString(body?.province).toUpperCase()
  };

  if (
    !input.email ||
    !input.firstName ||
    !input.lastName ||
    !input.username ||
    !input.province
  ) {
    return {
      error: "Email, first name, last name, username, and province are required"
    };
  }

  if (!EMAIL_PATTERN.test(input.email) || input.email.length > 254) {
    return { error: "Enter a valid email address" };
  }

  if (
    input.firstName.length > 100 ||
    input.lastName.length > 100 ||
    input.position.length > 150 ||
    input.department.length > 150
  ) {
    return { error: "One or more fields exceed the allowed length" };
  }

  if (
    input.username.length > 64 ||
    !USERNAME_PATTERN.test(input.username)
  ) {
    return {
      error: "Username may contain only letters, numbers, periods, underscores, and hyphens"
    };
  }

  if (!PROVINCES.has(input.province)) {
    return { error: "Select a valid province or jurisdiction" };
  }

  return { input };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const authorization = await requireManager(req);

    if (!authorization.ok) {
      return res
        .status(authorization.status)
        .json({ error: authorization.error });
    }

    const validation = validateInvitationInput(req.body);

    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const { input } = validation;
    const { supabaseUrl, secretKey } =
      getSupabaseConfiguration() || {};
    const databaseHeaders = {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json"
    };

    // Resolve the record before inviting. Never PATCH on a potentially
    // non-unique email filter: an existing row is updated by primary key.
    const lookupResponse = await fetch(
      `${supabaseUrl}/rest/v1/employees?email=eq.${encodeURIComponent(
        input.email
      )}&select=id,email&limit=2`,
      { headers: databaseHeaders }
    );

    if (!lookupResponse.ok) {
      throw new Error("Employee lookup failed");
    }

    const existingEmployees = await lookupResponse.json();

    if (!Array.isArray(existingEmployees)) {
      throw new Error("Employee lookup returned an invalid response");
    }

    if (existingEmployees.length > 1) {
      return res.status(409).json({
        error: "Multiple employee records use this email. Resolve the duplicate records before inviting."
      });
    }

    const siteUrl = (process.env.SITE_URL || "https://tymrak.vercel.app")
      .replace(/\/$/, "");
    const inviteResponse = await fetch(
      `${supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(
        `${siteUrl}/activate.html`
      )}`,
      {
        method: "POST",
        headers: databaseHeaders,
        body: JSON.stringify({
          email: input.email,
          data: {
            first_name: input.firstName,
            last_name: input.lastName,
            username: input.username
          }
        })
      }
    );

    const inviteData = await inviteResponse.json();

    if (!inviteResponse.ok) {
      return res.status(inviteResponse.status).json({
        error:
          inviteData?.msg ||
          inviteData?.message ||
          "Unable to create employee invitation"
      });
    }

    if (!inviteData?.id) {
      throw new Error("Invitation returned no authentication user ID");
    }

    const employeeData = {
      auth_user_id: inviteData.id,
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      username: input.username,
      position: input.position || null,
      department: input.department || null,
      province: input.province,
      invitation_status: "Invitation Sent",
      invited_at: new Date().toISOString(),
      is_active: true
    };

    const existingEmployee = existingEmployees[0];
    const employeeUrl = existingEmployee
      ? `${supabaseUrl}/rest/v1/employees?id=eq.${encodeURIComponent(
          existingEmployee.id
        )}`
      : `${supabaseUrl}/rest/v1/employees`;
    const employeeResponse = await fetch(employeeUrl, {
      method: existingEmployee ? "PATCH" : "POST",
      headers: {
        ...databaseHeaders,
        Prefer: "return=representation"
      },
      body: JSON.stringify(employeeData)
    });

    if (!employeeResponse.ok) {
      throw new Error("Employee record could not be saved after invitation");
    }

    const employeeRecord = await employeeResponse.json();

    return res.status(200).json({
      success: true,
      message: "TYMRAK activation invitation sent successfully",
      employee: employeeRecord?.[0] || null
    });
  } catch (error) {
    console.error("TYMRAK invitation operation failed");
    return res.status(500).json({ error: "Server error" });
  }
}
