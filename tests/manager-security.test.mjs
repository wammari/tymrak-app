import assert from "node:assert/strict";
import test from "node:test";
import {
  getBearerToken,
  requireManager
} from "../api/_manager-auth.js";
import { validateInvitationInput } from "../api/send-invitation.js";
import invitationHandler from "../api/send-invitation.js";

test("bearer tokens are required", () => {
  assert.equal(getBearerToken({ headers: {} }), null);
  assert.equal(
    getBearerToken({ headers: { authorization: "Basic abc" } }),
    null
  );
  assert.equal(
    getBearerToken({ headers: { authorization: "Bearer token" } }),
    "token"
  );
});

test("anonymous invitation requests are rejected before privileged work", async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  };
  const response = {
    statusCode: null,
    payload: null,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };

  try {
    await invitationHandler({ method: "POST", headers: {}, body: {} }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.payload.error, "Authentication required");
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("invitation fields are normalized and validated", () => {
  const valid = validateInvitationInput({
    email: " Manager@Example.COM ",
    firstName: " Ada ",
    lastName: " Lovelace ",
    username: "ada.lovelace",
    position: "Engineer",
    department: "Technology",
    province: "ab"
  });

  assert.equal(valid.input.email, "manager@example.com");
  assert.equal(valid.input.firstName, "Ada");
  assert.equal(valid.input.province, "AB");
  assert.match(
    validateInvitationInput({ ...valid.input, province: "XX" }).error,
    /valid province/
  );
  assert.match(
    validateInvitationInput({ ...valid.input, username: "bad user" }).error,
    /Username/
  );
});

test("authenticated employees are not authorized as managers", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "server-secret";

  global.fetch = async url => {
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "employee-id", email: "e@example.com" }));
    }
    return new Response(JSON.stringify([{ role: "employee" }]));
  };

  try {
    const result = await requireManager({
      headers: { authorization: "Bearer employee-token" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("explicit manager roles are authorized", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_server-key";
  const requests = [];

  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "manager-id", email: "m@example.com" }));
    }
    return new Response(JSON.stringify([{ role: "manager" }]));
  };

  try {
    const result = await requireManager({
      headers: { authorization: "Bearer manager-token" }
    });
    assert.equal(result.ok, true);
    assert.equal(result.role, "manager");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.headers.apikey, "sb_secret_server-key");
    assert.equal(requests[0].options.headers.Authorization, "Bearer manager-token");
    assert.deepEqual(requests[1].options.headers, {
      apikey: "sb_secret_server-key"
    });
    assert.notEqual(
      requests[1].options.headers.Authorization,
      "Bearer sb_secret_server-key"
    );
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("role lookup failures log safe Supabase diagnostics without credentials", async () => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_must-not-be-logged";
  const errorLogs = [];

  global.fetch = async url => {
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "manager-id", email: "m@example.com" }));
    }
    return new Response(
      JSON.stringify({ code: "PGRST301", message: "Permission denied" }),
      { status: 401 }
    );
  };
  console.error = (...args) => errorLogs.push(args);

  try {
    await assert.rejects(
      requireManager({
        headers: { authorization: "Bearer user-token-must-not-be-logged" }
      }),
      /Manager role lookup failed/
    );
    assert.deepEqual(errorLogs, [[
      "Manager role lookup rejected",
      {
        stage: "role_response",
        userId: "manager-id",
        status: 401,
        code: "PGRST301",
        message: "Permission denied"
      }
    ]]);
    const serializedLogs = JSON.stringify(errorLogs);
    assert.doesNotMatch(serializedLogs, /sb_secret_/);
    assert.doesNotMatch(serializedLogs, /user-token-must-not-be-logged/);
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
    process.env = originalEnv;
  }
});
