// Explicit local configuration for mocked API tests; never inherit hosted targets.
import test from "node:test";
test.beforeEach(() => {
  process.env.SITE_URL = "http://localhost:3000";
  process.env.APP_ENV = "development";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_local_test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.SUPABASE_EXPECTED_PROJECT_REF;
});
