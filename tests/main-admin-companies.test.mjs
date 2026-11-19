import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/main-admin-companies.js";

const ADMIN = "0bfba2af-ee44-47e5-ad08-d61a98992f55";
const OTHER = "11111111-1111-4111-8111-111111111111";
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
function res() { return { statusCode:0, body:null, headers:{}, setHeader(k,v){this.headers[k]=v}, status(code){this.statusCode=code;return this}, json(body){this.body=body;return this} }; }
function json(body,status=200){return {ok:status>=200&&status<300,status,json:async()=>body};}
test.afterEach(()=>{global.fetch=originalFetch;process.env.SUPABASE_SECRET_KEY=originalEnv.SUPABASE_SECRET_KEY;process.env.TYMRAK_MAIN_ADMIN_AUTH_USER_ID=originalEnv.TYMRAK_MAIN_ADMIN_AUTH_USER_ID;});
function configure(){process.env.SUPABASE_URL="https://tsosredghislnehfyypi.supabase.co";process.env.SUPABASE_SECRET_KEY="sb_secret_local_test";process.env.TYMRAK_MAIN_ADMIN_AUTH_USER_ID=ADMIN;}
test("company management fails closed without designated administrator",async()=>{
 configure();delete process.env.TYMRAK_MAIN_ADMIN_AUTH_USER_ID;
 let called=false;global.fetch=async()=>{called=true;throw Error("unexpected network")};
 const response=res();await handler({method:"GET",headers:{authorization:"Bearer token"}},response);
 assert.equal(response.statusCode,503);assert.equal(called,false);
});
test("non-designated authenticated users cannot list or create businesses",async()=>{
 configure();let calls=0;global.fetch=async()=>{calls++;return json({id:OTHER})};
 for(const method of ["GET","POST"]){const response=res();await handler({method,headers:{authorization:"Bearer token"},body:{name:"Other Company"}},response);assert.equal(response.statusCode,403);}
 assert.equal(calls,2);
});
test("designated administrator still requires database administrator membership",async()=>{
 configure();global.fetch=async url=>String(url).includes("/auth/v1/user")?json({id:ADMIN}):json([]);
 const response=res();await handler({method:"GET",headers:{authorization:"Bearer token"}},response);
 assert.equal(response.statusCode,403);
});
test("authorized main administrator can list companies without modifying data",async()=>{
 configure();const calls=[];global.fetch=async(url,options={})=>{
 calls.push([String(url),options.method||"GET"]);
 if(String(url).includes("/auth/v1/user"))return json({id:ADMIN});
 if(String(url).includes("/user_roles?"))return json([{organization_id:OTHER}]);
 if(String(url).includes("/organizations?"))return json([{id:OTHER,name:"Example Business",is_active:true}]);
 throw Error("unexpected request");
 };
 const response=res();await handler({method:"GET",headers:{authorization:"Bearer token"}},response);
 assert.equal(response.statusCode,200);assert.equal(response.body.companies[0].name,"Example Business");assert.ok(calls.every(([,method])=>method==="GET"));
});
test("company name validation blocks writes before database mutation",async()=>{
 configure();let writes=0;global.fetch=async(url,options={})=>{
 if(options.method==="POST")writes++;
 if(String(url).includes("/auth/v1/user"))return json({id:ADMIN});
 return json([{organization_id:OTHER}]);
 };
 const response=res();await handler({method:"POST",headers:{authorization:"Bearer token"},body:{name:" "}},response);
 assert.equal(response.statusCode,400);assert.equal(writes,0);
});

test("inactive administrator membership is rejected",async()=>{
 configure();global.fetch=async url=>{
  if(String(url).includes("/auth/v1/user"))return json({id:ADMIN});
  if(String(url).includes("/user_roles?"))return json([{organization_id:OTHER}]);
  if(String(url).includes("/organizations?"))return json([]);
  throw Error("unexpected request");
 };
 const response=res();await handler({method:"GET",headers:{authorization:"Bearer token"}},response);
 assert.equal(response.statusCode,403);
});
test("main administrator creates a company and receives admin membership",async()=>{
 configure();const createdId="22222222-2222-4222-8222-222222222222";const writes=[];
 global.fetch=async(url,options={})=>{
  const u=String(url);
  if(u.includes("/auth/v1/user"))return json({id:ADMIN});
  if(u.includes("/user_roles?"))return json([{organization_id:OTHER}]);
  if(u.includes("/organizations?")&&u.includes("is_active=eq.true"))return json([{id:OTHER}]);
  if(u.includes("/organizations?"))return json([]);
  if(u.endsWith("/rpc/create_company_with_admin")&&options.method==="POST"){writes.push(JSON.parse(options.body));return json([{id:createdId,name:"New Bakery",is_active:true}]);}
  throw Error("unexpected request: "+u);
 };
 const response=res();await handler({method:"POST",headers:{authorization:"Bearer token"},body:{name:"New Bakery",payFrequency:"semi_monthly"}},response);
 assert.equal(response.statusCode,201);assert.equal(response.body.company.id,createdId);
 assert.deepEqual(writes,[{p_name:"New Bakery",p_pay_frequency:"semi_monthly",p_pay_period_anchor:null,p_admin_user_id:ADMIN}]);
});
test("duplicate company name blocks creation",async()=>{
 configure();let writes=0;global.fetch=async(url,options={})=>{
  if(options.method==="POST")writes++;
  const u=String(url);
  if(u.includes("/auth/v1/user"))return json({id:ADMIN});
  if(u.includes("/user_roles?"))return json([{organization_id:OTHER}]);
  if(u.includes("is_active=eq.true"))return json([{id:OTHER}]);
  if(u.includes("name=ilike."))return json([{id:OTHER}]);
  throw Error("unexpected request: "+u);
 };
 const response=res();await handler({method:"POST",headers:{authorization:"Bearer token"},body:{name:"Existing Business",payFrequency:"monthly"}},response);
 assert.equal(response.statusCode,409);assert.equal(writes,0);
});

function creationFetch(writes,createdId,failCreation=false){
 return async(url,options={})=>{
  const u=String(url);
  if(u.includes("/auth/v1/user"))return json({id:ADMIN});
  if(u.includes("/user_roles?"))return json([{organization_id:OTHER}]);
  if(u.includes("/organizations?")&&u.includes("is_active=eq.true"))return json([{id:OTHER}]);
  if(u.includes("/organizations?"))return json([]);
  if(u.endsWith("/rpc/create_company_with_admin")&&options.method==="POST"){writes.push(JSON.parse(options.body));return failCreation?json({message:"permission denied"},403):json([{id:createdId,name:"Weekly Cafe",is_active:true}]);}
  if(options.method==="POST")throw Error("company creation must be a single database call: "+u);
  throw Error("unexpected request: "+u);
 };
}
test("a weekly company is created with its first pay period start date",async()=>{
 configure();const writes=[];global.fetch=creationFetch(writes,"33333333-3333-4333-8333-333333333333");
 const response=res();await handler({method:"POST",headers:{authorization:"Bearer token"},body:{name:"Weekly Cafe",payFrequency:"weekly",payPeriodAnchor:"2026-11-02"}},response);
 assert.equal(response.statusCode,201);
 assert.deepEqual(writes[0],{p_name:"Weekly Cafe",p_pay_frequency:"weekly",p_pay_period_anchor:"2026-11-02",p_admin_user_id:ADMIN});
});
test("a company cannot be created without a valid pay schedule",async()=>{
 for(const body of [{name:"No Schedule"},{name:"Bad Schedule",payFrequency:"fortnightly"},{name:"No Start",payFrequency:"biweekly"},{name:"Bad Start",payFrequency:"weekly",payPeriodAnchor:"2026-02-30"}]){
  configure();const writes=[];global.fetch=creationFetch(writes,"44444444-4444-4444-8444-444444444444");
  const response=res();await handler({method:"POST",headers:{authorization:"Bearer token"},body},response);
  assert.equal(response.statusCode,400,body.name);assert.equal(writes.length,0,body.name);
 }
});
test("a monthly company ignores a stray start date",async()=>{
 configure();const writes=[];global.fetch=creationFetch(writes,"55555555-5555-4555-8555-555555555555");
 const response=res();await handler({method:"POST",headers:{authorization:"Bearer token"},body:{name:"Monthly Shop",payFrequency:"monthly",payPeriodAnchor:"2026-11-02"}},response);
 assert.equal(response.statusCode,201);assert.equal(writes[0].p_pay_period_anchor,null);
});

test("if the database refuses, the admin is told nothing was saved and can retry",async()=>{
 configure();const writes=[];global.fetch=creationFetch(writes,"66666666-6666-4666-8666-666666666666",true);
 const response=res();await handler({method:"POST",headers:{authorization:"Bearer token"},body:{name:"Refused Co",payFrequency:"monthly"}},response);
 assert.equal(response.statusCode,502);assert.match(response.body.error,/Nothing was saved/);assert.doesNotMatch(response.body.error,/Do not retry/);
});

// ---- Changing a pay schedule ----------------------------------------------------------
import { todayKey } from "../api/_pay-schedule.js";
const COMPANY = "77777777-7777-4777-8777-777777777777";
function firstOfMonthAhead(months){const d=new Date(`${todayKey().slice(0,7)}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()+months);return d.toISOString().slice(0,10);}
function scheduleFetch(calls,{company={id:COMPANY,pay_frequency:"semi_monthly",pay_period_anchor:null,pay_schedule_changes:[]},change,cancel=true,refusal}={}){
 return async(url,options={})=>{
  const u=String(url);calls.push([u,options.method||"GET",options.body?JSON.parse(options.body):null]);
  if(u.includes("/auth/v1/user"))return json({id:ADMIN});
  if(u.includes("/user_roles?"))return json([{organization_id:OTHER}]);
  if(u.includes("/organizations?")&&u.includes("is_active=eq.true"))return json([{id:OTHER}]);
  if(u.includes(`/organizations?id=eq.${COMPANY}`))return json(company?[company]:[]);
  if(u.endsWith("/rpc/change_company_pay_schedule"))return refusal?json(refusal,400):json([change]);
  if(u.endsWith("/rpc/cancel_pay_schedule_change"))return json(cancel);
  throw Error("unexpected request: "+u);
 };
}
const rpcCalls=calls=>calls.filter(([u])=>u.includes("/rpc/"));

test("the Main Administrator schedules a change from a future 1st of the month",async()=>{
 configure();const calls=[];const from=firstOfMonthAhead(2);
 global.fetch=scheduleFetch(calls,{change:{id:9,organization_id:COMPANY,pay_frequency:"biweekly",pay_period_anchor:from,effective_from:from}});
 const response=res();await handler({method:"PATCH",headers:{authorization:"Bearer token"},body:{companyId:COMPANY,payFrequency:"biweekly",effectiveFrom:from}},response);
 assert.equal(response.statusCode,200);
 assert.deepEqual(rpcCalls(calls)[0][2],{p_organization_id:COMPANY,p_pay_frequency:"biweekly",p_effective_from:from,p_changed_by:ADMIN});
 assert.equal(response.body.paySchedule.frequency,"semi_monthly","the current schedule is unchanged until the change starts");
 assert.equal(response.body.paySchedule.upcomingChange.effectiveFrom,from);
});

test("changes that would move a started or misaligned period never reach the database",async()=>{
 const from=firstOfMonthAhead(2);
 for(const body of [
  {companyId:COMPANY,payFrequency:"biweekly",effectiveFrom:todayKey()},
  {companyId:COMPANY,payFrequency:"monthly",effectiveFrom:from.slice(0,8)+"02"},
  {companyId:COMPANY,payFrequency:"semi_monthly",effectiveFrom:from},
  {companyId:COMPANY,payFrequency:"fortnightly",effectiveFrom:from},
  {companyId:"not-a-company",payFrequency:"monthly",effectiveFrom:from}
 ]){
  configure();const calls=[];global.fetch=scheduleFetch(calls);
  const response=res();await handler({method:"PATCH",headers:{authorization:"Bearer token"},body},response);
  assert.equal(response.statusCode,400,JSON.stringify(body));assert.equal(rpcCalls(calls).length,0,JSON.stringify(body));
 }
});

test("only one change can wait at a time",async()=>{
 configure();const calls=[];const waiting=firstOfMonthAhead(2);
 global.fetch=scheduleFetch(calls,{company:{id:COMPANY,pay_frequency:"semi_monthly",pay_period_anchor:null,pay_schedule_changes:[{id:3,pay_frequency:"monthly",pay_period_anchor:null,effective_from:waiting}]}});
 const response=res();await handler({method:"PATCH",headers:{authorization:"Bearer token"},body:{companyId:COMPANY,payFrequency:"biweekly",effectiveFrom:firstOfMonthAhead(4)}},response);
 assert.equal(response.statusCode,400);assert.match(response.body.error,/Cancel it first/);assert.equal(rpcCalls(calls).length,0);
});

test("the database's reason is shown when it refuses a change",async()=>{
 configure();const calls=[];
 global.fetch=scheduleFetch(calls,{refusal:{code:"23514",message:"This company already has a pay schedule change waiting to start. Cancel it first."}});
 const response=res();await handler({method:"PATCH",headers:{authorization:"Bearer token"},body:{companyId:COMPANY,payFrequency:"monthly",effectiveFrom:firstOfMonthAhead(2)}},response);
 assert.equal(response.statusCode,400);assert.match(response.body.error,/waiting to start/);
});

test("a waiting change can be cancelled; a started one cannot",async()=>{
 configure();let calls=[];global.fetch=scheduleFetch(calls,{cancel:true});
 let response=res();await handler({method:"DELETE",headers:{authorization:"Bearer token"},body:{companyId:COMPANY,changeId:9}},response);
 assert.equal(response.statusCode,200);assert.deepEqual(rpcCalls(calls)[0][2],{p_organization_id:COMPANY,p_change_id:9});
 configure();calls=[];global.fetch=scheduleFetch(calls,{cancel:false});
 response=res();await handler({method:"DELETE",headers:{authorization:"Bearer token"},body:{companyId:COMPANY,changeId:9}},response);
 assert.equal(response.statusCode,409);
 configure();calls=[];global.fetch=scheduleFetch(calls);
 response=res();await handler({method:"DELETE",headers:{authorization:"Bearer token"},body:{companyId:COMPANY,changeId:"x"}},response);
 assert.equal(response.statusCode,400);assert.equal(rpcCalls(calls).length,0);
});

test("only the Main Administrator can change or cancel a schedule",async()=>{
 configure();let calls=0;global.fetch=async()=>{calls++;return json({id:OTHER})};
 for(const method of ["PATCH","DELETE"]){const response=res();await handler({method,headers:{authorization:"Bearer token"},body:{companyId:COMPANY,payFrequency:"monthly",effectiveFrom:firstOfMonthAhead(2),changeId:1}},response);assert.equal(response.statusCode,403,method);}
 assert.equal(calls,2,"stops after checking who is signed in");
});

test("the company list shows each company's current schedule and any waiting change",async()=>{
 configure();const waiting=firstOfMonthAhead(2);
 global.fetch=async url=>{const u=String(url);
  if(u.includes("/auth/v1/user"))return json({id:ADMIN});
  if(u.includes("/user_roles?"))return json([{organization_id:OTHER}]);
  if(u.includes("is_active=eq.true"))return json([{id:OTHER}]);
  if(u.includes("/organizations?select="))return json([{id:COMPANY,name:"Test company",is_active:true,pay_frequency:"semi_monthly",pay_period_anchor:null,pay_schedule_changes:[{id:4,pay_frequency:"monthly",pay_period_anchor:null,effective_from:waiting}]}]);
  throw Error("unexpected request: "+u);};
 const response=res();await handler({method:"GET",headers:{authorization:"Bearer token"}},response);
 assert.equal(response.statusCode,200);
 const [company]=response.body.companies;
 assert.equal(company.paySchedule.frequency,"semi_monthly");assert.equal(company.paySchedule.upcomingChange.id,4);
 assert.equal(company.pay_schedule_changes,undefined);assert.equal(response.body.today,todayKey());
});
