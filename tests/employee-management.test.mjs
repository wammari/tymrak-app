import "./_test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import employeesHandler from "../api/employees.js";
import invitationHandler from "../api/send-invitation.js";
import resendHandler from "../api/resend-invitation.js";
import { findDuplicate } from "../api/_employee-management.js";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function responseRecorder() {
  return {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function request(method, body = {}, query = {}) {
  return {
    method, body, query,
    headers: { authorization: "Bearer manager-access-token" }
  };
}

function employee(overrides = {}) {
  return {
    id: "employee-1", first_name: "Ada", last_name: "Lovelace",
    email: "ada@example.com", username: "ada", mobile: null,
    position: "Engineer", department: "Technology", province: "AB",
    hire_date: null, invitation_status: "Invitation Sent",
    invited_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    activated_at: null, is_active: true, ...overrides
  };
}

function input(overrides = {}) {
  return {
    firstName: "Ada", lastName: "Lovelace", email: "ada@example.com",
    username: "ada", mobile: "+1 403 555 0100", position: "Engineer",
    department: "Technology", province: "AB", hireDate: "2026-10-01",
    isActive: true, ...overrides
  };
}

function installManagerFetch(operation, authIdentity = null) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "manager-id", email: "manager@example.com" }));
    }
    if (String(url).includes("/auth/v1/admin/users/") && options.method === "PUT") {
      const id = decodeURIComponent(String(url).split("/").pop());
      const metadata = JSON.parse(options.body).user_metadata;
      return new Response(JSON.stringify({ id, email: "ada@example.com", user_metadata: metadata }));
    }
    if (String(url).includes("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(String(url).split("/").pop());
      return new Response(JSON.stringify(authIdentity || {
        id, email: "ada@example.com", invited_at: "2026-11-03T12:00:00Z",
        user_metadata: { first_name: "Ada", last_name: "Lovelace", username: "ada", company_name: "Le Delice Pastry Shop" }
      }));
    }
    if (String(url).includes("/rest/v1/organizations?")) {
      return new Response(JSON.stringify([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Le Delice Pastry Shop" }]));
    }
    if (String(url).includes("/rest/v1/user_roles")) {
      return new Response(JSON.stringify([{ role: "admin", organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organization: { is_active: true } }]));
    }
    return operation(String(url), options, calls);
  };
  return calls;
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret-never-public";
  process.env.SITE_URL = "https://app.example.com";
});

test.afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test("username duplicate checks treat underscore as a literal character", async () => {
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    return new Response("[]");
  };
  const duplicate = await findDuplicate({
    supabaseUrl: "https://example.supabase.co",
    secretKey: "sb_secret_test",
    organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "ada@example.com",
    username: "ada_test"
  });
  assert.equal(duplicate, null);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /&email=eq\.ada%40example\.com/);
  assert.ok(urls[1].includes("username=ilike.ada%5C_test"), urls[1]);
});

test("anonymous users cannot access any employee-management API", async () => {
  for (const [handler, req] of [
    [employeesHandler, { method: "GET", headers: {}, query: {} }],
    [invitationHandler, { method: "POST", headers: {}, body: input() }],
    [resendHandler, { method: "POST", headers: {}, body: { id: "employee-1" } }]
  ]) {
    let called = false;
    global.fetch = async () => { called = true; throw new Error("must not fetch"); };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(called, false);
  }
});

test("ordinary employees cannot access employee-management APIs", async () => {
  global.fetch = async url => String(url).endsWith("/auth/v1/user")
    ? new Response(JSON.stringify({ id: "ordinary-employee" }))
    : new Response(JSON.stringify([{ role: "employee" }]));
  const res = responseRecorder();
  await employeesHandler(request("GET"), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.error, /Manager/);
});

test("a manager can list employees", async () => {
  const record = employee();
  installManagerFetch(async url => {
    assert.match(url, /employees\?organization_id=eq\.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&select=/);
    return new Response(JSON.stringify([record]));
  });
  const res = responseRecorder();
  await employeesHandler(request("GET"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.employees, [record]);
});

test("a manager can create an active employee and send an invitation", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?") && options.method !== "POST") return new Response("[]");
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" }));
    if (url.endsWith("/rest/v1/employees") && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.is_active, true);
      assert.equal(body.mobile, "+1 403 555 0100");
      assert.equal(body.hire_date, "2026-10-01");
      assert.equal(body.auth_user_id, "11111111-1111-4111-8111-111111111111");
      assert.equal(body.invitation_status, "Invitation Sent");
      return new Response(JSON.stringify([employee({ auth_user_id: "11111111-1111-4111-8111-111111111111" })]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await invitationHandler(request("POST", input()), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.success, true);
  assert.equal(calls.filter(call => call.url.includes("/auth/v1/invite")).length, 1);
  const inviteRequest = calls.find(call => call.url.includes("/auth/v1/invite"));
  assert.equal(JSON.parse(inviteRequest.options.body).data.company_name, "Le Delice Pastry Shop");
});

test("company lookup failure blocks invitation before sending email", async () => {
  const calls = installManagerFetch(async url => {
    if (url.includes("/employees?")) return new Response("[]");
    throw new Error(`Unexpected URL ${url}`);
  });
  const originalFetchForTest = global.fetch;
  global.fetch = async (url, options) => String(url).includes("/rest/v1/organizations?")
    ? new Response("[]") : originalFetchForTest(url, options);
  const res = responseRecorder();
  await invitationHandler(request("POST", input()), res);
  assert.equal(res.statusCode, 409);
  assert.equal(calls.some(call => call.url.includes("/auth/v1/invite")), false);
});

test("fresh Supabase email identity timestamp is not mistaken for a prior sign-in", async () => {
  const created = "2026-11-04T15:13:20.155633Z";
  const identity = { provider: "email", created_at: created, last_sign_in_at: "2026-11-04T15:13:20.155568Z" };
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?") && options.method !== "POST") return new Response("[]");
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com", identities: [identity]
    }));
    if (url.endsWith("/rest/v1/employees") && options.method === "POST") {
      return new Response(JSON.stringify([employee({ auth_user_id: "11111111-1111-4111-8111-111111111111" })]));
    }
    throw new Error(`Unexpected URL ${url}`);
  }, {
    id: "11111111-1111-4111-8111-111111111111",
    email: "ada@example.com", invited_at: created, identities: [identity],
    user_metadata: { first_name: "Ada", last_name: "Lovelace", username: "ada", company_name: "Le Delice Pastry Shop" }
  });
  const res = responseRecorder();
  await invitationHandler(request("POST", input()), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.ok(calls.some(call => call.options.method === "POST" && call.url.endsWith("/rest/v1/employees")));
});

test("partial successful Auth invite is linked only after authoritative verification", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?") && options.method !== "POST") return new Response("[]");
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111"
    }));
    if (url.endsWith("/rest/v1/employees") && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.auth_user_id, "11111111-1111-4111-8111-111111111111");
      return new Response(JSON.stringify([employee({ auth_user_id: body.auth_user_id })]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await invitationHandler(request("POST", input()), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.success, true);
  const inviteIndex = calls.findIndex(call => call.url.includes("/auth/v1/invite"));
  const verifyIndex = calls.findIndex(call => call.url.includes("/auth/v1/admin/users/"));
  const saveIndex = calls.findIndex(call => call.options.method === "POST" && call.url.endsWith("/rest/v1/employees"));
  assert.ok(inviteIndex >= 0 && verifyIndex > inviteIndex && saveIndex > verifyIndex);
});

for (const duplicateField of ["email", "username"]) {
  test(`duplicate ${duplicateField} is rejected before an invitation is sent`, async () => {
    const calls = installManagerFetch(async url => {
      if (url.includes(`&${duplicateField}=`)) return new Response('[{"id":"existing"}]');
      if (url.includes("/employees?")) return new Response("[]");
      throw new Error(`Unexpected URL ${url}`);
    });
    const res = responseRecorder();
    await invitationHandler(request("POST", input()), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, new RegExp(duplicateField));
    assert.equal(calls.some(call => call.url.includes("/auth/v1/invite")), false);
  });
}


test("existing confirmed Auth user is not silently linked or reinvited", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?")) return new Response("[]");
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({msg:"A user with this email address has already been registered"}), {status:422});
    throw new Error("Unexpected write after Auth conflict");
  });
  const res = responseRecorder();
  await invitationHandler(request("POST", input({email:"existing@example.com"})), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /verify account ownership/);
  assert.equal(calls.filter(call => call.options.method === "POST" && call.url.endsWith("/rest/v1/employees")).length, 0);
});


test("existing Auth identity errors from either Supabase status are safe conflicts", async () => {
  for (const [status, body] of [
    [400, { code: "user_already_exists" }],
    [422, { message: "A user with this email address has already been registered" }]
  ]) {
    const calls = installManagerFetch(async (url) => {
      if (url.includes("/employees?")) return new Response("[]");
      if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify(body), { status });
      throw new Error("Unexpected request after invitation conflict");
    });
    const res = responseRecorder();
    await invitationHandler(request("POST", input({ email: "existing@example.com" })), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /verify account ownership/);
    assert.equal(calls.some(call => call.url.endsWith("/rest/v1/employees") && call.options.method === "POST"), false);
  }
});

test("successful Auth response never silently links a confirmed or mismatched identity", async () => {
  for (const authResult of [
    { id: "existing-user", email: "ada@example.com", email_confirmed_at: "2026-10-01T00:00:00Z" },
    { id: "existing-user", email: "ada@example.com", confirmed_at: "2026-10-01T00:00:00Z" },
    { id: "existing-user", email: "ada@example.com", last_sign_in_at: "2026-10-01T00:00:00Z" },
    { id: "other-user", email: "different@example.com" }
  ]) {
    const calls = installManagerFetch(async (url) => {
      if (url.includes("/employees?")) return new Response("[]");
      if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify(authResult));
      throw new Error("No employee write is allowed after an unsafe Auth response");
    });
    const res = responseRecorder();
    await invitationHandler(request("POST", input()), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /No employee account link was created|no verifiable user identity/i);
    assert.match(res.payload.error, /may have been sent/);
    assert.equal(calls.some(call => call.options.method === "POST" && call.url.endsWith("/rest/v1/employees")), false);
  }
});

test("incomplete Auth responses or nested prior sign-ins never create employee links", async () => {
  for (const authResult of [
    { email: "ada@example.com" },
    { id: "11111111-1111-4111-8111-111111111111", email: "", last_sign_in_at: "2026-10-01T00:00:00Z" },
    { id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com",
      identities: [{ provider: "email", last_sign_in_at: "2026-10-01T00:00:00Z" }] }
  ]) {
    const calls = installManagerFetch(async (url) => {
      if (url.includes("/employees?")) return new Response("[]");
      if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify(authResult));
      throw new Error("No employee write allowed after ambiguous Auth response");
    });
    const res = responseRecorder();
    await invitationHandler(request("POST", input()), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /may have been sent/);
    assert.equal(calls.some(call => call.options.method === "POST" &&
      call.url.endsWith("/rest/v1/employees")), false);
  }
});

test("resend fails closed on missing Auth email or nested prior sign-in", async () => {
  for (const authResult of [
    { id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com", confirmed_at: "2026-10-01T00:00:00Z" },
    { id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com",
      identities: [{ last_sign_in_at: "2026-10-01T00:00:00Z" }] }
  ]) {
    const calls = installManagerFetch(async url => {
      if (url.includes("/employees?")) return new Response(JSON.stringify([employee({
        auth_user_id: "11111111-1111-4111-8111-111111111111"
      })]));
      if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify(authResult));
      throw new Error("No status update allowed after ambiguous Auth response");
    });
    const res = responseRecorder();
    await resendHandler(request("POST", { id: "employee-1" }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(calls.some(call => call.options.method === "PATCH"), false);
  }
});

test("resend does not update employee after a confirmed or mismatched Auth response", async () => {
  for (const authResult of [
    { id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com", email_confirmed_at: "2026-10-01T00:00:00Z" },
    { id: "11111111-1111-4111-8111-111111111111", email: "different@example.com" }
  ]) {
    const calls = installManagerFetch(async url => {
      if (url.includes("/employees?")) return new Response(JSON.stringify([employee({ auth_user_id: "11111111-1111-4111-8111-111111111111" })]));
      if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify(authResult));
      throw new Error("No employee update is allowed after an unsafe Auth response");
    });
    const res = responseRecorder();
    await resendHandler(request("POST", { id: "employee-1" }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(calls.some(call => call.options.method === "PATCH"), false);
  }
});

test("a manager edits exactly one employee and can save inactive status", async () => {
  let patchUrl;
  installManagerFetch(async (url, options) => {
    if (url.includes("/employees?") && options.method !== "PATCH") return new Response("[]");
    if (options.method === "PATCH") {
      patchUrl = url;
      const body = JSON.parse(options.body);
      assert.equal(body.is_active, false);
      assert.equal(body.mobile, "+1 403 555 0100");
      assert.equal(body.hire_date, "2026-10-01");
      assert.equal("auth_user_id" in body, false);
      assert.equal("invitation_status" in body, false);
      return new Response(JSON.stringify([employee({ is_active: false })]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await employeesHandler(request("PATCH", input({ isActive: false }), { id: "employee-1" }), res);
  assert.equal(res.statusCode, 200);
  assert.match(patchUrl, /employees\?id=eq\.employee-1/);
  assert.equal(res.payload.employee.is_active, false);
});

test("resending an invitation updates by ID and never creates an employee", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?id=eq.employee-1") && !options.method) {
      return new Response(JSON.stringify([employee({ auth_user_id: "11111111-1111-4111-8111-111111111111" })]));
    }
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" }));
    if (url.includes("/employees?id=eq.employee-1") && options.method === "PATCH") {
      assert.match(url, /auth_user_id=eq\.11111111-1111-4111-8111-111111111111/);
      assert.match(url, /activated_at=is\.null/);
      assert.match(url, /invitation_status=neq\.Account%20Activated/);
      return new Response(JSON.stringify([employee()]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.some(call => call.options.method === "POST" && call.url.endsWith("/rest/v1/employees")), false);
  assert.equal(calls.filter(call => call.url.includes("/auth/v1/admin/users/")).length, 3);
  assert.equal(calls.filter(call => call.url.includes("/auth/v1/admin/users/") && call.options.method === "PUT").length, 1);
  const syncIndex = calls.findIndex(call => call.url.includes("/auth/v1/admin/users/") && call.options.method === "PUT");
  const inviteIndex = calls.findIndex(call => call.url.includes("/auth/v1/invite"));
  assert.ok(syncIndex >= 0 && inviteIndex > syncIndex, "company metadata must be synchronized before invitation email");
  const metadata = JSON.parse(calls[syncIndex].options.body).user_metadata;
  assert.equal(metadata.company_name, "Le Delice Pastry Shop");
  assert.equal(metadata.first_name, "Ada");
});

test("resend blocks a mismatched linked Auth identity before sending", async () => {
  const calls = installManagerFetch(async (url) => {
    if (url.includes("/employees?")) return new Response(JSON.stringify([employee({
      auth_user_id: "11111111-1111-4111-8111-111111111111"
    })]));
    throw new Error(`Unexpected URL ${url}`);
  }, {
    id: "11111111-1111-4111-8111-111111111111",
    email: "different@example.com", invited_at: "2026-11-03T12:00:00Z"
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(calls.some(call => call.url.includes("/auth/v1/invite")), false);
  assert.equal(calls.some(call => call.options.method === "PATCH"), false);
});

test("activated employees cannot be resent an activation invitation", async () => {
  const calls = installManagerFetch(async url => {
    if (url.includes("/employees?id=eq.employee-1")) {
      return new Response(JSON.stringify([employee({
        invitation_status: "Account Activated", activated_at: "2026-10-02T00:00:00Z"
      })]));
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(calls.some(call => call.url.includes("/auth/v1/invite")), false);
});

test("an existing Auth conflict on resend preserves the linked profile and reports the conflict accurately", async () => {
  const calls = installManagerFetch(async url => {
    if (url.includes('/employees?')) return new Response(JSON.stringify([employee({auth_user_id:'original-user'})]));
    if (url.includes('/auth/v1/invite')) return new Response(JSON.stringify({message:'User already registered'}),{status:422});
    throw new Error('Unexpected write after Auth conflict');
  });
  const res=responseRecorder();
  await resendHandler(request('POST',{id:'employee-1'}),res);
  assert.equal(res.statusCode,409);
  assert.match(res.payload.error,/verify account ownership/);
  assert.doesNotMatch(res.payload.error,/no employee profile/);
  assert.equal(calls.some(call=>['PATCH','DELETE'].includes(call.options.method)),false);
});

test("invitation creation never reports success for missing, ambiguous or incorrectly linked saved profiles", async () => {
  for (const saved of [[], {}, [employee(), employee()], [employee({auth_user_id:'different-user'})]]) {
    installManagerFetch(async (url, options) => {
      if (url.includes('/employees?')) return new Response('[]');
      if (url.includes('/auth/v1/invite')) return new Response(JSON.stringify({id:'11111111-1111-4111-8111-111111111111',email:'ada@example.com'}));
      if (options.method === 'POST') return new Response(JSON.stringify(saved));
      throw new Error('Unexpected request');
    });
    const res = responseRecorder();
    await invitationHandler(request('POST', input()), res);
    assert.equal(res.statusCode, 500);
    assert.notEqual(res.payload.success, true);
  }
});

test("an invitation sent before a failed employee write requires reconciliation, never blind retry", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?")) return new Response("[]");
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({id:"11111111-1111-4111-8111-111111111111",email:"ada@example.com"}));
    if (url.endsWith("/rest/v1/employees") && options.method === "POST") {
      return new Response(JSON.stringify({message:"database temporarily unavailable"}), {status:503});
    }
    throw new Error("Unexpected request");
  });
  const res = responseRecorder();
  await invitationHandler(request("POST", input()), res);
  assert.equal(res.statusCode, 500);
  assert.notEqual(res.payload.success, true);
  assert.match(res.payload.error, /invitation may have been sent/i);
  assert.match(res.payload.error, /Do not retry or resend/i);
  assert.doesNotMatch(res.payload.error, /database temporarily unavailable/i);
  assert.equal(calls.filter(call => call.url.includes("/auth/v1/invite")).length, 1);
  assert.equal(calls.filter(call => call.options.method === "POST" && call.url.endsWith("/rest/v1/employees")).length, 1);
});

test("an unlinked employee cannot receive a misleading resend", async () => {
  const calls = installManagerFetch(async () => new Response(JSON.stringify([employee({auth_user_id:null})])));
  const res = responseRecorder();
  await resendHandler(request('POST', {id:'employee-1'}), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /link needs repair/);
  assert.equal(calls.some(call => call.url.includes('/auth/v1/invite')), false);
});

test("resend preserves the employee identity when Auth returns a different user", async () => {
  const calls = installManagerFetch(async url => {
    if (url.includes('/employees?')) return new Response(JSON.stringify([employee({auth_user_id:'original-user'})]));
    if (url.includes('/auth/v1/invite')) return new Response(JSON.stringify({id:'different-user',email:'ada@example.com'}));
    throw new Error('Unexpected request');
  });
  const res = responseRecorder();
  await resendHandler(request('POST', {id:'employee-1'}), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /may have been sent/i);
  assert.match(res.payload.error, /do not retry or resend|administrator review required/i);
  assert.equal(calls.some(call => call.options.method === 'PATCH'), false);
});

test("a failed resend status update warns that an email may already have been sent", async () => {
  const calls = installManagerFetch(async (url, options) => {
    if (url.includes("/employees?") && options.method !== "PATCH") {
      return new Response(JSON.stringify([employee({ auth_user_id: "11111111-1111-4111-8111-111111111111" })]));
    }
    if (url.includes("/auth/v1/invite")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" }));
    }
    if (options.method === "PATCH") {
      return new Response(JSON.stringify({ message: "database unavailable" }), { status: 503 });
    }
    throw new Error("Unexpected request");
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.equal(res.statusCode, 500);
  assert.notEqual(res.payload.success, true);
  assert.match(res.payload.error, /invitation may have been sent/i);
  assert.match(res.payload.error, /Do not retry or resend/i);
  assert.doesNotMatch(res.payload.error, /database unavailable/i);
  assert.equal(calls.filter(call => call.url.includes("/auth/v1/invite")).length, 1);
  assert.equal(calls.filter(call => call.options.method === "PATCH").length, 1);
});

test("a concurrent activation cannot be overwritten by the resend status update", async () => {
  installManagerFetch(async (url, options) => {
    if (url.includes('/auth/v1/invite')) return new Response(JSON.stringify({id:'11111111-1111-4111-8111-111111111111',email:'ada@example.com'}));
    if (options.method === 'PATCH') {
      assert.match(url, /activated_at=is\.null/);
      assert.match(url, /invitation_status=neq\.Account%20Activated/);
      return new Response('[]'); // PostgREST finds no row after concurrent activation.
    }
    return new Response(JSON.stringify([employee({auth_user_id:'11111111-1111-4111-8111-111111111111'})]));
  });
  const res = responseRecorder();
  await resendHandler(request('POST', {id:'employee-1'}), res);
  assert.equal(res.statusCode, 500);
  assert.notEqual(res.payload.success, true);
  assert.match(res.payload.error, /Do not retry or resend/i);
});

test("server credentials never appear in Manager Portal browser code", () => {
  const browserSource = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.doesNotMatch(browserSource, /SUPABASE_SECRET_KEY|server-secret-never-public|service_role/);
  assert.match(browserSource, /Authorization:`Bearer \$\{session\.access_token\}`/);
});

test("employee list is the default Employees view and add/edit exposes mobile and hire date", () => {
  const browserSource = fs.readFileSync(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(browserSource, /id="employeeModal" hidden/);
  assert.match(browserSource, /<label for="mobile">Mobile Number<\/label>/);
  assert.match(browserSource, /<label for="hireDate">Hire Date<\/label>/);
  assert.match(browserSource, /mobile:\$\("mobile"\)\.value\.trim\(\)/);
  assert.match(browserSource, /hireDate:\$\("hireDate"\)\.value/);
  assert.match(browserSource, /\["mobile","mobile"\]/);
  assert.match(browserSource, /\["hireDate","hire_date"\]/);
});
import {PostgrestResponse as Response} from "./_postgrest-response.mjs";


test("administrator renewal rejects invitations older than 21 days before contacting Auth", async () => {
  const calls = installManagerFetch(async url => {
    if (url.includes("/employees?")) return new Response(JSON.stringify([employee({
      auth_user_id: "11111111-1111-4111-8111-111111111111",
      invited_at: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString()
    })]));
    throw new Error("Expired renewal must not call Auth or update records");
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /21-day/);
  assert.equal(calls.some(call => call.url.includes("/auth/v1/invite")), false);
  assert.equal(calls.some(call => call.options.method === "PATCH"), false);
});


test("resend queries original invited_at for 21-day eligibility", async () => {
  const calls = installManagerFetch(async url => {
    if (url.includes("/employees?")) return new Response(JSON.stringify([employee({
      auth_user_id: "11111111-1111-4111-8111-111111111111"
    })]));
    if (url.includes("/auth/v1/invite")) return new Response(JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com"
    }));
    if (url.includes("/rest/v1/employees") && url.includes("auth_user_id=eq.")) return new Response(JSON.stringify([employee()]));
    throw new Error("Unexpected request");
  });
  const res = responseRecorder();
  await resendHandler(request("POST", { id: "employee-1" }), res);
  assert.ok(calls.some(call => call.url.includes("/employees?") && call.url.includes("invited_at")));
});
