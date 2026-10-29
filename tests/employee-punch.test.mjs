import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/employee-punch.js";

const UUID = "11111111-1111-4111-8111-111111111111";
function res() { return { code: 0, data: null, setHeader(){}, status(n){this.code=n;return this;}, json(v){this.data=v;return this;} }; }
const payload = { punchType:"clock_in", requestId:UUID, expectedLastId:null,
  location:{latitude:43.3,longitude:-79.8,accuracy:15,capturedAt:Date.now()} };
function setup() {
  const oldFetch=globalThis.fetch, oldUrl=process.env.SUPABASE_URL, oldKey=process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL="https://fixture.invalid";process.env.SUPABASE_SECRET_KEY="sb_secret_fixture";
  const calls=[];
  globalThis.fetch=async (url,opts={})=>{
    calls.push({url:String(url),opts});
    if(String(url).endsWith("/auth/v1/user"))return new Response(JSON.stringify({id:UUID}));
    if(String(url).endsWith("/rpc/record_geofenced_punch"))return new Response(JSON.stringify({success:true,punch:{id:UUID}}));
    throw Error("Unexpected request");
  };
  return {calls,restore(){globalThis.fetch=oldFetch;
    if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;
    if(oldKey===undefined)delete process.env.SUPABASE_SECRET_KEY;else process.env.SUPABASE_SECRET_KEY=oldKey;}};
}
test("missing session cannot record punches",async()=>{
  const f=setup();try{const r=res();await handler({method:"POST",headers:{},body:payload},r);assert.equal(r.code,401);assert.equal(f.calls.length,0);}finally{f.restore();}
});
test("missing geolocation cannot bypass geofence",async()=>{
  const f=setup();try{const r=res();await handler({method:"POST",headers:{authorization:"Bearer fixture"},body:{...payload,location:null}},r);assert.equal(r.code,400);assert.equal(f.calls.length,0);}finally{f.restore();}
});
test("verified identity and geolocation are forwarded to geofenced RPC",async()=>{
  const f=setup();try{const r=res();await handler({method:"POST",headers:{authorization:"Bearer fixture"},body:{...payload,authUserId:"attacker"}},r);
    assert.equal(r.code,200);assert.equal(f.calls.length,2);
    const sent=JSON.parse(f.calls[1].opts.body);assert.equal(sent.p_auth_user_id,UUID);
    assert.equal(sent.p_location.latitude,43.3);\n    assert.equal(sent.p_location.accuracyMetres,15);\n    assert.equal(sent.p_location.capturedAt,payload.location.capturedAt);
    assert.ok(f.calls[1].url.endsWith("/rpc/record_geofenced_punch"));
    assert.equal(f.calls[1].opts.headers.apikey,"sb_secret_fixture");
    assert.equal(f.calls[1].opts.headers.Authorization,undefined);
  }finally{f.restore();}
});
