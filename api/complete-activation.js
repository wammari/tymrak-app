export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const authorization = req.headers.authorization;

    if (
      !authorization ||
      !authorization.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    const accessToken =
      authorization.substring("Bearer ".length);

    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !secretKey) {
      return res.status(500).json({
        error: "Supabase environment variables are not configured"
      });
    }

    /*
     * STEP 1
     * Verify the employee's access token with Supabase.
     * We do not trust a user ID supplied by the browser.
     */
    const userResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        method: "GET",
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const userData = await userResponse.json();

    if (!userResponse.ok || !userData?.id) {
      console.error(
        "Activation user verification error:",
        userData
      );

      return res.status(401).json({
        error: "Invalid or expired activation session"
      });
    }

    /*
     * STEP 2
     * Update only the employee record belonging
     * to the authenticated Supabase user.
     */
    const employeeResponse = await fetch(
      `${supabaseUrl}/rest/v1/employees?auth_user_id=eq.${encodeURIComponent(
        userData.id
      )}`,
      {
        method: "PATCH",
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          invitation_status: "Account Activated",
          activated_at: new Date().toISOString()
        })
      }
    );

    if (!employeeResponse.ok) {
      const employeeError =
        await employeeResponse.text();

      console.error(
        "Activation employee update error:",
        employeeError
      );

      return res.status(500).json({
        error:
          "Your password was created, but TYMRAK could not update the employee activation status."
      });
    }

const employeeData =
  await employeeResponse.json();

if (
  !Array.isArray(employeeData) ||
  employeeData.length === 0
) {
  return res.status(404).json({
    error:
      "No TYMRAK employee record was found for this account."
  });
}

const updatedEmployee =
  employeeData[0];

if (
  updatedEmployee.invitation_status !==
    "Account Activated" ||
  !updatedEmployee.activated_at
) {
  console.error(
    "Activation verification failed:",
    updatedEmployee
  );

  return res.status(500).json({
    error:
      "TYMRAK could not verify the employee activation update."
  });
}

return res.status(200).json({
  success: true,
  message: "TYMRAK account activated successfully"
});

  } catch (error) {
    console.error(
      "Complete activation error:",
      error
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
}
