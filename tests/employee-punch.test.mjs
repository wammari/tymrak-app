import './_test-environment.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import handler from '../api/employee-punch.js';
import {createPunchClient} from '../punch-client.js';
const user='11111111-1111-4111-8111-111111111111';
const original=global.fetch;
test.afterEach(()=>{global.fetch=original;});
function res(){return {setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;return this;}};}
function setup(){process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_test';}
function req(body,method='POST'){return {method,headers:{authorization:'Bearer session'},body};}
const body=()=>({requestId:crypto.randomUUID(),punchType:'clock_in',expectedLastId:null,employeeId:'attacker',punchedAt:'2099-01-01'});
test('API trusts only verified Auth ID and strips employee and timestamp input',async()=>{
 setup();let calls=0;global.fetch=async(url,init)=>{
  if(calls++===0) return Response.json({id:user});
  assert.deepEqual(JSON.parse(init.body),{p_auth_user_id:user,p_punch_type:'clock_in',p_request_id:b.requestId,p_expected_last_id:null});
  assert.equal(init.headers.Authorization,undefined);return Response.json({success:true});
 };const b=body(),r=res();await handler(req(b),r);assert.equal(r.code,200);
});
test('anonymous and malformed punches are rejected before network access',async()=>{
 setup();global.fetch=()=>{throw new Error('unexpected network')};
 const r=res();await handler({method:'POST',headers:{},body:body()},r);assert.equal(r.code,401);
 for(const b of [{...body(),requestId:'bad'},{...body(),expectedLastId:5},{...body(),punchType:'edit'}]) {
  const r=res();await handler(req(b),r);assert.equal(r.code,400);
 }
});
test('expired and malformed sessions never reach privileged RPC',async()=>{
 setup();for(const response of [new Response('',{status:401}),Response.json({id:'bad'})]) {
  let calls=0;global.fetch=async()=>{calls++;return response;};const r=res();await handler(req(body()),r);
  assert.equal(r.code,401);assert.equal(calls,1);
 }
});
test('API maps inactive employee, stale state, lock and outages safely',async()=>{
 setup();for(const [result,status,expected] of [[{error:'employee_unavailable'},200,403],[{error:'stale_state'},200,409],[{code:'P0001'},400,409],[{code:'XX000',message:'secret'},500,503]]) {
  let calls=0;global.fetch=async()=>calls++===0?Response.json({id:user}):Response.json(result,{status});
  const r=res();await handler(req(body()),r);assert.equal(r.code,expected);assert.doesNotMatch(JSON.stringify(r.body),/secret/);
 }
});
test('GET reads state through verified identity without accepting a body identity',async()=>{
 setup();let calls=0;global.fetch=async(url,init)=>{
  if(calls++===0)return Response.json({id:user});
  assert.deepEqual(JSON.parse(init.body),{p_auth_user_id:user});return Response.json({punches:[],lastPunch:null});
 };const r=res();await handler(req({employeeId:'attacker'},'GET'),r);assert.equal(r.code,200);
});
function storage(){const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
test('lost response and reload preserve original request until confirmed',async()=>{
 const local=storage(),requests=[];let attempts=0;
 const request=async(_,b)=>{requests.push({...b});if(attempts++===0)throw new Error('network');return {ok:true,status:200,body:{success:true}};};
 const options={request,storage:local,key:'employee',randomUUID:()=>crypto.randomUUID()};
 const a=createPunchClient(options);await assert.rejects(a.record('clock_in',null));
 const b=createPunchClient(options);assert.ok(b.pending);await b.record('clock_out','999');
 assert.deepEqual(requests[0],requests[1]);assert.equal(b.pending,null);assert.equal(local.getItem('employee'),undefined);
});
test('5xx preserves request, definitive stale-state rejection clears it',async()=>{
 let status=503;const c=createPunchClient({request:async()=>({ok:false,status,body:{error:'retry'}}),storage:storage(),key:'employee',randomUUID:()=>crypto.randomUUID()});
 await assert.rejects(c.record('clock_in',null));assert.ok(c.pending);
 status=409;await assert.rejects(c.record('clock_in',null));assert.equal(c.pending,null);
});
