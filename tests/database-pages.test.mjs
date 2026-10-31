import test from 'node:test';import assert from 'node:assert/strict';
import {databaseRows} from '../api/_database-pages.js';
test('reporting loads all pages despite a lower server row cap and preserves company scope and ordering',async()=>{
 const data=Array.from({length:1205},(_,id)=>({id}));const calls=[];
 const result=await databaseRows('https://db.example/rest/v1/punches?employee_id=eq.owned&order=punched_at.asc,id.asc',{},async(url,options)=>{
  const u=new URL(url),offset=Number(u.searchParams.get('offset'));calls.push(offset);
  assert.equal(u.searchParams.get('employee_id'),'eq.owned');assert.equal(u.searchParams.get('order'),'punched_at.asc,id.asc');assert.equal(options.headers.Prefer,'count=exact');
  const rows=data.slice(offset,offset+100);
  return new Response(JSON.stringify(rows),{headers:{'content-range':`${offset}-${offset+rows.length-1}/${data.length}`}});
 });
 assert.deepEqual(result,data);assert.equal(calls.length,13);
});
test('reporting rejects absent counts, empty truncated pages, oversized results and changing totals',async()=>{
 for(const [body,range] of [[[],null],[[],'*/12'],[[],'*/100001']])
  await assert.rejects(databaseRows('https://db.example/rest/v1/punches',{},async()=>new Response(JSON.stringify(body),{headers:range?{'content-range':range}:{}})));
 let count=0;
 await assert.rejects(databaseRows('https://db.example/rest/v1/punches',{},async()=>new Response('[{"id":1}]',{headers:{'content-range':`0-0/${++count+2}`}})),/changed/);
});
test('a later page failure propagates instead of returning partial payroll data',async()=>{
 let count=0;
 await assert.rejects(databaseRows('https://db.example/rest/v1/punches',{},async()=>++count===1
  ?new Response('[{"id":1}]',{headers:{'content-range':'0-0/2'}})
  :new Response('unavailable',{status:503})),e=>e.response.status===503);
});
