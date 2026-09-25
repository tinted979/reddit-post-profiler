// test-integrity.sh compares a change with its base in a throwaway git repository: fewer
// tests, or a new skip/only/todo marker, fails (exit 1); more tests pass; and a count it can't
// make, because npm ci fails, is an error of its own (exit 2) rather than a drop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "test-integrity.sh");

function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

const testFile = (bodies) => `import { test } from "node:test";\n${bodies.join("\n")}\n`;
const ok = (name) => `test("${name}", () => {});`;

// A repository whose base commit has two web tests; `change(testFile, webDir)` edits it for the
// second commit.
function withRepo(change, check) {
  const dir = mkdtempSync(join(tmpdir(), "test-integrity-"));
  try {
    mkdirSync(join(dir, "web", "tests"), { recursive: true });
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ name: "x", private: true, scripts: { test: "node --test" } }));
    writeFileSync(join(dir, "web", "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3, requires: true, packages: { "": { name: "x" } } }));
    writeFileSync(join(dir, "web", "tests", "a.test.js"), testFile([ok("one"), ok("two")]));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    change(join(dir, "web", "tests", "a.test.js"), join(dir, "web"));
    git(dir, "commit", "-qam", "change");
    const r = spawnSync("bash", [script, "HEAD^1"], { cwd: dir, encoding: "utf8" });
    check({ status: r.status, out: r.stdout + r.stderr });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("more tests pass", () => {
  withRepo((f) => writeFileSync(f, testFile([ok("one"), ok("two"), ok("three")])), (r) => {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /node tests: base 2, this change 3/);
  });
});

test("a removed test fails", () => {
  withRepo((f) => writeFileSync(f, testFile([ok("one")])), (r) => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /node test count dropped from 2 to 1/);
  });
});

test("a skipped test fails even though the count holds", () => {
  withRepo((f) => writeFileSync(f, testFile([ok("one"), 'test.skip("two", () => {});'])), (r) => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /marked skip\/only\/todo/);
  });
});

test("npm ci failing is an error, not a drop in the count", () => {
  // A dependency missing from the lockfile makes npm ci refuse, without touching the network.
  const unsynced = (_, web) =>
    writeFileSync(join(web, "package.json"), JSON.stringify({ name: "x", private: true, devDependencies: { "left-pad": "1.3.0" } }));
  withRepo(unsynced, (r) => {
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /npm ci failed/);
    assert.doesNotMatch(r.out, /count dropped/);
  });
});
