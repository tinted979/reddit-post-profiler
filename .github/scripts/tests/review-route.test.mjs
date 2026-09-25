// review-route.sh: the general reviewer on every PR but README- and plan-only ones, the
// specialists by path, and review:<role> labels for exactly that role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "review-route.sh");

function route({ files = [], added = [], diff = "", action = "opened", label = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "review-route-"));
  try {
    const paths = ["files", "added", "diff"].map((n) => join(dir, n));
    writeFileSync(paths[0], files.join("\n"));
    writeFileSync(paths[1], added.join("\n"));
    writeFileSync(paths[2], diff);
    const r = spawnSync("bash", [script, ...paths], { encoding: "utf8", env: { ...process.env, ACTION: action, LABEL: label } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a code change gets the general reviewer only", () => {
  assert.deepEqual(route({ files: ["web/core.js", "web/tests/core.test.js"] }), ["pr-reviewer"]);
  assert.deepEqual(route({ files: ["tools/build_dumps.py"] }), ["pr-reviewer"]);
});

test("README- and plan-only PRs get no review", () => {
  assert.deepEqual(route({ files: ["README.md"] }), []);
  assert.deepEqual(route({ files: ["docs/history/2026-09-25-x.md", "README.md"] }), []);
  assert.deepEqual(route({ files: ["README.md", "web/app.js"] }), ["pr-reviewer"]);
});

test("CI, agent config, shell scripts, CORS and the page shell add the security reviewer", () => {
  for (const f of [".github/workflows/ci.yml", ".claude/settings.json", "tools/upload_dumps.sh", "tools/r2-cors.json", "web/index.html"]) {
    assert.deepEqual(route({ files: [f] }), ["pr-reviewer", "security-reviewer"], f);
  }
});

test("grounding docs, a new web module or a storage schema change add the architecture reviewer", () => {
  assert.deepEqual(route({ files: ["CLAUDE.md"] }), ["pr-reviewer", "architecture-reviewer"]);
  assert.deepEqual(route({ files: ["docs/adr/0005-x.md"] }), ["pr-reviewer", "architecture-reviewer"]);
  assert.deepEqual(route({ files: ["web/stats.js"], added: ["web/stats.js"] }), ["pr-reviewer", "architecture-reviewer"]);
  assert.deepEqual(route({ files: ["web/tests/x.test.js"], added: ["web/tests/x.test.js"] }), ["pr-reviewer"]);
  const diff = "--- a/web/cache.js\n+++ b/web/cache.js\n-const DB_VERSION = 3;\n+const DB_VERSION = 4;\n";
  assert.deepEqual(route({ files: ["web/cache.js"], diff }), ["pr-reviewer", "architecture-reviewer"]);
  assert.deepEqual(route({ files: [".github/x.yml", "CLAUDE.md"] }), ["pr-reviewer", "security-reviewer", "architecture-reviewer"]);
});

test("a review: label runs that one role; other labels run nothing", () => {
  assert.deepEqual(route({ action: "labeled", label: "review:security-reviewer", files: ["web/app.js"] }), ["security-reviewer"]);
  assert.deepEqual(route({ action: "labeled", label: "review:perf-auditor" }), ["perf-auditor"]);
  assert.deepEqual(route({ action: "labeled", label: "ack:sensitive", files: ["web/app.js"] }), []);
  assert.deepEqual(route({ action: "labeled", label: "review:bogus" }), []);
});
