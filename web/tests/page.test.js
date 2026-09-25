// Checks that index.html agrees with the code's constants, so the help text and the form
// can't drift from what the page actually does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { HISTORY_YEARS, LARGE_SCAN, SCAN_DEFAULTS } from "../core.js";
import { MAX_WAITING, QUEUE_CONCURRENCY } from "../queue.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("numbers in the help text match the constants they describe", () => {
  const constants = { LARGE_SCAN, MAX_WAITING, QUEUE_CONCURRENCY, cacheDays: SCAN_DEFAULTS.cacheDays };
  const found = [...html.matchAll(/<span data-const="(\w+)">([^<]*)<\/span>/g)];
  assert.ok(found.length >= 5, "the help text's numbers are marked with data-const");
  for (const [, name, text] of found) {
    assert.ok(name in constants, `unknown data-const ${name}`);
    assert.equal(text, String(constants[name]), name);
  }
});

test("the history window options are HISTORY_YEARS", () => {
  const select = html.match(/<select id="years"[^>]*>([\s\S]*?)<\/select>/)[1];
  const values = [...select.matchAll(/<option value="(\d*)">/g)].map(([, v]) => v);
  assert.deepEqual(values.filter(Boolean).map(Number).sort((a, b) => a - b), [...HISTORY_YEARS].sort((a, b) => a - b));
});
