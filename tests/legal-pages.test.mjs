import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { blanks, publicPart, render } from "../scripts/build-legal-pages.mjs";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("only the public part of each draft goes on the page, never the reviewer notes", () => {
  for (const [file, heading] of [["docs/legal-drafts/privacy-policy-draft.md", "# Privacy Policy"], ["docs/legal-drafts/terms-of-use-draft.md", "# Terms of Use"]]) {
    const part = publicPart(read(file), heading);
    assert.ok(part.startsWith(heading));
    assert.doesNotMatch(part, /Notes for the reviewer|not yet publishable|DRAFT for legal review/);
  }
  for (const page of ["privacy.html", "terms.html"]) {
    const html = read(page);
    assert.doesNotMatch(html, /Notes for the reviewer|not yet publishable|\[REVIEWER/);
  }
});

test("a page with blanks left is a draft: banner shown and hidden from search engines", () => {
  for (const page of ["privacy.html", "terms.html"]) {
    const html = read(page);
    const isDraft = /class="blank"/.test(html);
    assert.equal(/Draft for review/.test(html), isDraft, page);
    assert.equal(/name="robots" content="noindex"/.test(html), isDraft, page);
  }
  assert.deepEqual(blanks("Effective [DATE], within [30] days. [REVIEWER: check] [link](/x)"), ["[DATE]", "[30]", "[REVIEWER: check]"]);
  assert.doesNotMatch(render({ title: "T", body: "<p>x</p>", isDraft: false }), /noindex|Draft for review/);
});

test("the pages have short addresses and are linked from every page's footer", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.deepEqual(vercel.rewrites, [{ source: "/privacy", destination: "/privacy.html" }, { source: "/terms", destination: "/terms.html" }]);
  const footer = read("support.js");
  assert.match(footer, /\["Privacy Policy", "\/privacy"\], \["Terms of Use", "\/terms"\]/);
  assert.match(read("cloudflare/public-assets.mjs"), /'privacy\.html', 'terms\.html'/);
  assert.match(read("docs/quickbooks-go-live.md"), /https:\/\/app\.tymrak\.com\/privacy/);
});
