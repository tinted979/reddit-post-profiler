import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parquetMetadataAsync, parquetQuery } from "../hyparquet.js";

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
