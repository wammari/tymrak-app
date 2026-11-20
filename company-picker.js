// For admin pages opened in a new tab (or after the chosen company was forgotten): instead
// of a dead end, let the person pick one of the businesses they're an admin of, right here.
// Returns true when a picker was shown (the page should stop loading), false otherwise.
export function needsCompanyChoice(session, { adminOnly = true } = {}) {
  const chosen = session.authorized && session.organizationId;
  return !chosen || (adminOnly && session.role !== "admin");
}

export function showCompanyPicker(session, { adminOnly = true, noticeId = "notice", what = "this page" } = {}) {
  const companies = (session.availableOrganizations || []).filter(company => !adminOnly || company.role === "admin");
  const notice = document.getElementById(noticeId);
  if (!companies.length) return false;
  const box = document.createElement("div");
  box.className = "company-picker";
  box.style.cssText = "background:#fff;border:1px solid #e4d7c7;border-radius:12px;padding:20px;margin:16px 0";
  const label = document.createElement("label");
  label.textContent = `Which business do you want to open ${what} for?`;
  label.style.cssText = "display:block;font-weight:700;margin-bottom:10px";
  const select = document.createElement("select");
  select.id = "companyPicker";
  select.style.cssText = "width:100%;max-width:420px;padding:9px;font:inherit;border:1px solid #cbbca9;border-radius:6px;background:#fff";
  label.htmlFor = select.id;
  const prompt = Object.assign(document.createElement("option"), { value: "", textContent: "Choose a business" });
  select.append(prompt, ...companies.map(company => Object.assign(document.createElement("option"), { value: company.organizationId, textContent: company.name })));
  select.addEventListener("change", () => {
    if (!companies.some(company => company.organizationId === select.value)) return;
    try { sessionStorage.setItem("tymrak-company-id", select.value); } catch {}
    location.reload();
  });
  box.append(label, select);
  if (notice) { notice.className = "notice"; notice.after(box); } else document.body.prepend(box);
  return true;
}
