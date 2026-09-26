// "Only subreddits in the archive": a scan option that limits a scan to whatever subreddits
// the archive covers when the scan starts, plus any typed in "Only check subreddits". Arctic
// Shift still answers for what the archive doesn't cover. Share links carry it as archived=1.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_BADGES, importScan } from "../core.js";
import { DumpSource } from "../dumps.js";
import {
  archivedNote,
  mergeOptions,
  optionsSummary,
  parseOptions,
  readShareParams,
  scanOnly,
  scanOptionNotes,
  shareParams,
} from "../options.js";

test("the option comes from its checkbox, and a share link carries it as archived=1", () => {
  assert.equal(parseOptions({}).onlyArchived, false);
  const opts = parseOptions({ onlyArchived: true, only: "rust" });
  assert.deepEqual([opts.onlyArchived, opts.only], [true, ["rust"]]);
  const params = shareParams("abc123", opts);
  assert.equal(params.get("archived"), "1");
  assert.equal(params.get("subs"), "rust");
  const { fields } = readShareParams(params);
  assert.deepEqual(parseOptions(fields), opts);
  // Only "1" turns it on; a link without it, or with anything else, leaves it off.
  assert.equal(readShareParams(new URLSearchParams("post=x&archived=0")).fields.onlyArchived, false);
  assert.equal(readShareParams(new URLSearchParams("post=x")).fields.onlyArchived, false);
  assert.equal(shareParams("abc123", parseOptions({})).has("archived"), false);
});

test("queued and saved options keep it only as a real boolean", () => {
  const base = parseOptions({});
  assert.equal(mergeOptions(base, { onlyArchived: true }).onlyArchived, true);
  assert.equal(mergeOptions({ ...base, onlyArchived: true }, {}).onlyArchived, true); // an older item: the form's
  assert.equal(mergeOptions(base, { onlyArchived: "yes" }).onlyArchived, false);
});

test("a scan is limited to the archive's subreddits now, plus the typed ones", () => {
  const typed = parseOptions({ only: "rust, Python" });
  assert.deepEqual(scanOnly(typed, ["Hasan_Piker"]), ["rust", "Python"]); // off: the box alone
  const on = { ...typed, onlyArchived: true };
  assert.deepEqual(scanOnly(on, ["Hasan_Piker", "python"]), ["rust", "Python", "Hasan_Piker"]); // no repeats, any case
  assert.deepEqual(scanOnly({ ...on, only: [] }, ["Hasan_Piker"]), ["Hasan_Piker"]);
  // The archive's list couldn't be read: the scan can't be limited as asked.
  assert.equal(scanOnly(on, null), null);
});

test("the options summary, saved-scan notes and the note by the checkbox say so", () => {
  const on = parseOptions({ onlyArchived: true });
  assert.equal(optionsSummary(on, DEFAULT_BADGES), "only archived subreddits");
  assert.equal(optionsSummary({ ...on, only: ["rust"] }, DEFAULT_BADGES), "only archived subreddits and r/rust");
  assert.deepEqual(scanOptionNotes({ onlyArchived: true, only: ["rust"] }), ["only archived subreddits and r/rust"]);
  assert.deepEqual(scanOptionNotes({ onlyArchived: true }), ["only archived subreddits"]);
  assert.equal(archivedNote(["Hasan_Piker"]), "Now 1: r/Hasan_Piker.");
  assert.equal(archivedNote(["a1", "b2", "c3", "d4", "e5", "f6", "g7"]), "Now 7: r/a1, r/b2, r/c3, r/d4, r/e5 and 2 more.");
  assert.equal(archivedNote(null), "The archive's list couldn't be read just now; a scan will try again.");
});

test("DumpSource lists the subreddits it covers, as the manifest names them, in order", () => {
  const subs = new Map([["zeta", { name: "Zeta" }], ["hasan_piker", { name: "Hasan_Piker" }], ["alpha", { name: "alpha" }]]);
  assert.deepEqual(new DumpSource(subs).subreddits(), ["alpha", "Hasan_Piker", "Zeta"]);
});

test("an imported saved scan keeps the option only when it's true", () => {
  const scan = (onlyArchived) => ({
    summary: {
      id: "abc123", post: { id: "abc123", author: "op", subreddit: "Python", createdUtc: 1_700_000_000, title: "t" },
      scannedAt: 1_700_000_100, opts: { only: ["rust"], onlyArchived },
    },
    profiles: [],
  });
  assert.equal(importScan(scan(true)).summary.opts.onlyArchived, true);
  assert.equal(importScan(scan("yes")).summary.opts.onlyArchived, false);
  assert.equal(importScan(scan(undefined)).summary.opts.onlyArchived, false);
});

test("the page has the checkbox, with its note", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<input id="only-archived" type="checkbox"[^>]*aria-describedby="only-archived-note[^"]*"/);
  assert.match(html, /id="only-archived-note"/);
});
