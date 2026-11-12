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
