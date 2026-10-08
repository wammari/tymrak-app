import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import handler from "../api/complete-activation.js";

const userId = "11111111-1111-4111-8111-111111111111";
const oldFetch = global.fetch;
const oldEnv = { ...process.env };
function recorder() {
  return { headers: {}, setHeader(k,v) { this.headers[k]=v; },
    status(code) { this.statusCode=code; return this; },
    json(body) { this.body=body; return this; } };
}
test.beforeEach(() => {
  process.env.SUPABASE_URL="https://example.supabase.co/";
  process.env.SUPABASE_SECRET_KEY="sb_secret_test";
});
test.afterEach(() => { global.fetch=oldFetch; process.env={...oldEnv}; });
async function call(outcome, options={}) {
  const calls=[];
  global.fetch=async (url, init) => {
    calls.push({url,init});
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify(options.user || {id:userId}), {status:options.authStatus || 200});
    assert.equal(url,"https://example.supabase.co/rest/v1/rpc/complete_employee_activation");
    assert.deepEqual(JSON.parse(init.body), {p_auth_user_id:userId});
    assert.equal(init.headers.apikey,process.env.SUPABASE_SECRET_KEY);
    if (process.env.SUPABASE_SECRET_KEY.startsWith("sb_secret_")) assert.equal(init.headers.Authorization,undefined);
    return new Response(JSON.stringify({outcome}), {status:options.rpcStatus || 200});
  };
  const res=recorder();
  await handler({method:"POST",headers:{authorization:"Bearer verified-session"},body:{auth_user_id:"attacker"}},res);
  return {res,calls};
}
test("successful activation uses the remotely verified Auth ID and secret apikey",async()=>{
  const {res,calls}=await call("activated");
  assert.equal(res.statusCode,200); assert.equal(res.body.success,true);
  assert.equal(res.body.alreadyActivated,false);
  assert.equal(calls[0].init.headers.Authorization,"Bearer verified-session");
  assert.equal(res.headers["Cache-Control"],"no-store");
});
test("legacy service-role JWT remains supported",async()=>{
  process.env.SUPABASE_SECRET_KEY="eyJ.legacy.jwt";
  const {calls}=await call("activated");
  assert.equal(calls[1].init.headers.Authorization,"Bearer eyJ.legacy.jwt");
});
test("already-activated account returns success without a direct employee PATCH",async()=>{
  const {res,calls}=await call("already_activated");
  assert.equal(res.statusCode,200); assert.equal(res.body.alreadyActivated,true);
  assert.equal(calls.length,2); assert.ok(calls.every(c=>c.init.method!=="PATCH"));
});
for (const [outcome,code] of [["missing",404],["duplicate",409]]) {
  test(outcome+" mapping fails closed",async()=>{
    const {res}=await call(outcome); assert.equal(res.statusCode,code);
    assert.equal(res.body.success,undefined);
  });
}
for (const authStatus of [401,403]) {
  test("invalid or expired session "+authStatus+" never reaches database",async()=>{
    const {res,calls}=await call("activated",{authStatus});
    assert.equal(res.statusCode,401); assert.equal(calls.length,1);
  });
}
test("missing/malformed authorization never performs a network request",async()=>{
  global.fetch=async()=>{throw new Error("must not fetch");};
  for (const authorization of [undefined,"","Basic value","Bearer "]) {
    const res=recorder(); await handler({method:"POST",headers:{authorization}},res);
    assert.equal(res.statusCode,401);
  }
});
test("Auth response without a valid UUID is rejected",async()=>{
  const {res,calls}=await call("activated",{user:{id:"untrusted"}});
  assert.equal(res.statusCode,401); assert.equal(calls.length,1);
});
test("database failure can be retried without changing account identity",async()=>{
  assert.equal((await call("activated",{rpcStatus:500})).res.statusCode,500);
  assert.equal((await call("already_activated")).res.statusCode,200);
});
test("unknown RPC result and Auth outage do not report success",async()=>{
  assert.equal((await call("unexpected")).res.statusCode,500);
  assert.equal((await call("activated",{authStatus:503})).res.statusCode,500);
});

const html=fs.readFileSync(new URL("../activate.html",import.meta.url),"utf8");
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/import \{ createClient \} from\s*"[^"]+";/,"");
async function page({hash="#type=invite&access_token=invite-token&refresh_token=refresh",search="",failures=0,setError=null,userMismatch=false,updateError=null,sessionMissing=false}={}) {
  const elements=Object.fromEntries(["activationForm","activateButton","message","password","confirmPassword","passwordFields","activationDescription"]
    .map(id=>[id,{style:{},value:"correct-password",disabled:false,hidden:false,textContent:"",
      addEventListener(_,fn){this.submit=fn;}}]));
  let saves=0,completions=0,sets=0,verifies=0,config;
  const user={id:userId,invited_at:"2026-10-01T00:00:00Z"};
  const session={user,access_token:"invite-token"};
  const context={
    URLSearchParams,document:{getElementById:id=>elements[id],title:"Activate"},
    window:{location:{search,hash,pathname:"/activate.html"},history:{replaceState(){}}},
    createClient(_url,_key,options){config=options;return{auth:{
      async setSession(){sets++;return{error:setError,data:{session}};},
      async verifyOtp(){verifies++;return{data:{session}};},
      async getUser(){return{data:{user:userMismatch?{...user,id:"different"}:user}};},
      async getSession(){return{data:{session:sessionMissing?null:session}};},
      async updateUser(){saves++;return{error:updateError,data:{user}};}
    }};},
    async fetch(){completions++;return new Response(JSON.stringify(completions<=failures?
      {error:"<img src=x onerror=alert(1)>"}:{success:true}),{status:completions<=failures?500:200});}
  };
  vm.runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,config,stats:()=>({saves,completions,sets,verifies}),
    submit:()=>elements.activationForm.submit({preventDefault(){}})};
}
test("valid invitation saves password then completes activation",async()=>{
  const p=await page(); await p.submit();
  assert.deepEqual(p.stats(),{saves:1,completions:1,sets:1,verifies:0});
  assert.equal(p.elements.activationForm.style.display,"none");
  assert.match(p.elements.message.textContent,/successfully/);
});
test("completion retry never saves password again and safely renders server errors",async()=>{
  const p=await page({failures:1}); await p.submit();
  assert.equal(p.elements.activateButton.textContent,"Retry Activation Completion");
  assert.equal(p.elements.password.disabled,true);
  assert.equal(p.elements.passwordFields.hidden,true);
  assert.equal(p.elements.password.value,"");
  assert.match(p.elements.message.textContent,/<img/);
  assert.equal(p.elements.message.innerHTML,undefined);
  await p.submit(); assert.equal(p.stats().saves,1); assert.equal(p.stats().completions,2);
});
test("failure obtaining session after password success still skips password on retry",async()=>{
  const p=await page({sessionMissing:true}); await p.submit(); await p.submit();
  assert.equal(p.stats().saves,1); assert.equal(p.stats().completions,0);
});
for(const values of [
  {hash:""},{hash:"#type=recovery&access_token=x&refresh_token=y"},
  {hash:"#error=access_denied&error_description=expired"},
  {hash:"#type=invite&access_token=x"},
  {hash:"",search:"?code=unrelated-code"}
]) {
  test("unrelated saved session or invalid callback is not invitation proof "+JSON.stringify(values),async()=>{
    const p=await page(values); await p.submit();
    assert.equal(p.elements.activationForm.style.display,"none");
    assert.equal(p.stats().sets,0); assert.equal(p.stats().saves,0); assert.equal(p.stats().completions,0);
    assert.equal(p.config.auth.persistSession,false);
    assert.equal(p.config.auth.detectSessionInUrl,false);
    assert.equal(p.config.auth.storageKey,"tymrak-invitation");
  });
}
test("expired invitation or mismatched identity cannot save a password",async()=>{
  for(const options of [{setError:new Error("expired")},{userMismatch:true}]) {
    const p=await page(options); await p.submit(); assert.equal(p.stats().saves,0);
  }
});
test("token-hash invitation template remains supported",async()=>{
  const p=await page({hash:"",search:"?type=invite&token_hash=hash"});
  await p.submit(); assert.equal(p.stats().verifies,1); assert.equal(p.stats().saves,1);
});
test("password failure permits another password attempt, not completion",async()=>{
  const p=await page({updateError:new Error("password rejected")});
  await p.submit(); assert.equal(p.stats().completions,0);
  assert.equal(p.elements.activateButton.textContent,"Activate My Account");
  assert.equal(p.elements.password.disabled,false);
});

