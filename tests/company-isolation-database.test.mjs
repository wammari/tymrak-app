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
 for(const name of ['202610010001_manager_roles.sql','202610040001_timecard_approvals.sql','202610080001_atomic_employee_activation.sql','202610230001_atomic_employee_punches.sql','20261023172638_manual_workplaces_geofenced_punches.sql','20261023213945_company_isolation.sql'])
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
const config=(employee,extra={})=>({id:null,name:'Office',address:'',latitude:43.65,longitude:-79.38,radiusMetres:150,isActive:true,employeeIds:[employee],...extra});
async function punch(user,type='clock_in',last=null){return (await db.query('select record_geofenced_punch($1::uuid,$2::text,$3::uuid,$4::text,$5::jsonb) result',
 [user,type,crypto.randomUUID(),last,{latitude:43.65,longitude:-79.38,accuracyMetres:10,capturedAt:Date.now()}])).rows[0].result;}

test('company workplace RPC hides other companies and rejects guessed workplace/employee IDs',async()=>{
 const wa=(await manage(ma,config(ea))).workplaces[0];
 const wb=(await manage(mb,config(eb))).workplaces[0];
 assert.deepEqual((await manage(ma)).workplaces.map(w=>w.id),[wa.id]);
 assert.equal((await manage(ma,config(ea,{id:wb.id}))).error,'workplace_not_found');
 assert.equal((await manage(ma,config(eb,{id:wa.id}))).error,'employee_not_found');
 assert.deepEqual((await manage(mb)).workplaces[0].employee_ids,[eb]);
 assert.equal((await db.query('select count(*)::int n from workplace_change_history')).rows[0].n,2);
});
test('database foreign keys reject cross-company assignments even with a service-side mistake',async()=>{
 const wa=(await manage(ma,config(ea))).workplaces[0];
 await denied('insert into employee_workplaces(employee_id,workplace_id,organization_id) values($1,$2,$3)',[eb,wa.id,a],/foreign key/);
 await denied('insert into employee_workplaces(employee_id,workplace_id,organization_id) values($1,$2,$3)',[eb,wa.id,b],/foreign key/);
 await denied('update employees set organization_id=$1 where id=$2',[b,ea],/cannot be reassigned/);
});
test('active employees can punch only with reviewed same-company assignments; suspended companies fail closed',async()=>{
 await manage(ma,config(ea));await manage(mb,config(eb));
 assert.equal((await punch(ua)).success,true);assert.equal((await punch(ub)).success,true);
 await db.query('update organizations set is_active=false where id=$1',[a]);
 assert.equal((await punch(ua,null)).error,'employee_unavailable');
 assert.equal((await manage(ma)).error,'manager_required');
 assert.ok((await punch(ub,null)).lastPunch);
 assert.equal((await punch(legacy)).error,'employee_unavailable');
});
test('restrictive browser policies defeat legacy broad SELECT policies and company reassignment',async()=>{
 await manage(ma,config(ea));await manage(mb,config(eb));await punch(ua);await punch(ub);
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[ua]);
 await db.exec('set local role authenticated');
 assert.deepEqual((await db.query('select id from employees')).rows.map(r=>r.id),[ea]);
 assert.deepEqual((await db.query('select employee_id from punches')).rows.map(r=>r.employee_id),[ea]);
 await denied('update employees set organization_id=$1 where id=$2',[b,ea],/permission denied/);
 await denied('select * from organizations',[],/permission denied/);
 await denied('select manage_workplaces($1::uuid)',[ma],/permission denied/);
 await denied('select record_geofenced_punch($1::uuid)',[ua],/permission denied/);
 await db.exec('reset role');
 await db.query('update organizations set is_active=false where id=$1',[a]);
 await db.exec('set local role authenticated');
 assert.equal((await db.query('select * from employees')).rows.length,0);
 assert.equal((await db.query('select * from punches')).rows.length,0);
});
test('activation gate refuses legacy and suspended companies and internal implementations are not service entry points',async()=>{
 assert.equal((await db.query('select complete_employee_activation($1::uuid) r',[legacy])).rows[0].r.outcome,'missing');
 await db.query('update organizations set is_active=false where id=$1',[a]);
 assert.equal((await db.query('select complete_employee_activation($1::uuid) r',[ua])).rows[0].r.outcome,'missing');
 await db.exec('set local role service_role');
 await denied('select tymrak_private.record_geofenced_punch($1::uuid)',[ub],/permission denied/);
 assert.equal((await db.query('select record_geofenced_punch($1::uuid) r',[ub])).rows[0].r.lastPunch,null);
});
