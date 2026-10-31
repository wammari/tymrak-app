import './_test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import employees from '../api/employees.js';
import invitation from '../api/send-invitation.js';
import resend from '../api/resend-invitation.js';
import approvals from '../api/manager-timecard-approvals.js';
import reopen from '../api/manager-timecard-reopen.js';
import timecards from '../api/manager-timecards.js';
import {requireManager} from '../api/_manager-auth.js';

const companyA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',companyB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const empA='11111111-1111-4111-8111-111111111111',empB='22222222-2222-4222-8222-222222222222';
let originalFetch,originalEnv,rows,calls,membership;
test.beforeEach(()=>{
 originalFetch=global.fetch;originalEnv={...process.env};
 process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_test';
 membership={role:'manager',organization_id:companyA,organization:{is_active:true}};
 rows=[{id:empA,organization_id:companyA,first_name:'A',last_name:'Employee',province:'ON',is_active:true},
       {id:empB,organization_id:companyB,first_name:'B',last_name:'Private',province:'ON',is_active:true}];
 calls=[];
 global.fetch=async(raw,options={})=>{
  const url=new URL(raw);calls.push({url,options});
  const json=value=>new Response(JSON.stringify(value));
  if(url.pathname==='/auth/v1/user')return json({id:'manager-A'});
  if(url.pathname==='/rest/v1/user_roles')return json([membership]);
  if(url.pathname==='/rest/v1/rpc/manager_employee_scope')return json({employeeIds:[empA]});
  if(url.pathname==='/auth/v1/invite')return json({id:'33333333-3333-4333-8333-333333333333'});
  if(url.pathname==='/rest/v1/employees'){
   if(options.method==='POST'){
    const row={id:'55555555-5555-4555-8555-555555555555',...JSON.parse(options.body)};assert.equal(row.organization_id,companyA);rows.push(row);return json([row]);
   }
   // Treat a missing company predicate as a failing test, not as a mock denial.
   assert.equal(url.searchParams.get('organization_id'),`eq.${companyA}`);
   let found=rows.filter(r=>url.searchParams.get('organization_id')===`eq.${r.organization_id}`);
   const id=url.searchParams.get('id');if(id?.startsWith('eq.'))found=found.filter(r=>id===`eq.${r.id}`);
   if(id?.startsWith('in.'))found=found.filter(r=>id.includes(r.id));
   if(id==='is.null')found=[];
   if(url.searchParams.has('email')||url.searchParams.has('username'))return json([]);
   if(options.method==='PATCH')for(const row of found)Object.assign(row,JSON.parse(options.body));
   return json(found);
  }
  if(url.pathname==='/rest/v1/overtime_rules')return json([]);
  if(url.pathname==='/rest/v1/punches'||url.pathname==='/rest/v1/timecard_approvals'){
   assert.ok(!url.searchParams.get('employee_id')?.includes(empB),'foreign employee must never reach child-table query');
   return json([]);
  }
  throw new Error(`Unexpected resource ${url.pathname}`);
 };
});
test.afterEach(()=>{global.fetch=originalFetch;process.env=originalEnv;});
const input={firstName:'A',lastName:'Employee',email:'a@example.com',username:'employeeA',province:'ON'};
async function run(handler,method,body={},query={}){
 const res={setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
 await handler({method,headers:{authorization:'Bearer manager-A'},body,query},res);return res;
}
test('global manager roles, missing company IDs, suspended companies and ambiguous records fail closed',async()=>{
 for(const value of [{role:'manager'},{...membership,organization_id:'bad'},{...membership,organization:{is_active:false}},{...membership,role:'employee'}]){
  membership=value;const result=await run(employees,'GET');assert.equal(result.code,403);
 }
 assert.equal(calls.some(c=>c.url.pathname==='/rest/v1/employees'),false);
});
test('manager list, update, duplicates and timecards stay inside the verified company',async()=>{
 const listed=await run(employees,'GET');assert.equal(listed.code,200);assert.deepEqual(listed.body.employees.map(r=>r.id),[empA]);
 const changed=await run(employees,'PATCH',{...input,organizationId:companyB},{id:empB});
 assert.equal(changed.code,404);assert.equal(rows[1].last_name,'Private');
 const cards=await run(timecards,'GET');assert.equal(cards.code,200);assert.equal(cards.body.timecards.length,1);
 assert.equal(cards.body.timecards[0].employee.id,empA);
});
test('foreign employee IDs cannot resend invitations, approve or reopen periods',async()=>{
 assert.equal((await run(resend,'POST',{id:empB})).code,404);
 assert.equal((await run(approvals,'POST',{employeeIds:[empB],period:'2026-09-2'})).code,400);
 assert.equal((await run(reopen,'POST',{employeeId:empB,period:'2026-09-2'})).code,404);
 assert.equal(calls.some(c=>c.url.pathname==='/auth/v1/invite'),false);
 assert.equal(calls.some(c=>c.url.pathname==='/rest/v1/timecard_approvals'),false);
});
test('new employee company comes from the server membership and ignores submitted company/role fields',async()=>{
 membership.role='admin';
 const result=await run(invitation,'POST',{...input,organization_id:companyB,organizationId:companyB,role:'admin'});
 assert.equal(result.code,201);const saved=rows.at(-1);assert.equal(saved.organization_id,companyA);assert.equal(saved.role,undefined);
});
test('authorization joins the active company using database-owned membership, never editable Auth metadata',async()=>{
 const result=await requireManager({headers:{authorization:'Bearer manager-A'}});
 assert.equal(result.organizationId,companyA);
 const roleCall=calls.find(c=>c.url.pathname==='/rest/v1/user_roles');
 assert.match(roleCall.url.searchParams.get('select'),/organizations!inner/);
 assert.equal(roleCall.url.searchParams.get('organization.is_active'),'eq.true');
});
test('same-company staff at another workplace are excluded from reads, edits, invitations and approvals',async()=>{
 const other='44444444-4444-4444-8444-444444444444';
 rows.push({id:other,organization_id:companyA,first_name:'Other',last_name:'Workplace',province:'ON',is_active:true});
 const list=await run(employees,'GET');assert.deepEqual(list.body.employees.map(r=>r.id),[empA]);
 assert.equal((await run(employees,'PATCH',input,{id:other})).code,404);
 assert.equal((await run(resend,'POST',{id:other})).code,404);
 assert.equal((await run(approvals,'POST',{employeeIds:[empA,other],period:'2026-09-2'})).code,400);
 assert.equal((await run(reopen,'POST',{employeeId:other,period:'2026-09-2'})).code,404);
 const cards=await run(timecards,'GET');assert.equal(cards.body.timecards.length,1);
 assert.equal(calls.some(c=>c.url.pathname==='/auth/v1/invite'),false);
});
test('workplace managers cannot create unassigned employees or choose a company-wide role',async()=>{
 const result=await run(invitation,'POST',{...input,role:'admin',organization_id:companyA});
 assert.equal(result.code,403);assert.equal(calls.some(c=>c.url.pathname==='/auth/v1/invite'),false);
});
test('empty or failed live workplace scopes never fall back to company-wide employee visibility',async()=>{
 const upstream=global.fetch;
 global.fetch=async(url,options)=>String(url).endsWith('/rpc/manager_employee_scope')
  ?new Response(JSON.stringify({employeeIds:[]})):upstream(url,options);
 const empty=await run(employees,'GET');assert.equal(empty.code,200);assert.deepEqual(empty.body.employees,[]);
 global.fetch=async(url,options)=>String(url).endsWith('/rpc/manager_employee_scope')
  ?new Response('unavailable',{status:503}):upstream(url,options);
 assert.equal((await run(employees,'GET')).code,500);
});
import {PostgrestResponse as Response} from "./_postgrest-response.mjs";
