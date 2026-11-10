import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorker} from '../cloudflare/adapter.mjs';
import worker from '../cloudflare/worker.mjs';
import {buildAssets} from '../cloudflare/build-assets.mjs';
import {publicAssets} from '../cloudflare/public-assets.mjs';
import {getSiteUrl} from '../api/_deployment-config.js';

const settings = {APP_ENV:'staging', CLOUDFLARE_RELEASE_ENV:'staging',
  SUPABASE_URL:'https://ctztwqcsizwkrqgpgrgg.supabase.co',
  SUPABASE_EXPECTED_PROJECT_REF:'ctztwqcsizwkrqgpgrgg',
  SUPABASE_SECRET_KEY:'sb_secret_test', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',
  SITE_URL:'https://tymrak-staging.test-account.workers.dev'};
async function configured(run) {
  const old=process.env; process.env={...settings};
  try {await run({...settings});} finally {process.env=old;}
}
function request(path, options) { return new Request('https://tymrak-staging.test-account.workers.dev'+path, options); }

test('Worker preserves authorization, duplicate queries, parsed JSON, status and headers',()=>configured(async env=>{
  const w=createWorker({'/api/test':async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer verified-later');
    assert.deepEqual(req.query.period,['a','b']); assert.equal(req.body.employeeId,'owned');
    res.setHeader('Allow','POST'); res.status(409).json({error:'conflict'});
  }});
  const result=await w.fetch(request('/api/test?period=a&period=b',{method:'POST',
    headers:{Authorization:'Bearer verified-later','Content-Type':'application/json'},body:'{"employeeId":"owned"}'}),env);
  assert.equal(result.status,409); assert.equal(result.headers.get('allow'),'POST');
  assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual(await result.json(),{error:'conflict'});
}));
test('real Worker public config and protected API routes keep existing authorization',()=>configured(async env=>{
  const config=await worker.fetch(request('/api/public-config'),env);
  assert.equal(config.status,200); const body=await config.json();
  assert.equal(body.siteUrl,settings.SITE_URL); assert.doesNotMatch(JSON.stringify(body),/sb_secret/);
  for(const path of ['employee-punch','employees','manager-session','manager-workplaces','manager-timecards',
    'manager-timecard-approvals','manager-timecard-reopen','send-invitation','resend-invitation',
    'complete-activation','workplace-map-config']) {
    const res=await worker.fetch(request('/api/'+path,{method:path==='complete-activation'?'POST':'GET'}),env);
    assert.ok([401,405].includes(res.status),`${path}: ${res.status}`);
    assert.equal(res.headers.get('cache-control'),'no-store');
  }
}));
test('Worker rejects malformed, non-JSON and oversized streamed bodies before handlers',()=>configured(async env=>{
  let called=false;const w=createWorker({'/api/test':()=>{called=true;}});
  for(const [body,type,status] of [['{','application/json',400],['{}','text/plain',415],['x'.repeat(131073),'application/json',413]]) {
    const res=await w.fetch(request('/api/test',{method:'POST',headers:{'Content-Type':type},body}),env);
    assert.equal(res.status,status);
  }
  assert.equal(called,false);
}));
test('unknown/private endpoints and exceptions never expose source or secrets',()=>configured(async env=>{
  for(const path of ['/api/_manager-auth.js','/api/__proto__','/api/employee-punch.js'])
    assert.equal((await worker.fetch(request(path),env)).status,404);
  const w=createWorker({'/api/test':()=>{throw new Error(settings.SUPABASE_SECRET_KEY);}});
  const res=await w.fetch(request('/api/test'),env);assert.equal(res.status,500);
  assert.doesNotMatch(await res.text(),/sb_secret/);
}));
test('staging Worker refuses production, missing bindings and runtime/binding target mismatch',()=>configured(async env=>{
  for(const changes of [{APP_ENV:'production'},{CLOUDFLARE_RELEASE_ENV:undefined},
    {SUPABASE_URL:'https://tsosredghislnehfyypi.supabase.co'},
    {SUPABASE_EXPECTED_PROJECT_REF:'tsosredghislnehfyypi'},{SUPABASE_SECRET_KEY:'different'}])
    assert.equal((await worker.fetch(request('/api/public-config'),{...env,...changes})).status,503);
}));
test('Worker root and exact asset URLs use the asset binding',async()=>{
  const seen=[];const env={ASSETS:{fetch:async req=>{seen.push(new URL(req.url).pathname);return new Response('asset');}}};
  assert.equal(await (await worker.fetch(request('/'),env)).text(),'asset');
  await worker.fetch(request('/employee.html'),env);
  assert.deepEqual(seen,['/index.html','/employee.html']);
});
test('asset build publishes only allowlisted application assets and fails on missing files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tymrak-assets-'));const destination=join(root,'.cloudflare-assets');
  try {
    for(const name of publicAssets) await writeFile(join(root,name),'fixture');
    await mkdir(join(root,'api'));await writeFile(join(root,'api','secret.js'),'private');
    await writeFile(join(root,'.env'),'private');await writeFile(join(root,'backup.sql'),'private');
    await buildAssets(root,destination);
    assert.deepEqual((await readdir(destination)).sort(),[...publicAssets].sort());
    await rm(join(root,publicAssets[0]));await assert.rejects(buildAssets(root,destination));
    await assert.rejects(readdir(destination));
    await assert.rejects(buildAssets(root,root));
  } finally {await rm(root,{recursive:true,force:true});}
});
test('Cloudflare staging origins are explicit and production callback rules stay strict',()=>{
  assert.equal(getSiteUrl(settings),settings.SITE_URL);
  for(const site of ['https://other.account.workers.dev','https://tymrak-staging.account.workers.dev.evil.com',
    'https://tymrak-staging.account.workers.dev/path'])
    assert.throws(()=>getSiteUrl({...settings,SITE_URL:site}));
  assert.throws(()=>getSiteUrl({...settings,CLOUDFLARE_RELEASE_ENV:undefined}));
  assert.throws(()=>getSiteUrl({...settings,APP_ENV:'production'}));
});
