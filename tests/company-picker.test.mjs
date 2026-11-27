import test from "node:test";
import assert from "node:assert/strict";
import { needsCompanyChoice } from "../company-picker.js";

test("admin pages ask which business when none is chosen, or the chosen one isn't theirs to manage", () => {
  assert.equal(needsCompanyChoice({ authorized: true, organizationId: "o1", role: "admin" }), false);
  assert.equal(needsCompanyChoice({ authorized: false, selectionRequired: true, organizationId: null, role: null }), true);
  assert.equal(needsCompanyChoice({ authorized: true, organizationId: "o1", role: "manager" }), true);
  assert.equal(needsCompanyChoice({ authorized: true, organizationId: "o1", role: "manager" }, { adminOnly: false }), false);
});

test("the picker only lists businesses the person is an admin of, as text", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../company-picker.js", import.meta.url), "utf8");
  assert.match(src, /filter\(company => !adminOnly \|\| company\.role === "admin"\)/);
  assert.doesNotMatch(src, /innerHTML/);
});

test("every page shows the support email from one shared script", async () => {
  const fs = await import("node:fs");
  const root = new URL("../", import.meta.url);
  const pages = fs.readdirSync(root).filter(name => name.endsWith(".html"));
  assert.ok(pages.length >= 14);
  for (const page of pages) assert.match(fs.readFileSync(new URL(page, root), "utf8"), /<script src="\/support\.js" defer><\/script><\/head>/, page);
  const script = fs.readFileSync(new URL("support.js", root), "utf8");
  assert.match(script, /SUPPORT_EMAIL = "info@tymrak\.com"/);
  assert.doesNotMatch(script, /innerHTML/);
  const { publicAssets } = await import("../cloudflare/public-assets.mjs");
  assert.ok(publicAssets.includes("support.js"));
});
