// How far a scan's recent-activity fetch goes (fetchTails): its first tailBudget pages
// always, then on to the post only if the rate those pages show says finishing costs fewer
// requests than asking per commenter would (tailWorth). Counts stop at the post
// (docs/adr/0006), so that's as far as a fetch ever goes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ArcticShiftClient, INGEST_LAG, fetchTails, tailWorth } from "../core.js";
import { DumpSource } from "../dumps.js";
import { breakdownLines } from "../format.js";

const FIX = new URL("./fixtures/dumps/", import.meta.url);
const BASE = "https://dumps.test";
const MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", FIX), "utf8"));
function localBuffer(relPath) {
  const buf = readFileSync(new URL(relPath, FIX));
  return { byteLength: buf.byteLength, slice: (s, e = buf.byteLength) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + e) };
}
const openFixtures = () =>
  DumpSource.open({ baseUrl: BASE, fetchFn: async () => new Response(JSON.stringify(MANIFEST)), openFile: async (url) => localBuffer(url.slice(BASE.length + 1)) });

const COMMENTS_THROUGH = 1699990000 - INGEST_LAG;
const NOW = 1_700_100_000;
const POSTED = 1_700_000_000;
const post = (numComments) => ({ id: "abc123", author: "op_user", subreddit: "Python", createdUtc: POSTED, title: "t", numComments });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// `n` comments spread evenly from where the files end to the post, served to subreddit-wide
// searches 100 at a time (honouring `before`). Records the comment searches.
function subreddit(n) {
  const step = (POSTED - COMMENTS_THROUGH) / (n + 1);
  const rows = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, author: `u${i % 50}`, created_utc: Math.floor(COMMENTS_THROUGH + step * (i + 1)), link_id: "t3_x" }));
  const searches = [];
  const clock = { t: NOW };
  const client = new ArcticShiftClient({
    delay: 0,
    fetchFn: async (url) => {
      const u = new URL(url);
      if (u.pathname.includes("/comments/")) searches.push(u);
      const after = Number(u.searchParams.get("after"));
      const before = Number(u.searchParams.get("before") ?? Infinity);
      const mine = u.pathname.includes("/comments/") ? rows : [];
      return json({ data: mine.filter((r) => r.created_utc > after && r.created_utc < before).slice(0, Number(u.searchParams.get("limit"))) });
    },
    sleep: async (s) => { clock.t += s; },
    now: () => clock.t,
    random: () => 0.5,
  });
  return { client, searches };
}

const comments = (report) => report.find((r) => r.kind === "comments");

test("tailWorth: about a request per thread comment for an only scan, half that for a full scan, within bounds", () => {
  assert.equal(tailWorth(40, { only: true }), 40);
  assert.equal(tailWorth(40), 20);
  assert.equal(tailWorth(0, { only: true }), 2); // never below the pages always fetched
  assert.equal(tailWorth(250), 100);
  assert.equal(tailWorth(10_000, { only: true }), 100);
});

test("when finishing is projected to cost less than asking per user, the fetch goes on to the post", async () => {
  const { client, searches } = subreddit(450); // ~5 pages; tailBudget(40) is 2, tailWorth(40, only) 40
  const dumps = await openFixtures();
  const report = await fetchTails(client, dumps, post(40), { only: ["Python"], now: () => NOW });
  assert.equal(searches.length, 5);
  assert.deepEqual(comments(report), { subreddit: "Python", kind: "comments", pages: 5, budget: 40, reachedEnd: true, through: POSTED - 1, error: null });
});

test("when finishing would cost more than asking per user, it stops after the pages always fetched", async () => {
  const { client, searches } = subreddit(1_000); // ~11 pages; tailWorth(4, only) is 4
  const dumps = await openFixtures();
  const report = await fetchTails(client, dumps, post(4), { only: ["Python"], now: () => NOW });
  assert.equal(searches.length, 2);
  const c = comments(report);
  assert.equal(c.reachedEnd, false);
  assert.ok(c.projected > 4, `projected ${c.projected}`);
  assert.ok(dumps.covers("python").commentsThrough < POSTED - 1);
});

test("a full scan is worth half as much per comment as an only scan", async () => {
  const full = subreddit(1_000); // ~11 pages: more than tailWorth(12) = 6, within tailWorth(12, only) = 12
  await fetchTails(full.client, await openFixtures(), post(12), { now: () => NOW });
  assert.equal(full.searches.length, 2);
  const only = subreddit(1_000);
  const dumps = await openFixtures();
  await fetchTails(only.client, dumps, post(12), { only: ["Python"], now: () => NOW });
  assert.equal(only.searches.length, 11);
  assert.equal(dumps.covers("python").commentsThrough, POSTED - 1);
});

test("an explicit budget is a fixed number of pages, with no projection", async () => {
  const { client, searches } = subreddit(450);
  const report = await fetchTails(client, await openFixtures(), post(40), { only: ["Python"], now: () => NOW, budget: 2 });
  assert.equal(searches.length, 2);
  assert.equal(comments(report).projected, undefined);
});

test("the breakdown says when a fetch stopped because finishing would cost more", () => {
  const [, line] = breakdownLines({
    requests: 2, byLabel: new Map(), retries: new Map(), archive: null, archiveByFile: new Map(),
    tails: [{ subreddit: "Python", kind: "comments", pages: 2, budget: 4, reachedEnd: false, through: 1699986400, error: null, projected: 11 }],
  });
  assert.equal(line, "r/Python comments since the archive files: 2 of 4 pages, stopped: finishing would take about 11 pages, more than asking per user; complete up to 2023-11-14 18:26 UTC");
});
