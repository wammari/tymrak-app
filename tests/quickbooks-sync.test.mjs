import "./_test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  QuickBooksError, authorizationUrl, decryptSecret, encryptSecret, quickBooksClient, quickBooksConfig, signState, tokenRecord, verifyState
} from "../api/_quickbooks.js";
import { formatMinutes, missingEntries, suggestMatches, timeActivity, timecardEntries } from "../api/_quickbooks-sync.js";

const KEY = crypto.randomBytes(32);
const env = { SITE_URL: "https://app.tymrak.com", APP_ENV: "development", QUICKBOOKS_CLIENT_ID: "client", QUICKBOOKS_CLIENT_SECRET: "secret", QUICKBOOKS_TOKEN_KEY: KEY.toString("base64") };

test("QuickBooks stays off until all three server settings exist", () => {
  assert.equal(quickBooksConfig({ ...env, QUICKBOOKS_CLIENT_SECRET: "" }), null);
  assert.equal(quickBooksConfig({ ...env, QUICKBOOKS_TOKEN_KEY: "" }), null);
  const config = quickBooksConfig(env);
  assert.equal(config.environment, "sandbox");
  assert.equal(config.apiBase, "https://sandbox-quickbooks.api.intuit.com");
  assert.equal(config.redirectUri, "https://app.tymrak.com/quickbooks.html");
  assert.equal(quickBooksConfig({ ...env, QUICKBOOKS_ENVIRONMENT: "production" }).apiBase, "https://quickbooks.api.intuit.com");
  assert.throws(() => quickBooksConfig({ ...env, QUICKBOOKS_TOKEN_KEY: Buffer.alloc(16).toString("base64") }), /32 bytes/);
  assert.throws(() => quickBooksConfig({ ...env, QUICKBOOKS_ENVIRONMENT: "live" }), /sandbox or production/);
});

test("tokens are encrypted, and tampering or a different key is refused", () => {
  const sealed = encryptSecret("refresh-token-value", KEY);
  assert.doesNotMatch(sealed, /refresh-token-value/);
  assert.notEqual(sealed, encryptSecret("refresh-token-value", KEY));
  assert.equal(decryptSecret(sealed, KEY), "refresh-token-value");
  const [v, iv, tag, data] = sealed.split(".");
  const flipped = Buffer.from(data, "base64url"); flipped[0] ^= 1;
  assert.throws(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), KEY), e => e instanceof QuickBooksError && e.reconnect);
  assert.throws(() => decryptSecret(sealed, crypto.randomBytes(32)), QuickBooksError);
  assert.throws(() => decryptSecret("plain-text", KEY), QuickBooksError);
});

test("sign-in state only works for the same company and person, for 10 minutes", () => {
  const who = { organizationId: "org-1", userId: "user-1" };
  const now = Date.parse("2026-11-19T15:00:00Z");
  const state = signState(who, KEY, now);
  assert.equal(verifyState(state, KEY, who, now + 9 * 60000), true);
  assert.equal(verifyState(state, KEY, who, now + 11 * 60000), false);
  assert.equal(verifyState(state, KEY, { ...who, organizationId: "org-2" }, now), false);
  assert.equal(verifyState(state, KEY, { ...who, userId: "user-2" }, now), false);
  assert.equal(verifyState(state, crypto.randomBytes(32), who, now), false);
  const [payload, signature] = state.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), o: "org-2" })).toString("base64url");
  assert.equal(verifyState(`${forged}.${signature}`, KEY, { ...who, organizationId: "org-2" }, now), false);
  assert.equal(verifyState("", KEY, who, now), false);
  const url = new URL(authorizationUrl(quickBooksConfig(env), state));
  assert.equal(url.origin + url.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assert.equal(url.searchParams.get("scope"), "com.intuit.quickbooks.accounting");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.tymrak.com/quickbooks.html");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("matching suggests unique email matches first, then unique names, never a taken person", () => {
  const employees = [
    { id: "e1", first_name: "Ana", last_name: "Lopez", email: "ANA@shop.ca" },
    { id: "e2", first_name: "Sam", last_name: "Lee", email: "" },
    { id: "e3", first_name: "Chris", last_name: "Kim", email: "" },   // two QuickBooks Chris Kims: no guess
    { id: "e4", first_name: "Dana", last_name: "Ray", email: "" },    // already matched
    { id: "e5", first_name: "Omar", last_name: "Ali", email: "" }     // only person is taken by e4
  ];
  const qb = [
    { id: "1", name: "Ana L.", givenName: "Ana", familyName: "Lopez", email: "ana@shop.ca" },
    { id: "2", name: "Sam Lee", givenName: "Sam", familyName: "Lee", email: "" },
    { id: "3", name: "Chris Kim", givenName: "Chris", familyName: "Kim", email: "" },
    { id: "4", name: "Chris Kim", givenName: "Chris", familyName: "Kim", email: "" },
    { id: "5", name: "Omar Ali", givenName: "Omar", familyName: "Ali", email: "" }
  ];
  const result = suggestMatches(employees, qb, [{ employee_id: "e4", external_id: "5" }]);
  assert.deepEqual(result, [
    { employeeId: "e1", externalId: "1", externalName: "Ana L.", matchedBy: "email" },
    { employeeId: "e2", externalId: "2", externalName: "Sam Lee", matchedBy: "name" }
  ]);
});

test("only regular hours become time entries; overtime and double time are listed for payroll", () => {
  const h = hours => hours * 3600000;
  const { entries, manual } = timecardEntries([
    { date: "2026-11-02", regularMilliseconds: h(8), overtimeMilliseconds: 0, doubleTimeMilliseconds: 0 },
    { date: "2026-11-03", regularMilliseconds: 0, overtimeMilliseconds: 0, doubleTimeMilliseconds: 0 },
    { date: "2026-11-06", regularMilliseconds: h(4) + 30 * 60000 + 20000, overtimeMilliseconds: h(6), doubleTimeMilliseconds: h(1.25) }
  ]);
  assert.deepEqual(entries, [{ date: "2026-11-02", minutes: 480 }, { date: "2026-11-06", minutes: 270 }]);
  assert.deepEqual(manual, [{ date: "2026-11-06", kind: "overtime", minutes: 360 }, { date: "2026-11-06", kind: "double_time", minutes: 75 }]);
  assert.deepEqual(timeActivity(entries[1], 42, { startKey: "2026-11-01", endKey: "2026-11-15" }), {
    TxnDate: "2026-11-06", NameOf: "Employee", EmployeeRef: { value: "42" }, Hours: 4, Minutes: 30, BillableStatus: "NotBillable",
    Description: "Tymrak: regular hours (approved pay period 2026-11-01 to 2026-11-15)"
  });
  assert.deepEqual(missingEntries(entries, [{ date: "2026-11-02", minutes: 480, externalId: "9" }]), [{ date: "2026-11-06", minutes: 270 }]);
  assert.equal(formatMinutes(75), "1:15");
});

function fakeIntuit(handlers) {
  const original = global.fetch, calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [match, reply] of handlers) if (String(url).includes(match)) return typeof reply === "function" ? reply(calls) : reply;
    throw new Error(`Unexpected URL ${url}`);
  };
  return { calls, restore: () => { global.fetch = original; } };
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("the client refreshes an expiring token, saves it encrypted, then calls QuickBooks", async () => {
  const config = quickBooksConfig(env);
  const connection = { organization_id: "org", realm_id: "9130", ...tokenRecord(config, { access_token: "old", refresh_token: "r1", expires_in: 30 }) };
  const saved = [];
  const intuit = fakeIntuit([
    ["/oauth2/v1/tokens/bearer", reply({ access_token: "new-access", refresh_token: "r2", expires_in: 3600, x_refresh_token_expires_in: 8640000 })],
    ["/query?", reply({ QueryResponse: { Employee: [{ Id: 7, DisplayName: "Ana Lopez", GivenName: "Ana", FamilyName: "Lopez", PrimaryEmailAddr: { Address: "ana@shop.ca" } }] } })]
  ]);
  try {
    const people = await quickBooksClient(config, connection, async record => saved.push(record)).employees();
    assert.deepEqual(people, [{ id: "7", name: "Ana Lopez", givenName: "Ana", familyName: "Lopez", email: "ana@shop.ca" }]);
    const refresh = intuit.calls[0];
    assert.match(refresh.options.body, /grant_type=refresh_token&refresh_token=r1/);
    assert.equal(refresh.options.headers.Authorization, `Basic ${Buffer.from("client:secret").toString("base64")}`);
    assert.equal(saved.length, 1);
    assert.equal(decryptSecret(saved[0].refresh_token_encrypted, config.key), "r2");
    assert.doesNotMatch(JSON.stringify(saved), /new-access|"r2"/);
    const api = intuit.calls[1];
    assert.match(api.url, /^https:\/\/sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/9130\/query\?/);
    assert.match(api.url, /minorversion=75/);
    assert.equal(api.options.headers.Authorization, "Bearer new-access");
  } finally { intuit.restore(); }
});

test("a revoked connection asks the admin to reconnect", async () => {
  const config = quickBooksConfig(env);
  const connection = { organization_id: "org", realm_id: "9130", ...tokenRecord(config, { access_token: "a", refresh_token: "r", expires_in: 3600 }) };
  const intuit = fakeIntuit([["/oauth2/v1/tokens/bearer", reply({ error: "invalid_grant" }, 400)], ["/companyinfo/", reply({ Fault: {} }, 401)]]);
  try {
    await assert.rejects(quickBooksClient(config, connection, async () => {}).companyName(), e => e instanceof QuickBooksError && e.reconnect);
  } finally { intuit.restore(); }
});

test("batch time entries report each entry's result in order", async () => {
  const config = quickBooksConfig(env);
  const connection = { organization_id: "org", realm_id: "9130", ...tokenRecord(config, { access_token: "a", refresh_token: "r", expires_in: 3600 }) };
  const intuit = fakeIntuit([["/batch?", reply({ BatchItemResponse: [
    { bId: "1", Fault: { Error: [{ Message: "Employee is inactive" }] } }, { bId: "0", TimeActivity: { Id: "501" } }
  ] })]]);
  try {
    const results = await quickBooksClient(config, connection, async () => {}).createTimeActivities([{ TxnDate: "2026-11-02" }, { TxnDate: "2026-11-03" }]);
    assert.deepEqual(results, [{ externalId: "501" }, { error: "Employee is inactive" }]);
    const body = JSON.parse(intuit.calls[0].options.body);
    assert.deepEqual(body.BatchItemRequest.map(i => [i.bId, i.operation]), [["0", "create"], ["1", "create"]]);
  } finally { intuit.restore(); }
});
