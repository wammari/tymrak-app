import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('delegation requires verified main administrator and service-only RPC',()=>{
 const api=read('api/company-administrators.js');
 assert.match(api,/await requireManager\(req\)/);
 assert.match(api,/rpc\/is_platform_administrator/);
 assert.match(api,/await check\.json\(\)!==true/);
 assert.match(api,/rpc\/set_company_administrator/);
 assert.match(api,/typeof grant!=="boolean"/);
});
test('delegation requires existing membership and protects main administrator',()=>{
 const sql=read('supabase/migrations/202611100006_company_admin_delegation.sql');
 assert.match(sql,/tymrak_private\.platform_administrators/);
 assert.match(sql,/organization_id=p_organization_id for update/);
 assert.match(sql,/User must already belong to this company/);
 assert.match(sql,/if v_member=p_platform_admin then raise exception/);
 assert.match(sql,/revoke all on function public\.set_company_administrator\(uuid,uuid,text,boolean\) from public,anon,authenticated/i);
 assert.match(sql,/grant execute on function public\.set_company_administrator\(uuid,uuid,text,boolean\) to service_role/i);
});
test('management page uses existing manager session and no client-side privilege flags',()=>{
 const page=read('company-management.html');
 assert.match(page,/\/api\/manager-session/);
 assert.match(page,/\/api\/company-administrators/);
 assert.doesNotMatch(page,/\/api\/manager-context/);
});
