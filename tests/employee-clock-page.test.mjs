import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createPunchClient} from '../punch-client.js';
import {businessHeaders} from '../employee-business.js';
const html=fs.readFileSync(new URL('../employee.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g,'');
async function page({lastType='clock_in',postFailure=false,businesses=[{employee_id:'employee',company_name:'Shop',activated:true}],chosen='first'}={}) {
 const elements=new Map();
 function element(){return {style:{},className:'',textContent:'',disabled:false,children:[],addEventListener(k,v){this[k]=v;},appendChild(x){this.children.push(x);},querySelectorAll(){return this.children;},replaceChildren(...x){this.children=x;},set innerHTML(x){this.children=[];this.html=x;},get innerHTML(){return this.html;}};}
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 let type=lastType,id='1',posts=0;const requests=[],picker=[],switchers=[];
 const memory=new Map();
 const context={document:{getElementById:get,createElement:element,querySelector:()=>element()},createPunchClient,mountAccountDeletion(){},
 loadMyBusinesses:async()=>businesses,chosenBusiness:list=>chosen==='none'?null:list?.[0]||null,businessHeaders,
 clearReminders:async()=>"unsupported",mountReminderSetting:()=>null,remindersPlugin:()=>null,syncReminders:async()=>"unsupported",showBusinessPicker:(_,list)=>picker.push(list),businessSwitcher:(list)=>{switchers.push(list);return null;},capturePunchLocation:async()=>({latitude:43,longitude:-79,accuracyMetres:5,capturedAt:Date.now()}),
 loadSupabaseConfiguration:async()=>({supabaseUrl:'https://example.supabase.co'}),
 localStorage:{getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},
 crypto,console,setInterval(){},window:{location:{}},
 createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'session',user:{id:'user'}}}})},
 from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:{id:'employee',first_name:'Test',is_active:true,invitation_status:'Account Activated'}})})}),
 fetch:async(_,init)=>{
  requests.push(init.headers);
  if(init.method==='POST') {posts++;if(postFailure)throw new Error('lost response');type=JSON.parse(init.body).punchType;id='2';return Response.json({success:true});}
  return Response.json({lastPunch:{id,punch_type:type,punched_at:'2026-10-21T23:00:00Z'},
   punches:[{id,punch_type:type,punched_at:'2026-10-21T23:00:00Z'}],timeZone:'America/Toronto',workDate:'2026-10-23'});
 }};
 await vm.runInNewContext('(async()=>{'+script+'})()',context);
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 return {get,posts:()=>posts,requests,picker,switchers};
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

test('someone with two businesses who has not chosen sees the picker and nothing is clocked',async()=>{
 const two=[{employee_id:'employee',company_name:'I Care Pharmacy',activated:true},{employee_id:'other',company_name:'Al Zaeem Shawrma',activated:true}];
 const p=await page({businesses:two,chosen:'none'});
 assert.equal(p.picker.length,1);assert.equal(p.picker[0].length,2);
 assert.equal(p.requests.length,0,'no punch request before a business is chosen');
 assert.equal(p.get('welcome').textContent,'Choose your business');
});
test('after choosing, every punch request names the chosen business',async()=>{
 const two=[{employee_id:'employee',company_name:'I Care Pharmacy',activated:true},{employee_id:'other',company_name:'Al Zaeem Shawrma',activated:true}];
 const p=await page({businesses:two});
 assert.equal(p.get('workStatus').textContent,'Working');
 assert.ok(p.requests.length>0);
 for(const headers of p.requests)assert.equal(headers['x-tymrak-employee-id'],'employee');
 assert.equal(p.switchers.length,1,'a switcher is offered');
});
