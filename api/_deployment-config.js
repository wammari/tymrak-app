// All deployed APIs and browser configuration share the same Supabase target.
export const STAGING_PROJECT_REF = "ctztwqcsizwkrqgpgrgg";

function environment(env) {
  const name = env.APP_ENV;
  if (!["staging", "production", "development"].includes(name)) {
    throw new Error("APP_ENV must be configured");
  }
  if ((env.VERCEL || env.VERCEL_ENV) && name === "development") throw new Error("Invalid hosted environment");
  if (env.VERCEL_ENV === "preview" && name === "production") {
    throw new Error("Production Supabase is forbidden in previews");
  }
  return name;
}

export function getSupabaseTarget(env = process.env) {
  const appEnvironment = environment(env);
  const url = new URL(env.SUPABASE_URL || "");
  if (url.username || url.password || url.search || url.hash ||
      !["", "/"].includes(url.pathname) || url.port) throw new Error("Invalid Supabase URL");
  const projectRef = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (url.protocol !== "https:" || !projectRef) throw new Error("Invalid Supabase URL");
  const expected = env.SUPABASE_EXPECTED_PROJECT_REF;
  if (appEnvironment === "staging" && (projectRef !== STAGING_PROJECT_REF || expected !== STAGING_PROJECT_REF)) {
    throw new Error("Staging Supabase target mismatch");
  }
  if (appEnvironment === "production" && (!expected || projectRef !== expected || projectRef === STAGING_PROJECT_REF)) {
    throw new Error("Production Supabase target mismatch");
  }
  if (expected && expected !== projectRef) throw new Error("Supabase target mismatch");
  return { supabaseUrl: url.origin, environment: appEnvironment };
}

export function getSiteUrl(env = process.env) {
  const appEnvironment = environment(env);
  const url = new URL(env.SITE_URL || "");
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      !["", "/"].includes(url.pathname) ||
      (url.protocol !== "https:" && !(appEnvironment === "development" && local && url.protocol === "http:"))) {
    throw new Error("SITE_URL must be a site origin");
  }
  if (appEnvironment === "staging" &&
      !(url.hostname.startsWith("tymrak-staging") && url.hostname.endsWith(".vercel.app")) &&
      !(env.CLOUDFLARE_RELEASE_ENV === "staging" && /^tymrak-staging\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)) &&
      url.hostname !== "staging.tymrak.com") throw new Error("Invalid staging site origin");
  if (appEnvironment === "production" && url.origin !== "https://www.tymrak.com") {
    throw new Error("Invalid production site origin");
  }
  return url.origin;
}

export function isBrowserKey(key) {
  if (typeof key !== "string" || !key || key.trim() !== key) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  // Support an existing legacy anon key, never a service_role JWT.
  try {
    const parts = key.split(".");
    return parts.length === 3 && JSON.parse(Buffer.from(parts[1], "base64url").toString()).role === "anon";
  } catch { return false; }
}

export function getPublicConfiguration(env = process.env) {
  const target = getSupabaseTarget(env);
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!isBrowserKey(key)) throw new Error("Browser Supabase key is not configured");
  return { ...target, supabasePublishableKey: key, siteUrl: getSiteUrl(env) };
}
