import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {dateKey} from '../timecard-calculation.js';

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
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql','20261023220346_manager_workplace_scope.sql','202611100001_multi_company_membership.sql','202611180001_company_pay_schedule.sql','202611190001_create_company_with_admin.sql','202611190002_pay_schedule_changes.sql'])
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`insert into organizations(id,name) values('${a}','Semi-monthly Co');
 insert into organizations(id,name,pay_frequency,pay_period_anchor) values('${b}','Weekly Co','weekly','2026-11-02');
 insert into employees(id,auth_user_id,is_active,invitation_status,province,organization_id) values
 ('${ea}','${ua}',true,'Account Activated','ON','${a}'),('${eb}','${ub}',true,'Account Activated','ON','${b}');`);
});
test.after(async()=>db.close());
test.beforeEach(async()=>db.exec('begin'));
test.afterEach(async()=>db.exec('rollback'));

// Dates relative to today in Toronto, the calendar the database uses for "today".
const today=dateKey(new Date(),'America/Toronto');
const firstOfMonth=monthsAhead=>{const d=new Date(`${today.slice(0,7)}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()+monthsAhead);return d.toISOString().slice(0,10);};
const future=firstOfMonth(2), later=firstOfMonth(4);
// A date after today inside the current twice-a-month period, if today is not its last day.
const semiEnd=Number(today.slice(8))<=15?today.slice(0,8)+'15':new Date(Date.UTC(+today.slice(0,4),+today.slice(5,7),0)).toISOString().slice(0,10);
const insideCurrent=semiEnd>today?semiEnd:null;
const change='select * from change_company_pay_schedule($1,$2,$3,$4)';

async function refused(role,sql,args){
 await db.exec('savepoint attempt');
 try {await db.exec(`set local role ${role}`);await db.query(sql,args);}
 catch(error){await db.exec('rollback to attempt;release attempt');return error;}
 await db.exec('rollback to attempt;release attempt');
 throw new assert.AssertionError({message:'expected the database to refuse: '+sql+' '+JSON.stringify(args)});
}
async function asServer(sql,args){
 await db.exec('set local role service_role');
 try {return await db.query(sql,args);} finally {await db.exec('reset role');}
}

test('a twice-a-month company can switch to every two weeks from a future 1st of the month',async()=>{
 const {rows}=await asServer(change,[a,'biweekly',future,ua]);
 assert.equal(rows.length,1);
 assert.equal(rows[0].pay_frequency,'biweekly');
 assert.equal(dateKey(rows[0].effective_from,'UTC'),future);
 assert.equal(dateKey(rows[0].pay_period_anchor,'UTC'),future,'periods are counted from the change date');
 const {rows:saved}=await db.query('select changed_by from pay_schedule_changes where organization_id=$1',[a]);
 assert.deepEqual(saved,[{changed_by:ua}]);
});

test('a change inside a future period is allowed and shortens only that period',async()=>{
 const inside=future.slice(0,8)+'10';
 const {rows:[saved]}=await asServer(change,[a,'biweekly',inside,ua]);
 assert.equal(dateKey(saved.effective_from,'UTC'),inside);
});

test('changes that would move a started or misaligned period are refused',async()=>{
 const cases=[
  [[a,'monthly',today,ua],/future date/],
  [[a,'monthly','2020-01-01',ua],/future date/],
  [[a,'semi_monthly',future,ua],/already uses this pay schedule/],
  [[b,'monthly',nextWeeklyStartNotFirst(),ua],/own pay periods/],
  [[a,'monthly',future.slice(0,8)+'02',ua],/own pay periods/],
  ...(insideCurrent?[[[a,'biweekly',insideCurrent,ua],/already started/]]:[]),
  [[a,'fortnightly',future,ua],/check|constraint|own pay periods/],
  [['99999999-9999-4999-8999-999999999999','monthly',future,ua],/Company not found/]
 ];
 for(const [args,pattern] of cases){
  const error=await refused('service_role',change,args);
  assert.match(error.message,pattern,JSON.stringify(args));
 }
 assert.equal((await db.query('select count(*)::int n from pay_schedule_changes')).rows[0].n,0);
});
function nextWeeklyStartNotFirst(){
 // A future Monday counted from the weekly company's anchor (2026-11-02) that is not the 1st.
 let d=new Date('2026-11-02T12:00:00Z');
 while(d.toISOString().slice(0,10)<=today||d.getUTCDate()===1)d.setUTCDate(d.getUTCDate()+7);
 return d.toISOString().slice(0,10);
}

test('only one change can wait at a time, and a waiting change can be cancelled',async()=>{
 const {rows:[first]}=await asServer(change,[a,'monthly',future,ua]);
 const error=await refused('service_role',change,[a,'biweekly',later,ua]);
 assert.match(error.message,/waiting to start/);
 const cancelled=await asServer('select cancel_pay_schedule_change($1,$2) ok',[a,first.id]);
 assert.equal(cancelled.rows[0].ok,true);
 const {rows:[second]}=await asServer(change,[a,'biweekly',later,ua]);
 assert.equal(second.pay_frequency,'biweekly');
});

test('a change that has already started cannot be cancelled, and the next change follows it',async()=>{
 const started=firstOfMonth(-1);
 await db.query(`insert into pay_schedule_changes(organization_id,pay_frequency,pay_period_anchor,effective_from) values($1,'biweekly',$2,$2)`,[a,started]);
 const {rows:[row]}=await db.query('select id from pay_schedule_changes where organization_id=$1',[a]);
 const cancelled=await asServer('select cancel_pay_schedule_change($1,$2) ok',[a,row.id]);
 assert.equal(cancelled.rows[0].ok,false);
 // The schedule in effect is now every two weeks from that date, so a later change must
 // start on one of those two-week boundaries.
 let boundary=new Date(`${started}T12:00:00Z`);
 while(boundary.toISOString().slice(0,10)<=today)boundary.setUTCDate(boundary.getUTCDate()+14);
 const key=boundary.toISOString().slice(0,10);
 // The day before that boundary is inside the current two-week period, which has started.
 const insideStarted=new Date(boundary.getTime()-86400000).toISOString().slice(0,10);
 const error=await refused('service_role',change,[a,'weekly',insideStarted,ua]);
 assert.match(error.message,/already started|future date/);
 const {rows:[next]}=await asServer(change,[a,'weekly',key,ua]);
 assert.equal(next.pay_frequency,'weekly');
});

test('a company cannot cancel another company\'s change',async()=>{
 const {rows:[mine]}=await asServer(change,[a,'monthly',future,ua]);
 const result=await asServer('select cancel_pay_schedule_change($1,$2) ok',[b,mine.id]);
 assert.equal(result.rows[0].ok,false);
 assert.equal((await db.query('select count(*)::int n from pay_schedule_changes')).rows[0].n,1);
});

test('employees see their own company\'s schedule history, sign-up schedule first',async()=>{
 await asServer(change,[a,'biweekly',future,ua]);
 await db.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${ua}',true)`);
 const own=await db.query('select * from employee_pay_schedule()');
 await db.exec(`select set_config('request.jwt.claim.sub','${ub}',true)`);
 const other=await db.query('select * from employee_pay_schedule()');
 await db.exec('reset role');
 assert.equal(own.rows.length,2);
 assert.deepEqual([own.rows[0].pay_frequency,own.rows[0].effective_from],['semi_monthly',null]);
 assert.equal(own.rows[1].pay_frequency,'biweekly');
 assert.deepEqual(other.rows.map(r=>r.pay_frequency),['weekly'],'another company sees none of these changes');
});

test('only the server can change or cancel schedules, and nobody can edit the history directly',async()=>{
 const {rows}=await db.query(`select
  has_function_privilege('anon','public.change_company_pay_schedule(uuid,text,date,uuid)','execute') anon_change,
  has_function_privilege('authenticated','public.change_company_pay_schedule(uuid,text,date,uuid)','execute') user_change,
  has_function_privilege('authenticated','public.cancel_pay_schedule_change(uuid,bigint)','execute') user_cancel,
  has_function_privilege('service_role','public.change_company_pay_schedule(uuid,text,date,uuid)','execute') server_change,
  has_table_privilege('authenticated','public.pay_schedule_changes','select') user_read,
  has_table_privilege('service_role','public.pay_schedule_changes','insert') server_insert,
  has_table_privilege('service_role','public.pay_schedule_changes','delete') server_delete`);
 assert.deepEqual(rows[0],{anon_change:false,user_change:false,user_cancel:false,server_change:true,user_read:false,server_insert:false,server_delete:false});
});

test('the sign-up schedule itself stays locked',async()=>{
 const error=await refused('postgres',`update organizations set pay_frequency='monthly' where id=$1`,[a]);
 assert.match(error.message,/set at sign-up/);
});
