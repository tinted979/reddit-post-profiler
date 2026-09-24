import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parquetMetadataAsync, parquetQuery } from "../hyparquet.js";
import { Aborted, INGEST_LAG } from "../core.js";
import { DUMP_FORMAT, DumpSource, DumpUnavailable, parseManifest } from "../dumps.js";

const FIX = new URL("./fixtures/dumps/", import.meta.url);

// A local file as hyparquet's AsyncBuffer (what range requests give in the browser).
function localBuffer(relPath) {
  const buf = readFileSync(new URL(relPath, FIX));
  return { byteLength: buf.byteLength, slice: (s, e = buf.byteLength) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + e) };
}

test("the saved hyparquet reads the build script's Snappy Parquet", async () => {
  const file = localBuffer("r/python/v1/comments_by_author.parquet");
  const metadata = await parquetMetadataAsync(file);
  const rows = await parquetQuery({ file, metadata, columns: ["author", "created_utc"], filter: { author: { $eq: "alice" } } });
  assert.deepEqual(rows.map((r) => Number(r.created_utc)), [1698000000, 1699000000, 1699500000]);
});

const BASE = "https://dumps.test";
const MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", FIX), "utf8"));
const localFile = async (url) => localBuffer(url.slice(BASE.length + 1));
const serve = (body, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const openFixtures = (opts = {}) => DumpSource.open({ baseUrl: BASE, fetchFn: serve(MANIFEST), openFile: localFile, ...opts });

test("open reads the manifest; covers matches any case and ends an hour early", async () => {
  const dumps = await openFixtures();
  const expected = { name: "Python", postsThrough: 1699950000 - INGEST_LAG, commentsThrough: 1699990000 - INGEST_LAG };
  assert.deepEqual(dumps.covers("python"), expected);
  assert.deepEqual(dumps.covers("PYTHON"), expected);
  assert.equal(dumps.covers("rust"), null);
});

test("timestamps finds an author in any case, oldest first", async () => {
  const dumps = await openFixtures();
  assert.deepEqual(await dumps.timestamps("comments", "Python", "ALICE"), [1698000000, 1699000000, 1699500000]);
  assert.deepEqual(await dumps.timestamps("posts", "python", "Alice"), [1699900000]);
  assert.deepEqual(await dumps.timestamps("posts", "Python", "nobody"), []);
});

test("reads counts successful timestamps calls, not failures", async () => {
  const dumps = await openFixtures();
  assert.equal(dumps.reads, 0);
  await dumps.timestamps("comments", "Python", "alice");
  await dumps.timestamps("posts", "Python", "alice");
  assert.equal(dumps.reads, 2);

  const failing = await openFixtures({ openFile: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(failing.timestamps("comments", "Python", "alice"), DumpUnavailable);
  assert.equal(failing.reads, 0);
});

test("a read that never resolves times out as DumpUnavailable and switches the source off", async () => {
  const dumps = await openFixtures({ readTimeoutMs: 50, openFile: async () => new Promise(() => {}) });
  await assert.rejects(dumps.timestamps("comments", "Python", "alice"), DumpUnavailable);
  assert.equal(dumps.broken, true);
  assert.equal(dumps.reads, 0);
});

test("each file is opened once per source", async () => {
  let opens = 0;
  const dumps = await openFixtures({ openFile: async (url) => (opens++, localFile(url)) });
  await Promise.all([dumps.timestamps("comments", "Python", "alice"), dumps.timestamps("comments", "Python", "carol")]);
  await dumps.timestamps("posts", "Python", "bob");
  assert.equal(opens, 2);
});

test("a failed read throws DumpUnavailable and switches the source off", async () => {
  const dumps = await openFixtures({ openFile: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(dumps.timestamps("comments", "Python", "alice"), DumpUnavailable);
  assert.equal(dumps.broken, true);
  assert.equal(dumps.covers("Python"), null);
  await assert.rejects(dumps.timestamps("posts", "Python", "alice"), DumpUnavailable);
});

test("Stop during a read throws Aborted and leaves the source usable", async () => {
  const controller = new AbortController();
  const dumps = await openFixtures({
    signal: controller.signal,
    openFile: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); },
  });
  await assert.rejects(dumps.timestamps("comments", "Python", "alice"), Aborted);
  assert.equal(dumps.broken, false);
});

test("open gives null when there's no usable manifest", async () => {
  const open = (fetchFn) => DumpSource.open({ baseUrl: BASE, fetchFn, openFile: localFile });
  assert.equal(await open(serve("not found", 404)), null);
  assert.equal(await open(serve("{not json")), null);
  assert.equal(await open(async () => { throw new TypeError("Failed to fetch"); }), null);
  assert.equal(await open(serve({ ...MANIFEST, format: DUMP_FORMAT + 1 })), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(DumpSource.open({ baseUrl: BASE, fetchFn: serve(MANIFEST), signal: controller.signal }), Aborted);
});

test("parseManifest leaves out subreddits it can't trust", () => {
  const sub = MANIFEST.subreddits.python;
  const withFile = (name, change) => ({
    format: DUMP_FORMAT,
    subreddits: { python: { ...sub, files: { ...sub.files, [name]: { ...sub.files[name], ...change } } } },
  });
  assert.equal(parseManifest(MANIFEST).size, 1);
  for (const path of ["../secret.parquet", "https://evil.example/x.parquet", "r/python/v1/x.json", "r/python/../../x.parquet"]) {
    assert.equal(parseManifest(withFile("posts_by_author", { path })).size, 0, path);
  }
  assert.equal(parseManifest(withFile("comments_by_author", { bytes: -1 })).size, 0);
  assert.equal(parseManifest({ format: DUMP_FORMAT, subreddits: { rust: sub } }).size, 0); // key must match the name
  assert.equal(parseManifest({ format: DUMP_FORMAT, subreddits: { python: { ...sub, posts_to_utc: "soon" } } }).size, 0);
  assert.equal(parseManifest(null).size, 0);
});
