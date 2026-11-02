import "./_test-environment.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { activationRedirect, sendActivationInvite } from "../api/_employee-management.js";

test("production invitations target the password setup page, never the portal homepage", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  try {
    process.env.APP_ENV = "production";
    process.env.SITE_URL = "https://app.tymrak.com";
    process.env.VERCEL_ENV = "production";
    assert.equal(activationRedirect(), "https://app.tymrak.com/activate.html");
    let called = false;
    global.fetch = async (url, options) => {
      called = true;
      const target = new URL(url);
      assert.equal(target.pathname, "/auth/v1/invite");
      assert.equal(target.searchParams.get("redirect_to"), "https://app.tymrak.com/activate.html");
      assert.equal(options.method, "POST");
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", email: "unused-test@example.com", email_confirmed_at: null, last_sign_in_at: null, identities: [] }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    };
    await sendActivationInvite({ supabaseUrl: "https://example.supabase.co", secretKey: "sb_secret_test" }, {
      email: "unused-test@example.com", firstName: "Test", lastName: "Employee", username: "unused-test"
    });
    assert.equal(called, true);
  } finally {
    process.env = originalEnv;
    global.fetch = originalFetch;
  }
});

test("production invitation redirects reject a misconfigured site URL rather than silently falling back", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.APP_ENV = "production";
    process.env.VERCEL_ENV = "production";
    process.env.SITE_URL = "https://tymrak.vercel.app";
    assert.throws(() => activationRedirect(), /Invalid production site origin/);
  } finally {
    process.env = originalEnv;
  }
});


test("staging invitations use the stable release-branch activation page", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  try {
    process.env.APP_ENV = "staging";
    process.env.VERCEL_ENV = "preview";
    process.env.SITE_URL = "https://tymrak-staging-git-release-customer-candidate-wammari.vercel.app";
    const expected = process.env.SITE_URL + "/activate.html";
    assert.equal(activationRedirect(), expected);
    let calls = 0;
    global.fetch = async (url, options) => {
      calls++;
      const target = new URL(url);
      assert.equal(target.pathname, "/auth/v1/invite");
      assert.equal(target.searchParams.get("redirect_to"), expected);
      assert.equal(options.method, "POST");
      return new Response(JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        email: "unused-staging-test@example.com",
        email_confirmed_at: null,
        last_sign_in_at: null,
        identities: []
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await sendActivationInvite({ supabaseUrl: "https://example.supabase.co", secretKey: "sb_secret_test" }, {
      email: "unused-staging-test@example.com", firstName: "Test", lastName: "Employee", username: "unused-staging-test"
    });
    assert.equal(calls, 1);
  } finally {
    process.env = originalEnv;
    global.fetch = originalFetch;
  }
});

test("staging invitation redirects reject a production site URL before sending", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  try {
    process.env.APP_ENV = "staging";
    process.env.VERCEL_ENV = "preview";
    process.env.SITE_URL = "https://app.tymrak.com";
    let called = false;
    global.fetch = async () => { called = true; throw new Error("must not send"); };
    await assert.rejects(
      sendActivationInvite({ supabaseUrl: "https://example.supabase.co", secretKey: "sb_secret_test" }, {
        email: "unused-staging-test@example.com", firstName: "Test", lastName: "Employee", username: "unused-staging-test"
      }),
      /Invalid staging site origin/
    );
    assert.equal(called, false);
  } finally {
    process.env = originalEnv;
    global.fetch = originalFetch;
  }
});
