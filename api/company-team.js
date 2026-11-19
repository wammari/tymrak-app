import { requireManager } from "./_manager-auth.js";
import { databaseHeaders, sendActivationInvite } from "./_employee-management.js";

// Team access for one company: who has admin or manager access, inviting someone new,
// giving an existing employee access on their own login, changing a role or a manager's
// workplaces, and removing access. Only the company's admins can use it. The database
// functions (202611190005_company_team_access.sql) enforce every rule again.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["admin", "manager"]);

const MESSAGES = {
  admin_required: [403, "Only this business's admins can manage team access."],
  invalid_role: [400, "Choose Admin or Manager."],
  user_not_found: [404, "That person's login could not be found."],
  cannot_change_own_access: [400, "You can't change or remove your own access. Ask another admin of this business."],
  protected_user: [400, "That person's access is managed by Tymrak."],
  workplace_required: [400, "Choose at least one workplace for a manager."],
  invalid_workplace: [400, "One or more workplaces don't belong to this business. Refresh and try again."],
  last_admin: [400, "A business needs at least one admin."],
  not_a_member: [404, "That person doesn't have admin or manager access here. Refresh the page."]
};

function protectedUser() {
  const id = process.env.TYMRAK_MAIN_ADMIN_AUTH_USER_ID;
  return UUID.test(id || "") ? id : null;
}

function serverHeaders(secretKey) {
  return { ...databaseHeaders(secretKey), "Content-Type": "application/json" };
}

async function rpc(configuration, name, body) {
  const response = await fetch(`${configuration.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST", headers: serverHeaders(configuration.secretKey), body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = new Error(`Team access ${name} failed`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

async function readRows(configuration, path) {
  const response = await fetch(`${configuration.supabaseUrl}/rest/v1/${path}`, { headers: databaseHeaders(configuration.secretKey) });
  if (!response.ok) throw new Error("Team access lookup failed");
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Team access lookup returned an invalid response");
  return rows;
}

function refusal(res, result) {
  const [status, error] = MESSAGES[result?.error] || [409, "Unable to update team access. Refresh and try again."];
  return res.status(status).json({ error, code: result?.error || null });
}

function accessInput(body) {
  const role = body?.role;
  if (!ROLES.has(role)) return { error: "Choose Admin or Manager." };
  const workplaceIds = role === "manager" ? body?.workplaceIds : [];
  if (!Array.isArray(workplaceIds) || workplaceIds.length > 200 || !workplaceIds.every(id => UUID.test(id || ""))) {
    return { error: "Choose valid workplaces." };
  }
  if (role === "manager" && !workplaceIds.length) return { error: "Choose at least one workplace for a manager." };
  return { role, workplaceIds: [...new Set(workplaceIds)] };
}

function cleanName(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 60 ? value.trim() : null;
}

async function grant(auth, authUserId, access) {
  return rpc(auth.configuration, "grant_company_access", {
    p_actor: auth.user.id, p_organization_id: auth.organizationId, p_auth_user_id: authUserId,
    p_role: access.role, p_workplace_ids: access.workplaceIds, p_protected_user: protectedUser()
  });
}

async function listTeam(auth, res) {
  const { configuration, organizationId } = auth;
  const team = await rpc(configuration, "company_team", {
    p_actor: auth.user.id, p_organization_id: organizationId, p_hidden_user: protectedUser()
  });
  if (team?.error) return refusal(res, team);
  const org = encodeURIComponent(organizationId);
  // Workplaces come from company_team(): the server may not read that table directly.
  if (!Array.isArray(team.workplaces)) throw new Error("company_team did not return workplaces");
  const employees = await readRows(configuration,
    `employees?organization_id=eq.${org}&is_active=eq.true&auth_user_id=not.is.null&select=id,first_name,last_name,email,auth_user_id&order=last_name.asc,first_name.asc`);
  const members = new Set(team.members.map(member => member.authUserId));
  const hidden = protectedUser();
  return res.status(200).json({
    members: team.members,
    workplaces: team.workplaces.map(w => ({ id: w.id, name: w.name, isActive: w.isActive !== false })),
    // Employees who could be given access on their own login (auth ids stay on the server).
    employees: employees.filter(e => !members.has(e.auth_user_id) && e.auth_user_id !== hidden)
      .map(e => ({ id: e.id, name: `${e.first_name || ""} ${e.last_name || ""}`.trim(), email: e.email || "" }))
  });
}

async function inviteNewPerson(auth, req, res, access) {
  const { configuration, organizationId } = auth;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const firstName = cleanName(req.body?.firstName), lastName = cleanName(req.body?.lastName);
  if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  if (!firstName || !lastName) return res.status(400).json({ error: "Enter a first and last name." });
  const org = encodeURIComponent(organizationId);
  const [company] = await readRows(configuration, `organizations?id=eq.${org}&is_active=eq.true&select=id,name`);
  if (!company || company.id !== organizationId || !company.name?.trim()) return res.status(403).json({ error: "Active company could not be verified" });
  const existing = await readRows(configuration, `employees?organization_id=eq.${org}&email=ilike.${encodeURIComponent(email)}&select=id`);
  if (existing.length) {
    return res.status(409).json({ error: "This person is already an employee here. Choose them under \"Existing employee\" so they keep one login." });
  }
  let invite;
  try {
    invite = await sendActivationInvite(configuration, { email, firstName, lastName }, company.name, { tymrak_access: "team" });
  } catch (error) {
    if (error?.status === 409 && /already has a sign-in account/.test(error.message || "")) {
      return res.status(409).json({ error: "This email already has a Tymrak login, so no invitation was sent. If they work here, add them as an employee first, then choose them under \"Existing employee\". Otherwise, contact Tymrak support." });
    }
    throw error;
  }
  let result;
  try { result = await grant(auth, invite.id, access); } catch { result = null; }
  if (!result?.success) {
    console.error("Team invitation sent but access was not saved", { organizationId, code: result?.error || "request_failed" });
    return res.status(500).json({ error: "The invitation may have been sent, but their access could not be saved. Don't send it again; contact Tymrak support to finish it." });
  }
  return res.status(201).json({ success: true, message: `Invitation sent to ${email}.` });
}

async function giveEmployeeAccess(auth, req, res, access) {
  const employeeId = req.body?.employeeId;
  if (!UUID.test(employeeId || "")) return res.status(400).json({ error: "Choose an employee." });
  const org = encodeURIComponent(auth.organizationId);
  const [employee] = await readRows(auth.configuration,
    `employees?id=eq.${encodeURIComponent(employeeId)}&organization_id=eq.${org}&is_active=eq.true&select=id,auth_user_id,first_name,last_name`);
  if (!employee?.auth_user_id) return res.status(404).json({ error: "That employee doesn't have a Tymrak login yet. They need to accept their employee invitation first." });
  const result = await grant(auth, employee.auth_user_id, access);
  if (!result?.success) return refusal(res, result);
  return res.status(201).json({ success: true, message: `${employee.first_name} ${employee.last_name} can now sign in to the Manager Portal with their usual login.` });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const auth = await requireManager(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (auth.role !== "admin") return res.status(403).json({ error: MESSAGES.admin_required[1] });

    if (req.method === "GET") return listTeam(auth, res);

    if (req.method === "DELETE") {
      const authUserId = req.body?.authUserId;
      if (!UUID.test(authUserId || "")) return res.status(400).json({ error: "Choose a person." });
      const result = await rpc(auth.configuration, "revoke_company_access", {
        p_actor: auth.user.id, p_organization_id: auth.organizationId, p_auth_user_id: authUserId, p_protected_user: protectedUser()
      });
      return result?.success ? res.status(200).json({ success: true }) : refusal(res, result);
    }

    const access = accessInput(req.body);
    if (access.error) return res.status(400).json({ error: access.error });

    if (req.method === "PATCH") {
      const authUserId = req.body?.authUserId;
      if (!UUID.test(authUserId || "")) return res.status(400).json({ error: "Choose a person." });
      // Changing access only applies to someone already on the team; adding someone new
      // goes through an invitation or the existing-employee choice.
      const team = await rpc(auth.configuration, "company_team", {
        p_actor: auth.user.id, p_organization_id: auth.organizationId, p_hidden_user: protectedUser()
      });
      if (team?.error) return refusal(res, team);
      if (!team.members.some(member => member.authUserId === authUserId)) return refusal(res, { error: "not_a_member" });
      const result = await grant(auth, authUserId, access);
      if (!result?.success) return refusal(res, result);
      return res.status(200).json({ success: true });
    }

    if (req.body?.kind === "employee") return giveEmployeeAccess(auth, req, res, access);
    if (req.body?.kind === "new") return inviteNewPerson(auth, req, res, access);
    return res.status(400).json({ error: "Choose a new person or an existing employee." });
  } catch (error) {
    console.error("Team access operation failed", { errorName: error?.name || "Error", status: error?.httpStatus || null });
    return res.status(error?.status >= 400 && error.status < 500 ? error.status : 500)
      .json({ error: error?.status ? error.message : "Unable to manage team access. Please try again." });
  }
}
