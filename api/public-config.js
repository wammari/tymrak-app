import { getSupabaseTarget, getSiteUrl, isBrowserKey } from "./_deployment-config.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Return only a fixed validation stage. Never expose keys, URLs, or exception details.
  let target;
  try {
    target = getSupabaseTarget();
  } catch {
    return res.status(503).json({ error: "TYMRAK configuration is unavailable. Please contact your administrator.", diagnostic: "supabase_target" });
  }
  if (!isBrowserKey(process.env.SUPABASE_PUBLISHABLE_KEY)) {
    return res.status(503).json({ error: "TYMRAK configuration is unavailable. Please contact your administrator.", diagnostic: "publishable_key" });
  }
  let siteUrl;
  try {
    siteUrl = getSiteUrl();
  } catch {
    return res.status(503).json({ error: "TYMRAK configuration is unavailable. Please contact your administrator.", diagnostic: "site_url" });
  }
  return res.status(200).json({ ...target, supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY, siteUrl });
}
