// "Delete my account" for employees (App Store / privacy requirement).
// Employees confirm with their password, then a manager or admin processes the request.
// Processing removes personal details; hours already worked are kept for payroll records.
const DAYS_TO_PROCESS = 30;
const STYLE = {
  link: "background:none;border:0;padding:6px;color:#7a4f14;text-decoration:underline;font:inherit;font-size:13px;cursor:pointer",
  overlay: "position:fixed;inset:0;background:#2a140a99;display:grid;place-items:center;z-index:1000;padding:16px",
  card: "background:#fff;color:#351b0c;max-width:440px;width:100%;border-radius:16px;padding:24px;box-shadow:0 20px 50px #0004;font-family:Arial,Helvetica,sans-serif",
  input: "width:100%;padding:12px;margin:6px 0 4px;border:1px solid #cdbba3;border-radius:8px;font:inherit",
  primary: "background:#8c2f1b;color:#fff;border:0;border-radius:10px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer",
  secondary: "background:#f1e6d4;color:#351b0c;border:0;border-radius:10px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer"
};

function el(tag, text, style, attributes = {}) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (style) node.style.cssText = style;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

async function api(method, token) {
  const response = await fetch("/api/account-deletion", { method, headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

export function mountAccountDeletion({ supabase, container = document.body }) {
  if (document.getElementById("accountDeletionFooter")) return;
  const footer = el("div", "", "text-align:center;margin:28px auto 20px;padding:0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#4b3626", { id: "accountDeletionFooter" });
  const status = el("div", "", "margin-bottom:4px", { role: "status" });
  const action = el("button", "Delete my account", STYLE.link, { type: "button" });
  footer.append(status, action);
  container.append(footer);

  let current = null;
  const render = () => {
    if (current) {
      status.textContent = `Account deletion requested on ${new Date(current.requestedAt).toLocaleDateString()}. A manager will process it within ${DAYS_TO_PROCESS} days.`;
      action.textContent = current.status === "Pending" ? "Cancel deletion request" : "";
      action.hidden = current.status !== "Pending";
    } else {
      status.textContent = "";
      action.textContent = "Delete my account";
      action.hidden = false;
    }
  };
  const session = async () => (await supabase.auth.getSession()).data.session;

  session().then(async s => {
    if (!s) return;
    const result = await api("GET", s.access_token);
    if (result.ok) { current = result.data.request || null; render(); }
  }).catch(() => {});

  action.addEventListener("click", async () => {
    if (current) {
      const s = await session(); if (!s) return;
      const result = await api("DELETE", s.access_token);
      if (result.ok) { current = null; render(); }
      return;
    }
    openDialog();
  });

  function openDialog() {
    const overlay = el("div", "", STYLE.overlay, { role: "dialog", "aria-modal": "true", "aria-labelledby": "adTitle" });
    const card = el("div", "", STYLE.card);
    const title = el("h2", "Delete your account?", "margin:0 0 10px;font-size:20px", { id: "adTitle" });
    const body = el("p", `This removes your name, email, username and phone number from TYMRAK and permanently deletes your sign-in. Your employer keeps the hours you already worked, shown as “Former Employee”, because payroll records must be retained. A manager will process your request within ${DAYS_TO_PROCESS} days. You can cancel until then.`, "margin:0 0 14px;line-height:1.5;font-size:14px");
    const label = el("label", "Confirm your password", "font-size:13px;font-weight:700", { for: "adPassword" });
    const password = el("input", "", STYLE.input, { id: "adPassword", type: "password", autocomplete: "current-password" });
    const message = el("p", "", "min-height:20px;margin:6px 0 12px;color:#8c2f1b;font-size:13px", { role: "alert" });
    const row = el("div", "", "display:flex;gap:10px;justify-content:flex-end");
    const cancel = el("button", "Keep my account", STYLE.secondary, { type: "button" });
    const confirm = el("button", "Request deletion", STYLE.primary, { type: "button" });
    row.append(cancel, confirm);
    card.append(title, body, label, password, message, row);
    overlay.append(card);
    document.body.append(overlay);
    password.focus();
    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
    confirm.addEventListener("click", async () => {
      message.textContent = "";
      if (!password.value) { message.textContent = "Enter your password to continue."; return; }
      confirm.disabled = true;
      try {
        const existing = await session();
        const signedIn = await supabase.auth.signInWithPassword({ email: existing.user.email, password: password.value });
        if (signedIn.error || !signedIn.data?.session) { message.textContent = "That password is not correct."; return; }
        const result = await api("POST", signedIn.data.session.access_token);
        if (!result.ok) { message.textContent = result.data?.error || "Unable to send your request. Please try again."; return; }
        current = result.data.request; render(); close();
      } catch { message.textContent = "Unable to send your request. Please try again."; }
      finally { confirm.disabled = false; password.value = ""; }
    });
  }
}
