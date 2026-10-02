const MANAGER_ROLES = new Set(["manager", "admin"]);

export function getBearerToken(req) {
  const authorization = req.headers.authorization;

  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

export function getSupabaseConfiguration() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !secretKey) {
    return null;
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    secretKey
  };
}

export async function requireManager(req) {
  const accessToken = getBearerToken(req);

  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      error: "Authentication required"
    };
  }

  const configuration = getSupabaseConfiguration();

  if (!configuration) {
    return {
      ok: false,
      status: 500,
      error: "Supabase environment variables are not configured"
    };
  }

  const { supabaseUrl, secretKey } = configuration;
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!userResponse.ok) {
    return {
      ok: false,
      status: 401,
      error: "Invalid or expired session"
    };
  }

  const user = await userResponse.json();

  if (!user?.id) {
    return {
      ok: false,
      status: 401,
      error: "Invalid or expired session"
    };
  }

  const roleResponse = await fetch(
    `${supabaseUrl}/rest/v1/user_roles?auth_user_id=eq.${encodeURIComponent(
      user.id
    )}&select=role`,
    {
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`
      }
    }
  );

  if (!roleResponse.ok) {
    throw new Error("Manager role lookup failed");
  }

  const roleRecords = await roleResponse.json();
  const role = Array.isArray(roleRecords) ? roleRecords[0]?.role : null;

  if (!MANAGER_ROLES.has(role)) {
    return {
      ok: false,
      status: 403,
      error: "Manager access required"
    };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email || ""
    },
    role,
    configuration
  };
}

