import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ea='11111111-1111-4111-8111-111111111111', eb='22222222-2222-4222-8222-222222222222';
const ua='33333333-3333-4333-8333-333333333333', ub='44444444-4444-4444-8444-444444444444';
const stranger='55555555-5555-4555-8555-555555555555';
let db;
test.before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 insert into auth.users values('${ua}'),('${ub}'),('${stranger}');
 create table employees(id uuid primary key,auth_user_id uuid,is_active boolean,invitation_status text,activated_at timestamptz,province text);
 create table punches(id bigserial primary key,employee_id uuid references employees(id),punch_type text,punched_at timestamptz,source text);
 alter table employees enable row level security;alter table punches enable row level security;
 grant all on employees,punches to authenticated;`);
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql','202611180001_company_pay_schedule.sql'])
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`insert into organizations(id,name) values('${a}','Semi-monthly Co');
 insert into organizations(id,name,pay_frequency,pay_period_anchor) values('${b}','Weekly Co','weekly','2026-11-02');
 insert into employees(id,auth_user_id,is_active,invitation_status,province,organization_id) values
 ('${ea}','${ua}',true,'Account Activated','ON','${a}'),('${eb}','${ub}',true,'Account Activated','ON','${b}');`);
});
test.after(async()=>db.close());
test.beforeEach(async()=>db.exec('begin'));
test.afterEach(async()=>db.exec('rollback'));
async function denied(sql,args,pattern){
 await db.exec('savepoint expected_denial');
 try {await assert.rejects(db.query(sql,args),pattern);} finally {await db.exec('rollback to expected_denial;release expected_denial');}
}
async function asUser(user,fn){
 await db.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${user}',true)`);
 try {return await fn();} finally {await db.exec('reset role')}
}

test('existing companies keep the original semi-monthly schedule',async()=>{
 const {rows}=await db.query('select pay_frequency,pay_period_anchor from organizations where id=$1',[a]);
 assert.deepEqual(rows[0],{pay_frequency:'semi_monthly',pay_period_anchor:null});
});

test('only the four schedules are allowed, and weekly or every-two-weeks need a start date',async()=>{
 await denied(`insert into organizations(name,pay_frequency) values('Bad','fortnightly')`,[],/organizations_pay_frequency_check/);
 await denied(`insert into organizations(name,pay_frequency) values('No start','biweekly')`,[],/organizations_pay_period_anchor_check/);
 await denied(`insert into organizations(name,pay_frequency,pay_period_anchor) values('Stray start','monthly','2026-11-01')`,[],/organizations_pay_period_anchor_check/);
 await db.query(`insert into organizations(name,pay_frequency,pay_period_anchor) values('Biweekly Co','biweekly','2026-11-02')`);
 await db.query(`insert into organizations(name,pay_frequency) values('Monthly Co','monthly')`);
});

test('the schedule is locked after sign-up unless support deliberately unlocks it',async()=>{
 await denied(`update organizations set pay_frequency='monthly' where id=$1`,[a],/set at sign-up/);
 await denied(`update organizations set pay_period_anchor='2026-11-09' where id=$1`,[b],/set at sign-up/);
 await db.query(`update organizations set name='Renamed Co' where id=$1`,[a]);
 await db.exec(`set local tymrak.allow_pay_schedule_change='on'`);
 await db.query(`update organizations set pay_frequency='monthly' where id=$1`,[a]);
 assert.equal((await db.query('select pay_frequency from organizations where id=$1',[a])).rows[0].pay_frequency,'monthly');
});

test('an employee can read only their own company schedule',async()=>{
 const own=await asUser(ub,()=>db.query('select * from employee_pay_schedule()'));
 assert.deepEqual(own.rows,[{pay_frequency:'weekly',pay_period_anchor:new Date('2026-11-02T00:00:00Z')}]);
 const other=await asUser(ua,()=>db.query('select * from employee_pay_schedule()'));
 assert.equal(other.rows[0].pay_frequency,'semi_monthly');
 const none=await asUser(stranger,()=>db.query('select * from employee_pay_schedule()'));
 assert.equal(none.rows.length,0);
 await db.exec('savepoint closed');
 await db.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${ua}',true)`);
 await assert.rejects(db.query('select pay_frequency from organizations'),/permission denied/);
 await db.exec('rollback to closed;release closed;reset role');
});

test('anonymous visitors cannot call the schedule lookup',async()=>{
 const {rows}=await db.query(`select has_function_privilege('anon','public.employee_pay_schedule()','execute') anon,
  has_function_privilege('authenticated','public.employee_pay_schedule()','execute') signed_in`);
 assert.deepEqual(rows[0],{anon:false,signed_in:true});
});
