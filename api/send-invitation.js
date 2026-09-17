export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, firstName, username } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Email address is required" });
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "TYMRAK <invite@tymrak.com>",
        to: [email],
        subject: "Welcome to TYMRAK – Activate Your Account",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;">
            <h1 style="color:#14213d;margin-bottom:5px;">TYMRAK</h1>

            <p style="color:#39a96b;font-weight:bold;">
              TIME. TRACKED RIGHT.
            </p>

            <hr style="border:none;border-top:1px solid #ddd;margin:25px 0;">

            <h2>Welcome to TYMRAK</h2>

            <p>Hi ${firstName || "there"},</p>

            <p>
              Your employer has invited you to use TYMRAK
              for time tracking and employee services.
            </p>

            <p>
              <strong>Your username:</strong>
              ${username || "test.employee"}
            </p>

            <p style="margin:30px 0;">
              <a href="https://tymrak.com"
                 style="
                   background:#14213d;
                   color:white;
                   padding:14px 24px;
                   text-decoration:none;
                   border-radius:6px;
                   font-weight:bold;">
                 Activate My Account
              </a>
            </p>

            <p style="font-size:13px;color:#666;">
              If you were not expecting this invitation,
              please disregard this email.
            </p>

            <p style="margin-top:30px;">
              TYMRAK<br>
              TIME. TRACKED RIGHT.
            </p>
          </div>
        `
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Resend error:", data);
      return res.status(response.status).json({
        error: "Email could not be sent",
        details: data
      });
    }

    return res.status(200).json({
      success: true,
      message: "TYMRAK invitation sent successfully",
      id: data.id
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
