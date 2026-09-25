// fileFindings() with an in-memory fake gh (never the real CLI, so no test can touch a real
// repository): the cap, severity order, de-duplication against earlier (even closed) findings,
// low severities never filed, unknown roles skipped, and @mentions defused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileFindings } from "../file-findings.mjs";

const finding = (title, severity, extra = {}) => ({ title, severity, location: "web/core.js:1", evidence: "e", suggestion: "s", ...extra });

// byRole: { role: findings[] | raw text }. known: bodies of issues already filed.
function file(byRole, { known = [], max } = {}) {
  const issues = [];
  const gh = (...args) => {
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(known.map((body) => ({ body })));
    if (args[0] === "issue" && args[1] === "create") {
      const at = (flag) => args[args.indexOf(flag) + 1];
      issues.push({ title: at("--title"), body: at("--body"), labels: at("--label") });
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const files = Object.fromEntries(
    Object.entries(byRole).map(([role, v]) => [`findings-${role}.json`, typeof v === "string" ? v : JSON.stringify({ findings: v })]),
  );
  const log = fileFindings(files, { gh, ...(max === undefined ? {} : { max }) });
  return { issues, out: log.join("\n") };
}

test("files highest severity first, at most three, with the role's labels", () => {
  const { issues, out } = file({
    "bug-hunter": [finding("m1", "medium"), finding("h1", "high"), finding("m2", "medium")],
    "perf-auditor": [finding("h2", "high")],
  });
  assert.deepEqual(issues.map((i) => i.title), ["h1", "h2", "m1"]);
  assert.equal(issues[0].labels, "agent:finding,agent:bug-hunter");
  assert.equal(issues[1].labels, "agent:finding,agent:perf-auditor");
  assert.match(out, /Over the cap of 3: bug-hunter: m2/);
});

test("low severities and unknown values are never filed", () => {
  const { issues } = file({ "bug-hunter": [finding("l", "low"), finding("x", "critical")] });
  assert.deepEqual(issues, []);
});

test("a finding already filed, even one closed since, isn't filed again", () => {
  const first = file({ "context-steward": [finding("Wrong constant", "medium")] });
  const id = first.issues[0].body.match(/finding-id: ([0-9a-f]{12})/)[1];
  const again = file({ "context-steward": [finding("  wrong CONSTANT ", "medium")] }, { known: [`… <!-- finding-id: ${id} -->`] });
  assert.deepEqual(again.issues, []);
  assert.match(again.out, /Already filed/);
});

test("max sets the cap", () => {
  const { issues } = file({ "bug-hunter": [finding("a", "high"), finding("b", "high")] }, { max: 1 });
  assert.equal(issues.length, 1);
});

test("agent text can't mention anyone, and a repro test can't close its code fence", () => {
  const { issues } = file({
    "bug-hunter": [finding("ping @someone", "high", { evidence: "cc @octocat and a@b.c", repro_test: "x\n~~~\n# heading" })],
  });
  assert.equal(issues[0].title, "ping @​someone");
  assert.match(issues[0].body, /cc @​octocat and a@​b\.c/);
  assert.doesNotMatch(issues[0].body.split("~~~js")[1].split("\n~~~\n")[0], /~~~/);
});

test("unknown roles and broken JSON are skipped", () => {
  const { issues, out } = file({ "not-a-role": [finding("a", "high")], "bug-hunter": "{nope" });
  assert.deepEqual(issues, []);
  assert.match(out, /unknown role/);
  assert.match(out, /not valid JSON/);
});
