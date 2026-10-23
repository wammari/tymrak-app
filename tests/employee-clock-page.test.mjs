import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createPunchClient} from '../punch-client.js';
const html=fs.readFileSync(new URL('../employee.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g,'');
async function page({lastType='clock_in',postFailure=false}={}) {
 const elements=new Map();
 function element(){return {style:{},className:'',textContent:'',disabled:false,children:[],addEventListener(k,v){this[k]=v;},appendChild(x){this.children.push(x);},querySelectorAll(){return this.children;},replaceChildren(...x){this.children=x;},set innerHTML(x){this.children=[];this.html=x;},get innerHTML(){return this.html;}};}
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 let type=lastType,id='1',posts=0;
 const memory=new Map();
 const context={document:{getElementById:get,createElement:element},createPunchClient,capturePunchLocation:async()=>({latitude:43,longitude:-79,accuracyMetres:5,capturedAt:Date.now()}),
 loadSupabaseConfiguration:async()=>({supabaseUrl:'https://example.supabase.co'}),
 localStorage:{getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},
 crypto,console,setInterval(){},window:{location:{}},
 createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'session',user:{id:'user'}}}})},
 from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:{id:'employee',first_name:'Test',is_active:true,invitation_status:'Account Activated'}})})}),
 fetch:async(_,init)=>{
  if(init.method==='POST') {posts++;if(postFailure)throw new Error('lost response');type=JSON.parse(init.body).punchType;id='2';return Response.json({success:true});}
  return Response.json({lastPunch:{id,punch_type:type,punched_at:'2026-10-21T23:00:00Z'},
   punches:[{id,punch_type:type,punched_at:'2026-10-21T23:00:00Z'}],timeZone:'America/Toronto',workDate:'2026-10-23'});
 }};
 await vm.runInNewContext('(async()=>{'+script+'})()',context);
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 return {get,posts:()=>posts};
}
test('overnight refresh keeps Clock Out available using server state',async()=>{
 const p=await page();assert.equal(p.get('workStatus').textContent,'Working');
 const button=p.get('buttonArea').children.find(b=>b.textContent==='Clock Out');assert.ok(button);await button.click();
 assert.equal(p.posts(),1);assert.equal(p.get('workStatus').textContent,'Not Clocked In');
 assert.match(p.get('message').textContent,/recorded successfully/);assert.equal(p.get('message').style.display,'block');
});
test('lost response replaces action buttons with retry of original request',async()=>{
 const p=await page({lastType:'clock_out',postFailure:true});await p.get('buttonArea').children[0].click();
 assert.equal(p.get('buttonArea').children.length,1);assert.equal(p.get('buttonArea').children[0].textContent,'Retry Unconfirmed Punch');
});
