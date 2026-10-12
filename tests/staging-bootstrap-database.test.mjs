import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

// In-memory PostgreSQL only. No Supabase URL, credentials, sockets or Auth API.
// Simulate only the managed roles/auth objects that the app SQL depends on.
const rawBootstrap = fs.readFileSync(new URL("../supabase/staging/initialize-empty-staging.sql", import.meta.url), "utf8");
const confirmation = "-- set local tymrak.staging_confirmation = 'cztwqcsizwkrqgpgrgg';";
assert.equal(rawBootstrap.split(confirmation).length, 2);
const bootstrap = rawBootstrap.replace(confirmation, confirmation.slice(3));
const rlsFixture = fs.readFileSync(new URL("./fixtures/verified-rls-auto-enable.sql", import.meta.url), "utf8");
const ids = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  manager: "33333333-3333-4333-8333-333333333333",
  unmapped: "44444444-4444-4444-8444-444444444444",
  inactive: "55555555-5555-4555-8555-555555555555",
  legacy: "66666666-6666-4666-8666-666666666666"
};
const employeeIds = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  inactive: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  legacy: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
};

async function managedDependencies(db) {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    -- Exercise revocation against broad pre-existing defaults, rather than
    -- relying on PostgreSQL's initially restrictive table/sequence defaults.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
}
async function disposable(fn, options) {
  const db = new PGlite(options);
  try { await managedDependencies(db); await fn(db); }
  finally { await db.close(); }
}
async function publicCatalog(db) {
  return (await db.query(`
    select 'relation' as kind, c.relname::text as name, c.relkind::text as definition
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    union all
    select 'routine', p.proname::text, pg_get_functiondef(p.oid)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union all
    select 'type', t.typname::text, t.typtype::text
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
    order by kind, name, definition
  `)).rows;
}
async function rejectedWithoutWrites(db, sql, pattern) {
  const before = await publicCatalog(db);
  const users = (await db.query("select * from auth.users order by id")).rows;
  await assert.rejects(db.exec(sql), pattern);
  await db.exec("rollback");
  assert.deepEqual(await publicCatalog(db), before, "guard failure must preserve schema/routine definitions");
  assert.deepEqual((await db.query("select * from auth.users order by id")).rows, users);
}

test("bootstrap requires an explicit local confirmation and rejects a wrong project string", async () => {
  await disposable(async db => {
    await rejectedWithoutWrites(db, rawBootstrap, /explicitly confirm/);
    await rejectedWithoutWrites(db, bootstrap.replace("= 'cztwqcsizwkrqgpgrgg';", "= 'wrong-project';"), /explicitly confirm/);
  });
});

const conflicts = [
  ["table", "create table public.existing (sentinel text); insert into public.existing values ('retained');",
    "select sentinel from public.existing", /public schema already contains relation/],
  ["view", "create view public.existing as select 42 as sentinel;", "select * from public.existing",
    /public schema already contains relation/],
  ["materialized view", "create materialized view public.existing as select 42 as sentinel;", "select * from public.existing",
    /public schema already contains relation/],
  ["sequence", "create sequence public.existing start with 73;", "select last_value, is_called from public.existing",
    /public schema already contains relation/],
  ["activation function", `create function public.complete_employee_activation(uuid) returns jsonb language sql as
    $$ select '{"outcome":"retained"}'::jsonb $$;`,
    "select public.complete_employee_activation(null)", /public schema already contains routine/],
  ["timestamp trigger function", `create function public.set_updated_at() returns trigger language plpgsql as
    $$ begin raise exception 'retained function'; end; $$;`,
    "select pg_get_functiondef('public.set_updated_at()'::regprocedure)", /public schema already contains routine/],
  ["procedure", "create procedure public.existing() language plpgsql as $$ begin null; end; $$;",
    "select pg_get_functiondef('public.existing()'::regprocedure)", /public schema already contains routine/],
  ["enum", "create type public.existing as enum ('retained');", "select 'retained'::public.existing",
    /public schema already contains type/],
  ["domain", "create domain public.existing as integer check (value > 0);", "select 42::public.existing",
    /public schema already contains type/],
  ["collation", 'create collation public.existing from pg_catalog."C";',
    "select collname from pg_collation where collnamespace = 'public'::regnamespace",
    /public schema already contains collation/],
  ["text search configuration", "create text search configuration public.existing (copy = pg_catalog.simple);",
    "select cfgname from pg_ts_config where cfgnamespace = 'public'::regnamespace",
    /public schema already contains text search configuration/]
];
for (const [kind, fixture, read, error] of conflicts) {
  test("bootstrap refuses an existing " + kind + " without replacing it", async () => {
    await disposable(async db => {
      await db.exec(fixture);
      const before = (await db.query(read)).rows;
      await rejectedWithoutWrites(db, bootstrap, error);
      assert.deepEqual((await db.query(read)).rows, before);
    });
  });
}
test("bootstrap rejects a public extension rather than exempting its objects", async () => {
  await disposable(async db => {
    await db.exec("create extension pgcrypto with schema public");
    await rejectedWithoutWrites(db, bootstrap, /public schema already contains extension pgcrypto/);
    assert.equal((await db.query("select count(*)::int as count from pg_extension where extname = 'pgcrypto'")).rows[0].count, 1);
  }, { extensions: { pgcrypto } });
});
test("bootstrap rejects an existing Auth user and preserves it", async () => {
  await disposable(async db => {
    await db.query("insert into auth.users values ($1, $2)", [ids.a, "retained@test.invalid"]);
    await rejectedWithoutWrites(db, bootstrap, /Auth accounts already exist/);
  });
});
test("failure after schema creation rolls back the complete bootstrap", async () => {
  await disposable(async db => {
    const injected = bootstrap.replace("-- BEGIN SOURCE: supabase/staging/least-privilege-and-fixtures.sql", () =>
      "do $$ begin raise exception 'test-only failure after migrations'; end; $$;\n" +
      "-- BEGIN SOURCE: supabase/staging/least-privilege-and-fixtures.sql");
    await rejectedWithoutWrites(db, injected, /test-only failure after migrations/);
    assert.deepEqual(await publicCatalog(db), []);
  });
});

async function rlsObjects(db) {
  return {
    function: (await db.query(`select oid, proowner, prosrc, proconfig, proacl::text,
      pg_get_functiondef(oid) as definition from pg_proc
      where oid='public.rls_auto_enable()'::regprocedure`)).rows,
    trigger: (await db.query("select * from pg_event_trigger order by evtname")).rows
  };
}
test("reviewed automatic-RLS function and trigger are preserved and remain active after bootstrap", async () => {
  await disposable(async db => {
    await db.exec(rlsFixture);
    const before = await rlsObjects(db);
    await db.exec(bootstrap);
    assert.deepEqual(await rlsObjects(db), before, "definition, owner, configuration, ACLs and trigger must be unchanged");
    await db.exec("create table public.synthetic_rls_probe (id integer)");
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.synthetic_rls_probe'::regclass")).rows[0].relrowsecurity, true);
    assert.equal((await db.query("select count(*)::int as count from pg_policies where schemaname='public'")).rows[0].count, 4);
  });
});

for (const [name, tamper] of [
  ["changed body", `create or replace function public.rls_auto_enable() returns event_trigger language plpgsql
    security definer set search_path to pg_catalog as $$ begin null; end; $$;`],
  ["wrong owner", "alter function public.rls_auto_enable() owner to authenticated;"],
  ["wrong search path", "alter function public.rls_auto_enable() set search_path to public;"],
  ["changed volatility", "alter function public.rls_auto_enable() immutable;"],
  ["disabled trigger", "alter event trigger ensure_rls disable;"],
  ["missing trigger", "drop event trigger ensure_rls;"],
  ["wrong trigger tags", `drop event trigger ensure_rls; create event trigger ensure_rls on ddl_command_end
    when tag in ('CREATE TABLE') execute function public.rls_auto_enable();`],
  ["renamed trigger", "alter event trigger ensure_rls rename to unexpected_rls;"],
  ["additional binding", `create event trigger additional_rls on ddl_command_end
    when tag in ('CREATE TABLE') execute function public.rls_auto_enable();`],
  ["wrong trigger owner", "create role other_event_owner superuser; alter event trigger ensure_rls owner to other_event_owner;"]
]) {
  test("RLS exception refuses " + name + " without modifying existing objects", async () => {
    await disposable(async db => {
      await db.exec(rlsFixture); await db.exec(tamper);
      const before = await rlsObjects(db);
      await rejectedWithoutWrites(db, bootstrap, /differs from the reviewed/);
      assert.deepEqual(await rlsObjects(db), before);
    });
  });
}
for (const [name, fixture] of [
  ["another routine", "create function public.unexpected() returns integer language sql as $$ select 42 $$;"],
  ["overloaded helper", "create function public.rls_auto_enable(integer) returns integer language sql as $$ select $1 $$;"],
  ["existing table", "create table public.unexpected (id integer);"]
]) {
  test("verified RLS helper does not exempt " + name, async () => {
    await disposable(async db => {
      await db.exec(rlsFixture); await db.exec(fixture);
      const before = await rlsObjects(db);
      await rejectedWithoutWrites(db, bootstrap, /public schema already contains/);
      assert.deepEqual(await rlsObjects(db), before);
    });
  });
}

let db, initialCounts;
test.before(async () => {
  db = new PGlite();
  await managedDependencies(db);
  await db.exec(bootstrap);
  initialCounts = (await db.query(`
    select (select count(*)::int from auth.users) as users,
      (select count(*)::int from public.employees) as employees,
      (select count(*)::int from public.punches) as punches,
      (select count(*)::int from public.user_roles) as roles,
      (select count(*)::int from public.timecard_approval_history) as history
  `)).rows[0];
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users values ($1, $2)", [id, name + "@test.invalid"]);
  }
  for (const name of ["a", "b", "inactive", "legacy"]) {
    await db.query(`
      insert into public.employees
        (id, auth_user_id, first_name, last_name, email, username, province, is_active,
         invitation_status, activated_at, updated_at)
      values ($1, $2, 'Synthetic', 'Employee', $3, $4, 'ON', $5, 'Invitation Sent', $6, '2026-01-01')
    `, [employeeIds[name], ids[name], name + "@test.invalid", "staging." + name,
      name !== "inactive", name === "legacy" ? "2026-09-01T12:00:00Z" : null]);
  }
});
test.after(async () => { await db?.close(); });
async function role(name, user, fn) {
  assert.ok(["anon", "authenticated", "service_role"].includes(name));
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user || ""]);
  await db.exec("set role " + name);
  try { return await fn(); }
  finally { await db.exec("reset role"); }
}
async function employees() { return (await db.query("select * from public.employees order by id")).rows; }
async function complete(id) {
  return role("service_role", null, async () =>
    (await db.query("select public.complete_employee_activation($1::uuid) as result", [id])).rows[0].result);
}

test("full bootstrap creates the recovered schema, four RLS policies and synthetic ON rule", async () => {
  assert.deepEqual(initialCounts, { users: 0, employees: 0, punches: 0, roles: 0, history: 0 });
  const tables = (await db.query(`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by c.relname
  `)).rows;
  assert.deepEqual(tables.map(t => t.name), ["employees", "overtime_rules", "punches",
    "timecard_approval_history", "timecard_approvals", "user_roles"]);
  assert.ok(tables.every(t => t.rls && !t.forced));
  assert.equal((await db.query("select count(*)::int as count from pg_policies where schemaname='public'")).rows[0].count, 4);
  const columns = (await db.query(`
    select table_name, count(*)::int as count from information_schema.columns
    where table_schema = 'public' and table_name in ('employees','overtime_rules','punches')
    group by table_name order by table_name
  `)).rows;
  assert.deepEqual(columns, [{ table_name: "employees", count: 20 }, { table_name: "overtime_rules", count: 29 },
    { table_name: "punches", count: 10 }]);
  const rule = (await db.query("select * from public.overtime_rules")).rows;
  assert.equal(rule.length, 1); assert.equal(rule[0].province_code, "ON");
  assert.equal(Number(rule[0].weekly_threshold_hours), 44);
  assert.match(rule[0].notes, /Synthetic/);
  assert.equal((await db.query("select pg_get_serial_sequence('public.punches', 'id') as name")).rows[0].name, "public.punches_id_seq");
  assert.equal((await db.query(`select count(*)::int as count from pg_constraint
    where conrelid='public.timecard_approvals'::regclass and conname='timecard_approvals_status'`)).rows[0].count, 0);
});

test("actual SQL grants restrict browser roles and activation RPC execution", async () => {
  const grants = (await db.query(`
    select r,
      has_table_privilege(r, 'public.employees', 'UPDATE') as employee_update,
      has_table_privilege(r, 'public.employees', 'TRUNCATE') as employee_truncate,
      has_table_privilege(r, 'public.punches', 'INSERT') as punch_insert,
      has_table_privilege(r, 'public.user_roles', 'SELECT') as role_read,
      has_table_privilege(r, 'public.timecard_approval_history', 'INSERT') as history_insert,
      has_function_privilege(r, 'public.complete_employee_activation(uuid)', 'EXECUTE') as activation
    from (values ('anon'), ('authenticated'), ('service_role')) as roles(r)
  `)).rows;
  assert.deepEqual(grants, [
    { r: "anon", employee_update: false, employee_truncate: false, punch_insert: false,
      role_read: false, history_insert: false, activation: false },
    { r: "authenticated", employee_update: false, employee_truncate: false, punch_insert: true,
      role_read: false, history_insert: false, activation: false },
    { r: "service_role", employee_update: true, employee_truncate: false, punch_insert: true,
      role_read: true, history_insert: false, activation: true }
  ]);
  for (const name of ["anon", "authenticated"]) {
    await role(name, ids.a, async () =>
      assert.rejects(db.query("select public.complete_employee_activation($1::uuid)", [ids.a]), /permission denied/));
  }
});

test("RLS restricts profiles to the mapped user and prevents punches before activation", async () => {
  await role("authenticated", ids.a, async () => {
    assert.deepEqual((await db.query("select id from public.employees")).rows, [{ id: employeeIds.a }]);
    await assert.rejects(db.query("insert into public.punches (employee_id, punch_type) values ($1,'clock_in')", [employeeIds.a]),
      /row-level security/);
    await assert.rejects(db.exec("update public.employees set invitation_status='Account Activated'"), /permission denied/);
    await assert.rejects(db.exec("select * from public.user_roles"), /permission denied/);
    await assert.rejects(db.exec("truncate public.employees"), /permission denied/);
  });
  await role("anon", null, async () => {
    await assert.rejects(db.exec("select * from public.employees"), /permission denied/);
    await assert.rejects(db.exec("select * from public.punches"), /permission denied/);
  });
});

test("activation on the complete schema preserves identity and first timestamps on retries", async () => {
  const before = (await db.query("select * from public.employees where id=$1", [employeeIds.a])).rows[0];
  assert.deepEqual(await complete(ids.a), { outcome: "activated" });
  const after = (await db.query("select * from public.employees where id=$1", [employeeIds.a])).rows[0];
  assert.equal(after.invitation_status, "Account Activated");
  assert.ok(after.activated_at); assert.ok(after.updated_at > before.updated_at);
  assert.deepEqual({ ...after, invitation_status: before.invitation_status, activated_at: before.activated_at,
    updated_at: before.updated_at }, before);
  assert.deepEqual(await complete(ids.a), { outcome: "already_activated" });
  assert.deepEqual((await db.query("select * from public.employees where id=$1", [employeeIds.a])).rows[0], after);
  const legacy = (await db.query("select * from public.employees where id=$1", [employeeIds.legacy])).rows[0];
  assert.deepEqual(await complete(ids.legacy), { outcome: "already_activated" });
  assert.deepEqual((await db.query("select * from public.employees where id=$1", [employeeIds.legacy])).rows[0], legacy);
  const all = await employees();
  assert.deepEqual(await complete(ids.unmapped), { outcome: "missing" });
  assert.deepEqual(await employees(), all);
});

test("real unique Auth mapping rejects a duplicate without changing employees", async () => {
  const before = await employees();
  await role("service_role", null, async () =>
    assert.rejects(db.query(`insert into public.employees
      (auth_user_id, first_name, last_name, email, username)
      values ($1,'Synthetic','Duplicate','duplicate@test.invalid','staging.duplicate')`, [ids.a]),
    /employees_auth_user_id_key/));
  assert.deepEqual(await employees(), before);
});

test("activated employees can insert own identity punches, but not another or inactive employee", async () => {
  await role("authenticated", ids.a, async () => {
    const result = await db.query(`insert into public.punches (employee_id, punch_type, punched_at)
      values ($1,'clock_in','2026-10-10T13:00:00Z') returning id, source`, [employeeIds.a]);
    assert.ok(Number(result.rows[0].id) > 0); assert.equal(result.rows[0].source, "employee");
    await assert.rejects(db.query("insert into public.punches (employee_id, punch_type) values ($1,'clock_in')",
      [employeeIds.b]), /row-level security/);
  });
  await role("authenticated", ids.b, async () => {
    assert.deepEqual((await db.query("select * from public.punches")).rows, []);
  });
  await complete(ids.inactive);
  await role("authenticated", ids.inactive, async () =>
    assert.rejects(db.query("insert into public.punches (employee_id, punch_type) values ($1,'clock_in')",
      [employeeIds.inactive]), /row-level security/));
});

test("approval, reopen and re-approval triggers work with server-only grants and append-only history", async () => {
  await role("service_role", null, async () => {
    const approval = (await db.query(`
      insert into public.timecard_approvals
        (employee_id, period_start, period_end, work_timezone, approved_by)
      values ($1,'2026-10-01','2026-10-15','America/Toronto',$2) returning id
    `, [employeeIds.a, ids.manager])).rows[0].id;
    await assert.rejects(db.query(`insert into public.punches (employee_id, punch_type, punched_at)
      values ($1,'clock_out','2026-10-10T14:00:00Z')`, [employeeIds.a]), /approved and locked/);
    await assert.rejects(db.query("update public.punches set notes='blocked' where employee_id=$1", [employeeIds.a]),
      /approved and locked/);
    await db.query(`update public.timecard_approvals set status='reopened', reopened_by=$1,
      reopened_at=now() where id=$2`, [ids.manager, approval]);
    await db.query("update public.punches set notes='synthetic correction' where employee_id=$1", [employeeIds.a]);
    await db.query(`update public.timecard_approvals set status='approved', approved_by=$1,
      approved_at=now() where id=$2`, [ids.manager, approval]);
    const history = (await db.query("select action, reopen_reason from public.timecard_approval_history where approval_id=$1", [approval])).rows;
    assert.deepEqual(history.map(h => h.action).sort(), ["approved", "re-approved", "reopened"]);
    assert.ok(history.every(h => h.reopen_reason === null));
  });
  await assert.rejects(db.exec("update public.timecard_approval_history set reopen_reason='overwrite'"), /append-only/);
  await assert.rejects(db.exec("delete from public.timecard_approval_history"), /append-only/);
});

test("re-running bootstrap refuses initialization and preserves all synthetic records", async () => {
  const before = await employees();
  const history = (await db.query("select * from public.timecard_approval_history order by id")).rows;
  await rejectedWithoutWrites(db, bootstrap, /public schema already contains/);
  assert.deepEqual(await employees(), before);
  assert.deepEqual((await db.query("select * from public.timecard_approval_history order by id")).rows, history);
});

test("test-manager seed requires confirmation, adds only the selected test role and never overwrites a role", async () => {
  const raw = fs.readFileSync(new URL("../supabase/staging/test-manager-role.sql", import.meta.url), "utf8");
  const selected = raw.replace(confirmation, confirmation.slice(3))
    // Replace only the declaration, leaving the placeholder rejection intact.
    .replace("test_manager_email text := 'REPLACE_WITH_CONTROLLED_TEST_MANAGER_EMAIL';",
      "test_manager_email text := 'manager@test.invalid';");
  const authBefore = (await db.query("select * from auth.users order by id")).rows;
  const employeeBefore = await employees();
  await assert.rejects(db.exec(raw), /staging bootstrap marker and explicit confirmation/);
  await db.exec("rollback");
  await assert.rejects(db.exec(raw.replace(confirmation, confirmation.slice(3))), /Replace the test manager email/);
  await db.exec("rollback");
  await db.exec(selected);
  assert.deepEqual((await db.query("select auth_user_id, role from public.user_roles")).rows,
    [{ auth_user_id: ids.manager, role: "manager" }]);
  await assert.rejects(db.exec(selected), /user_roles_pkey/);
  await db.exec("rollback");
  const employeeSeed = selected.replace("test_manager_email text := 'manager@test.invalid';",
    "test_manager_email text := 'a@test.invalid';");
  await assert.rejects(db.exec(employeeSeed), /separate test manager/);
  await db.exec("rollback");
  assert.deepEqual((await db.query("select auth_user_id, role from public.user_roles")).rows,
    [{ auth_user_id: ids.manager, role: "manager" }]);
  assert.deepEqual((await db.query("select * from auth.users order by id")).rows, authBefore);
  assert.deepEqual(await employees(), employeeBefore);
});
