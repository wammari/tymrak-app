import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const review=fs.readFileSync(new URL('../ops/review-company-bootstrap.sql',import.meta.url),'utf8');
let db;
test.before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create table employees(id uuid primary key,auth_user_id uuid,first_name text,last_name text,email text,username text,
 is_active boolean,invitation_status text,activated_at timestamptz,province text,updated_at timestamptz);
 create table punches(id bigserial primary key,employee_id uuid references employees(id),punch_type text,punched_at timestamptz,source text);
 alter table employees enable row level security;alter table punches enable row level security;`);
 const ids=[];
 for(let i=0;i<4;i++){
  const id=crypto.randomUUID();ids.push(id);
  await db.query('insert into auth.users values($1,$2,now())',[id,i===0?'w.ammari@outlook.com':`fixture${i}@example.invalid`]);
  await db.query("insert into employees values($1,$1,'Test','Employee',$2,$3,true,'Account Activated',now(),'ON',now())",[id,`fixture${i}@example.invalid`,`fixture${i}`]);
 }
 await db.query("insert into punches(employee_id,punch_type,punched_at,source) select $1,case when n%2=1 then 'clock_in' else 'clock_out' end,now()+n*interval '1 minute','fixture' from generate_series(1,43) n",[ids[0]]);
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql','20261023220346_manager_workplace_scope.sql'])
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.query("insert into user_roles(auth_user_id,role) values($1,'manager')",[ids[0]]);
});
test.after(async()=>db.close());

test('company bootstrap rehearses the exact reviewed mapping and rolls back without changing histories',async()=>{
 const before=(await db.query('select row_to_json(e) data from employees e order by id')).rows;
 const result=await db.exec(review);
 const report=result.flatMap(r=>r.rows??[]).find(r=>r.bootstrap_review)?.bootstrap_review;
 assert.deepEqual(report,{company_count:1,company_employee_count:4,administrator_count:1,inactive_workplace_count:1,employee_assignments:0,punches:43,will_commit:false});
 assert.equal((await db.query('select count(*)::int n from organizations')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from workplaces')).rows[0].n,0);
 assert.deepEqual((await db.query('select row_to_json(e) data from employees e order by id')).rows,before);
 assert.equal((await db.query('select role from user_roles')).rows[0].role,'manager');
});

test('company bootstrap rejects inventory drift before creating a company',async()=>{
 await db.exec("insert into punches(employee_id,punch_type,punched_at) select id,'clock_out',now() from employees limit 1");
 try {
  await assert.rejects(db.exec(review),/inventory differs/);
  await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from organizations')).rows[0].n,0);
 } finally {
  await db.exec('delete from punches where id=(select max(id) from punches)');
 }
});

test('company bootstrap refuses an existing company rather than reassigning ownership',async()=>{
 await db.exec("insert into organizations(name) values('Existing company')");
 try {
  await assert.rejects(db.exec(review),/Unexpected company/);
  await db.exec('rollback');
  assert.equal((await db.query("select count(*)::int n from organizations where name='Existing company'")).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from employees where organization_id is not null')).rows[0].n,0);
 } finally {
  await db.exec('delete from organizations');
 }
});
