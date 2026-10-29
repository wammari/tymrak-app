// Public Supabase configuration. Only publishable keys belong in browser code.
// Select by the deployed application's hostname to prevent staging sessions
// from reading or writing production employee and punch records.
const STAGING = Object.freeze({
  url: "https://ctztwqcsizwkrqgpgrgg.supabase.co",
  publishableKey: "sb_publishable__NGh_dC6GYEQ487PvboXNQ_iMeCC-Ah"
});
const PRODUCTION = Object.freeze({
  url: "https://tsosredghislnehfyypi.supabase.co",
  publishableKey: "sb_publishable_u3i0ktj9UjpwUWkEF4sfcg_WZjWo0w6"
});

export function getClientSupabaseConfiguration(hostname = globalThis.location?.hostname) {
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  if (host === "localhost" || host === "127.0.0.1" ||
      (host.startsWith("tymrak-staging") && host.endsWith(".vercel.app"))) {
    return STAGING;
  }
  if (host === "tymrak.com" || host === "www.tymrak.com" ||
      host === "tymrak.vercel.app" ||
      (host.startsWith("tymrak-") && host.endsWith(".vercel.app"))) {
    return PRODUCTION;
  }
  // Unknown hostnames must never silently default to production.
  throw new Error("This Tymrak hostname is not configured for authentication");
}
