import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import publicConfig from "../api/public-config.js";
import { getPublicConfiguration, getSupabaseTarget, getSiteUrl, isBrowserKey } from "../api/_deployment-config.js";
import { getSupabaseConfiguration, requireManager } from "../api/_manager-auth.js";
import { activationRedirect } from "../api/_employee-management.js";
import activationHandler from "../api/complete-activation.js";
import invitationHandler from "../api/send-invitation.js";

const staging = {
  APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production",
  SUPABASE_URL: "https://ctztwqcsizwkrqgpgrgg.supabase.co/",
  SUPABASE_EXPECTED_PROJECT_REF: "ctztwqcsizwkrqgpgrgg",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_never_in_browser",
  SITE_URL: "https://tymrak-staging.vercel.app/"
};
function response() {
  return { headers: {}, setHeader(k,v) { this.headers[k]=v; },
    status(value) { this.statusCode=value; return this; }, json(value) { this.body=value; return this; } };
}
const originalEnv = process.env;
const originalFetch = global.fetch;
test.afterEach(() => { process.env=originalEnv; global.fetch=originalFetch; });

test("staging public configuration exposes only public fields and uses the shared server target", () => {
  process.env={...staging};
  const res=response(); publicConfig({method:"GET"},res);
  assert.equal(res.statusCode,200);
  assert.deepEqual(Object.keys(res.body).sort(),["environment","siteUrl","supabasePublishableKey","supabaseUrl"]);
  assert.equal(res.body.supabaseUrl,getSupabaseConfiguration().supabaseUrl);
  assert.equal(res.body.siteUrl,"https://tymrak-staging.vercel.app");
  assert.equal(res.headers["Cache-Control"],"no-store");
  assert.doesNotMatch(JSON.stringify(res.body),/sb_secret_|SUPABASE_SECRET_KEY/);
  assert.equal(activationRedirect(),"https://tymrak-staging.vercel.app/activate.html");
  assert.equal(new URL("/reset-password.html",res.body.siteUrl).href,"https://tymrak-staging.vercel.app/reset-password.html");
});

test("staging rejects other projects, omitted guard and wrong guard", () => {
  for(const changes of [
    {SUPABASE_URL:"https://unrelated.supabase.co"},
    {SUPABASE_EXPECTED_PROJECT_REF:undefined},
    {SUPABASE_EXPECTED_PROJECT_REF:"unrelated"}
  ]) assert.throws(()=>getSupabaseTarget({...staging,...changes}));
});

test("hosted environments must explicitly select APP_ENV and previews cannot use production", () => {
  assert.throws(()=>getSupabaseTarget({...staging,APP_ENV:undefined}));
  assert.throws(()=>getSupabaseTarget({...staging,APP_ENV:"development"}));
  assert.throws(()=>getSupabaseTarget({...staging,APP_ENV:"production",VERCEL_ENV:"preview"}));
  assert.throws(()=>getSupabaseTarget({...staging,APP_ENV:"production",SUPABASE_EXPECTED_PROJECT_REF:undefined}));
});

test("production can explicitly select its own project and never falls back to staging", () => {
  const env={...staging,APP_ENV:"production",SUPABASE_URL:"https://productionexample.supabase.co",
    SUPABASE_EXPECTED_PROJECT_REF:"productionexample",SITE_URL:"https://www.tymrak.com"};
  assert.equal(getPublicConfiguration(env).supabaseUrl,"https://productionexample.supabase.co");
  assert.throws(()=>getSupabaseTarget({...staging,APP_ENV:"production"}));
});

test("production accepts only the canonical TYMRAK site for Auth redirects", () => {
  const env={...staging,APP_ENV:"production",VERCEL_ENV:"production",
    SUPABASE_URL:"https://productionexample.supabase.co",
    SUPABASE_EXPECTED_PROJECT_REF:"productionexample",SITE_URL:"https://www.tymrak.com"};
  assert.equal(getSiteUrl(env),"https://www.tymrak.com");
  for(const SITE_URL of ["https://app.example.com","https://tymrak.com",
    "https://www.tymrak.com.evil.test","http://www.tymrak.com"]) {
    assert.throws(()=>getSiteUrl({...env,SITE_URL}));
  }
});

test("malformed Supabase URLs and staging site origins fail closed", () => {
  for(const SUPABASE_URL of ["","http://ctztwqcsizwkrqgpgrgg.supabase.co","https://user:pass@ctztwqcsizwkrqgpgrgg.supabase.co",
    "https://ctztwqcsizwkrqgpgrgg.supabase.co/path","https://ctztwqcsizwkrqgpgrgg.supabase.co?x=1",
    "https://ctztwqcsizwkrqgpgrgg.supabase.co.evil.test"]) {
    assert.throws(()=>getSupabaseTarget({...staging,SUPABASE_URL}));
  }
  for(const SITE_URL of ["","https://app.example.com","http://tymrak-staging.vercel.app",
    "https://tymrak-staging.vercel.app/activate.html","https://tymrak-staging.vercel.app?x=1",
    "https://user:pass@tymrak-staging.vercel.app"]) assert.throws(()=>getSiteUrl({...staging,SITE_URL}));
});

test("public configuration rejects secrets and legacy service JWTs without reflecting them", () => {
  const jwt=role => "header."+Buffer.from(JSON.stringify({role})).toString("base64url")+".signature";
  assert.equal(isBrowserKey(jwt("anon")),true);
  for(const key of ["sb_secret_private",jwt("service_role"),"garbage",undefined]) {
    process.env={...staging,SUPABASE_PUBLISHABLE_KEY:key};
    const res=response(); publicConfig({method:"GET"},res);
    assert.equal(res.statusCode,503);
    assert.deepEqual(res.body,{error:"TYMRAK configuration is unavailable. Please contact your administrator."});
    assert.doesNotMatch(JSON.stringify(res.body),/private|signature/);
  }
  process.env={...staging};const res=response();publicConfig({method:"POST"},res);
  assert.equal(res.statusCode,405); assert.equal(res.headers.Allow,"GET");
});

test("wrong staging backend never reaches Auth, employee writes or invitation sending",async()=>{
  process.env={...staging,SUPABASE_URL:"https://unrelated.supabase.co"};
  let calls=0;global.fetch=async()=>{calls++;throw new Error("must not fetch");};
  const req={method:"POST",headers:{authorization:"Bearer test-session"},body:{}};
  assert.equal((await requireManager(req)).status,500);
  for(const handler of [activationHandler,invitationHandler]) {
    const res=response();await handler(req,res);assert.equal(res.statusCode,500);
  }
  assert.equal(calls,0);
});

test("missing SITE_URL cannot fall back to a production invitation redirect",()=>{
  process.env={...staging,SITE_URL:undefined};
  assert.throws(()=>activationRedirect());
});

test("every Auth page loads shared configuration and recovery redirects use the configured site",()=>{
  for(const name of ["activate","employee","login","manager-login","manager","reset-password","timecard"]) {
    const html=fs.readFileSync(new URL("../"+name+".html",import.meta.url),"utf8");
    assert.match(html,/await loadSupabaseConfiguration\(\)/);
    assert.doesNotMatch(html,/https:\/\/[a-z0-9]+\.supabase\.co|sb_publishable_[A-Za-z0-9_-]+/);
  }
  for(const name of ["activate","reset-password"]) {
    assert.match(fs.readFileSync(new URL("../"+name+".html",import.meta.url),"utf8"),
      /<meta name="referrer" content="no-referrer">/);
  }
  assert.match(fs.readFileSync(new URL("../login.html",import.meta.url),"utf8"),
    /new URL\("\/reset-password\.html", deploymentConfiguration\.siteUrl\)\.href/);
});

test("browser configuration failures disable forms and render a fixed text error",async()=>{
  let notice,prepended,calls=0;const controls=[{},{}];
  const source=fs.readFileSync(new URL("../supabase-config.js",import.meta.url),"utf8").replace("export async function","async function");
  const context={document:{querySelectorAll:()=>controls,
    createElement:()=>notice={setAttribute(){},textContent:""},body:{prepend:n=>{prepended=n;}}},
    fetch:async()=>{calls++;return new Response("<img src=x onerror=alert(1)>",{status:503});}};
  vm.runInNewContext(source+"; globalThis.load = loadSupabaseConfiguration;",context);
  await assert.rejects(context.load(),/configuration unavailable/);
  assert.ok(controls.every(c=>c.disabled));
  assert.equal(prepended,notice);assert.doesNotMatch(notice.textContent,/<img/);
  assert.equal(calls,1);
});

test("browser configuration is fetched once and shares one result",async()=>{
  let calls=0;
  const source=fs.readFileSync(new URL("../supabase-config.js",import.meta.url),"utf8").replace("export async function","async function");
  const context={fetch:async(url,options)=>{calls++;assert.equal(url,"/api/public-config");assert.equal(options.cache,"no-store");
    return new Response(JSON.stringify(getPublicConfiguration(staging)));}};
  vm.runInNewContext(source+"; globalThis.load = loadSupabaseConfiguration;",context);
  const [a,b]=await Promise.all([context.load(),context.load()]);assert.equal(a,b);assert.equal(calls,1);
});

async function recoveryPage({event="PASSWORD_RECOVERY",error=null}={}) {
  const html=fs.readFileSync(new URL("../reset-password.html",import.meta.url),"utf8");
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/import \{ createClient \} from\s*"[^"]+";/,"")
    .replace(/import \{ loadSupabaseConfiguration \} from "[^"]+";/,"");
  const elements=Object.fromEntries(["form","message","resetButton","password","confirmPassword"].map(id=>
    [id,{style:{},value:"test-only-password",addEventListener(_,fn){this.click=fn;}}]));
  let listener,saves=0;
  const user={id:"test-recovery-user"};
  const context={document:{getElementById:id=>elements[id]},
    console:{log(){},error(){}},loadSupabaseConfiguration:async()=>getPublicConfiguration(staging),
    createClient(url,key,options) {
      assert.equal(url,"https://ctztwqcsizwkrqgpgrgg.supabase.co");
      assert.equal(key,"sb_publishable_test");
      assert.equal(options.auth.detectSessionInUrl,true);assert.equal(options.auth.persistSession,true);
      return {auth:{onAuthStateChange(fn){listener=fn;},
        async updateUser(){saves++;return {error,data:{user}};}}};
    }};
  await vm.runInNewContext("(async()=>{"+script+"})()",context);
  listener(event,{user});
  await elements.resetButton.click();
  return {elements,saves};
}

test("configured recovery preserves PASSWORD_RECOVERY success and rejects unrelated login events",async()=>{
  const valid=await recoveryPage();
  assert.equal(valid.saves,1);assert.equal(valid.elements.form.style.display,"none");
  assert.match(valid.elements.message.innerHTML,/Password updated successfully/);
  const invalid=await recoveryPage({event:"SIGNED_IN"});
  assert.equal(invalid.saves,0);assert.match(invalid.elements.message.textContent,/not ready/);
});

test("configured recovery renders Auth errors as text",async()=>{
  const p=await recoveryPage({error:{message:"<img src=x onerror=alert(1)>"}});
  assert.equal(p.elements.message.textContent,"<img src=x onerror=alert(1)>");
  assert.equal(p.elements.message.innerHTML,undefined);
});

test("draft staging branch disables automatic Git deployments",()=>{
  const config=JSON.parse(fs.readFileSync(new URL("../vercel.json",import.meta.url),"utf8"));
  assert.equal(config.git.deploymentEnabled["setup/isolated-staging"],false);
  assert.equal(config.git.deploymentEnabled.main,undefined);
});

test("prepared bootstrap contains exact migrations, guards and narrowed grants without executing SQL",()=>{
  const sql=fs.readFileSync(new URL("../supabase/staging/initialize-empty-staging.sql",import.meta.url),"utf8");
  const names=fs.readdirSync(new URL("../supabase/migrations/",import.meta.url)).filter(n=>n.endsWith(".sql")).sort();
  let previous=0;
  for(const name of names) {
    const marker="-- BEGIN SOURCE: supabase/migrations/"+name+"\n";
    const at=sql.indexOf(marker);assert.ok(at>previous);previous=at;
    const end=sql.indexOf("\n-- END SOURCE:",at);
    let expected=fs.readFileSync(new URL("../supabase/migrations/"+name,import.meta.url),"utf8");
    if(name==="202610080001_atomic_employee_activation.sql") {
      expected=expected.replace(/^begin;\n/m,"").replace(/^commit;\n/m,"");
    }
    assert.equal(sql.slice(at+marker.length,end),expected);
  }
  assert.match(sql,/public schema already contains/);assert.match(sql,/Auth accounts already exist/);
  assert.equal(sql.match(/^begin;$/gm)?.length,1);
  assert.equal(sql.match(/^commit;$/gm)?.length,1);
  assert.match(sql,/employees_auth_user_id_key unique \(auth_user_id\)/);
  assert.match(sql,/float8 double precision/);assert.match(sql,/punch_type text/);
  assert.match(sql,/revoke all on sequence public.punches_id_seq/);
  assert.match(sql,/grant insert on public.punches to authenticated/);
  assert.doesNotMatch(sql,/grant[^;]*\btruncate\b/i);
  assert.doesNotMatch(sql,/insert into (?:public\.)?employees|insert into auth\.users/i);
});

test("empty-staging guard checks all relation kinds and routines before any schema write",()=>{
  const sql=fs.readFileSync(new URL("../supabase/staging/initialize-empty-staging.sql",import.meta.url),"utf8");
  const guard=sql.slice(sql.indexOf("do $guard$"),sql.indexOf("$guard$;")+8);
  assert.match(guard,/pg_catalog\.pg_class\b/);
  assert.doesNotMatch(guard,/relkind\s*(?:in|=)/i,"views/sequences/foreign relations must not be excluded");
  assert.match(guard,/pg_catalog\.pg_proc\b/);
  assert.match(guard,/pg_catalog\.pg_namespace n on n\.oid = objects\.namespace_oid/);
  assert.match(guard,/where n\.nspname = 'public'/);
  assert.match(guard,/if existing_public_object is not null then\s+raise exception/);
  assert.match(guard,/current_setting\('tymrak\.staging_confirmation', true\)/);
  assert.match(guard,/if exists \(select 1 from auth\.users\)/);
  assert.doesNotMatch(guard.replace(/'(?:''|[^'])*'/g,"''").replace(/--[^\n]*/g,""),
    /\b(?:create|alter|drop|insert|update|delete|truncate|grant|revoke)\b/i);
  assert.ok(sql.indexOf("$guard$;")<sql.indexOf("create table public.employees"));
});

test("empty-staging guard rejects standalone schema objects and public extensions without exemptions",()=>{
  const sql=fs.readFileSync(new URL("../supabase/staging/initialize-empty-staging.sql",import.meta.url),"utf8");
  const guard=sql.slice(sql.indexOf("do $guard$"),sql.indexOf("$guard$;")+8);
  for(const catalog of ["pg_type","pg_collation","pg_operator","pg_opclass","pg_opfamily","pg_conversion",
    "pg_ts_config","pg_ts_dict","pg_ts_parser","pg_ts_template","pg_extension"]) {
    assert.match(guard,new RegExp("pg_catalog\\."+catalog+"\\b"));
  }
  const objects=guard.slice(guard.indexOf("from ("),guard.indexOf(") as objects"));
  assert.doesNotMatch(objects,/\b(?:not exists|except)\b/i,"extension membership must not bypass the guard");
  assert.match(objects,/pg_catalog\.pg_proc where oid is distinct from verified_rls_oid/);
  assert.match(guard,/325ae266d9b166715ef5230ceaf7ff9d523e483cf5610dfb9779ab3f183f4af9/);
  assert.match(guard,/verified_rls_oid := rls_helper\.oid/);
});

// Run this regression guard in CI for staging configuration changes.
test("the earlier misspelled staging host is rejected even with its matching expected ref", () => {
  assert.throws(() => getSupabaseTarget({...staging,
    SUPABASE_URL: "https://cztwqcsizwkrqgpgrgg.supabase.co",
    SUPABASE_EXPECTED_PROJECT_REF: "cztwqcsizwkrqgpgrgg"}));
});
