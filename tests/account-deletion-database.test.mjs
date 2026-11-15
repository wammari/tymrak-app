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
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql','202611140001_employee_termination.sql','202611140002_account_deletion.sql'])
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
const gone=/^deleted-/;
async function personalise(){
 await db.query('delete from employees where id=$1',[legacy]);
 await db.exec(`alter table employees add column first_name text,add column last_name text,add column email text,add column username text,add column mobile text,add column position text;
  update employees set first_name='Ada',last_name='Lovelace',email=id||'@example.com',username='user-'||id,mobile='555-0100',position='Engineer';
  alter table employees alter column email set not null,alter column username set not null,add constraint e_email_u unique(email),add constraint e_user_u unique(username)`);
}
const call=(org,emp,by=ma)=>db.query('select public.anonymize_employee_account($1::uuid,$2::uuid,$3::uuid) r',[org,emp,by]).then(x=>x.rows[0].r);
const request=(emp,org=a,user=ua)=>db.query("insert into account_deletion_requests(organization_id,employee_id,auth_user_id) values($1,$2,$3) returning id",[org,emp,user]).then(x=>x.rows[0].id);
async function punches(emp){return (await db.query('select count(*)::int n from punches where employee_id=$1',[emp])).rows[0].n;}
async function row(emp){return (await db.query('select * from employees where id=$1',[emp])).rows[0];}
const setup=personalise; // runs inside each test's own rolled-back transaction

test('requested deletion removes personal details but keeps the hours and the employment facts',async()=>{
 await setup();await db.query("insert into punches(employee_id,punch_type,punched_at,source) values($1,'clock_in',now()-interval '2 hours','employee'),($1,'clock_out',now()-interval '1 hour','employee')",[ea]);
 await request(ea);
 const r=await call(a,ea);
 assert.equal(r.outcome,'anonymized');assert.equal(r.authUserId,ua);
 const e=await row(ea);
 assert.equal(e.first_name,'Former');assert.equal(e.last_name,'Employee');
 assert.match(e.email,gone);assert.match(e.username,gone);assert.equal(e.mobile,null);
 assert.equal(e.auth_user_id,null);assert.equal(e.is_active,false);
 assert.ok(e.termination_date);assert.ok(e.terminated_at);
 assert.equal(e.province,'ON');assert.equal(e.position,'Engineer');
 assert.equal(await punches(ea),2);
 const other=await row(eb);assert.equal(other.first_name,'Ada');assert.equal(other.is_active,true);
});
test('personal placeholders are unique per employee so unique email/username constraints still hold',async()=>{
 await setup();await db.query("update employees set is_active=false,termination_date=current_date,terminated_at=now() where id in($1,$2)",[ea,eb]);
 await call(a,ea);
 await db.query("update organizations set is_active=true where id=$1",[b]);
 assert.equal((await call(b,eb,mb)).outcome,'anonymized');
 assert.notEqual((await row(ea)).email,(await row(eb)).email);
});
test('an active employee with no request is refused; a terminated one can be processed by a manager',async()=>{
 await setup();
 assert.equal((await call(a,ea)).error,'not_terminated');assert.equal((await row(ea)).first_name,'Ada');
 await db.query("update employees set is_active=false,termination_date=current_date,terminated_at=now() where id=$1",[ea]);
 assert.equal((await call(a,ea)).outcome,'anonymized');
 const req=(await db.query("select requested_by,status,processed_by from account_deletion_requests where employee_id=$1",[ea])).rows[0];
 assert.deepEqual(req,{requested_by:'manager',status:'Anonymized',processed_by:ma});
});
test('manager and admin sign-ins are refused and nothing changes',async()=>{
 await setup();await db.query("insert into employees(id,auth_user_id,is_active,invitation_status,province,organization_id,first_name,last_name,email,username) values($1,$2,false,'Account Activated','ON',$3,'Boss','Person','boss@example.com','boss')",[crypto.randomUUID(),ma,a]);
 const id=(await db.query("select id from employees where auth_user_id=$1",[ma])).rows[0].id;
 await db.query("update employees set termination_date=current_date,terminated_at=now() where id=$1",[id]);
 assert.equal((await call(a,id)).error,'manager_account');assert.equal((await row(id)).first_name,'Boss');
});
test('a manager from another company cannot process this employee',async()=>{
 await setup();await request(ea);
 assert.equal((await call(b,ea,mb)).error,'employee_not_found');assert.equal((await row(ea)).first_name,'Ada');
});
test('retrying after a partial failure only returns the sign-in account to delete, then completion clears the id',async()=>{
 await setup();const id=await request(ea);
 const first=await call(a,ea);const again=await call(a,ea);
 assert.equal(again.outcome,'already_anonymized');assert.equal(again.authUserId,first.authUserId);assert.equal(again.requestId,id);
 await db.query('select public.complete_account_deletion($1::uuid)',[id]);
 const done=(await db.query('select status,auth_user_id from account_deletion_requests where id=$1',[id])).rows[0];
 assert.deepEqual(done,{status:'Completed',auth_user_id:null});
});
test('only one open request per employee, and a cancelled one allows a new request',async()=>{
 await setup();const id=await request(ea);
 await denied("insert into account_deletion_requests(organization_id,employee_id,auth_user_id) values($1,$2,$3)",[a,ea,ua],/account_deletion_one_open_request/);
 await db.query("update account_deletion_requests set status='Cancelled' where id=$1",[id]);
 await request(ea);
});
test('browser roles can neither read the requests nor run the deletion functions',async()=>{
 await setup();await request(ea);
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[ua]);await db.exec('set local role authenticated');
 try{
  for(const sql of ['select * from account_deletion_requests',"select public.anonymize_employee_account('"+a+"','"+ea+"','"+ua+"')","select public.complete_account_deletion('"+crypto.randomUUID()+"')",
   "insert into account_deletion_requests(organization_id,employee_id) values('"+a+"','"+ea+"')"]) {
   await db.exec('savepoint s');
   try{await assert.rejects(db.exec(sql),/permission denied/,sql);}finally{await db.exec('rollback to s;release s');}
  }
 }finally{await db.exec('reset role');}
});
