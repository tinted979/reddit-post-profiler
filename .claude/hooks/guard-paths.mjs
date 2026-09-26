// PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit: keeps agents off the files that
// define their own rules. The agent workflows set AGENT_ROLE; interactive sessions leave it
// unset, so there you're asked instead of blocked. Node, not bash, so it runs on Windows too.
// In CI, claude-code-action restores .claude/ from the base branch, so this file is always the
// base's version: a PR can't loosen the hook that guards it.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!file) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const abs = resolve(root, file);
const back = relative(root, abs);
const shown = back.replaceAll("\\", "/");
// Matched in lower case, so CLAUDE.md can't be reached as claude.md on a case-insensitive
// file system.
const rel = shown.toLowerCase();
const role = process.env.AGENT_ROLE || "";

// Agent rules and CI; the vendored library; the bucket's CORS policy; the script that holds
// the R2 token in the archive sync (docs/adr/0005).
const PROTECTED = [/^\.github\//, /^\.claude\//, /^claude\.md$/, /^web\/hyparquet\.js$/, /^tools\/r2-cors\.json$/, /^tools\/publish_build\.sh$/];
const TESTS = [/^web\/tests\//, /^tools\/tests\//];

if (back.startsWith("..") || isAbsolute(back)) {
  if (role) block(`${file} is outside the repository.`);
  process.exit(0);
}
if (PROTECTED.some((re) => re.test(rel))) {
  if (role) block(`${shown} is maintained by a human. Describe the change you want in the PR body, under Grounding.`);
  ask(`${shown} defines agent rules, CI or deploy config.`);
}
if (role === "refactorer" && TESTS.some((re) => re.test(rel)) && existsSync(abs)) {
  block("A refactor keeps existing tests unchanged. Add a new test file if you need more coverage.");
}
process.exit(0);

function block(reason) {
  process.stderr.write(reason + "\n");
  process.exit(2);
}
function ask(reason) {
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
