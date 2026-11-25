// The business a person is working for right now, when they work for more than one.
// Each business has its own employee record; the chosen record's id is remembered on this
// device and sent with every employee request (see api/_chosen-employee.js). The database
// only accepts a record that belongs to the signed-in person.

const storageKey = userId => `tymrak-employee-id:${userId}`;

export const businessHeaders = employeeId => (employeeId ? { "x-tymrak-employee-id": employeeId } : {});

// [{ employee_id, company_name, is_active, terminated, activated }], or null if unavailable.
export async function loadMyBusinesses(supabase) {
  try {
    const { data, error } = await supabase.rpc("employee_businesses");
    return error || !Array.isArray(data) ? null : data;
  } catch {
    return null;
  }
}

export function rememberBusiness(userId, employeeId) {
  try { localStorage.setItem(storageKey(userId), employeeId); } catch {}
}

// The chosen business, or null when the person has several and hasn't chosen yet.
export function chosenBusiness(businesses, userId) {
  if (!businesses?.length) return null;
  if (businesses.length === 1) return businesses[0];
  let stored = null;
  try { stored = localStorage.getItem(storageKey(userId)); } catch {}
  return businesses.find(business => business.employee_id === stored) || null;
}

const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };

// Full-card picker shown when someone with several businesses hasn't chosen one yet.
export function showBusinessPicker(container, businesses, userId) {
  const list = el("div", { className: "business-picker-list" });
  list.style.cssText = "display:grid;gap:10px;margin-top:14px";
  for (const business of businesses) {
    const button = el("button", { type: "button", textContent: business.company_name });
    button.style.cssText = "font:inherit;font-weight:700;text-align:left;padding:14px 16px;border-radius:10px;border:1px solid #d8c7b4;background:#fff;color:#3b2412;cursor:pointer";
    if (!business.activated) button.append(el("span", { textContent: " · not activated yet" }));
    if (business.terminated) button.append(el("span", { textContent: " · employment ended" }));
    button.addEventListener("click", () => { rememberBusiness(userId, business.employee_id); location.reload(); });
    list.append(button);
  }
  const box = el("div", { className: "business-picker", role: "region", ariaLabel: "Choose your business" },
    el("h2", { textContent: "Which business are you working for?" }),
    el("p", { textContent: "You work for more than one business on TYMRAK. Choose one; you can switch at any time." }), list);
  box.style.cssText = "text-align:left;max-width:440px;margin:8px auto";
  container.replaceChildren(box);
}

// Small switcher for people with several businesses.
export function businessSwitcher(businesses, current, userId) {
  if (!businesses || businesses.length < 2 || !current) return null;
  const select = el("select", { id: "businessSwitcher", ariaLabel: "Business" });
  select.style.cssText = "font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #d8c7b4;background:#fff;color:#3b2412;max-width:100%";
  for (const business of businesses) select.append(el("option", { value: business.employee_id, textContent: business.company_name, selected: business.employee_id === current.employee_id }));
  select.addEventListener("change", () => { rememberBusiness(userId, select.value); location.reload(); });
  const label = el("label", { htmlFor: "businessSwitcher", textContent: "Business " });
  label.style.cssText = "font-size:13px;color:#716254;margin-right:6px";
  const wrap = el("div", { className: "business-switcher" }, label, select);
  wrap.style.cssText = "margin-top:10px";
  return wrap;
}
