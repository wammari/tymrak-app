import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
function source(name){return fs.readFileSync(new URL('../'+name+'.html',import.meta.url),'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g,'');}
test('recovery bridge rejects external and script destinations',async()=>{
 for(const url of ['javascript:alert(1)','https://evil.example/auth/v1/verify?type=recovery','https://example.supabase.co/auth/v1/verify?type=invite','https://example.supabase.co/auth/v1/verify?type=recovery&token=test']) {
  const button={style:{},addEventListener(_,fn){this.click=fn;}};
  const context={URL,URLSearchParams,loadSupabaseConfiguration:async()=>({supabaseUrl:'https://example.supabase.co'}),document:{getElementById:()=>button},window:{location:{search:'?recovery_url='+encodeURIComponent(url)}}};
  await vm.runInNewContext('(async()=>{'+source('password-recovery')+'})()',context);
  assert.equal(Boolean(button.click),url.endsWith('token=test'));
 }
});
test('password reset renders untrusted Auth error as text',async()=>{
 const elements=Object.fromEntries(['form','message','resetButton','password','confirmPassword'].map(id=>[id,{style:{},value:'test-password',addEventListener(_,fn){this.click=fn;},after(){}}]));
 let listener;
 const context={console,loadSupabaseConfiguration:async()=>({supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'sb_publishable_test'}),document:{getElementById:id=>elements[id],createElement:()=>({})},
 createClient:()=>({auth:{onAuthStateChange:fn=>listener=fn,updateUser:async()=>({error:{message:'<img src=x onerror=alert(1)>'}})}})};
 await vm.runInNewContext('(async()=>{'+source('reset-password')+'})()',context);
 listener('PASSWORD_RECOVERY',{user:{id:'user'}});await elements.resetButton.click();
 assert.equal(elements.message.textContent,'<img src=x onerror=alert(1)>');assert.equal(elements.message.innerHTML,undefined);
});
