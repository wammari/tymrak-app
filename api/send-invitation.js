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

    /*
     * Create the Supabase Auth invitation.
     * Supabase generates and emails the secure one-time invitation link.
     */
    const inviteResponse = await fetch(
      `${supabaseUrl}/auth/v1/invite`,
      {
        method: "POST",
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          data: {
            first_name: firstName,
            last_name: lastName || "",
            username: username
          },
          redirect_to: "https://tymrak.vercel.app/activate.html"
        })
      }
    );

    const inviteData = await inviteResponse.json();

    if (!inviteResponse.ok) {
      console.error("Supabase invitation error:", inviteData);

      return res.status(inviteResponse.status).json({
        error:
          inviteData.msg ||
          inviteData.message ||
          "Unable to create employee invitation"
      });
    }

    /*
     * Create/update the employee record.
     * The secret key is used only inside this server-side function.
     */
    const employeeResponse = await fetch(
      `${supabaseUrl}/rest/v1/employees?email=eq.${encodeURIComponent(
        email.trim().toLowerCase()
      )}`,
      {
        method: "POST",
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify({
          auth_user_id: inviteData.id,
          first_name: firstName,
          last_name: lastName || "",
          email: email.trim().toLowerCase(),
          username: username,
          invitation_status: "Invitation Sent",
          invited_at: new Date().toISOString(),
          is_active: true
        })
      }
    );

    if (!employeeResponse.ok) {
      const employeeError = await employeeResponse.text();

      console.error(
        "Employee record error:",
        employeeError
      );

      return res.status(500).json({
        error:
          "Authentication invitation was created, but the employee record could not be updated."
      });
    }

    return res.status(200).json({
      success: true,
      message: "TYMRAK activation invitation sent successfully"
    });

  } catch (error) {
    console.error("TYMRAK invitation error:", error);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
