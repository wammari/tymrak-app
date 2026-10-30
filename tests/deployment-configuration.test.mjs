import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {getPublicConfiguration,getSupabaseTarget} from '../api/_deployment-config.js';
import handler from '../api/public-config.js';
const staging={APP_ENV:'staging',VERCEL:'1',VERCEL_ENV:'production',SUPABASE_URL:'https://ctztwqcsizwkrqgpgrgg.supabase.co',SUPABASE_EXPECTED_PROJECT_REF:'ctztwqcsizwkrqgpgrgg',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SITE_URL:'https://tymrak-staging.vercel.app'};
test('staging and browser use validated target with no server key exposed',()=>{
 const config=getPublicConfiguration({...staging,SUPABASE_SECRET_KEY:'sb_secret_private'});
 assert.equal(config.supabaseUrl,staging.SUPABASE_URL);assert.doesNotMatch(JSON.stringify(config),/sb_secret/);
});
test('previews, missing environment and wrong staging project fail closed',()=>{
 for(const changes of [{APP_ENV:undefined},{APP_ENV:'development'},{APP_ENV:'production',VERCEL_ENV:'preview'},{SUPABASE_EXPECTED_PROJECT_REF:'other'},{SUPABASE_URL:'https://tsosredghislnehfyypi.supabase.co'}])
 assert.throws(()=>getSupabaseTarget({...staging,...changes}));
});
test('production requires explicit target and canonical site',()=>{
 const env={...staging,APP_ENV:'production',SUPABASE_URL:'https://tsosredghislnehfyypi.supabase.co',SUPABASE_EXPECTED_PROJECT_REF:'tsosredghislnehfyypi',SITE_URL:'https://app.tymrak.com'};
 assert.equal(getPublicConfiguration(env).supabaseUrl,env.SUPABASE_URL);
 assert.throws(()=>getPublicConfiguration({...env,SITE_URL:'https://tymrak-staging.vercel.app'}));
 assert.throws(()=>getPublicConfiguration({...env,SUPABASE_EXPECTED_PROJECT_REF:undefined}));
});
test('public endpoint does not reflect private values on failure',()=>{
 const old=process.env;process.env={...staging,SUPABASE_PUBLISHABLE_KEY:'sb_secret_private'};
 try {const res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;}};handler({method:'GET'},res);assert.equal(res.code,503);assert.doesNotMatch(JSON.stringify(res.body),/private/);}
 finally{process.env=old;}
});
test('all Auth pages use shared config and no embedded production credentials',()=>{
 for(const name of ['activate','employee','login','manager-login','manager','reset-password','timecard']) {
  const html=fs.readFileSync(new URL('../'+name+'.html',import.meta.url),'utf8');
  assert.match(html,/await loadSupabaseConfiguration\(\)/);assert.doesNotMatch(html,/tsosredghislnehfyypi|sb_publishable_/);
 }
 const html=fs.readFileSync(new URL('../activate.html',import.meta.url),'utf8');
 assert.ok(html.indexOf('window.history.replaceState')<html.indexOf('await loadSupabaseConfiguration()'));
});
test('release branch suppresses automatic Vercel Git deployment',()=>{
 const config=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 assert.equal(config.git.deploymentEnabled['fix/basic-clock-release'],false);
});
