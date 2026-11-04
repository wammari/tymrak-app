import test from 'node:test';import assert from 'node:assert/strict';
import worker from '../cloudflare/production-worker.mjs';import staging from '../cloudflare/worker.mjs';
const settings={APP_ENV:'production',CLOUDFLARE_RELEASE_ENV:'production',SITE_URL:'https://app.tymrak.com',SUPABASE_URL:'https://tsosredghislnehfyypi.supabase.co',SUPABASE_EXPECTED_PROJECT_REF:'tsosredghislnehfyypi',SUPABASE_SECRET_KEY:'sb_secret_fake',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',TYMRAK_RELEASE_READY:'true'};
const request=()=>new Request('https://app.tymrak.com/api/public-config');
async function configured(fn){const old=process.env;process.env={...settings};try{await fn({...settings})}finally{process.env=old}}
test('production entry point returns only public config for the pinned production target',()=>configured(async env=>{
 const response=await worker.fetch(request(),env);assert.equal(response.status,200);const config=await response.json();assert.equal(config.environment,'production');assert.equal(config.siteUrl,'https://app.tymrak.com');assert.equal(config.supabaseUrl,settings.SUPABASE_URL);assert.doesNotMatch(JSON.stringify(config),/sb_secret/);
}));
test('production refuses release hold, staging, missing secrets, wrong origin and runtime mismatch',()=>configured(async env=>{
 for(const change of [{TYMRAK_RELEASE_READY:'false'},{TYMRAK_RELEASE_READY:undefined},{APP_ENV:'staging'},{CLOUDFLARE_RELEASE_ENV:'staging'},{SUPABASE_URL:'https://ctztwqcsizwkrqgpgrgg.supabase.co'},{SUPABASE_EXPECTED_PROJECT_REF:'ctztwqcsizwkrqgpgrgg'},{SITE_URL:'https://tymrak-production.example.workers.dev'},{SUPABASE_SECRET_KEY:undefined},{SUPABASE_PUBLISHABLE_KEY:undefined},{SUPABASE_PUBLISHABLE_KEY:'sb_publishable_different'}])assert.equal((await worker.fetch(request(),{...env,...change})).status,503,JSON.stringify(change));
}));
test('staging entry point cannot be repointed to production by dashboard settings',()=>configured(async env=>assert.equal((await staging.fetch(request(),env)).status,503)));
