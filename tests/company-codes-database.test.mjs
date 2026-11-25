import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const ICARE = "11111111-1111-4111-8111-111111111111";
let db;

test.before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema tymrak_private;
    create table public.organizations(id uuid primary key default gen_random_uuid(), name text not null, is_active boolean default true, created_at timestamptz default now());
    create table public.employees(id uuid primary key default gen_random_uuid(), organization_id uuid, username text);
    insert into public.organizations(id, name, created_at) values
      ('${ICARE}', 'I Care Pharmacy', '2026-11-10'),
      (gen_random_uuid(), 'Le Delice Pastry Shop', '2026-11-11'),
      (gen_random_uuid(), 'Al Zaeem Shawrma', '2026-11-12'),
      (gen_random_uuid(), 'QB testing', '2026-11-20'),
      (gen_random_uuid(), 'Ice Cream Parlour', '2026-11-21');`);
  await db.exec(fs.readFileSync(new URL("../supabase/migrations/202611250001_company_codes_and_usernames.sql", import.meta.url), "utf8"));
});
test.after(async () => db.close());

const codes = async () => Object.fromEntries((await db.query("select name, company_code from public.organizations")).rows.map(r => [r.name, r.company_code]));

test("existing companies get codes from their names, oldest first keeps the plain code", async () => {
  assert.deepEqual(await codes(), {
    "I Care Pharmacy": "ICP", "Le Delice Pastry Shop": "LDP", "Al Zaeem Shawrma": "AZS", "QB testing": "QBT", "Ice Cream Parlour": "ICP2"
  });
});

test("new companies get a unique code automatically", async () => {
  await db.exec(`insert into public.organizations(name) values ('Shyftrak'), ('I.C.P. Holdings Corp'), ('1001822269 Ontario Corporation')`);
  const all = await codes();
  assert.equal(all["Shyftrak"], "SHY");
  assert.equal(all["I.C.P. Holdings Corp"], "IHC");
  assert.equal(all["1001822269 Ontario Corporation"], "1OC");
  await assert.rejects(db.exec(`update public.organizations set company_code = 'LDP' where name = 'Shyftrak'`), /company_code_key/);
  await assert.rejects(db.exec(`update public.organizations set company_code = 'no!' where name = 'Shyftrak'`), /company_code_format/);
});

test("usernames count up per company and skip ones already taken", async () => {
  const next = async () => (await db.query(`select public.next_employee_username($1) as u`, [ICARE])).rows[0].u;
  assert.equal(await next(), "ICP-1001");
  assert.equal(await next(), "ICP-1002");
  await db.exec(`insert into public.employees(organization_id, username) values ('${ICARE}', 'icp-1003')`);
  assert.equal(await next(), "ICP-1004", "an existing username (any case) is skipped");
  await assert.rejects(db.query(`select public.next_employee_username(gen_random_uuid())`), /Company not found/);
});

test("only the server can create usernames", async () => {
  const grants = await db.query(`select grantee from information_schema.role_routine_grants where routine_name = 'next_employee_username' and grantee in ('anon','authenticated','service_role','PUBLIC')`);
  assert.deepEqual(grants.rows.map(r => r.grantee), ["service_role"]);
});
