import test from "node:test";
import assert from "node:assert/strict";
import employeesHandler from "../api/employees.js";
import timecardsHandler from "../api/manager-timecards.js";
import approvalsHandler from "../api/manager-timecard-approvals.js";
import reopenHandler from "../api/manager-timecard-reopen.js";

const ORG_A="11111111-1111-4111-8111-111111111111";
const ORG_B="22222222-2222-4222-8222-222222222222";
const MANAGER="33333333-3333-4333-8333-333333333333";
const ALPHA="44444444-4444-4444-8444-444444444444";
const BETA="55555555-5555-4555-8555-555555555555";

function recorder(){
  return {statusCode:null,payload:null,setHeader(){},status(code){this.statusCode=code;return this;},json(value){this.payload=value;return this;}};
}
function installFixture(){
  const oldFetch=globalThis.fetch, oldEnv={...process.env};
  process.env.SUPABASE_URL="https://example.invalid";
  process.env.SUPABASE_SECRET_KEY="fixture-only-secret";
  const calls=[];
  globalThis.fetch=async (raw,options={})=>{
    const url=new URL(raw); calls.push({url:url.toString(),method:options.method||"GET"});
    const pathname=url.pathname;
    if(pathname.endsWith("/auth/v1/user"))return new Response(JSON.stringify({id:MANAGER,email:"alpha@example.invalid"}));
    if(pathname.endsWith("/user_roles"))return new Response(JSON.stringify(url.searchParams.get("select")==="role" ? [{role:"admin"}] : [{role:"admin",organization_id:ORG_A}]));
    if(pathname.endsWith("/organizations"))return new Response(JSON.stringify([{id:ORG_A}]));
    if(pathname.endsWith("/employees")){
      if(options.method && options.method!=="GET")throw new Error("Cross-company employee mutation reached database");
      if(url.searchParams.get("select")==="id,organization_id")return new Response(JSON.stringify([{id:ALPHA,organization_id:ORG_A}]));
      if(url.searchParams.has("is_active"))return new Response(JSON.stringify([{id:ALPHA,first_name:"Test",last_name:"Alpha",province:"ON"}]));
      return new Response(JSON.stringify([{id:ALPHA,first_name:"Test",last_name:"Alpha",organization_id:ORG_A}]));
    }
    if(pathname.endsWith("/overtime_rules"))return new Response("[]");
    if(pathname.endsWith("/punches")||pathname.endsWith("/timecard_approvals")){
      if(options.method && options.method!=="GET")throw new Error("Cross-company timecard mutation reached database");
      return new Response("[]");
    }
    throw new Error("Unexpected fixture request: "+pathname);
  };
  return {calls,restore(){globalThis.fetch=oldFetch;process.env=oldEnv;}};
}
function req(method,body={},query={}){
  return {method,body,query,headers:{authorization:"Bearer fixture-alpha-manager"}};
}
async function invoke(handler,request){
  const res=recorder();await handler(request,res);return res;
}

test("Alpha employee GET ignores a Beta ID and never returns Beta",async()=>{
  const fixture=installFixture();
  try{
    const res=await invoke(employeesHandler,req("GET",{}, {id:BETA}));
    assert.equal(res.statusCode,200);
    assert.deepEqual(res.payload.employees.map(e=>e.id),[ALPHA]);
    assert.equal(fixture.calls.some(c=>c.url.includes("employees?id=eq."+BETA)),false);
  }finally{fixture.restore();}
});

test("Alpha cannot update a Beta employee; no database write occurs",async()=>{
  const fixture=installFixture();
  try{
    const res=await invoke(employeesHandler,req("PATCH",{firstName:"Unauthorized"},{id:BETA}));
    assert.equal(res.statusCode,403);
    assert.equal(fixture.calls.some(c=>c.method!=="GET"),false);
  }finally{fixture.restore();}
});

test("Alpha cannot approve Beta or mixed Alpha/Beta timecard batches",async()=>{
  const fixture=installFixture();
  try{
    for(const ids of [[BETA],[ALPHA,BETA]]){
      const res=await invoke(approvalsHandler,req("POST",{employeeIds:ids,period:"2026-10-1"}));
      assert.equal(res.statusCode,403);
    }
    assert.equal(fixture.calls.some(c=>c.method!=="GET"),false);
  }finally{fixture.restore();}
});

test("Alpha cannot reopen Beta timecard; no approval write occurs",async()=>{
  const fixture=installFixture();
  try{
    const res=await invoke(reopenHandler,req("POST",{employeeId:BETA,period:"2026-10-1"}));
    assert.equal(res.statusCode,403);
    assert.equal(fixture.calls.some(c=>c.method!=="GET"),false);
  }finally{fixture.restore();}
});

test("Alpha manager timecards exclude Beta and query punches/approvals only for Alpha",async()=>{
  const fixture=installFixture();
  try{
    const res=await invoke(timecardsHandler,req("GET",{}, {period:"2026-10-1"}));
    assert.equal(res.statusCode,200);
    assert.deepEqual(res.payload.timecards.map(card=>card.employee.id),[ALPHA]);
    for(const call of fixture.calls.filter(c=>/\/(punches|timecard_approvals)\?/.test(c.url))){
      assert.equal(call.url.includes(ALPHA),true);
      assert.equal(call.url.includes(BETA),false);
    }
  }finally{fixture.restore();}
});
