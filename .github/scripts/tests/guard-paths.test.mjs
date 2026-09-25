// .claude/hooks/guard-paths.mjs: with AGENT_ROLE set (CI) it blocks protected paths and paths
// outside the repository, and the refactorer can't edit existing tests; without it
// (interactive) it asks before protected paths and allows the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".claude", "hooks", "guard-paths.mjs");

// A throwaway project with one existing test file, so "existing" means something.
const root = mkdtempSync(join(tmpdir(), "guard-paths-"));
mkdirSync(join(root, "web", "tests"), { recursive: true });
writeFileSync(join(root, "web", "tests", "core.test.js"), "");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function run(toolInput, role) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete env.AGENT_ROLE;
  if (role) env.AGENT_ROLE = role;
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: toolInput, cwd: root }), env, encoding: "utf8" });
  const decision = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
  return { status: r.status, decision, stderr: r.stderr };
}

const PROTECTED = [".github/workflows/ci.yml", ".claude/settings.json", ".claude/hooks/guard-paths.mjs", "CLAUDE.md", "web/hyparquet.js", "tools/r2-cors.json"];

test("an agent is blocked from every protected path", () => {
  for (const p of PROTECTED) {
    const r = run({ file_path: p }, "implementer");
    assert.equal(r.status, 2, p);
    assert.match(r.stderr, /maintained by a human/);
  }
});

test("interactively, protected paths ask and ordinary files are allowed", () => {
  for (const p of PROTECTED) assert.deepEqual([run({ file_path: p }).status, run({ file_path: p }).decision], [0, "ask"], p);
  assert.deepEqual(run({ file_path: "web/core.js" }), { status: 0, decision: null, stderr: "" });
});

test("absolute, Windows-style and differently cased paths are still recognised", () => {
  assert.equal(run({ file_path: join(root, ".github", "workflows", "ci.yml") }, "implementer").status, 2);
  assert.equal(run({ file_path: ".github\\workflows\\ci.yml" }, "implementer").status, 2);
  assert.equal(run({ file_path: "claude.md" }, "implementer").status, 2);
  assert.equal(run({ file_path: "web/../CLAUDE.md" }, "implementer").status, 2);
});

test("an agent can't write outside the repository; interactively that's left to the permission prompt", () => {
  assert.equal(run({ file_path: "../elsewhere.txt" }, "implementer").status, 2);
  assert.equal(run({ file_path: join(tmpdir(), "x.txt") }, "implementer").status, 2);
  assert.equal(run({ file_path: "../elsewhere.txt" }).status, 0);
});

test("the implementer may edit code and tests", () => {
  for (const p of ["web/core.js", "web/tests/core.test.js", "web/tests/new.test.js", "tools/build_dumps.py", "docs/history/x.md"]) {
    assert.equal(run({ file_path: p }, "implementer").status, 0, p);
  }
});

test("the refactorer can't edit an existing test, but can add one", () => {
  const r = run({ file_path: "web/tests/core.test.js" }, "refactorer");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /keeps existing tests unchanged/);
  assert.equal(run({ file_path: "web/tests/new.test.js" }, "refactorer").status, 0);
  assert.equal(run({ file_path: "web/core.js" }, "refactorer").status, 0);
});

test("notebook_path is checked like file_path, and a call with neither is allowed", () => {
  assert.equal(run({ notebook_path: ".claude/x.ipynb" }, "implementer").status, 2);
  assert.equal(run({ command: "ls" }, "implementer").status, 0);
});
