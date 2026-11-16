import { getSupabaseTarget, getSiteUrl, isBrowserKey } from "./_deployment-config.js";

const ERROR = "TYMRAK configuration is unavailable. Please contact your administrator.";
const PRODUCTION_REF = "tsosredghislnehfyypi";
const STAGING_REF = "ctztwqcsizwkrqgpgrgg";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const fail = diagnostic => res.status(503).json({ error: ERROR, diagnostic });
  // Fixed categories only. Never echo values, keys, or exception messages.
  const env = process.env;
  if (!["production", "staging", "development"].includes(env.APP_ENV)) return fail("app_env_invalid");
  if (env.VERCEL_ENV === "preview" && env.APP_ENV === "production") return fail("preview_production_conflict");
  if ((env.VERCEL || env.VERCEL_ENV) && env.APP_ENV === "development") return fail("hosted_development_conflict");
  let parsed;
  try { parsed = new URL(env.SUPABASE_URL || ""); } catch { return fail("supabase_url_invalid"); }
  if (parsed.protocol !== "https:" || parsed.hostname.split(".").length !== 3 || parsed.hostname.split(".")[1] !== "supabase" || parsed.hostname.split(".")[2] !== "co" || !/^[a-z0-9]+$/.test(parsed.hostname.split(".")[0]) ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      !["", "/"].includes(parsed.pathname) || parsed.port) return fail("supabase_url_invalid");
  const actualRef = parsed.hostname.split(".")[0];
  if (env.APP_ENV === "production" && actualRef !== PRODUCTION_REF) return fail("production_supabase_url_mismatch");
  if (env.APP_ENV === "production" && env.SUPABASE_EXPECTED_PROJECT_REF !== PRODUCTION_REF) return fail("production_expected_ref_mismatch");
  if (env.APP_ENV === "staging" && actualRef !== STAGING_REF) return fail("staging_supabase_url_mismatch");
  if (env.APP_ENV === "staging" && env.SUPABASE_EXPECTED_PROJECT_REF !== STAGING_REF) return fail("staging_expected_ref_mismatch");
  let target;
  try { target = getSupabaseTarget(); } catch { return fail("supabase_target_other"); }
  if (!isBrowserKey(env.SUPABASE_PUBLISHABLE_KEY)) return fail("publishable_key");
  let siteUrl;
  try { siteUrl = getSiteUrl(); } catch { return fail("site_url"); }
  return res.status(200).json({ ...target, supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY, siteUrl });
}
