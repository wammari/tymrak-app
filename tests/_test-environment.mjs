// Explicit local configuration for mocked API tests; never inherit hosted targets.
import test from "node:test";
test.beforeEach(() => {
  process.env.APP_ENV = "development";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.SUPABASE_EXPECTED_PROJECT_REF;
});
