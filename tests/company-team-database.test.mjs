import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

// Two companies. In company A: owner (admin), a manager, an employee who will be given
// access, and the Main Administrator (hidden from clients). Company B: its own admin.
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner='11111111-1111-4111-8111-111111111111', manager='22222222-2222-4222-8222-222222222222';
const worker='33333333-3333-4333-8333-333333333333', mainAdmin='44444444-4444-4444-8444-444444444444';
const otherAdmin='55555555-5555-4555-8555-555555555555', invited='66666666-6666-4666-8666-666666666666';
const eOwner='a1111111-1111-4111-8111-111111111111', eWorker='a3333333-3333-4333-8333-333333333333';
const wA1='c1111111-1111-4111-8111-111111111111', wA2='c2222222-2222-4222-8222-222222222222', wB='c3333333-3333-4333-8333-333333333333';
let db;
test.before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,last_sign_in_at timestamptz,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 insert into auth.users(id,email,last_sign_in_at,raw_user_meta_data) values
  ('${owner}','owner@a.test',now(),'{}'),('${manager}','manager@a.test',now(),'{}'),('${worker}','worker@a.test',now(),'{}'),
  ('${mainAdmin}','main@tymrak.test',now(),'{}'),('${otherAdmin}','admin@b.test',now(),'{}'),
  ('${invited}','new@a.test',null,'{"first_name":"Nina","last_name":"New"}');
 create table employees(id uuid primary key,auth_user_id uuid,is_active boolean,invitation_status text,activated_at timestamptz,province text,first_name text,last_name text);
 create table punches(id bigserial primary key,employee_id uuid references employees(id),punch_type text,punched_at timestamptz,source text);
 alter table employees enable row level security;alter table punches enable row level security;
 grant all on employees,punches to authenticated;`);
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610040002_timecard_approval_audit.sql','202610040003_optional_timecard_reopen_reason.sql','202610070001_drop_obsolete_timecard_status_constraint.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql','20261023220346_manager_workplace_scope.sql','202611100001_multi_company_membership.sql','202611190005_company_team_access.sql'])
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`insert into organizations(id,name) values('${a}','Company A'),('${b}','Company B');
 insert into user_roles(auth_user_id,role,organization_id) values('${owner}','admin','${a}'),('${manager}','manager','${a}'),('${mainAdmin}','admin','${a}'),('${otherAdmin}','admin','${b}'),('${mainAdmin}','admin','${b}');
 insert into employees(id,auth_user_id,is_active,invitation_status,province,organization_id,first_name,last_name) values
  ('${eOwner}','${owner}',true,'Account Activated','ON','${a}','Olivia','Owner'),('${eWorker}','${worker}',true,'Account Activated','ON','${a}','Will','Worker');
 insert into workplaces(id,name,address,latitude,longitude,radius_metres,organization_id) values
  ('${wA1}','Main Street','',43.5,-80.2,100,'${a}'),('${wA2}','Mall Kiosk','',43.6,-80.3,100,'${a}'),('${wB}','B Shop','',43.7,-80.4,100,'${b}');
 insert into manager_workplaces(manager_id,workplace_id,organization_id) values('${manager}','${wA1}','${a}');`);
});
test.after(async()=>db.close());
test.beforeEach(async()=>db.exec('begin'));
test.afterEach(async()=>db.exec('rollback'));

async function server(sql,args){
 await db.exec('set local role service_role');
 try {return (await db.query(sql,args)).rows[0];} finally {await db.exec('reset role');}
}
const team=actor=>server('select company_team($1,$2,$3) r',[actor,a,mainAdmin]).then(r=>r.r);
const grant=(actor,user,role,workplaces=[])=>server('select grant_company_access($1,$2,$3,$4,$5,$6) r',[actor,a,user,role,workplaces,mainAdmin]).then(r=>r.r);
const revoke=(actor,user)=>server('select revoke_company_access($1,$2,$3,$4) r',[actor,a,user,mainAdmin]).then(r=>r.r);
const roleOf=async user=>(await db.query('select role from user_roles where auth_user_id=$1 and organization_id=$2',[user,a])).rows[0]?.role??null;

test('a company admin sees their team, without the Main Administrator',async()=>{
 const {members}=await team(owner);
 assert.deepEqual(members.map(m=>m.email).sort(),['manager@a.test','owner@a.test']);
 const me=members.find(m=>m.email==='owner@a.test');
 assert.equal(me.isYou,true);assert.equal(me.name,'Olivia Owner');assert.equal(me.employee.id,eOwner);
 assert.deepEqual(members.find(m=>m.role==='manager').workplaces,[{id:wA1,name:'Main Street'}]);
});

test('managers and other companies cannot see or change the team',async()=>{
 assert.deepEqual(await team(manager),{error:'admin_required'});
 assert.deepEqual(await server('select company_team($1,$2,$3) r',[otherAdmin,a,mainAdmin]).then(r=>r.r),{error:'admin_required'});
 assert.deepEqual(await grant(manager,worker,'manager',[wA1]),{error:'admin_required'});
 assert.deepEqual(await grant(otherAdmin,worker,'manager',[wA1]),{error:'admin_required'});
 assert.equal(await roleOf(worker),null);
});

test('an existing employee can be made a manager of chosen workplaces on their own login',async()=>{
 const result=await grant(owner,worker,'manager',[wA1,wA2,wA2]);
 assert.deepEqual(result,{success:true,role:'manager',created:true});
 assert.equal(await roleOf(worker),'manager');
 const {rows}=await db.query('select workplace_id from manager_workplaces where manager_id=$1 order by workplace_id',[worker]);
 assert.deepEqual(rows.map(r=>r.workplace_id),[wA1,wA2]);
 const {members}=await team(owner);
 assert.equal(members.find(m=>m.authUserId===worker).employee.name,'Will Worker');
});

test('an invited person shows as invited, with their invitation name',async()=>{
 await grant(owner,invited,'admin');
 const m=(await team(owner)).members.find(x=>x.authUserId===invited);
 assert.deepEqual([m.status,m.name,m.role,m.employee],['invited','Nina New','admin',null]);
});

test('managers need at least one workplace of this company',async()=>{
 assert.deepEqual(await grant(owner,worker,'manager',[]),{error:'workplace_required'});
 assert.deepEqual(await grant(owner,worker,'manager',[wB]),{error:'invalid_workplace'});
 assert.deepEqual(await grant(owner,worker,'payroll',[]),{error:'invalid_role'});
});

test('changing a manager to admin drops their workplace limits, and back again',async()=>{
 await grant(owner,manager,'admin');
 assert.equal(await roleOf(manager),'admin');
 assert.equal((await db.query('select count(*)::int n from manager_workplaces where manager_id=$1',[manager])).rows[0].n,0);
 await grant(owner,manager,'manager',[wA2]);
 assert.deepEqual((await db.query('select workplace_id from manager_workplaces where manager_id=$1',[manager])).rows.map(r=>r.workplace_id),[wA2]);
});

test('nobody can change or remove their own access, or the Main Administrator',async()=>{
 assert.deepEqual(await grant(owner,owner,'manager',[wA1]),{error:'cannot_change_own_access'});
 assert.deepEqual(await revoke(owner,owner),{error:'cannot_change_own_access'});
 assert.deepEqual(await grant(owner,mainAdmin,'manager',[wA1]),{error:'protected_user'});
 assert.deepEqual(await revoke(owner,mainAdmin),{error:'protected_user'});
});

test('an admin can remove another admin; the one acting always remains',async()=>{
 await grant(owner,worker,'admin');
 assert.deepEqual(await revoke(worker,owner),{success:true});
 assert.equal(await roleOf(owner),null);
 assert.equal(await roleOf(worker),'admin');
 // The last remaining admin can never be removed: they cannot remove themselves.
 assert.deepEqual(await revoke(worker,worker),{error:'cannot_change_own_access'});
});

test('removing access keeps the employee login and their employee record',async()=>{
 await grant(owner,worker,'manager',[wA1]);
 assert.deepEqual(await revoke(owner,worker),{success:true});
 assert.equal(await roleOf(worker),null);
 assert.equal((await db.query('select count(*)::int n from employees where auth_user_id=$1',[worker])).rows[0].n,1);
 assert.deepEqual(await revoke(owner,worker),{error:'not_a_member'});
});

async function refused(sql,args){
 await db.exec('savepoint attempt');
 try {await db.query(sql,args);}catch(error){await db.exec('rollback to attempt;release attempt');return error;}
 await db.exec('rollback to attempt;release attempt');
 throw new assert.AssertionError({message:'expected refusal: '+sql});
}
const approve=`insert into timecard_approvals(employee_id,period_start,period_end,work_timezone,status,approved_by) values($1,'2026-11-01','2026-11-15','America/Toronto','approved',$2)`;

test('nobody can approve their own timecard; someone else can',async()=>{
 const error=await refused(approve,[eOwner,owner]);
 assert.match(error.message,/can't approve your own timecard/);
 await db.query(approve,[eOwner,manager]);
 assert.equal((await db.query('select approved_by from timecard_approvals where employee_id=$1',[eOwner])).rows[0].approved_by,manager);
});

test('nobody can reopen or re-approve their own timecard',async()=>{
 await db.query(approve,[eOwner,manager]);
 const reopenSelf=await refused(`update timecard_approvals set status='reopened',reopened_by=$2,reopened_at=now() where employee_id=$1`,[eOwner,owner]);
 assert.match(reopenSelf.message,/can't reopen your own timecard/);
 await db.query(`update timecard_approvals set status='reopened',reopened_by=$2,reopened_at=now() where employee_id=$1`,[eOwner,manager]);
 const reapproveSelf=await refused(`update timecard_approvals set status='approved',approved_by=$2,approved_at=now() where employee_id=$1`,[eOwner,owner]);
 assert.match(reapproveSelf.message,/can't approve your own timecard/);
});

test('only the server can call the team functions',async()=>{
 const {rows}=await db.query(`select
  has_function_privilege('authenticated','public.company_team(uuid,uuid,uuid)','execute') a1,
  has_function_privilege('authenticated','public.grant_company_access(uuid,uuid,uuid,text,uuid[],uuid)','execute') a2,
  has_function_privilege('anon','public.revoke_company_access(uuid,uuid,uuid,uuid)','execute') a3,
  has_function_privilege('service_role','public.grant_company_access(uuid,uuid,uuid,text,uuid[],uuid)','execute') s1,
  has_table_privilege('service_role','public.user_roles','insert') s2`);
 assert.deepEqual(rows[0],{a1:false,a2:false,a3:false,s1:true,s2:false});
});
