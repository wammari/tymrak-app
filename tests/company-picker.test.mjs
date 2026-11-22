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
