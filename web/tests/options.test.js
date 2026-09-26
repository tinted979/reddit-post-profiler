import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_BADGES, SCAN_DEFAULTS, SCAN_LIMITS } from "../core.js";
import {
  FIELD_IDS,
  mergeOptions,
  SHARE_PARAMS,
  optionsSummary,
  parseMinCount,
  parseOptions,
  readShareParams,
  scanOptionNotes,
  shareParams,
} from "../options.js";

const DEFAULT_OPTS = {
  includeOp: false, exclude: [], only: [], onlyArchived: false, years: null, maxUsers: null,
  delay: SCAN_DEFAULTS.delay, concurrency: SCAN_DEFAULTS.concurrency, cacheDays: SCAN_DEFAULTS.cacheDays,
};

test("empty fields give the default options", () => {
  assert.deepEqual(parseOptions({}), DEFAULT_OPTS);
});

test("fields are parsed and clamped like the form's", () => {
  const opts = parseOptions({
    includeOp: true, exclude: "u/Alice, bob  carol", only: "r/Python, rust", years: "5",
    maxUsers: "50.7", delay: "0.01", concurrency: "9", cacheDays: "Infinity",
  });
  assert.deepEqual(opts, {
    includeOp: true, exclude: ["Alice", "bob", "carol"], only: ["Python", "rust"], onlyArchived: false, years: 5, maxUsers: 50,
    delay: SCAN_LIMITS.delay.min, concurrency: SCAN_LIMITS.concurrency.max, cacheDays: SCAN_DEFAULTS.cacheDays,
  });
  assert.equal(parseOptions({ years: "3" }).years, null); // not an offered window
});

test("parseMinCount keeps whole non-negative numbers", () => {
  assert.deepEqual(["", "3", "3.9", "-2", "lots"].map(parseMinCount), [0, 3, 3, 0, 0]);
});

// The round trip a share link makes: options -> link -> the fields init fills -> options.
function roundTrip(opts, extra = {}) {
  const params = new URLSearchParams(shareParams("abc123", opts, extra).toString());
  const { post, fields } = readShareParams(params);
  return { post, fields, opts: parseOptions(fields) };
}

test("a share link carries every option back to the same options", () => {
  const cases = [
    DEFAULT_OPTS,
    { ...DEFAULT_OPTS, includeOp: true, exclude: ["alice", "bob"], only: ["Python"], years: 1, maxUsers: 300 },
    { ...DEFAULT_OPTS, delay: 2.5, concurrency: 1, cacheDays: 0 },
    { ...DEFAULT_OPTS, cacheDays: 30, years: 10, only: ["a_b", "c-d".replace("-", "_")] },
  ];
  for (const opts of cases) {
    const back = roundTrip(opts);
    assert.equal(back.post, "abc123");
    assert.deepEqual(back.opts, opts);
  }
  const rules = { ...DEFAULT_BADGES, regular: { ...DEFAULT_BADGES.regular, count: 11 } };
  const back = roundTrip(DEFAULT_OPTS, { minCount: 4, badges: rules });
  assert.equal(parseMinCount(back.fields.minCount), 4);
  assert.equal(typeof back.fields.badges, "string");
});

test("defaults are left out of a share link", () => {
  assert.equal(shareParams("abc123", DEFAULT_OPTS).toString(), "post=abc123");
});

test("every share param is both written and read", () => {
  // Setting every option to something non-default must write every param, and reading the
  // link back must find each of them: an option added on one side only fails here.
  const opts = {
    includeOp: true, exclude: ["alice"], only: ["Python"], onlyArchived: true, years: 5, maxUsers: 10,
    delay: 2, concurrency: 3, cacheDays: 1,
  };
  const rules = { ...DEFAULT_BADGES, occasional: { ...DEFAULT_BADGES.occasional, count: 1 } };
  const params = shareParams("abc123", opts, { minCount: 2, badges: rules });
  assert.deepEqual([...params.keys()].sort(), ["post", ...Object.values(SHARE_PARAMS)].sort());
  const { fields } = readShareParams(params);
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(SHARE_PARAMS).sort());
});

test("every option field id exists in the page", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const id of Object.values(FIELD_IDS)) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("optionsSummary lists what differs from the defaults", () => {
  assert.equal(optionsSummary(DEFAULT_OPTS, DEFAULT_BADGES), "");
  const custom = { ...DEFAULT_BADGES, regular: { ...DEFAULT_BADGES.regular, count: 99 } };
  assert.equal(
    optionsSummary({ ...DEFAULT_OPTS, includeOp: true, exclude: ["a"], only: ["x", "y", "z", "w"], cacheDays: 0 }, custom),
    "author included · skipping 1 user · only 4 subreddits · not saving results · custom badges",
  );
  assert.equal(optionsSummary({ ...DEFAULT_OPTS, only: ["Python"], years: 1, delay: 2 }, DEFAULT_BADGES), "only r/Python · last 1 year · 2s between requests");
});

test("mergeOptions lays stored options over the base, keeping only valid fields", () => {
  const base = { ...DEFAULT_OPTS, exclude: ["me"], only: ["Base"], years: 5, maxUsers: 50, delay: 2 };
  // A queued item's options: all fields set.
  const item = { includeOp: true, exclude: ["alice"], only: ["Python"], onlyArchived: true, years: null, maxUsers: null, delay: 1, concurrency: 1, cacheDays: 0 };
  assert.deepEqual(mergeOptions(base, item), item);
  // Missing fields (an older page's item) come from the base.
  assert.deepEqual(mergeOptions(base, { only: ["Python"] }), { ...base, only: ["Python"] });
  assert.deepEqual(mergeOptions(base, undefined), base);
  assert.deepEqual(mergeOptions(base, "nonsense"), base);
});

test("mergeOptions cleans odd stored values instead of passing them to a scan", () => {
  const odd = {
    includeOp: "yes", exclude: "alice", only: ["ok", 7, "u/x y"], years: 3, maxUsers: -4,
    delay: "fast", concurrency: 99, cacheDays: Infinity,
  };
  assert.deepEqual(mergeOptions(DEFAULT_OPTS, odd), {
    includeOp: false, // not a boolean: the base's
    exclude: [], // not a list: the base's
    only: ["ok"], // non-strings dropped, names cleaned like the form's
    onlyArchived: false, // not given: the base's
    years: null, // not an offered window
    maxUsers: null, // below 1: no cap
    delay: SCAN_DEFAULTS.delay,
    concurrency: SCAN_LIMITS.concurrency.max,
    cacheDays: SCAN_DEFAULTS.cacheDays,
  });
});

test("scanOptionNotes describes a saved scan's options", () => {
  assert.deepEqual(scanOptionNotes({ years: 5, only: ["a"], maxUsers: 20, includeOp: true, exclude: ["b", "c"] }),
    ["last 5 years", "only r/a", "top 20", "author included", "skipped b, c"]);
  assert.deepEqual(scanOptionNotes(), []);
});
