// pr-guards.sh in a throwaway repository, with a fake `gh` that reports the PR's authors, its
// labels and who added them. Agent work (anyone but the owner, Dependabot aside) can never
// change protected paths and needs ack:tests to change existing tests; the owner's own PRs
// need ack:sensitive for protected paths. It's judged by authorship, whatever the branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "pr-guards.sh");

// `gh pr view … author,commits` prints FAKE_AUTHORS and `gh pr view … labels` FAKE_LABELS (both
// comma separated), one per line; `gh api …` (the label events) prints FAKE_LABELER, the login
// that added the label.
const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
writeFileSync(
  join(bin, "gh"),
  [
    "#!/usr/bin/env bash",
    'case "$*" in',
    `  *author,commits*) tr ',' '\\n' <<<"$FAKE_AUTHORS" ;;`,
    `  pr*) tr ',' '\\n' <<<"$FAKE_LABELS" ;;`,
    '  *) echo "$FAKE_LABELER" ;;',
    "esac",
    "",
  ].join("\n"),
);
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

const testFile = (...names) => `import { test } from "node:test";\n${names.map((n) => `test("${n}", () => {});`).join("\n")}\n`;

// Base commit: a web package with one test file; `files` are written for the PR's commit.
function guards({ authors = ["owner"], files, labels = [], labeler = "owner" }) {
  const dir = mkdtempSync(join(tmpdir(), "pr-guards-"));
  try {
    write(dir, "web/package.json", JSON.stringify({ name: "x", private: true }));
    write(dir, "web/package-lock.json", JSON.stringify({ name: "x", lockfileVersion: 3, requires: true, packages: { "": { name: "x" } } }));
    write(dir, "web/tests/a.test.js", testFile("one"));
    write(dir, "web/core.js", "export const x = 1;\n");
    write(dir, ".gitignore", "node_modules/\n");
    write(dir, ".claude/settings.json", "{}\n");
    mkdirSync(join(dir, "tools"));
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    // A null text deletes the file (with another path added, git would see a move).
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(dir, path));
      else write(dir, path, text);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "change");
    const env = {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      PR: "7",
      OWNER: "owner",
      GITHUB_REPOSITORY: "o/r",
      FAKE_AUTHORS: authors.join(","),
      FAKE_LABELS: labels.join(","),
      FAKE_LABELER: labeler,
    };
    const r = spawnSync("bash", [script], { cwd: dir, env, encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const workflow = { ".github/workflows/x.yml": "name: x\n" };
const agent = ["app/claude", "owner"]; // the Claude App opened it
const agentCommit = ["owner", "owner", "claude[bot]"]; // the owner's PR, with an agent's commit

test("agent work can't change protected paths, even with ack:sensitive", () => {
  // "(unlinked)" is what pr-guards.sh's jq makes of a commit author with no GitHub login.
  for (const authors of [agent, agentCommit, ["owner", "Copilot"], ["owner", "(unlinked)"]]) {
    for (const files of [workflow, { "CLAUDE.md": "x" }, { ".claude/settings.json": "{}" }]) {
      const r = guards({ authors, files, labels: ["ack:sensitive"] });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /no label waives this/);
    }
  }
});

test("moving a protected file out of its folder still counts as changing it", () => {
  const moved = { ".claude/settings.json": null, "notes/settings.json": "{}\n" };
  const r = guards({ authors: agent, files: moved });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no label waives this/);
  assert.equal(guards({ files: moved }).status, 1, "the owner's own move needs ack:sensitive");
});

test("the owner's PR needs the owner's own ack:sensitive for protected paths, whatever its branch", () => {
  assert.equal(guards({ files: workflow }).status, 1);
  assert.equal(guards({ files: workflow, labels: ["ack:sensitive"] }).status, 0);
  const r = guards({ files: workflow, labels: ["ack:sensitive"], labeler: "someone-else" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /add ack:sensitive/);
});

test("Dependabot's action bumps count as the owner's, so ack:sensitive applies", () => {
  const authors = ["app/dependabot", "dependabot[bot]"];
  assert.equal(guards({ authors, files: workflow }).status, 1);
  assert.equal(guards({ authors, files: workflow, labels: ["ack:sensitive"] }).status, 0);
});

test("agent work needs ack:tests to change an existing test, but not to add one", () => {
  const changed = { "web/tests/a.test.js": testFile("one renamed") };
  const r = guards({ authors: agent, files: changed });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /changes or deletes existing tests/);
  assert.equal(guards({ authors: agent, files: changed, labels: ["ack:tests"] }).status, 0);
  assert.equal(guards({ files: changed }).status, 0, "the owner's own test edits aren't flagged");
  const added = { "web/tests/b.test.js": testFile("two"), "web/core.js": "export const x = 2;\n" };
  assert.equal(guards({ authors: agent, files: added }).status, 0);
});
