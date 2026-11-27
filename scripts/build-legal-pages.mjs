// Builds the public Privacy Policy and Terms of Use pages (privacy.html, terms.html) from
// the drafts in docs/legal-drafts, so the lawyer's edits to the Markdown carry straight over.
//
//   node scripts/build-legal-pages.mjs           final pages: refuses while any blank remains
//   node scripts/build-legal-pages.mjs --draft   preview: blanks highlighted, "Draft" banner,
//                                                hidden from search engines
//
// Only the public part of each draft is used (everything after the reviewer notes, from the
// "# Privacy Policy" / "# Terms of Use" heading on). Blanks are written in square brackets:
// [DATE], [30], [REVIEWER: ...].
import fs from "node:fs";
import { marked } from "marked";

const draft = process.argv.includes("--draft");
const root = new URL("../", import.meta.url);
const pages = [
  { source: "docs/legal-drafts/privacy-policy-draft.md", heading: "# Privacy Policy", output: "privacy.html", title: "Privacy Policy" },
  { source: "docs/legal-drafts/terms-of-use-draft.md", heading: "# Terms of Use", output: "terms.html", title: "Terms of Use" }
];
const BLANK = /\[(DATE|REVIEWER:[^\]]*|\d+)\]/g;

export function publicPart(markdown, heading) {
  const start = markdown.split("\n").findIndex(line => line.trim() === heading);
  if (start < 0) throw new Error(`Heading "${heading}" not found`);
  return markdown.split("\n").slice(start).join("\n").trim();
}

// The drafts wrap long paragraphs onto several lines, so single line breaks are joined. Two
// kinds of lines must stay separate: "**Label:** value" lines, and the address in the
// Contact section. Those get a Markdown hard break.
export function keepLines(markdown) {
  const lines = markdown.split("\n");
  let inContact = false;
  return lines.map((line, i) => {
    if (line.startsWith("#")) inContact = /Contact\s*$/.test(line);
    const next = lines[i + 1] ?? "";
    const label = /^\*\*[^*]+:\*\*/;
    const breakAfter = line.trim() && next.trim() && !next.startsWith("#") && !/^[-|>]/.test(next.trim()) &&
      (label.test(next) || (inContact && !line.startsWith("#")));
    return breakAfter ? `${line}  ` : line;
  }).join("\n");
}

export function blanks(text) {
  return [...text.matchAll(BLANK)].map(m => m[0]);
}

export function render({ title, body, isDraft }) {
  const banner = isDraft ? `<div class="draft-banner" role="note"><strong>Draft for review.</strong> This page is not in effect yet. Highlighted items are still to be decided.</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | TYMRAK</title>${isDraft ? `\n<meta name="robots" content="noindex">` : ""}
<meta name="theme-color" content="#351b0c"><link rel="stylesheet" href="/tymrak-theme.css">
<style>body{font:16px/1.6 system-ui;background:#fbf8f3;color:#35271e;margin:0}main{max-width:820px;margin:32px auto;padding:24px}a{color:#70400e}
article{background:white;border:1px solid #e4d7c7;border-radius:12px;padding:28px 32px}article h1{margin-top:0;font-size:30px}article h2{margin-top:30px;font-size:20px}
table{width:100%;border-collapse:collapse;margin:12px 0 18px;font-size:14px}th,td{border:1px solid #e4d7c7;padding:8px 10px;text-align:left;vertical-align:top}th{background:#f6efe6}
.blank{background:#fff1a8;padding:0 3px;border-radius:3px}.draft-banner{background:#fff4df;color:#70400e;border-radius:8px;padding:12px 14px;margin:0 0 16px}
.legal-nav{display:flex;gap:16px;margin:0 0 16px;font-size:15px}@media(max-width:640px){main{padding:14px}article{padding:20px}}
@media print{body{background:white}main{margin:0;max-width:none;padding:0}article{border:0;padding:0}.legal-nav,.brand-home{display:none}}</style><script src="/support.js" defer></script></head>
<body class="workspace-page"><main><a class="brand-home" href="/" aria-label="TYMRAK home"><span class="tymrak-brand-mark"><img src="/tymrak-logo.png" alt="TYMRAK — Time. Tracked Right." width="526" height="396"></span></a>
<nav class="legal-nav" aria-label="Legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Use</a></nav>
${banner}<article>
${body}
</article></main></body></html>
`;
}

function build() {
  const missing = [];
  for (const page of pages) {
    const markdown = publicPart(fs.readFileSync(new URL(page.source, root), "utf8"), page.heading);
    const open = blanks(markdown);
    if (open.length && !draft) { missing.push(`${page.source}: ${[...new Set(open)].join(", ")}`); continue; }
    let html = marked.parse(keepLines(markdown.replace(/\s*\[REVIEWER:[^\]]*\]/g, "")));
    if (draft) html = html.replace(BLANK, m => `<mark class="blank">${m}</mark>`);
    fs.writeFileSync(new URL(page.output, root), render({ title: page.title, body: html.trim(), isDraft: draft }));
    console.log(`Wrote ${page.output}${draft ? " (draft)" : ""}`);
  }
  if (missing.length) {
    console.error(`Not built: these blanks still need the lawyer's answer:\n- ${missing.join("\n- ")}\nRun with --draft for a preview.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) build();
