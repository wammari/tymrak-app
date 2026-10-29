import test from "node:test";
import assert from "node:assert/strict";
import { resolveManagerScope, authorizedEmployees, requireEmployeeScope } from "../api/_tenant-authorization.js";
import managerSessionHandler from "../api/manager-session.js";

const A="11111111-1111-4111-8111-111111111111";
const B="22222222-2222-4222-8222-222222222222";
const M="33333333-3333-4333-8333-333333333333";
const E1="44444444-4444-4444-8444-444444444444";
const E2="55555555-5555-4555-8555-555555555555";
const W="66666666-6666-4666-8666-666666666666";
const X="77777777-7777-4777-8777-777777777777";
const originalFetch=globalThis.fetch;
function mock(role="manager", organization=A) {
 globalThis.fetch=async url=>{
  const u=new URL(url);
  const t=u.pathname.split("/").at(-1);
  const data={
   user_roles:[{role,organization_id:organization}],
   organizations:organization===A?[{id:A}]:[],
   manager_workplaces:[{workplace_id:W}],
   workplaces:[{id:W}],
   employees:[{id:E1,organization_id:A},{id:E2,organization_id:A}],
   employee_workplaces:[{employee_id:E1,workplace_id:W},{employee_id:E2,workplace_id:X}]
  }[t]||[];
  return {ok:true,json:async()=>data};
 };
 return {ok:true,user:{id:M},configuration:{supabaseUrl:"https://example.invalid",secretKey:"test"}};
}
test("manager sees assigned workplace employee only",async()=>{const a=mock();const scope=await resolveManagerScope(a);assert.equal(scope.organizationId,A);assert.deepEqual([...await authorizedEmployees(a,scope)],[E1]);assert.equal(await requireEmployeeScope(a,[E2]),null);});
test("inactive workplace cannot grant manager access",async()=>{
 const a=mock();
 const prior=globalThis.fetch;
 globalThis.fetch=async url=>{
  if(new URL(url).pathname.endsWith("/workplaces"))return {ok:true,json:async()=>[]};
  return prior(url);
 };
 try{
  const scope=await resolveManagerScope(a);
  assert.deepEqual([...scope.workplaces],[]);
  assert.deepEqual([...await authorizedEmployees(a,scope)],[]);
  assert.equal(await requireEmployeeScope(a,[E1]),null);
 }finally{globalThis.fetch=prior;}
});
test("admin sees all employees in own company",async()=>{const a=mock("admin");const scope=await resolveManagerScope(a);assert.deepEqual([...await authorizedEmployees(a,scope)],[E1,E2]);});
test("inactive or unknown organization fails closed",async()=>{const a=mock("manager",B);assert.equal(await resolveManagerScope(a),null);});
test("invalid employee identifier fails closed",async()=>{const a=mock();assert.equal(await requireEmployeeScope(a,["not-a-uuid"]),null);});

test("manager session denies a manager without a valid company assignment",async()=>{
 const priorEnv={...process.env};
 process.env.SUPABASE_URL="https://example.invalid";
 process.env.SUPABASE_SECRET_KEY="test-secret";
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async url=>{
  if(url.endsWith("/auth/v1/user"))return new Response(JSON.stringify({id:M,email:"manager@example.invalid"}));
  if(url.includes("/user_roles?")&&url.includes("select=role,organization_id"))return new Response(JSON.stringify([{role:"manager",organization_id:null}]));
  if(url.includes("/user_roles?"))return new Response(JSON.stringify([{role:"manager"}]));
  throw new Error("Unexpected lookup");
 };
 const res={statusCode:0,payload:null,setHeader(){},status(code){this.statusCode=code;return this;},json(value){this.payload=value;return this;}};
 try{
  await managerSessionHandler({method:"GET",headers:{authorization:"Bearer test"}},res);
  assert.equal(res.statusCode,403);
  assert.equal(res.payload.error,"Company access denied");
 }finally{globalThis.fetch=oldFetch;process.env=priorEnv;}
});
test.after(()=>{globalThis.fetch=originalFetch;});
