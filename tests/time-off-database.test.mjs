import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const emp = '11111111-1111-4111-8111-111111111111', empUser = '22222222-2222-4222-8222-222222222222';
const veteran = '33333333-3333-4333-8333-333333333333', veteranUser = '44444444-4444-4444-8444-444444444444';
const mgr = '55555555-5555-4555-8555-555555555555', outsider = '66666666-6666-4666-8666-666666666666';
const nextYear = new Date().getUTCFullYear() + 1;
const day = (m, d) => `${nextYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
let db;

test.before(async () => {
  db = new PGlite();
  // Minimal stand-ins for tables and the scope helper that the real database provides.
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);create schema tymrak_private;
    create table public.organizations(id uuid primary key,name text,is_active boolean default true);
    create table public.employees(id uuid primary key,auth_user_id uuid,organization_id uuid,first_name text,last_name text,
      hire_date date,is_active boolean default true,invitation_status text default 'Account Activated');
    create table public.user_roles(auth_user_id uuid,organization_id uuid,role text);
    create function tymrak_private.manager_can_access_employee(m uuid,e uuid) returns boolean language sql stable as $$
      select exists(select 1 from public.user_roles r join public.employees x on x.organization_id=r.organization_id
        where r.auth_user_id=m and x.id=e) $$;
    insert into auth.users values('${empUser}'),('${veteranUser}'),('${mgr}'),('${outsider}');
    insert into public.organizations values('${org}','A'),('${other}','B');
    insert into public.user_roles values('${mgr}','${org}','manager'),('${outsider}','${other}','manager');
    insert into public.employees(id,auth_user_id,organization_id,first_name,last_name,hire_date) values
      ('${emp}','${empUser}','${org}','New','Hire',current_date - interval '1 year'),
      ('${veteran}','${veteranUser}','${org}','Old','Hand',current_date - interval '6 years');`);
  for (const name of ['202611160001_time_off_core.sql', '202611160002_time_off_functions.sql', '202611160003_time_off_company_scope.sql'])
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
});
test.after(async () => db.close());
test.beforeEach(async () => db.exec('begin'));
test.afterEach(async () => db.exec('rollback'));
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const request = async (user, start, end, sh = 'full', eh = 'full') =>
  (await one('select public.request_time_off($1,$2,$3,$4,$5,null) r', [user, start, end, sh, eh])).r;

test('Ontario holidays are recognised, including the moving ones', async () => {
  const holidays = await db.query(`select d::date::text d from generate_series('2027-01-01'::date,'2027-12-31','1 day') g(d)
    where tymrak_private.is_ontario_holiday(d::date) order by 1`);
  assert.deepEqual(holidays.rows.map(r => r.d), ['2027-01-01', '2027-02-15', '2027-03-26', '2027-05-24', '2027-07-01', '2027-09-06', '2027-10-11', '2027-12-25', '2027-12-26']);
});

test('working days skip weekends and holidays', async () => {
  assert.equal(Number((await one(`select tymrak_private.working_days('2026-12-21','2026-12-31') n`)).n), 8);
  assert.equal(Number((await one(`select tymrak_private.working_days('2027-06-05','2027-06-06') n`)).n), 0);
});

test('entitlement is 10 days, 15 from the fifth anniversary, never below the minimum', async () => {
  const q = async (hire, on, ovr) => Number((await one('select tymrak_private.entitlement_as_of($1,$2,$3) n', [hire, on, ovr])).n);
  assert.equal(await q('2022-03-10', '2027-03-09', null), 10);
  assert.equal(await q('2022-03-10', '2027-03-10', null), 15);
  assert.equal(await q('2022-03-10', '2027-03-10', 12), 15);
  assert.equal(await q('2024-01-01', '2027-03-10', 20), 20);
});

test('request, approval, balance deduction and cancellation refund', async () => {
  const made = await request(empUser, day(3, 1), day(3, 5)); // Mon-Fri
  assert.equal(made.success, true); assert.equal(Number(made.days), 5);
  const approved = (await one(`select public.decide_time_off($1,$2,$3,'approved',null) r`, [mgr, org, made.requestId])).r;
  assert.equal(approved.success, true);
  let balance = (await one('select public.employee_time_off($1) r', [empUser])).r.balance;
  assert.equal(Number(balance.entitled), 10);
  const after = (await one(`select tymrak_private.balance_for($1,(select id from public.time_off_types where code='vacation'),$2) b`, [emp, nextYear])).b;
  assert.equal(Number(after.remaining), 5);
  const cancelled = (await one('select public.manager_cancel_time_off($1,$2,$3) r', [mgr, org, made.requestId])).r;
  assert.equal(cancelled.success, true);
  const refunded = (await one(`select tymrak_private.balance_for($1,(select id from public.time_off_types where code='vacation'),$2) b`, [emp, nextYear])).b;
  assert.equal(Number(refunded.remaining), 10);
});

test('half days count as half and requests above the balance are blocked', async () => {
  const half = await request(empUser, day(3, 2), day(3, 2), 'pm', 'full');
  assert.equal(Number(half.days), 0.5);
  const tooMany = await request(empUser, day(4, 5), day(4, 30));
  assert.equal(tooMany.error, 'insufficient_balance');
});

test('pending requests reserve balance and overlapping requests are rejected', async () => {
  assert.equal((await request(empUser, day(5, 3), day(5, 7))).success, true);
  assert.equal((await request(empUser, day(5, 5), day(5, 6))).error, 'overlaps_existing');
  assert.equal((await request(empUser, day(6, 7), day(6, 11))).success, true);
  assert.equal((await request(empUser, day(7, 5), day(7, 5))).error, 'insufficient_balance');
});

test('past dates, weekends-only and year-spanning requests are rejected', async () => {
  assert.equal((await request(empUser, '2020-01-06', '2020-01-07')).error, 'past_dates');
  assert.equal((await request(empUser, day(6, 5), day(6, 6))).error, 'no_working_days');
  assert.equal((await request(empUser, day(12, 30), `${nextYear + 1}-01-03`)).error, 'spans_two_years');
});

test('manager decisions stay inside their own company', async () => {
  const made = await request(empUser, day(3, 1), day(3, 2));
  const denied = (await one(`select public.decide_time_off($1,$2,$3,'approved',null) r`, [outsider, other, made.requestId])).r;
  assert.equal(denied.error, 'request_not_found');
  const wrongOrg = (await one(`select public.decide_time_off($1,$2,$3,'approved',null) r`, [mgr, other, made.requestId])).r;
  assert.equal(wrongOrg.error, 'request_not_found');
  const list = (await one('select public.manager_time_off($1,$2) r', [outsider, other])).r;
  assert.deepEqual(list.requests, []);
  assert.equal((await one('select public.manager_time_off($1,$2) r', [outsider, org])).r.error, 'manager_required');
});

test('a manager can raise annual days but not go below the Ontario minimum', async () => {
  assert.equal((await one('select public.set_time_off_entitlement($1,$2,$3,9) r', [mgr, org, emp])).r.error, 'below_ontario_minimum');
  assert.equal((await one('select public.set_time_off_entitlement($1,$2,$3,12.5) r', [mgr, org, emp])).r.success, true);
  const bal = (await one('select public.employee_time_off($1) r', [empUser])).r.balance;
  assert.equal(Number(bal.entitled), 12.5);
  assert.equal((await one('select public.set_time_off_entitlement($1,$2,$3,12.3) r', [mgr, org, emp])).r.error, 'invalid_request');
});

test('the ledger is append-only', async () => {
  await request(empUser, day(3, 1), day(3, 1));
  await one('select public.employee_time_off($1)', [empUser]);
  await db.exec('savepoint s');
  await assert.rejects(db.query(`update public.time_off_ledger set days=99`), /append-only/);
  await db.exec('rollback to s');
  await assert.rejects(db.query('delete from public.time_off_ledger'), /append-only/);
});
