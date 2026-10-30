let configuration;

export async function loadSupabaseConfiguration() {
  configuration ||= fetch("/api/public-config", { cache: "no-store", credentials: "same-origin" })
    .then(async response => {
      if (!response.ok) throw new Error("Configuration unavailable");
      const value = await response.json();
      if (!value || typeof value.supabaseUrl !== "string" ||
          typeof value.supabasePublishableKey !== "string" || typeof value.siteUrl !== "string") {
        throw new Error("Invalid configuration");
      }
      return value;
    });
  try { return await configuration; }
  catch {
    document.querySelectorAll("button, input, select, textarea").forEach(element => { element.disabled = true; });
    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = "TYMRAK configuration is unavailable. Please contact your administrator.";
    document.body.prepend(notice);
    throw new Error("TYMRAK configuration unavailable");
  }
}
