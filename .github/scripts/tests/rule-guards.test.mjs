// rule-guards.sh passes on the page as it is, and fails on each kind of rule break, run
// against a copy of web/ so nothing in the repository changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "rule-guards.sh");
const web = join(here, "..", "..", "..", "web");

function copyOfWeb() {
  const dir = mkdtempSync(join(tmpdir(), "rule-guards-"));
  for (const f of readdirSync(web)) {
    if (f.endsWith(".js") || f === "package.json") cpSync(join(web, f), join(dir, f));
  }
  return dir;
}

function guards(dir) {
  const r = spawnSync("bash", [script, dir], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

test("the page as it is passes", () => {
  const dir = copyOfWeb();
  try {
    const r = guards(dir);
    assert.equal(r.status, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const breaks = [
  ["an HTML sink", "app.js", "\nel.innerHTML = name;\n", /Untrusted input rule/],
  ["fetch outside core.js and dumps.js", "app.js", "\nfetch(url);\n", /API rule/],
  ["an import that isn't ./x.js", "app.js", '\nimport { x } from "../x.js";\n', /Imports rule/],
  ["a single-quoted import", "format.js", "\nimport { x } from './core.js';\n", /Imports rule/],
  ["a dynamic import", "app.js", '\nconst m = await import("./core.js");\n', /Imports rule/],
];

for (const [name, file, code, message] of breaks) {
  test(`fails on ${name}`, () => {
    const dir = copyOfWeb();
    try {
      appendFileSync(join(dir, file), code);
      const r = guards(dir);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("fails on a dependency, and on a dev dependency other than fake-indexeddb", () => {
  for (const extra of [{ dependencies: { lodash: "1" } }, { devDependencies: { "fake-indexeddb": "6", jsdom: "1" } }]) {
    const dir = copyOfWeb();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", ...extra }));
      const r = guards(dir);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /no dependencies/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
