// pr-guards.sh in a throwaway repository, with a fake `gh` that reports the PR's labels and who
// added them. Agent (writer) branches can never change protected paths and need ack:tests to
// change existing tests; other claude/* branches need the owner's ack:sensitive; other
// branches are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "pr-guards.sh");

// `gh pr view … labels` prints FAKE_LABELS (comma separated), one per line; `gh api …` (the
// label events) prints FAKE_LABELER, the login that added the label.
const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
if [ "$1" = pr ]; then tr ',' '\\n' <<<"$FAKE_LABELS"; else echo "$FAKE_LABELER"; fi
`);
chmodSync(join(bin, "gh"), 0o755);
process.on("exit", () => rmSync(bin, { recursive: true, force: true }));

function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

// Base commit: a web package with one test file; `files` are written for the PR's commit.
function guards({ branch, files, labels = [], labeler = "owner" }) {
  const dir = mkdtempSync(join(tmpdir(), "pr-guards-"));
  try {
    write(dir, "web/package.json", JSON.stringify({ name: "x", private: true }));
    write(dir, "web/package-lock.json", JSON.stringify({ name: "x", lockfileVersion: 3, requires: true, packages: { "": { name: "x" } } }));
    write(dir, "web/tests/a.test.js", 'import { test } from "node:test";\ntest("one", () => {});\n');
    write(dir, "web/core.js", "export const x = 1;\n");
    write(dir, ".gitignore", "node_modules/\n");
    mkdirSync(join(dir, "tools"));
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    for (const [path, text] of Object.entries(files)) write(dir, path, text);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "change");
    const env = {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      PR: "7", HEAD_REF: branch, OWNER: "owner", GITHUB_REPOSITORY: "o/r",
      FAKE_LABELS: labels.join(","), FAKE_LABELER: labeler,
    };
    const r = spawnSync("bash", [script], { cwd: dir, env, encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const workflow = { ".github/workflows/x.yml": "name: x\n" };

test("an agent branch can't change protected paths, even with ack:sensitive", () => {
  for (const files of [workflow, { "CLAUDE.md": "x" }, { ".claude/settings.json": "{}" }]) {
    const r = guards({ branch: "claude/12-fix-thing", files, labels: ["ack:sensitive"] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no label waives this/);
  }
});

test("another claude/* branch needs the owner's ack:sensitive for protected paths", () => {
  assert.equal(guards({ branch: "claude/workflow-x", files: workflow }).status, 1);
  assert.equal(guards({ branch: "claude/workflow-x", files: workflow, labels: ["ack:sensitive"] }).status, 0);
  const r = guards({ branch: "claude/workflow-x", files: workflow, labels: ["ack:sensitive"], labeler: "someone-else" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /add ack:sensitive/);
});

test("an agent branch needs ack:tests to change an existing test, but not to add one", () => {
  const changed = { "web/tests/a.test.js": 'import { test } from "node:test";\ntest("one", () => { /* weaker */ });\n' };
  const r = guards({ branch: "claude/12-fix-thing", files: changed });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /changes or deletes existing tests/);
  assert.equal(guards({ branch: "claude/12-fix-thing", files: changed, labels: ["ack:tests"] }).status, 0);
  const added = { "web/tests/b.test.js": 'import { test } from "node:test";\ntest("two", () => {});\n', "web/core.js": "export const x = 2;\n" };
  assert.equal(guards({ branch: "claude/12-fix-thing", files: added }).status, 0);
});

test("branches outside claude/* are skipped", () => {
  const r = guards({ branch: "feature/x", files: workflow });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /skipping/);
});
