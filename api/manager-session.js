import { requireManager } from "./_manager-auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const authorization = await requireManager(req);

    if (!authorization.ok) {
      return res
        .status(authorization.status)
        .json({ error: authorization.error });
    }

    return res.status(200).json({
      authorized: true,
      user: authorization.user,
      role: authorization.role
    });
  } catch (error) {
    console.error("Manager session verification failed", {
      stage: "unhandled_authorization_error",
      errorName: error?.name || "Error",
      message: error?.message || "Unknown authorization error"
    });
    return res.status(500).json({
      error: "Unable to verify manager access"
    });
  }
}
