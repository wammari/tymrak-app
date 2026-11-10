import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const auth='11111111-1111-4111-8111-111111111111',emp='22222222-2222-4222-8222-222222222222';
let db;
test.before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create table auth.users(id uuid primary key);
 insert into auth.users values('${auth}');
 create table employees(id uuid primary key,auth_user_id uuid,is_active boolean,invitation_status text,province text);
 insert into employees values('${emp}','${auth}',true,'Account Activated','ON');
 create table punches(id bigserial primary key,employee_id uuid references employees(id),punch_type text,punched_at timestamptz,source text);
 grant insert,truncate,trigger,references on punches to anon,authenticated;
 grant insert (employee_id,punch_type) on punches to authenticated;
 grant truncate,trigger,references on employees to anon,authenticated;
 grant usage on sequence punches_id_seq to anon,authenticated;`);
 for(const name of ['202610040001_timecard_approvals.sql','202610230001_atomic_employee_punches.sql'])
   await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
});
test.after(async()=>await db.close());
test.beforeEach(async()=>{await db.exec(`truncate employee_punch_requests,punches,timecard_approvals;update employees set is_active=true,invitation_status='Account Activated';`);});
async function call(type=null,id=null,expected=null,user=auth) {
 return (await db.query('select record_employee_punch($1::uuid,$2::text,$3::uuid,$4::text) as result',[user,type,id,expected])).rows[0].result;
}
const request=()=>crypto.randomUUID();
test('clock in/out use server timestamps and return persisted state',async()=>{
 const before=Date.now();const a=await call('clock_in',request());assert.equal(a.success,true);
 assert.ok(Date.parse(a.punch.punched_at)>=before-1000);
 const state=await call();assert.equal(state.lastPunch.id,a.punch.id);assert.equal(state.timeZone,'America/Toronto');
 const b=await call('clock_out',request(),a.punch.id);assert.equal(b.success,true);
 assert.equal((await call()).lastPunch.punch_type,'clock_out');
});
test('retry same request returns exactly the same receipt and one insert',async()=>{
 const id=request(),first=await call('clock_in',id);assert.deepEqual(await call('clock_in',id),first);
 assert.equal((await db.query('select count(*)::int n from punches')).rows[0].n,1);
 assert.equal((await call('clock_out',id,first.punch.id)).error,'request_conflict');
});
test('two tabs with same state cannot create duplicate clock-ins',async()=>{
 const results=await Promise.all([call('clock_in',request()),call('clock_in',request())]);
 assert.equal(results.filter(x=>x.success).length,1);assert.equal(results.filter(x=>x.error==='stale_state').length,1);
});
test('invalid initial transitions and malformed requests fail closed',async()=>{
 for(const type of ['clock_out','break_start','break_end']) assert.equal((await call(type,request())).error,'invalid_transition');
 assert.equal((await call('invalid',request())).error,'invalid_request');
 assert.equal((await call('clock_in')).error,'invalid_request');
});
test('break sequence works and invalid repeat is rejected',async()=>{
 const a=await call('clock_in',request());
 assert.equal((await call('clock_in',request(),a.punch.id)).error,'invalid_transition');
 const b=await call('break_start',request(),a.punch.id);
 assert.equal((await call('break_start',request(),b.punch.id)).error,'invalid_transition');
 const c=await call('break_end',request(),b.punch.id);
 assert.equal((await call('clock_out',request(),c.punch.id)).success,true);
});
test('overnight active session survives today boundary',async()=>{
 await db.query(`insert into punches(employee_id,punch_type,punched_at,source) values($1,'clock_in',now()-interval '2 days','employee')`,[emp]);
 const state=await call();assert.equal(state.lastPunch.punch_type,'clock_in');assert.equal(state.punches.length,1);
 assert.equal((await call('clock_out',request(),state.lastPunch.id)).success,true);
});
test('inactive, pending and missing employees cannot read or write',async()=>{
 for(const changes of ["is_active=false","is_active=null","invitation_status='Invitation Sent'"]) {
  await db.exec(`update employees set is_active=true,invitation_status='Account Activated';update employees set ${changes}`);
  assert.equal((await call()).error,'employee_unavailable');assert.equal((await call('clock_in',request())).error,'employee_unavailable');
 }
 assert.equal((await call(null,null,null,crypto.randomUUID())).error,'employee_unavailable');
});
test('approval lock still prevents punch and rolls back request receipt',async()=>{
 const date=(await call()).workDate;
 await db.query(`insert into timecard_approvals(employee_id,period_start,period_end,work_timezone,approved_by) values($1,$2,$2,'America/Toronto',$3)`,[emp,date,auth]);
 await assert.rejects(call('clock_in',request()),/approved and locked/);
 assert.equal((await db.query('select count(*)::int n from employee_punch_requests')).rows[0].n,0);
});
test('browser cannot insert directly or invoke service RPC or access receipts',async()=>{
 for(const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  try {
   await assert.rejects(call(),/permission denied/);
   await assert.rejects(db.query(`insert into punches(employee_id,punch_type) values($1,'clock_in')`,[emp]),/permission denied/);
   await assert.rejects(db.query('select * from employee_punch_requests'),/permission denied/);
   await assert.rejects(db.exec('truncate punches'),/permission denied/);
  } finally {await db.exec('reset role');}
 }
 await db.exec('set role service_role');try {assert.ok((await call()).punches);} finally {await db.exec('reset role');}
});
