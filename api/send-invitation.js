export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, firstName, lastName, username } = req.body || {};

    if (!email || !firstName || !username) {
      return res.status(400).json({
        error: "Email, first name, and username are required"
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !secretKey) {
      return res.status(500).json({
        error: "Supabase environment variables are not configured"
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    /*
     * STEP 1
     * Create the Supabase Auth invitation.
     */
    const inviteResponse = await fetch(
    `${supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(
  "https://tymrak.vercel.app/activate.html"
)}`,
      {
        method: "POST",
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: normalizedEmail,
          data: {
            first_name: firstName,
            last_name: lastName || "",
            username: username
          },
          
        })
      }
    );

    const inviteData = await inviteResponse.json();

    if (!inviteResponse.ok) {
      console.error(
        "Supabase invitation error:",
        inviteData
      );

      return res.status(inviteResponse.status).json({
        error:
          inviteData.msg ||
          inviteData.message ||
          "Unable to create employee invitation"
      });
    }

    const authUserId = inviteData.id;

    if (!authUserId) {
      console.error(
        "Supabase invitation returned no user ID:",
        inviteData
      );

      return res.status(500).json({
        error:
          "Invitation was created but no authentication user ID was returned."
      });
    }

    /*
     * Common headers for server-side database requests.
     */
    const databaseHeaders = {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json"
    };

    /*
     * STEP 2
     * Check whether this employee already exists.
     */
    const lookupResponse = await fetch(
      `${supabaseUrl}/rest/v1/employees?email=eq.${encodeURIComponent(
        normalizedEmail
      )}&select=id,email`,
      {
        method: "GET",
        headers: databaseHeaders
      }
    );

    if (!lookupResponse.ok) {
      const lookupError = await lookupResponse.text();

      console.error(
        "Employee lookup error:",
        lookupError
      );

      return res.status(500).json({
        error:
          "Invitation was created, but TYMRAK could not check the employee record."
      });
    }

    const existingEmployees =
      await lookupResponse.json();

    const employeeData = {
      auth_user_id: authUserId,
      first_name: firstName,
      last_name: lastName || "",
      email: normalizedEmail,
      username: username,
      invitation_status: "Invitation Sent",
      invited_at: new Date().toISOString(),
      is_active: true
    };

    /*
     * STEP 3
     * UPDATE existing employee
     * or INSERT a new employee.
     */
    let employeeResponse;

    if (
      Array.isArray(existingEmployees) &&
      existingEmployees.length > 0
    ) {
      employeeResponse = await fetch(
        `${supabaseUrl}/rest/v1/employees?email=eq.${encodeURIComponent(
          normalizedEmail
        )}`,
        {
          method: "PATCH",
          headers: {
            ...databaseHeaders,
            Prefer: "return=representation"
          },
          body: JSON.stringify(employeeData)
        }
      );
    } else {
      employeeResponse = await fetch(
        `${supabaseUrl}/rest/v1/employees`,
        {
          method: "POST",
          headers: {
            ...databaseHeaders,
            Prefer: "return=representation"
          },
          body: JSON.stringify(employeeData)
        }
      );
    }

    if (!employeeResponse.ok) {
      const employeeError =
        await employeeResponse.text();

      console.error(
        "Employee record error:",
        employeeError
      );

      return res.status(500).json({
        error:
          "Authentication invitation was created, but the employee record could not be saved."
      });
    }

    const employeeRecord =
      await employeeResponse.json();

    return res.status(200).json({
      success: true,
      message:
        "TYMRAK activation invitation sent successfully",
      employee: employeeRecord?.[0] || null
    });

  } catch (error) {
    console.error(
      "TYMRAK invitation error:",
      error
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
}
