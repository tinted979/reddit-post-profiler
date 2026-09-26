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

test("plural", () => {
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

// The end-of-scan note on what the archive answered. Files end at FILES, the post is at POST.
const { archiveNote } = await import("../format.js");
const FILES = 1_000_000;
const noteFor = (post, { tailed = FILES, tailRequests = 0, ...counters } = {}) => archiveNote({
  post: { createdUtc: post },
  archive: { name: "Python", postsThrough: FILES + 50, commentsThrough: FILES },
  tailed: { postsThrough: tailed, commentsThrough: tailed + 50 },
  tailRequests,
  dumps: { broken: false, reads: 1, lifetimeReads: 0, lifetimeGaps: 0, threadReads: 0, ...counters },
  date: (t) => `<${t}>`,
});

test("archiveNote: a post older than where the files end took its before facts from them alone", () => {
  // Not "up to" a date after the post, and nothing about tails, even one an earlier scan left.
  assert.equal(noteFor(FILES - 10, { tailed: FILES + 500 }), " Activity in r/Python before the post came from archive files.");
});

test("archiveNote credits the whole-subreddit fetch only when it reached the post", () => {
  const post = FILES + 1000;
  const upTo = ` Activity in r/Python before the post, up to <${FILES}>, came from archive files.`;
  assert.equal(noteFor(post, { tailed: post - 1, tailRequests: 3 }),
    `${upTo} Activity from then to the post came from 3 requests for the whole subreddit rather than for each user.`);
  assert.equal(noteFor(post, { tailed: FILES + 400, tailRequests: 3 }),
    `${upTo} Activity after that came from 3 requests for the whole subreddit, up to <${FILES + 400}>, and from Arctic Shift for each user for the rest.`);
  assert.equal(noteFor(post, { tailed: post - 1 }),
    `${upTo} Activity from then to the post came from what an earlier scan in this tab fetched for the whole subreddit.`);
  assert.equal(noteFor(post, { tailed: FILES + 400 }),
    `${upTo} Activity after that came from what an earlier scan in this tab fetched for the whole subreddit, up to <${FILES + 400}>, and from Arctic Shift for each user for the rest.`);
  assert.equal(noteFor(post), `${upTo} Activity after that came from Arctic Shift for each user.`);
});

test("archiveNote: counts and threads from the files, a broken archive, and nothing read", () => {
  const post = FILES - 10;
  assert.equal(noteFor(post, { reads: 0, lifetimeReads: 2 }), " Subreddit counts came from the archive files.");
  assert.equal(noteFor(post, { reads: 0, lifetimeReads: 2, lifetimeGaps: 1 }),
    " Subreddit counts came from the archive files, plus Arctic Shift for anything between where they end and the post.");
  assert.equal(noteFor(post, { reads: 0, threadReads: 1 }), " The thread's comments came from the archive files, plus Arctic Shift for those made since.");
  // It names the subreddit whose files failed, which may not be the post's (a scan limited to others).
  assert.equal(noteFor(post, { broken: true, brokenSubreddit: "Python" }),
    " The archive stopped answering partway (reading r/Python's files), so Arctic Shift answered for the rest.");
  assert.equal(noteFor(post, { broken: true, brokenSubreddit: "rust" }),
    " The archive stopped answering partway (reading r/rust's files), so Arctic Shift answered for the rest.");
  assert.equal(noteFor(post, { reads: 0 }), "");
});
