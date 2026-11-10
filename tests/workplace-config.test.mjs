import './_test-environment.mjs';import test from 'node:test';import assert from 'node:assert/strict';import handler,{validateWorkplace} from '../api/manager-workplaces.js';import {capturePunchLocation} from '../geolocation.js';import {createPunchClient} from '../punch-client.js';
const valid={id:null,name:'Office',address:'',latitude:43,longitude:-79,radiusMetres:150,isActive:true,employeeIds:[]};
test('manual workplace input rejects invalid coordinates, radii, empty names and bad assignments',()=>{
 assert.ok(validateWorkplace(valid));for(const patch of [{latitude:NaN},{latitude:91},{longitude:-181},{radiusMetres:0},{radiusMetres:5001},{name:' '},{employeeIds:['bad']},{id:'bad'},{isActive:'true'}])assert.equal(validateWorkplace({...valid,...patch}),null);
});
test('anonymous workplace request is rejected without database access',async()=>{
 const r={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};await handler({method:'GET',headers:{}},r);assert.equal(r.code,401);
});
test('GPS capture requests fresh high accuracy and maps permission denial',async()=>{
 const result=await capturePunchLocation({getCurrentPosition(ok,fail,options){assert.equal(options.maximumAge,0);assert.equal(options.enableHighAccuracy,true);ok({coords:{latitude:1,longitude:2,accuracy:3},timestamp:4});}});assert.deepEqual(result,{latitude:1,longitude:2,accuracyMetres:3,capturedAt:4});
 await assert.rejects(capturePunchLocation({getCurrentPosition(ok,fail){fail({code:1});}}),/Allow location/);
});
test('uncertain retries preserve request identity but never persist GPS',async()=>{
 const saved=new Map(),requests=[];let reading=0;
 const c=createPunchClient({request:async(_,b)=>{requests.push(b);return {ok:false,status:503,body:{}};},storage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},key:'test',randomUUID:()=>crypto.randomUUID(),captureLocation:async()=>({latitude:++reading})});
 await assert.rejects(c.record('clock_in',null));await assert.rejects(c.record('clock_out','2'));assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(requests[1].location.latitude,2);assert.doesNotMatch(saved.get('test'),/latitude|location/);
});
test('denied GPS does not leave a new unsent punch pending',async()=>{
 const data=new Map();let calls=0;const c=createPunchClient({request:async()=>{calls++;},storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},key:'x',randomUUID:()=>crypto.randomUUID(),captureLocation:async()=>{throw new Error('permission');}});
 await assert.rejects(c.record('clock_in',null),/permission/);assert.equal(c.pending,null);assert.equal(calls,0);
});
