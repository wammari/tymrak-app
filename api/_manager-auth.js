const MANAGER_ROLES = new Set(["manager", "admin"]);

async function getSafeSupabaseError(response) {
  try {
    const body = await response.json();
    return {
      code: typeof body?.code === "string" ? body.code : null,
      message: typeof body?.message === "string"
        ? body.message
        : typeof body?.msg === "string"
          ? body.msg
          : null
    };
  } catch {
    return { code: null, message: null };
  }
}

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
    console.error("Manager authorization configuration missing", {
      stage: "configuration",
      hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
      hasSupabaseSecretKey: Boolean(process.env.SUPABASE_SECRET_KEY)
    });
    return {
      ok: false,
      status: 500,
      error: "Supabase environment variables are not configured"
    };
  }

  const { supabaseUrl, secretKey } = configuration;
  console.info("Manager authorization configuration available", {
    stage: "configuration"
  });

  let userResponse;
  try {
    userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${accessToken}`
      }
    });
  } catch (error) {
    console.error("Manager access-token validation request failed", {
      stage: "auth_request",
      errorName: error?.name || "Error"
    });
    throw error;
  }

  if (!userResponse.ok) {
    const authError = await getSafeSupabaseError(userResponse);
    console.error("Manager access-token validation rejected", {
      stage: "auth_response",
      status: userResponse.status,
      ...authError
    });
    return {
      ok: false,
      status: 401,
      error: "Invalid or expired session"
    };
  }

  let user;
  try {
    user = await userResponse.json();
  } catch (error) {
    console.error("Manager access-token validation response was invalid", {
      stage: "auth_response_body",
      status: userResponse.status,
      errorName: error?.name || "Error"
    });
    throw error;
  }

  if (!user?.id) {
    console.error("Manager access-token validation returned no user UUID", {
      stage: "auth_user"
    });
    return {
      ok: false,
      status: 401,
      error: "Invalid or expired session"
    };
  }

  console.info("Manager access-token validation succeeded", {
    stage: "auth_user",
    userId: user.id
  });

  let roleResponse;
  try {
    roleResponse = await fetch(
      `${supabaseUrl}/rest/v1/user_roles?auth_user_id=eq.${encodeURIComponent(
        user.id
      )}&select=role`,
      {
        headers: {
          apikey: secretKey
        }
      }
    );
  } catch (error) {
    console.error("Manager role lookup request failed", {
      stage: "role_request",
      userId: user.id,
      errorName: error?.name || "Error"
    });
    throw error;
  }

  if (!roleResponse.ok) {
    const roleError = await getSafeSupabaseError(roleResponse);
    console.error("Manager role lookup rejected", {
      stage: "role_response",
      userId: user.id,
      status: roleResponse.status,
      ...roleError
    });
    throw new Error("Manager role lookup failed");
  }

  let roleRecords;
  try {
    roleRecords = await roleResponse.json();
  } catch (error) {
    console.error("Manager role lookup response was invalid", {
      stage: "role_response_body",
      userId: user.id,
      status: roleResponse.status,
      errorName: error?.name || "Error"
    });
    throw error;
  }
  const role = Array.isArray(roleRecords) ? roleRecords[0]?.role : null;
  const authorized = MANAGER_ROLES.has(role);

  console.info("Manager role lookup completed", {
    stage: "authorization_decision",
    userId: user.id,
    recordCount: Array.isArray(roleRecords) ? roleRecords.length : null,
    role: role || null,
    authorized
  });

  if (!authorized) {
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
