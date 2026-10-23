import { getPublicConfiguration } from "./_deployment-config.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    return res.status(200).json(getPublicConfiguration());
  } catch {
    // Never return environment values or exception details.
    return res.status(503).json({ error: "TYMRAK configuration is unavailable. Please contact your administrator." });
  }
}
