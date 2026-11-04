import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {PGlite} from '@electric-sql/pglite';
const auth='11111111-1111-4111-8111-111111111111',emp='22222222-2222-4222-8222-222222222222',manager='33333333-3333-4333-8333-333333333333';let db,w;
const migration='20261023172638_manual_workplaces_geofenced_punches.sql';
test.before(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('${auth}'),('${manager}');create table employees(id uuid primary key,auth_user_id uuid,is_active boolean,invitation_status text,province text);insert into employees values('${emp}','${auth}',true,'Account Activated','ON');create table user_roles(auth_user_id uuid,role text);insert into user_roles values('${manager}','manager');create table punches(id bigserial primary key,employee_id uuid references employees(id),punch_type text,punched_at timestamptz,source text);`);
 for(const name of ['202610040001_timecard_approvals.sql','202610230001_atomic_employee_punches.sql',migration])await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
});
test.after(async()=>db.close());
async function manage(body=null,user=manager){return (await db.query('select manage_workplaces($1::uuid,$2::jsonb) result',[user,body])).rows[0].result;}
const config=(extra={})=>({id:null,name:'Office',address:'Reference address',latitude:43.65,longitude:-79.38,radiusMetres:150,isActive:true,employeeIds:[emp],...extra});
const gps=(extra={})=>({latitude:43.65,longitude:-79.38,accuracyMetres:10,capturedAt:Date.now(),...extra});
async function punch(type='clock_in',id=crypto.randomUUID(),last=null,location=gps(),user=auth){return (await db.query('select record_geofenced_punch($1::uuid,$2::text,$3::uuid,$4::text,$5::jsonb) result',[user,type,id,last,location])).rows[0].result;}
test.beforeEach(async()=>{await db.exec(`truncate punch_location_verifications,employee_punch_requests,punches,timecard_approvals,workplace_change_history,employee_workplaces,workplaces;update employees set is_active=true;`);w=(await manage(config())).workplaces[0];});
test('manager saves coordinates and assignments atomically and records change history',async()=>{
 assert.equal(w.employee_ids[0],emp);assert.equal(w.radius_metres,150);
 const r=await manage(config({id:w.id,employeeIds:[crypto.randomUUID()]}));assert.equal(r.error,'employee_not_found');
 assert.equal((await manage()).workplaces[0].employee_ids[0],emp);
 assert.equal((await manage(config(),auth)).error,'manager_required');
 assert.equal((await db.query('select count(*)::int n from workplace_change_history')).rows[0].n,1);
});
test('all punch types require location and record matched workplace with evidence',async()=>{
 let last=null;for(const type of ['clock_in','break_start','break_end','clock_out']){
  assert.equal((await punch(type,crypto.randomUUID(),last,null)).error,'location_required');
  const r=await punch(type,crypto.randomUUID(),last);assert.equal(r.success,true);last=r.punch.id;
 }
 const rows=(await db.query('select * from punch_location_verifications')).rows;assert.equal(rows.length,4);assert.equal(rows[0].workplace_id,w.id);assert.equal(rows[0].distance_metres,0);
});
test('missing, malformed, inaccurate, stale, future and outside GPS fail closed',async()=>{
 for(const [location,error] of [[null,'location_required'],[{},'invalid_location'],[gps({latitude:91}),'invalid_location'],[gps({accuracyMetres:101}),'inaccurate_location'],[gps({capturedAt:Date.now()-60000}),'stale_location'],[gps({capturedAt:Date.now()+60000}),'stale_location'],[gps({latitude:44}),'outside_geofence'],[gps({latitude:43.651,accuracyMetres:80}),'outside_geofence']])assert.equal((await punch('clock_in',crypto.randomUUID(),null,location)).error,error);
 assert.equal((await db.query('select count(*)::int n from punches')).rows[0].n,0);
});
test('unassigned and inactive workplaces deny punching; alternate assigned workplace works',async()=>{
 await manage(config({id:w.id,isActive:false}));assert.equal((await punch()).error,'workplace_unassigned');
 await manage(config({latitude:44}));assert.equal((await punch('clock_in',crypto.randomUUID(),null,gps({latitude:44}))).success,true);
});
test('committed retry returns same punch after GPS expiration without duplicating evidence',async()=>{
 const id=crypto.randomUUID(),a=await punch('clock_in',id);assert.equal(a.success,true);
 assert.deepEqual(await punch('clock_in',id,null,null),a);
 assert.equal((await db.query('select count(*)::int n from punch_location_verifications')).rows[0].n,1);
 assert.equal((await punch('clock_out',id,a.punch.id)).error,'request_conflict');
});
test('stale state and approval locks still apply and evidence rolls back',async()=>{
 const a=await punch();assert.equal((await punch()).error,'stale_state');
 const state=await punch(null);await db.query(`insert into timecard_approvals(employee_id,period_start,period_end,work_timezone,approved_by) values($1,$2,$2,'America/Toronto',$3)`,[emp,state.workDate,manager]);
 await assert.rejects(punch('clock_out',crypto.randomUUID(),a.punch.id),/approved and locked/);
 assert.equal((await db.query('select count(*)::int n from punch_location_verifications')).rows[0].n,1);
});
test('browser roles cannot mutate workplaces or call RPCs; old service punch RPC cannot bypass fence',async()=>{
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(manage(),/permission denied/);await assert.rejects(punch(),/permission denied/);await assert.rejects(db.exec('select * from punch_location_verifications'),/permission denied/);}finally{await db.exec('reset role');}}
 await db.exec('set role service_role');try{await assert.rejects(db.query('select record_employee_punch($1::uuid)',[auth]),/permission denied/);assert.equal((await punch()).success,true);}finally{await db.exec('reset role');}
});
