import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ea='11111111-1111-4111-8111-111111111111', eb='22222222-2222-4222-8222-222222222222';
const ua='33333333-3333-4333-8333-333333333333', ub='44444444-4444-4444-8444-444444444444';
const ma='55555555-5555-4555-8555-555555555555', mb='66666666-6666-4666-8666-666666666666';
const legacy='77777777-7777-4777-8777-777777777777';
let db;
test.before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 insert into auth.users values('${ua}'),('${ub}'),('${ma}'),('${mb}'),('${legacy}');
 create table employees(id uuid primary key,auth_user_id uuid,is_active boolean,invitation_status text,activated_at timestamptz,province text);
 insert into employees values('${legacy}','${legacy}',true,'Account Activated',now(),'ON');
 create table punches(id bigserial primary key,employee_id uuid references employees(id),punch_type text,punched_at timestamptz,source text);
 alter table employees enable row level security;alter table punches enable row level security;
 grant all on employees,punches to authenticated;
 create policy legacy_employee_read on employees for select to authenticated using(true);
 create policy legacy_employee_update on employees for update to authenticated using(true) with check(true);
 create policy legacy_punch_read on punches for select to authenticated using(true);`);
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql','202611140001_employee_termination.sql'])
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`insert into organizations(id,name) values('${a}','Company A'),('${b}','Company B');
 insert into user_roles(auth_user_id,role,organization_id) values('${ma}','manager','${a}'),('${mb}','admin','${b}');
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
async function manage(manager,body=null){return (await db.query('select manage_workplaces($1::uuid,$2::jsonb) result',[manager,body])).rows[0].result;}
const config=(employee)=>({id:null,name:'Office',address:'',latitude:43.65,longitude:-79.38,radiusMetres:150,isActive:true,employeeIds:[employee]});
async function punch(user,type='clock_in',last=null){return (await db.query('select record_geofenced_punch($1::uuid,$2::text,$3::uuid,$4::text,$5::jsonb) result',
 [user,type,crypto.randomUUID(),last,{latitude:43.65,longitude:-79.38,accuracyMetres:10,capturedAt:Date.now()}])).rows[0].result;}
async function terminate(id,on='2026-11-13'){await db.query('update employees set is_active=false,termination_date=$2,terminated_at=now(),termination_reason=$3 where id=$1',[id,on,'Resigned']);}
async function asEmployee(user,fn){
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);await db.exec('set local role authenticated');
 try {return await fn();} finally {await db.exec('reset role');}
}

test('terminated employee cannot clock in or out, and can no longer start a punch',async()=>{
 await manage(ma,config(ea));
 const first=await punch(ua);assert.equal(first.success,true);
 await terminate(ea);
 for(const type of ['clock_out','clock_in','break_start']) assert.equal((await punch(ua,type,first.punch.id)).error,'employee_unavailable');
 assert.equal((await punch(ua,null)).error,'employee_unavailable');
});
test('terminated employee keeps read-only access to their own history and nobody elses',async()=>{
 await manage(ma,config(ea));await manage(mb,config(eb));await punch(ua);await punch(ub);await terminate(ea);
 await asEmployee(ua,async()=>{
  assert.deepEqual((await db.query('select id from employees')).rows.map(r=>r.id),[ea]);
  assert.deepEqual((await db.query('select employee_id from punches')).rows.map(r=>r.employee_id),[ea]);
  assert.equal((await db.query('select termination_date::text d from employees')).rows[0].d,'2026-11-13');
 });
});
test('terminated employee cannot write punches or edit their own record from the browser',async()=>{
 await manage(ma,config(ea));await punch(ua);await terminate(ea);
 await asEmployee(ua,async()=>{
  for(const sql of ["insert into punches(employee_id,punch_type,punched_at,source) values('"+ea+"','clock_in',now(),'employee')",
    "update punches set punch_type='clock_out'","delete from punches","update employees set is_active=true,termination_date=null,termination_reason=null,terminated_at=null","delete from employees"]) {
   await db.exec('savepoint s');
   try {await assert.rejects(db.exec(sql),/permission denied|row-level security|violates/);} finally {await db.exec('rollback to s;release s');}
  }
 });
 assert.equal((await db.query("select count(*)::int n from punches where employee_id=$1",[ea])).rows[0].n,1);
});
test('a merely deactivated employee (no termination date) is still fully blocked from reading',async()=>{
 await manage(ma,config(ea));await punch(ua);
 await db.query('update employees set is_active=false where id=$1',[ea]);
 await asEmployee(ua,async()=>{
  assert.equal((await db.query('select id from employees')).rows.length,0);
  assert.equal((await db.query('select id from punches')).rows.length,0);
 });
 assert.equal((await punch(ua,null)).error,'employee_unavailable');
});
test('database rejects an active employee that also has a termination date, and half-filled termination fields',async()=>{
 await denied('update employees set termination_date=$2,terminated_at=now() where id=$1',[ea,'2026-11-13'],/employees_termination_consistent/);
 await denied('update employees set is_active=false,termination_date=$2 where id=$1',[ea,'2026-11-13'],/employees_termination_consistent/);
 await denied('update employees set is_active=false,terminated_at=now(),termination_date=$2,termination_reason=$3 where id=$1',[ea,'2026-11-13','x'.repeat(501)],/employees_termination_consistent/);
});
test('reactivation clears termination, restores clocking, and history survives',async()=>{
 await manage(ma,config(ea));await punch(ua);await terminate(ea);
 await db.query('update employees set is_active=true,termination_date=null,termination_reason=null,terminated_at=null where id=$1',[ea]);
 const last=(await punch(ua,null)).lastPunch;assert.equal((await punch(ua,'clock_out',last.id)).success,true);
 assert.equal((await db.query('select count(*)::int n from punches where employee_id=$1',[ea])).rows[0].n,2);
});
test('a terminated employee in a suspended company is still blocked',async()=>{
 await manage(ma,config(ea));await punch(ua);await terminate(ea);
 await db.query('update organizations set is_active=false where id=$1',[a]);
 await asEmployee(ua,async()=>assert.equal((await db.query('select id from punches')).rows.length,0));
});
