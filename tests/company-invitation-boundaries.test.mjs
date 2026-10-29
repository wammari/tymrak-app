import test from "node:test";
import assert from "node:assert/strict";
import inviteHandler from "../api/send-invitation.js";

const MANAGER="33333333-3333-4333-8333-333333333333";
const ORG="11111111-1111-4111-8111-111111111111";
const valid={firstName:"Pilot",lastName:"Employee",email:"pilot@example.invalid",username:"pilot",province:"ON"};
const response=()=>({statusCode:null,payload:null,setHeader(){},status(n){this.statusCode=n;return this;},json(p){this.payload=p;return this;}});
function setup(role,organization=ORG,saveFails=false){
 const oldFetch=globalThis.fetch,oldEnv={...process.env},calls=[];
 process.env.SUPABASE_URL="https://example.invalid";process.env.SUPABASE_SECRET_KEY="fixture-key";
 globalThis.fetch=async(raw,options={})=>{
  const u=new URL(raw),method=options.method||"GET";calls.push({path:u.pathname,method,body:options.body});
  if(u.pathname==="/auth/v1/user")return new Response(JSON.stringify({id:MANAGER,email:"manager@example.invalid"}));
  if(u.pathname.endsWith("/user_roles"))return new Response(JSON.stringify(u.searchParams.get("select")==="role"?[{role}]:[{role,organization_id:organization}]));
  if(u.pathname.endsWith("/organizations"))return new Response(JSON.stringify([{id:ORG}]));
  if(u.pathname.endsWith("/manager_workplaces"))return new Response("[]");
  if(u.pathname.endsWith("/workplaces"))return new Response("[]");
  if(u.pathname.endsWith("/employees")&&method==="GET")return new Response("[]");
  if(u.pathname==="/auth/v1/invite")return new Response(JSON.stringify({id:"44444444-4444-4444-8444-444444444444"}));
  if(u.pathname.endsWith("/employees")&&method==="POST")return saveFails?new Response("{}",{status:500}):new Response(JSON.stringify([{id:"55555555-5555-4555-8555-555555555555"}]));
  if(u.pathname.startsWith("/auth/v1/admin/users/")&&method==="DELETE")return new Response(null,{status:204});
  throw new Error("Unexpected request: "+u.pathname);
 };
 return {calls,restore(){globalThis.fetch=oldFetch;process.env=oldEnv;}};
}
const req=()=>({method:"POST",headers:{authorization:"Bearer fixture-token"},body:valid});
test("workplace manager cannot invite employees or trigger Auth side effects",async()=>{
 const f=setup("manager");try{
  const res=response();await inviteHandler(req(),res);
  assert.equal(res.statusCode,403);
  assert.equal(f.calls.some(x=>x.path==="/auth/v1/invite"),false);
  assert.equal(f.calls.some(x=>x.method==="POST"),false);
 }finally{f.restore();}
});
test("admin invitation writes organization ID into employee record",async()=>{
 const f=setup("admin");try{
  const res=response();await inviteHandler(req(),res);
  assert.equal(res.statusCode,201);
  const write=f.calls.find(x=>x.path.endsWith("/employees")&&x.method==="POST");
  assert.ok(write);
  assert.equal(JSON.parse(write.body).organization_id,ORG);
 }finally{f.restore();}
});
test("admin without organization cannot invite or create auth user",async()=>{
 const f=setup("admin",null);try{
  const res=response();await inviteHandler(req(),res);
  assert.equal(res.statusCode,403);
  assert.equal(f.calls.some(x=>x.path==="/auth/v1/invite"),false);
 }finally{f.restore();}
});

test("failed employee persistence never deletes potentially existing Auth identity",async()=>{
 const f=setup("admin",ORG,true);try{
  const res=response();await inviteHandler(req(),res);
  assert.equal(res.statusCode,500);
  const invite=f.calls.find(x=>x.path==="/auth/v1/invite");
  const cleanup=f.calls.find(x=>x.path==="/auth/v1/admin/users/44444444-4444-4444-8444-444444444444"&&x.method==="DELETE");
  assert.ok(invite);
  assert.equal(cleanup,undefined);
 }finally{f.restore();}
});
