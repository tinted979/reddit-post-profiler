---
name: perf-audit
description: How to measure scan cost (Arctic Shift requests per scenario by endpoint, archive reads and bytes, simulated time) offline with the bench. Use for performance audits and perf reviews of PRs.
---
Run `node web/bench/scan-bench.mjs`, or `node web/bench/scan-bench.mjs --base <git-ref>` to
compare with another commit (it runs the same scenarios there in a temporary git worktree and
removes it afterwards). It drives `buildProfile` with a real `ArcticShiftClient` and
`DumpSource` against an in-memory API model and the archive fixtures in
web/tests/fixtures/dumps, on a virtual clock, and prints JSON: per scenario, API requests by
endpoint, archive manifest and range reads with bytes, and `fakeSeconds`; plus `wallMs`. Any
request the model doesn't expect makes it exit 1.

Compare like with like: same scenarios, same ref pair. Request counts and bytes are exact and
deterministic, so a change of even one request in a scenario is real. `fakeSeconds` follows
from requests, pacing and overlap (each request is modelled at 1.3 s). `wallMs` is noise on a
shared runner; ignore it.

The archive fixtures are tiny (a few hundred bytes), so byte counts only show whether a read
happens, not how big it would be on real files. The API model answers what the tests assume;
it can't show server-side behaviour (slow-downs, 429s). Scenarios live in the script; a new
one is added through an agent:implement issue.
