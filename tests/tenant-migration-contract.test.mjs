import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/202610280001_tenant_company_boundaries_prerequisite.sql", import.meta.url), "utf8").toLowerCase();

test("tenant migration creates all four tenant tables and company columns", () => {
  for (const table of ["organizations", "workplaces", "manager_workplaces", "employee_workplaces"]) {
    assert.match(sql, new RegExp("create\\s+table\\s+if\\s+not\\s+exists\\s+public\\."+table+"\\b"));
  }
  for (const table of ["employees", "user_roles"]) {
    assert.match(sql, new RegExp("alter\\s+table\\s+public\\."+table+"\\s+add\\s+column\\s+if\\s+not\\s+exists\\s+organization_id"));
  }
});

test("tenant migration constrains cross-company workplace mappings", () => {
  for (const name of [
    "manager_workplaces_manager_company_fk",
    "manager_workplaces_workplace_company_fk",
    "employee_workplaces_employee_company_fk",
    "employee_workplaces_workplace_company_fk"
  ]) assert.ok(sql.includes(name), "missing cross-company foreign key: "+name);
  assert.match(sql, /foreign key\s*\(manager_id,organization_id\)/);
  assert.match(sql, /foreign key\s*\(employee_id,organization_id\)/);
});

test("tenant migration enables RLS and restricts tenant table access to server reads", () => {
  for (const table of ["organizations", "workplaces", "manager_workplaces", "employee_workplaces"]) {
    assert.match(sql, new RegExp("alter\\s+table\\s+public\\."+table+"\\s+enable\\s+row\\s+level\\s+security"));
  }
  assert.match(sql, /grant select on public\.organizations, public\.workplaces, public\.manager_workplaces, public\.employee_workplaces to service_role/);
  assert.doesNotMatch(sql, /create\s+policy\b/);
});

test("tenant migration does not silently assign or delete existing test accounts", () => {
  assert.doesNotMatch(sql, /\b(update|delete|truncate|drop)\s+(?:table\s+)?(?:public\.)?(?:employees|user_roles)\b/);
  assert.doesNotMatch(sql, /\binsert\s+into\s+(?:public\.)?(?:employees|user_roles)\b/);
});
