import assert from "node:assert/strict";
import { test } from "node:test";

import { ArcticShiftError, QueryTimeout, ServerBusy } from "../core.js";
import {
  describeRule,
  explain,
  formatAge,
  formatDuration,
  formatEta,
  plural,
  requestsText,
  timelineText,
  tookText,
} from "../format.js";

test.skip("plural", () => {
  assert.deepEqual([plural(0, "user"), plural(1, "user"), plural(2, "user")], ["0 users", "1 user", "2 users"]);
});

test("formatEta rounds up, coarser as the wait grows", () => {
  const cases = [
    [null, "estimating time left…"], [3, "almost done"], [12, "about 15 s left"], [60, "about 1 min left"],
    [95, "about 1 min 40 s left"], [600, "about 10 min left"], [3599, "about 1 h left"], [3700, "about 1 h 2 min left"],
  ];
  for (const [s, text] of cases) assert.equal(formatEta(s), text, String(s));
});

test("formatDuration", () => {
  const cases = [[4.24, "4.2 s"], [38.4, "38 s"], [60, "1 min"], [98, "1 min 38 s"], [3600, "1 h"], [3900, "1 h 5 min"]];
  for (const [s, text] of cases) assert.equal(formatDuration(s), text, String(s));
});

test("formatAge", () => {
  const cases = [[0.5, "less than a day"], [1, "1 day"], [13, "13 days"], [20, "2 weeks"], [90, "2 months"], [800, "2 years"]];
  for (const [d, text] of cases) assert.equal(formatAge(d), text, String(d));
});

test("requestsText leaves out archive requests a scan didn't count", () => {
  assert.equal(requestsText(1, null), "1 Arctic Shift request");
  assert.equal(requestsText(1, undefined), "1 Arctic Shift request");
  assert.equal(requestsText(5, 0), "5 Arctic Shift requests and 0 archive requests");
});

test("tookText", () => {
  assert.equal(tookText({ seconds: 70, profilingSeconds: null }), "1 min 10 s");
  assert.equal(tookText({ seconds: 70, profilingSeconds: 65 }), "1 min 10 s (profiling 1 min 5 s)");
});

test("describeRule", () => {
  assert.equal(describeRule({ count: 1, days: 0, tenure: 0 }), "1+ post or comment");
  assert.equal(describeRule({ count: 0, days: 0, tenure: 0 }), "1+ posts and comments"); // 0 still means at least 1
  assert.equal(describeRule({ count: 8, days: 3, tenure: 30 }), "8+ posts and comments, on 3+ different days, the first 30+ days before");
});

test("timelineText", () => {
  assert.equal(timelineText({ days: null }), " (no timeline saved, so the badge goes by the count alone)");
  assert.equal(timelineText({ days: 1, exact: true, tenureDays: null }), ", on 1 day");
  assert.equal(timelineText({ days: 5, exact: false, tenureDays: 20 }), ", on at least 5 different days, the first 2 weeks before");
});

test("explain turns errors into plain advice", () => {
  assert.match(explain(new ServerBusy("x", 422)), /overloaded/);
  assert.match(explain(new QueryTimeout("x", 422)), /couldn't count/);
  assert.match(explain(new ArcticShiftError("x", 429)), /limiting requests/);
  assert.match(explain(new ArcticShiftError("x", null)), /Couldn't reach Arctic Shift/);
  assert.equal(explain(new ArcticShiftError("x", 503)), "Arctic Shift returned an error (HTTP 503).");
  assert.equal(explain(new Error("Something else")), "Something else");
});
