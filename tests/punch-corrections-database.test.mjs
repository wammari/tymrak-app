import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGER = "11111111-1111-4111-8111-111111111111", WORKER = "22222222-2222-4222-8222-222222222222";
const ANA = "33333333-3333-4333-8333-333333333333", BOB_BC = "44444444-4444-4444-8444-444444444444";
const MANAGER_AS_EMPLOYEE = "55555555-5555-4555-8555-555555555555", ELSEWHERE = "66666666-6666-4666-8666-666666666666";
let db;

test.before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
  create schema auth; create schema tymrak_private;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create table public.organizations(id uuid primary key, name text);
  insert into organizations values ('${ORG}', 'I Care'), ('${OTHER_ORG}', 'Elsewhere');
  create table public.employees(id uuid primary key, organization_id uuid references organizations(id), auth_user_id uuid, province text);
  insert into employees values ('${ANA}', '${ORG}', '${WORKER}', 'ON'), ('${BOB_BC}', '${ORG}', null, 'BC'),
    ('${MANAGER_AS_EMPLOYEE}', '${ORG}', '${MANAGER}', 'ON'), ('${ELSEWHERE}', '${OTHER_ORG}', null, 'ON');
  create table public.punches(id bigserial primary key, employee_id uuid references employees(id), punch_type text,
    punched_at timestamptz, location_name text, source text default 'employee');
  create table public.punch_location_verifications(punch_id bigint primary key references punches(id), workplace_name text);
  create table public.timecard_approvals(employee_id uuid, period_start date, period_end date, work_timezone text, status text);
  create function public.prevent_approved_timecard_punch_changes() returns trigger language plpgsql as $$
  begin
    if tg_op in ('UPDATE','DELETE') and exists (select 1 from public.timecard_approvals a where a.employee_id = old.employee_id
      and a.status = 'approved' and (old.punched_at at time zone a.work_timezone)::date between a.period_start and a.period_end) then
      raise exception using errcode = 'P0001', message = 'This timecard period is approved and locked.'; end if;
    if tg_op = 'DELETE' then return old; end if;
    if exists (select 1 from public.timecard_approvals a where a.employee_id = new.employee_id
      and a.status = 'approved' and (new.punched_at at time zone a.work_timezone)::date between a.period_start and a.period_end) then
      raise exception using errcode = 'P0001', message = 'This timecard period is approved and locked.'; end if;
    return new;
  end $$;
  create trigger block_approved_timecard_punch_changes before insert or delete or update on public.punches
    for each row execute function public.prevent_approved_timecard_punch_changes();`);
  await db.exec(fs.readFileSync(new URL("../supabase/migrations/202611260001_punch_corrections.sql", import.meta.url), "utf8"));
});
test.after(async () => db.close());
test.beforeEach(async () => db.exec("truncate punch_corrections, punch_location_verifications, punches, timecard_approvals restart identity cascade"));

const correct = async ({ actor = MANAGER, org = ORG, employee = ANA, action, punch = null, type = null, local = null, reason = "Forgot to clock out", label = "lead@example.com" }) =>
  (await db.query("select public.correct_punch($1,$2,$3,$4,$5,$6,$7::timestamp,$8,$9) as r", [actor, org, employee, action, punch, type, local, reason, label])).rows[0].r;
const punch = async (employee, type, at, location = null) =>
  (await db.query("insert into punches(employee_id,punch_type,punched_at,location_name) values ($1,$2,$3,$4) returning id", [employee, type, at, location])).rows[0].id;
const history = async () => (await db.query("select action, before_type, before_at, after_type, after_at, reason, corrected_by_label, before_location from punch_corrections order by corrected_at")).rows;

test("adding a missing clock-out uses the employee's own time zone and records who and why", async () => {
  await punch(ANA, "clock_in", "2026-11-17T14:00:00Z");
  const r = await correct({ action: "add", type: "clock_out", local: "2026-11-17 17:05" });
  assert.equal(r.success, true);
  assert.equal(r.timeZone, "America/Toronto");
  const added = (await db.query("select punch_type, punched_at, source from punches where id = $1", [r.punchId])).rows[0];
  assert.equal(added.punched_at.toISOString(), "2026-11-17T22:05:00.000Z", "5:05 p.m. Toronto is 22:05 UTC");
  assert.equal(added.source, "manager");
  const [h] = await history();
  assert.equal(h.action, "added"); assert.equal(h.after_type, "clock_out"); assert.equal(h.before_at, null);
  assert.equal(h.reason, "Forgot to clock out"); assert.equal(h.corrected_by_label, "lead@example.com");
  const bc = await correct({ employee: BOB_BC, action: "add", type: "clock_in", local: "2026-11-17 09:00" });
  assert.equal(bc.timeZone, "America/Vancouver");
  assert.equal(new Date(bc.punchedAt).toISOString(), "2026-11-17T17:00:00.000Z");
});

test("changing and removing keep the before values; removing drops the location check too", async () => {
  const id = await punch(ANA, "clock_in", "2026-11-17T14:00:00Z", "Main store");
  await db.query("insert into punch_location_verifications values ($1, 'Main store')", [id]);
  const changed = await correct({ action: "change", punch: id, type: "clock_in", local: "2026-11-17 08:30", reason: "Clocked in late by mistake" });
  assert.equal(changed.success, true);
  assert.equal((await db.query("select punched_at from punches where id=$1", [id])).rows[0].punched_at.toISOString(), "2026-11-17T13:30:00.000Z");
  const removed = await correct({ action: "remove", punch: id, reason: "Duplicate punch" });
  assert.equal(removed.success, true);
  assert.equal((await db.query("select count(*)::int n from punches")).rows[0].n, 0);
  const [c, r] = await history();
  assert.equal(c.action, "changed"); assert.equal(c.before_at.toISOString(), "2026-11-17T14:00:00.000Z"); assert.equal(c.after_at.toISOString(), "2026-11-17T13:30:00.000Z");
  assert.equal(r.action, "removed"); assert.equal(r.after_at, null); assert.equal(r.before_location, "Main store");
});

test("refuses: no reason, own punches, another business, someone else's punch, future time, nothing changed", async () => {
  const id = await punch(ANA, "clock_in", "2026-11-17T14:00:00Z");
  const other = await punch(ELSEWHERE, "clock_in", "2026-11-17T14:00:00Z");
  assert.equal((await correct({ action: "remove", punch: id, reason: "  x " })).error, "reason_required");
  assert.equal((await correct({ action: "remove", punch: id, reason: "y".repeat(501) })).error, "reason_required");
  assert.equal((await correct({ employee: MANAGER_AS_EMPLOYEE, action: "add", type: "clock_in", local: "2026-11-17 09:00" })).error, "own_punches");
  assert.equal((await correct({ employee: ELSEWHERE, action: "remove", punch: other })).error, "employee_not_found");
  assert.equal((await correct({ action: "remove", punch: other })).error, "punch_not_found", "a punch id from another employee");
  assert.equal((await correct({ action: "add", type: "clock_out", local: "2099-01-01 09:00" })).error, "future_time");
  assert.equal((await correct({ action: "change", punch: id, type: "clock_in", local: "2026-11-17 09:00" })).error, "no_change");
  assert.equal((await correct({ action: "add", type: "lunch", local: "2026-11-17 09:00" })).error, "invalid_request");
  assert.equal((await correct({ action: "explode" })).error, "invalid_request");
  assert.equal((await history()).length, 0, "nothing recorded for refused corrections");
});

test("approved timecards stay locked, in both directions", async () => {
  await db.query(`insert into timecard_approvals values ('${ANA}', '2026-11-01', '2026-11-15', 'America/Toronto', 'approved')`);
  const inLocked = await punch(ANA, "clock_in", "2026-11-17T14:00:00Z"); // Nov 17: open period
  const id = (await db.query("select id from punches where id=$1", [inLocked])).rows[0].id;
  assert.equal((await correct({ action: "add", type: "clock_out", local: "2026-11-10 17:00" })).error, "period_locked");
  assert.equal((await correct({ action: "change", punch: id, type: "clock_in", local: "2026-11-14 09:00" })).error, "period_locked", "can't move a punch into a locked period");
  await db.query("update timecard_approvals set status='reopened'");
  const locked = await punch(ANA, "clock_in", "2026-11-10T14:00:00Z");
  await db.query("update timecard_approvals set status='approved'");
  assert.equal((await correct({ action: "remove", punch: locked })).error, "period_locked");
  assert.equal((await correct({ action: "change", punch: locked, type: "clock_in", local: "2026-11-17 09:00" })).error, "period_locked", "or out of one");
  assert.equal((await db.query("select count(*)::int n from punches")).rows[0].n, 2);
});

test("employees see only their own corrections, in their own dates", async () => {
  await punch(ANA, "clock_in", "2026-11-17T14:00:00Z");
  await correct({ action: "add", type: "clock_out", local: "2026-11-17 17:05" });
  await correct({ employee: BOB_BC, action: "add", type: "clock_in", local: "2026-11-17 09:00" });
  const mine = async (uid, from, to) => {
    await db.exec(`set test.uid = '${uid}'`);
    return (await db.query("select * from public.my_punch_corrections($1::date, $2::date)", [from, to])).rows;
  };
  const ana = await mine(WORKER, "2026-11-16", "2026-11-30");
  assert.equal(ana.length, 1);
  assert.equal(ana[0].action, "added"); assert.equal(ana[0].reason, "Forgot to clock out");
  assert.ok(!("corrected_by_label" in ana[0]), "employees don't see the manager's email");
  assert.equal((await mine(WORKER, "2026-11-01", "2026-11-15")).length, 0, "outside the dates");
  assert.equal((await mine(MANAGER, "2026-11-16", "2026-11-30")).length, 0, "the manager's own record has none");
  await db.exec("reset test.uid");
});

test("only the server can correct punches; employees can read their own list", async () => {
  const grants = (await db.query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') auth,
    has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('service_role', p.oid, 'execute') svc
    from pg_proc p where proname in ('correct_punch','my_punch_corrections') order by 1`)).rows;
  assert.deepEqual(grants, [
    { proname: "correct_punch", auth: false, anon: false, svc: true },
    { proname: "my_punch_corrections", auth: true, anon: false, svc: false }
  ]);
  assert.equal((await db.query("select has_table_privilege('authenticated','public.punch_corrections','select') s")).rows[0].s, false);
});
