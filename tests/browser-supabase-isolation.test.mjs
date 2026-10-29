import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { getClientSupabaseConfiguration } from "../client-supabase-config.js";

const staging = getClientSupabaseConfiguration("tymrak-staging.vercel.app");
const production = getClientSupabaseConfiguration("tymrak.com");

test("staging and production hosts resolve to separate Supabase projects", () => {
  assert.equal(staging.url, "https://ctztwqcsizwkrqgpgrgg.supabase.co");
  assert.equal(production.url, "https://tsosredghislnehfyypi.supabase.co");
  assert.notEqual(staging.url, production.url);
  assert.notEqual(staging.publishableKey, production.publishableKey);
  for (const hostname of [
    "tymrak-staging.vercel.app",
    "tymrak-staging-wammari.vercel.app",
    "tymrak-staging-1p4wgq5ck-wammari.vercel.app",
    "localhost",
    "127.0.0.1"
  ]) assert.deepEqual(getClientSupabaseConfiguration(hostname), staging);
  for (const hostname of [
    "tymrak.com",
    "www.tymrak.com",
    "tymrak.vercel.app",
    "tymrak-wammari.vercel.app",
    "tymrak-4i145qnog-wammari.vercel.app"
  ]) assert.deepEqual(getClientSupabaseConfiguration(hostname), production);
});

test("unknown hosts fail closed instead of defaulting to production", () => {
  for (const hostname of ["", "example.com", "tymrak-staging.attacker.com", "other.vercel.app"]) {
    assert.throws(() => getClientSupabaseConfiguration(hostname), /not configured/);
  }
});

test("every browser auth and punch page uses shared host-specific config", () => {
  const pages = [
    "employee.html", "timecard.html", "activate.html", "login.html",
    "manager-login.html", "reset-password.html", "manager.html"
  ];
  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(html, /from "\/client-supabase-config\.js"/, page);
    assert.doesNotMatch(html, /https:\/\/(?:tsosredghislnehfyypi|ctztwqcsizwkrqgpgrgg)\.supabase\.co/, page);
  }
});
