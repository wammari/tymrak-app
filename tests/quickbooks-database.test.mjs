import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", emp = "11111111-1111-4111-8111-111111111111", emp2 = "22222222-2222-4222-8222-222222222222";
const sent = "33333333-3333-4333-8333-333333333333", failed = "44444444-4444-4444-8444-444444444444", partial = "55555555-5555-4555-8555-555555555555", untouched = "66666666-6666-4666-8666-666666666666";
let db;

test.before(async () => {
  db = new PGlite();
  // Minimal stand-ins for the real tables this migration refers to.
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);create schema tymrak_private;
    create table public.organizations(id uuid primary key);
    create table public.employees(id uuid primary key,organization_id uuid);
    create table public.timecard_approvals(id uuid primary key,employee_id uuid,status text);
    insert into public.organizations values('${org}');
    insert into public.employees values('${emp}','${org}'),('${emp2}','${org}');
    insert into public.timecard_approvals values('${sent}','${emp}','approved'),('${failed}','${emp}','approved'),
      ('${partial}','${emp}','approved'),('${untouched}','${emp}','approved');`);
  await db.exec(fs.readFileSync(new URL("../supabase/migrations/202611190007_quickbooks_sync.sql", import.meta.url), "utf8"));
  await db.exec(`insert into public.accounting_timecard_syncs(approval_id,organization_id,employee_id,realm_id,status,entries) values
    ('${sent}','${org}','${emp}','9130','synced','[{"date":"2026-11-02","minutes":480,"externalId":"1"}]'),
    ('${failed}','${org}','${emp}','9130','failed','[]'),
    ('${partial}','${org}','${emp}','9130','failed','[{"date":"2026-11-02","minutes":480,"externalId":"2"}]');`);
});
test.after(async () => db.close());
test.beforeEach(async () => db.exec("begin"));
test.afterEach(async () => db.exec("rollback"));

const reopen = id => db.query(`update public.timecard_approvals set status='open' where id=$1`, [id]);

test("a timecard sent to QuickBooks cannot be reopened", async () => {
  await assert.rejects(reopen(sent), /sent to QuickBooks and is locked/);
});

test("a partly sent timecard is locked too, so QuickBooks never holds hours Tymrak dropped", async () => {
  await assert.rejects(reopen(partial), /locked/);
});

test("a timecard whose send failed before anything was created, or never sent, can still be reopened", async () => {
  await reopen(failed);
  await reopen(untouched);
  const rows = await db.query(`select status from public.timecard_approvals where id in ($1,$2)`, [failed, untouched]);
  assert.deepEqual(rows.rows.map(r => r.status), ["open", "open"]);
});

test("only the server can read QuickBooks tables; signed-in users and the public cannot", async () => {
  for (const table of ["accounting_connections", "employee_accounting_links", "accounting_timecard_syncs"]) {
    const grants = await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name=$1`, [table]);
    const grantees = new Set(grants.rows.map(r => r.grantee));
    assert.equal(grantees.has("anon"), false, table);
    assert.equal(grantees.has("authenticated"), false, table);
    assert.equal(grantees.has("service_role"), true, table);
    const rls = await db.query(`select relrowsecurity from pg_class where relname=$1`, [table]);
    assert.equal(rls.rows[0].relrowsecurity, true, table);
  }
  const deletes = await db.query(`select 1 from information_schema.role_table_grants where table_name='accounting_timecard_syncs' and privilege_type='DELETE' and grantee='service_role'`);
  assert.equal(deletes.rows.length, 0, "sync history is never deleted");
});

test("a QuickBooks employee can only be matched to one Tymrak employee per company", async () => {
  await db.exec(`insert into public.employee_accounting_links(employee_id,organization_id,external_id,matched_by) values('${emp}','${org}','7','manual')`);
  await assert.rejects(db.exec(`insert into public.employee_accounting_links(employee_id,organization_id,external_id,matched_by) values('${emp2}','${org}','7','manual')`), /employee_accounting_links_one_per_external/);
});

test("bad values are refused", async () => {
  await assert.rejects(db.exec(`insert into public.accounting_connections(organization_id,realm_id,environment,access_token_encrypted,refresh_token_encrypted,access_expires_at)
    values('${org}','9130; drop','sandbox','x','y',now())`), /check/);
  await db.exec("rollback; begin");
  await assert.rejects(db.exec(`insert into public.accounting_timecard_syncs(approval_id,organization_id,employee_id,status) values('${untouched}','${org}','${emp}','done')`), /check/);
});
