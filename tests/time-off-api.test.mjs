import './_test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import employeeHandler from '../api/employee-time-off.js';
import managerHandler from '../api/manager-time-off.js';

const user = '11111111-1111-4111-8111-111111111111';
const reqId = '22222222-2222-4222-8222-222222222222';
const original = global.fetch;
test.afterEach(() => { global.fetch = original; });
const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } });
const setup = () => { process.env.SUPABASE_URL = 'https://example.supabase.co'; process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'; };
const emp = (method, body, query) => ({ method, headers: { authorization: 'Bearer session' }, body, query });
const html = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('employee API rejects anonymous and malformed requests before any network call', async () => {
  setup(); global.fetch = () => { throw new Error('unexpected network'); };
  let r = res(); await employeeHandler({ method: 'GET', headers: {} }, r); assert.equal(r.code, 401);
  for (const body of [{}, { startDate: 'bad', endDate: '2027-01-02' }, { startDate: '2027-01-02', endDate: '2027-01-03', startHalf: 'am' }, { startDate: '2027-01-02', endDate: '2027-01-03', note: 'x'.repeat(501) }]) {
    r = res(); await employeeHandler(emp('POST', body), r); assert.equal(r.code, 400);
  }
  r = res(); await employeeHandler(emp('DELETE', null, { id: 'nope' }), r); assert.equal(r.code, 400);
  r = res(); await employeeHandler(emp('PUT'), r); assert.equal(r.code, 405);
});

test('employee API uses only the verified Auth ID and ignores any employee id in the body', async () => {
  setup(); let calls = 0;
  global.fetch = async (url, init) => {
    if (calls++ === 0) return Response.json({ id: user });
    assert.match(url, /rpc\/request_time_off$/);
    assert.deepEqual(JSON.parse(init.body), { p_auth_user_id: user, p_start: '2027-03-01', p_end: '2027-03-05', p_start_half: 'full', p_end_half: 'full', p_note: null });
    return Response.json({ success: true, requestId: reqId, days: 5 });
  };
  const r = res(); await employeeHandler(emp('POST', { startDate: '2027-03-01', endDate: '2027-03-05', employeeId: 'attacker', p_auth_user_id: 'attacker' }), r);
  assert.equal(r.code, 200); assert.equal(r.body.days, 5);
});

test('employee API maps business errors and hides outage details', async () => {
  setup();
  for (const [result, status, expected] of [[{ error: 'insufficient_balance' }, 200, 409], [{ error: 'employee_unavailable' }, 200, 403], [{ code: 'XX000', message: 'secret' }, 500, 503]]) {
    let calls = 0; global.fetch = async () => calls++ === 0 ? Response.json({ id: user }) : Response.json(result, { status });
    const r = res(); await employeeHandler(emp('POST', { startDate: '2027-03-01', endDate: '2027-03-02' }), r);
    assert.equal(r.code, expected); assert.doesNotMatch(JSON.stringify(r.body), /secret/);
  }
});

test('manager API validates actions before the database and rejects anonymous callers', async () => {
  setup(); global.fetch = () => { throw new Error('unexpected network'); };
  let r = res(); await managerHandler({ method: 'GET', headers: {} }, r); assert.equal(r.code, 401);
  r = res(); await managerHandler({ method: 'PUT', headers: {} }, r); assert.equal(r.code, 405);
});

test('manager API pins every database call to the selected company and verified manager', async () => {
  setup();
  const org = '33333333-3333-4333-8333-333333333333';
  const seen = [];
  global.fetch = async (url, init) => {
    if (/auth\/v1\/user/.test(url)) return Response.json({ id: user, email: 'm@example.com' });
    if (/user_roles/.test(url)) return Response.json([{ role: 'admin', organization_id: org, organization: { id: org, name: 'Co', is_active: true } }]);
    if (/manager_employee_scope/.test(url)) return Response.json({ all: true, employee_ids: [] });
    if (/rpc\/(\w+)/.test(url)) { seen.push([url.match(/rpc\/(\w+)/)[1], JSON.parse(init.body)]); return Response.json({ success: true, status: 'approved' }); }
    return Response.json([]);
  };
  const r = res();
  await managerHandler({ method: 'POST', headers: { authorization: 'Bearer session', 'x-tymrak-organization-id': org }, body: { action: 'approve', requestId: reqId, p_organization_id: 'attacker', p_manager_id: 'attacker' } }, r);
  assert.equal(r.code, 200);
  const call = seen.find(([name]) => name === 'decide_time_off');
  assert.equal(call[1].p_organization_id, org); assert.equal(call[1].p_manager_id, user);
});

test('Payroll is removed and Time Off is a working manager screen', () => {
  const manager = html('manager.html');
  assert.doesNotMatch(manager, />Payroll</);
  assert.match(manager, /data-view="timeoff">Time Off</);
  assert.match(manager, /id="timeOffView"/); assert.match(manager, /\/api\/manager-time-off/);
  assert.doesNotMatch(manager, /\bconfirm\(/);
});

test('employee page shows balance, request form and cancel without native dialogs', () => {
  const page = html('employee.html');
  for (const id of ['toRemaining', 'timeOffForm', 'toList']) assert.match(page, new RegExp(`id="${id}"`));
  assert.match(page, /\/api\/employee-time-off/);
  assert.doesNotMatch(page, /\bconfirm\(/);
});

test('Time Off endpoints are registered with the Cloudflare worker', () => {
  const worker = html('cloudflare/worker.mjs');
  assert.match(worker, /'\/api\/employee-time-off'/); assert.match(worker, /'\/api\/manager-time-off'/);
});
