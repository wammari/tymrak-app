import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("an email can be used once per business, in several businesses", async () => {
  const db = new PGlite();
  try {
    // The production table as it was before this change: email unique everywhere.
    await db.exec(`create table public.employees(id uuid primary key default gen_random_uuid(),
      organization_id uuid not null, email text unique, auth_user_id uuid);`);
    await db.exec(`insert into public.employees(organization_id, email) values ('${A}', 'Waleed@Example.ca')`);
    await assert.rejects(db.exec(`insert into public.employees(organization_id, email) values ('${B}', 'waleed@example.ca'), ('${B}', 'Waleed@Example.ca')`));

    await db.exec(fs.readFileSync(new URL("../supabase/migrations/202611250004_employee_email_per_business.sql", import.meta.url), "utf8"));

    await db.exec(`insert into public.employees(organization_id, email) values ('${B}', 'Waleed@Example.ca')`);
    await assert.rejects(db.exec(`insert into public.employees(organization_id, email) values ('${B}', 'waleed@example.ca')`),
      /employees_company_email_unique/, "same business, any case: still refused");
    assert.equal((await db.query(`select count(*)::int as n from public.employees`)).rows[0].n, 2);
  } finally {
    await db.close();
  }
});
