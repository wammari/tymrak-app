// Uses fake credentials only. Runs client and local Worker in the same process tree.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const production=process.argv.includes('--production');
const siteUrl=production?'https://app.tymrak.com':'https://tymrak-staging.local-test.workers.dev';
const databaseUrl=production?'https://tsosredghislnehfyypi.supabase.co':'https://ctztwqcsizwkrqgpgrgg.supabase.co';
const server=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--local',...(production?['--config','wrangler.production.jsonc','--var','TYMRAK_RELEASE_READY:true']:[]),
  '--ip','127.0.0.1','--port','8787','--inspector-port','9229',
  '--var',`SITE_URL:${siteUrl}`,
  '--var','SUPABASE_PUBLISHABLE_KEY:sb_publishable_local_test',
  '--var','SUPABASE_SECRET_KEY:sb_secret_local_test'],{stdio:['ignore','pipe','pipe'],detached:true});
try {
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Local Worker startup timed out')),45000);
    server.on('error',error=>{clearTimeout(timeout);reject(error);});
    server.on('exit',code=>{clearTimeout(timeout);reject(new Error(`Local Worker exited: ${code}`));});
    server.stderr.on('data',()=>{});
    server.stdout.on('data',data=>{
      if(data.toString().includes('Ready on http://127.0.0.1:8787')) {clearTimeout(timeout);resolve();}
    });
  });
  for(const [path,status] of [['/',200],['/employee.html',200],['/TYMRAK-approved-reference.png',200],
    ['/api/public-config',200],['/api/employee-punch',401],['/api/_manager-auth.js',404],
    ['/.env',404],['/package.json',404],['/supabase/migrations/20261023213945_company_isolation.sql',404]]) {
    const response=await fetch('http://127.0.0.1:8787'+path);
    assert.equal(response.status,status,path);
    if(path==='/api/public-config') {
      const body=await response.json();
      assert.equal(body.siteUrl,siteUrl);
      assert.equal(body.supabaseUrl,databaseUrl);
      assert.doesNotMatch(JSON.stringify(body),/sb_secret/);
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    console.log(`${status} ${path}`);
  }
  console.log('Cloudflare local runtime smoke checks passed (fake credentials; no database calls).');
} finally {
  try {process.kill(-server.pid,'SIGTERM');} catch {server.kill('SIGTERM');}
}
