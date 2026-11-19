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
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql','20261023220346_manager_workplace_scope.sql','202611100001_multi_company_membership.sql','202611180001_company_pay_schedule.sql','202611190001_create_company_with_admin.sql'])
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`insert into organizations(id,name) values('${a}','Semi-monthly Co');
 insert into organizations(id,name,pay_frequency,pay_period_anchor) values('${b}','Weekly Co','weekly','2026-11-02');
 insert into employees(id,auth_user_id,is_active,invitation_status,province,organization_id) values
 ('${ea}','${ua}',true,'Account Activated','ON','${a}'),('${eb}','${ub}',true,'Account Activated','ON','${b}');`);
});
test.after(async()=>db.close());
test.beforeEach(async()=>db.exec('begin'));
test.afterEach(async()=>db.exec('rollback'));
async function asRole(role,fn){
 await db.exec(`set local role ${role}`);
 try {return await fn();} finally {await db.exec('reset role')}
}
// Runs a statement as a role that is expected to fail, then undoes it (and the role
// change) by rolling back to a savepoint, so the test transaction stays usable.
async function refused(role,sql,args){
 await db.exec('savepoint attempt');
 try {await db.exec(`set local role ${role}`);await db.query(sql,args);}
 catch(error){await db.exec('rollback to attempt;release attempt');return error;}
 await db.exec('rollback to attempt;release attempt');
 throw new assert.AssertionError({message:'expected the database to refuse: '+sql});
}
const create='select * from create_company_with_admin($1,$2,$3,$4)';

test('the server may not add admin roles directly (the cause of the half-created company)',async()=>{
 const error=await refused('service_role',`insert into user_roles(auth_user_id,organization_id,role) values($1,$2,'admin')`,[ua,a]);
 assert.match(error.message,/permission denied/);
});

test('the server creates a company and its administrator together',async()=>{
 const {rows}=await asRole('service_role',()=>db.query(create,['  New Bakery ','biweekly','2026-11-01',ua]));
 assert.equal(rows.length,1);
 assert.equal(rows[0].name,'New Bakery');
 assert.equal(rows[0].pay_frequency,'biweekly');
 const roles=await db.query('select auth_user_id,role from user_roles where organization_id=$1',[rows[0].id]);
 assert.deepEqual(roles.rows,[{auth_user_id:ua,role:'admin'}]);
});

test('nothing is saved when any part fails',async()=>{
 const before=(await db.query('select count(*)::int n from organizations')).rows[0].n;
 for(const args of [['Bad Schedule','weekly',null,ua],['No Admin','monthly',null,null],['Unknown Admin','monthly',null,'99999999-9999-4999-8999-999999999999']]){
  await refused('service_role',create,args);
 }
 assert.equal((await db.query('select count(*)::int n from organizations')).rows[0].n,before);
});

test('browsers and signed-in users cannot create companies',async()=>{
 const {rows}=await db.query(`select has_function_privilege('anon','public.create_company_with_admin(text,text,date,uuid)','execute') anon,
  has_function_privilege('authenticated','public.create_company_with_admin(text,text,date,uuid)','execute') signed_in,
  has_function_privilege('service_role','public.create_company_with_admin(text,text,date,uuid)','execute') server`);
 assert.deepEqual(rows[0],{anon:false,signed_in:false,server:true});
});
