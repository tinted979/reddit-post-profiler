// Turns audit findings (JSON files from agent-audit.yml's agent jobs) into at most MAX_ISSUES
// issues, highest severity first. This job holds the audit workflow's only write token; the
// agents that wrote the findings had none. Each finding gets a fingerprint, so it's never filed
// twice, even after it's been closed. The text is agent-written: it's clipped, and @mentions
// are defused so a finding can't ping anyone. The owner reads an issue before labelling it
// for a writer.
// Usage: node file-findings.mjs findings-<role>.json...   (env MAX_ISSUES, default 3)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const RANK = { high: 0, medium: 1 };
const ROLES = new Set(["bug-hunter", "perf-auditor", "architecture-reviewer", "context-steward"]);
// A zero-width space after @ keeps the text readable but stops it being a mention.
const clean = (s, n) => String(s ?? "").slice(0, n).replace(/@(?=[A-Za-z0-9_-])/g, "@​");
const fingerprint = (f) =>
  createHash("sha256")
    .update([f.role, f.location, f.title].map((s) => String(s ?? "").trim().toLowerCase()).join("|"))
    .digest("hex")
    .slice(0, 12);

// files: { path: text }. gh(...args) runs the GitHub CLI and returns its stdout; the tests
// pass a fake, so they can never touch a real repository. Returns the lines it would log.
export function fileFindings(files, { gh, max = 3 }) {
  const log = [];
  const known = gh("issue", "list", "--label", "agent:finding", "--state", "all", "--limit", "1000", "--json", "body");
  const seen = new Set([...known.matchAll(/finding-id: ([0-9a-f]{12})/g)].map((m) => m[1]));

  const all = [];
  for (const [file, text] of Object.entries(files)) {
    const role = basename(file, ".json").replace(/^findings-/, "");
    if (!ROLES.has(role)) {
      log.push(`Skipping ${file}: unknown role.`);
      continue;
    }
    try {
      const findings = JSON.parse(text).findings;
      for (const f of Array.isArray(findings) ? findings : []) all.push({ ...f, role });
    } catch {
      log.push(`Skipping ${file}: not valid JSON.`);
    }
  }
  all.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));

  let filed = 0;
  for (const f of all) {
    if (!(f.severity in RANK)) {
      log.push(`Not filed (${clean(f.severity, 20)}): ${f.role}: ${clean(f.title, 120)} (${clean(f.location, 200)})`);
      continue;
    }
    const id = fingerprint(f);
    if (seen.has(id)) {
      log.push(`Already filed: ${f.role}: ${clean(f.title, 120)}`);
      continue;
    }
    if (filed >= max) {
      log.push(`Over the cap of ${max}: ${f.role}: ${clean(f.title, 120)}`);
      continue;
    }
    const body = [
      `**Where:** \`${clean(f.location, 200).replaceAll("`", "'")}\` · **Severity:** ${f.severity} · **Found by:** ${f.role} audit`,
      "",
      clean(f.evidence, 4000),
      "",
      ...(f.repro_test ? ["Reproduction:", "", "~~~js", clean(f.repro_test, 4000).replaceAll("~~~", "~ ~ ~"), "~~~", ""] : []),
      `**Suggested fix:** ${clean(f.suggestion, 2000)}`,
      "",
      "<sub>Written by an agent: read it before labelling it for a writer. Wrong or not worth doing? Close it as not planned; it won't be filed again.</sub>",
      `<!-- finding-id: ${id} -->`,
    ].join("\n");
    gh("issue", "create", "--title", clean(f.title, 120) || "(untitled finding)", "--body", body, "--label", `agent:finding,agent:${f.role}`);
    seen.add(id);
    filed++;
  }
  log.push(`Filed ${filed} issue(s).`);
  return log;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = Object.fromEntries(process.argv.slice(2).map((p) => [p, readFileSync(p, "utf8")]));
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
  for (const line of fileFindings(files, { gh, max: Number(process.env.MAX_ISSUES ?? 3) })) console.log(line);
}
