---
name: finding-format
description: Shared severity scale, evidence bar and output shape for every agent that reports findings (reviewers and auditors). Load before reporting any finding.
---
Severity:
- high: wrong results; loss of saved scans, cache, queue or settings; a security hole; or a
  break of a CLAUDE.md rule that visitors would notice.
- medium: a real bug in an edge case, or a rule break with limited impact.
- low: everything else. Low goes in the summary only, never an inline comment or an issue.

Evidence bar: a finding names a file and line, says what goes wrong for which input, and shows
how you know (a test you ran, or a code path you traced). "Might", "could potentially" and
"consider" are not findings. Reporting nothing is correct when nothing meets this bar.

Never report: style, naming, formatting, anything the tests or rule guards check,
pre-existing problems outside the change under review, or duplicates of an `agent:finding`
issue, open or closed.

Structured output follows findings.schema.json in this folder: title (≤120 characters),
severity, location (`path:line`), evidence, suggestion, and optionally repro_test.
