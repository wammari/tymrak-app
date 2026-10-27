import { databaseHeaders } from "./_employee-management.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function rows(configuration, resource, params) {
  const response = await fetch(`${configuration.supabaseUrl}/rest/v1/${resource}?${params}`, {
    headers: databaseHeaders(configuration.secretKey)
  });
  if (!response.ok) throw new Error("Authorization scope lookup failed");
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Invalid authorization scope response");
  return data;
}

export async function resolveManagerScope(authorization) {
  if (!authorization?.ok || !UUID.test(authorization.user?.id || "")) return null;
  const roles = await rows(authorization.configuration, "user_roles",
    `auth_user_id=eq.${authorization.user.id}&select=role,organization_id`);
  const allowed = roles.filter(r => ["manager", "admin"].includes(r.role) && UUID.test(r.organization_id || ""));
  // Ambiguous or missing tenant assignment must never confer global access.
  if (allowed.length !== 1) return null;
  const assignment = allowed[0];
  const orgs = await rows(authorization.configuration, "organizations",
    `id=eq.${assignment.organization_id}&is_active=eq.true&select=id`);
  if (orgs.length !== 1) return null;
  let workplaces = null;
  if (assignment.role === "manager") {
    const mappings = await rows(authorization.configuration, "manager_workplaces",
      `manager_id=eq.${authorization.user.id}&organization_id=eq.${assignment.organization_id}&select=workplace_id`);
    workplaces = new Set(mappings.map(x => x.workplace_id).filter(x => UUID.test(x || "")));
  }
  return { organizationId: assignment.organization_id, role: assignment.role, workplaces };
}

export async function authorizedEmployees(authorization, scope) {
  const employees = await rows(authorization.configuration, "employees",
    `organization_id=eq.${scope.organizationId}&select=id,organization_id`);
  if (scope.role === "admin") return new Set(employees.map(e => e.id));
  if (!scope.workplaces?.size) return new Set();
  const assignments = await rows(authorization.configuration, "employee_workplaces",
    `organization_id=eq.${scope.organizationId}&select=employee_id,workplace_id`);
  const inOrg = new Set(employees.map(e => e.id));
  return new Set(assignments.filter(a => scope.workplaces.has(a.workplace_id) && inOrg.has(a.employee_id)).map(a => a.employee_id));
}

export async function requireEmployeeScope(authorization, employeeIds) {
  const scope = await resolveManagerScope(authorization);
  if (!scope) return null;
  const allowed = await authorizedEmployees(authorization, scope);
  if (!employeeIds.every(id => UUID.test(id) && allowed.has(id))) return null;
  return { ...scope, allowed };
}
