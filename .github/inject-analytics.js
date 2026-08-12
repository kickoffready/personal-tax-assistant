#!/usr/bin/env node
/**
 * Adds the analytics tag to every page, at publish time.        run: node .github/inject-analytics.js
 *
 * The tag is deliberately NOT committed. ledger.html is meant to be taken and kept — a tool for
 * working on your own records, offline, for as long as you are required to hold them — and a file
 * that phones home every time it opens is not that. So the repository stays clean and only the
 * hosted copy is tagged, here, at the last possible moment before upload.
 *
 * The measurement ID is not a secret: it is readable in the page source of any site using it. It
 * lives in this file rather than a repository variable so that what gets injected is visible to
 * anyone reading the repo.
 *
 * Run it against a scratch copy to see what it does; it refuses to run twice over the same file.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ID = "G-77DBRRLYT5";

const TAG = [
  '<!-- Google tag (gtag.js) — injected at deploy, not committed. Measures the visit: page,',
  '     referrer, approximate location, device. It never reads the ledger, which lives in a file',
  '     you load and save yourself and is sent nowhere. The copy of this page in the repository',
  '     carries no tag at all. -->',
  `<script async src="https://www.googletagmanager.com/gtag/js?id=${ID}"></script>`,
  "<script>",
  "  window.dataLayer = window.dataLayer || [];",
  "  function gtag(){dataLayer.push(arguments);}",
  "  gtag('js', new Date());",
  "",
  `  gtag('config', '${ID}');`,
  "</script>",
  ""
].join("\n");

const dir = process.argv[2] || ".";
const pages = fs.readdirSync(dir).filter(name => name.endsWith(".html"));
if (!pages.length) throw new Error(`no HTML to publish in ${path.resolve(dir)} — wrong directory?`);

for (const page of pages) {
  const file = path.join(dir, page);
  const html = fs.readFileSync(file, "utf8");
  // Both of these mean the repo has drifted from what this script assumes, and both are worth
  // failing the deploy over: a silently untagged page reads as no traffic at all, and a page
  // tagged twice double-counts every visit. Either would be discovered weeks later, in the data.
  if (!html.includes("</head>")) throw new Error(`${page} has no </head> to inject into`);
  if (html.includes(ID)) throw new Error(`${page} already carries the tag — it must not be committed`);
  fs.writeFileSync(file, html.replace("</head>", TAG + "</head>"));
  console.log("tagged " + page);
}
