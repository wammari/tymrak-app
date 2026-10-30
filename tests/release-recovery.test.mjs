import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import './_test-environment.mjs';
import {getSupabaseConfiguration} from '../api/_manager-auth.js';

const source=fs.readFileSync(new URL('../reset-password.html',import.meta.url),'utf8')
 .match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g,'');
async function page({search='',hash='',event=null,identity='recovery-user',exchangeRecovery=false,otpError=null}={}) {
 const elements=Object.fromEntries(['form','message','resetButton','password','confirmPassword'].map(id=>[id,{style:{},value:'fixture-password',addEventListener(_,fn){this.click=fn;},after(){}}]));
 const links=[];let listener;let updates=0;let verified=0;let cleared=0;
 const auth={onAuthStateChange(fn){listener=fn;if(event)fn(event,{user:{id:'recovery-user'}});},
  verifyOtp:async()=>{verified++;return otpError?{error:otpError}:{data:{session:{user:{id:'recovery-user'}}}};},
  exchangeCodeForSession:async()=>{if(exchangeRecovery)listener('PASSWORD_RECOVERY',{user:{id:'recovery-user'}});return {data:{session:{user:{id:'recovery-user'}}}};},
  getUser:async()=>({data:{user:{id:identity}}}),
  updateUser:async()=>{updates++;return {data:{user:{id:identity}}};}};
 const context={URL,URLSearchParams,console:{log(){},error(){}},
  window:{location:{search,hash,pathname:'/reset-password.html'},history:{replaceState(){cleared++;}}},
  loadSupabaseConfiguration:async()=>({supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'sb_publishable_fixture'}),
  document:{title:'Reset',getElementById:id=>elements[id],createElement:()=>{const link={after(){}};links.push(link);return link;}},
  createClient:()=>({auth})};
 await vm.runInNewContext('(async()=>{'+source+'})()',context);
 return {elements,links,submit:()=>elements.resetButton.click(),state:()=>({updates,verified,cleared})};
}

test('normal sign-in and normal PKCE exchange do not authorize password reset',async()=>{
 for(const options of [{event:'SIGNED_IN'},{search:'?code=normal-login'}]){
  const p=await page(options);await p.submit();assert.equal(p.state().updates,0);
 }
});
test('verified recovery token hash resets the same identity and offers both portal links',async()=>{
 const p=await page({search:'?token_hash=fixture&type=recovery'});await p.submit();
 assert.equal(p.state().verified,1);assert.equal(p.state().updates,1);assert.ok(p.state().cleared>0);
 assert.deepEqual(p.links.map(x=>x.href),['/login.html','/manager-login.html']);
});
test('PKCE recovery event authorizes reset while expired tokens do not',async()=>{
 const good=await page({search:'?code=recovery',exchangeRecovery:true});await good.submit();assert.equal(good.state().updates,1);
 const expired=await page({search:'?token_hash=expired&type=recovery',otpError:{message:'Expired'}});await expired.submit();assert.equal(expired.state().updates,0);
});
test('changing authenticated identity after recovery prevents the password write',async()=>{
 const p=await page({event:'PASSWORD_RECOVERY',identity:'another-user'});await p.submit();
 assert.equal(p.state().updates,0);assert.match(p.elements.message.textContent,/mismatch/);
});
test('manager auth uses the configured publishable key and fails closed without it',()=>{
 const saved={...process.env};
 try{
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_fixture';
  process.env.SUPABASE_PUBLISHABLE_KEY='sb_publishable_fixture';
  assert.equal(getSupabaseConfiguration().publishableKey,'sb_publishable_fixture');
  delete process.env.SUPABASE_PUBLISHABLE_KEY;assert.equal(getSupabaseConfiguration(),null);
 }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});

test('manager password recovery uses its deployment callback rather than production in staging',async()=>{
 const managerSource=fs.readFileSync(new URL('../manager-login.html',import.meta.url),'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g,'');
 const elements=Object.fromEntries(['loginForm','loginButton','message','forgotPassword','email'].map(id=>[id,{style:{},value:'fixture@example.invalid',addEventListener(_,fn){this.click=fn;}}]));
 let request;
 await vm.runInNewContext('(async()=>{'+managerSource+'})()',{
  URL,loadSupabaseConfiguration:async()=>({supabaseUrl:'https://staging.supabase.co',supabasePublishableKey:'sb_publishable_fixture',siteUrl:'https://tymrak-staging.example.vercel.app'}),
  document:{getElementById:id=>elements[id]},createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),resetPasswordForEmail:async(...args)=>{request=args;return {};}}})
 });
 await elements.forgotPassword.click({preventDefault(){}});
 assert.equal(request[1].redirectTo,'https://tymrak-staging.example.vercel.app/reset-password.html');
 assert.match(elements.message.textContent,/If this email is registered/);
});
