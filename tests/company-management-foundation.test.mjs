import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('platform company creation requires verified server-side main administrator', () => {
  const api = read('api/platform-companies.js');
  assert.match(api, /await requireManager\(req\)/);
  assert.match(api, /rpc\/is_platform_administrator/);
  assert.match(api, /if \(await readJson\(check\) !== true\) return res\.status\(403\)/);
  assert.match(api, /rpc\/create_managed_company/);
  assert.doesNotMatch(api, /req\.body\?\.(?:auth_user_id|platformAdmin|isAdmin)/);
});

test('company management database functions are service-only and grant creator membership', () => {
  const sql = read('supabase/migrations/202611100004_company_management_foundation.sql');
  assert.match(sql, /revoke all on function public\.create_managed_company\(text,uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.create_managed_company\(text,uuid\) to service_role/i);
  assert.match(sql, /insert into public\.user_roles\(auth_user_id,organization_id,role\)/i);
  assert.match(sql, /p_platform_admin,v_id,'admin'/i);
  assert.match(sql, /tymrak_private\.platform_administrators/);
});

test('company management page does not store administrator permissions in the browser', () => {
  const page = read('company-management.html');
  assert.match(page, /\/api\/platform-companies/);
  assert.match(page, /session\.access_token/);
  assert.doesNotMatch(page, /localStorage\.setItem\(['"](?:isAdmin|platformAdmin)/);
});
