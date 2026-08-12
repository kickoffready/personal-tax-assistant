#!/usr/bin/env node
/**
 * Inline ledger.js into the standalone ledger.html artifact.
 *
 * Usage:
 *   node build-ledger.js
 *   node build-ledger.js --check
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE_PATH = path.join(__dirname, "ledger.js");
const HTML_PATH = path.join(__dirname, "ledger.html");
const START_MARKER = "/* BEGIN GENERATED: ledger.js */";
const END_MARKER = "/* END GENERATED: ledger.js */";

function normaliseNewlines(value) {
  return value.replace(/\r\n?/g, "\n");
}

function normaliseSource(source) {
  const normalised = normaliseNewlines(source);
  return normalised.endsWith("\n") ? normalised : normalised + "\n";
}

function countOccurrences(value, needle) {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

function validateSource(source) {
  if (/<\/script/i.test(source)) {
    throw new Error("ledger.js contains </script, which cannot be safely inlined into HTML");
  }
  if (source.includes(START_MARKER) || source.includes(END_MARKER)) {
    throw new Error("ledger.js must not contain the generated artifact markers");
  }
}

function generatedRange(html) {
  const startCount = countOccurrences(html, START_MARKER);
  const endCount = countOccurrences(html, END_MARKER);
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `ledger.html must contain exactly one generated marker pair (found ${startCount} start, ${endCount} end)`
    );
  }

  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  if (end <= start) {
    throw new Error("ledger.html generated markers are out of order");
  }
  return { start, end };
}

function extractGeneratedSource(html) {
  const normalisedHtml = normaliseNewlines(html);
  const { start, end } = generatedRange(normalisedHtml);
  const contentStart = start + START_MARKER.length;
  const generated = normalisedHtml.slice(contentStart, end);
  if (!generated.startsWith("\n") || !generated.endsWith("\n")) {
    throw new Error("ledger.html generated markers and source must each be on their own lines");
  }
  return generated.slice(1);
}

function renderLedgerHtml(html, source) {
  validateSource(source);
  const normalisedHtml = normaliseNewlines(html);
  const { start, end } = generatedRange(normalisedHtml);
  const replacement = `${START_MARKER}\n${normaliseSource(source)}${END_MARKER}`;
  return normalisedHtml.slice(0, start) + replacement + normalisedHtml.slice(end + END_MARKER.length);
}

function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args[0] && args[0] !== "--check")) {
    throw new Error("Usage: node build-ledger.js [--check]");
  }

  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const expected = renderLedgerHtml(html, source);

  if (args[0] === "--check") {
    if (normaliseNewlines(html) !== expected) {
      console.error("ledger.html is out of date; run node build-ledger.js");
      process.exitCode = 1;
      return;
    }
    console.log("ledger.html is in sync with ledger.js");
    return;
  }

  if (normaliseNewlines(html) === expected) {
    console.log("ledger.html is already in sync");
    return;
  }

  const temporaryPath = path.join(__dirname, `.ledger.html.tmp-${process.pid}`);
  try {
    fs.writeFileSync(temporaryPath, expected, "utf8");
    fs.renameSync(temporaryPath, HTML_PATH);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  console.log("Generated ledger.html from ledger.js");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  END_MARKER,
  START_MARKER,
  extractGeneratedSource,
  normaliseNewlines,
  normaliseSource,
  renderLedgerHtml,
  validateSource
};
