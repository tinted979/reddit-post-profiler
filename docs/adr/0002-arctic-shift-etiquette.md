# 0002. Arctic Shift etiquette: one throttled client, and no escalation when it's busy

**Status:** Accepted (recorded 2026-09-25).

## Context

Arctic Shift is a free, shared archive API run by one person. Measured in September 2026, it
tops out at about 0.8 requests a second whatever the client does, answers "Timeout. Maybe
slow down a bit" (422) when busy, rate-limits per IP in 60-second windows, and doesn't expose
its reset header to browsers. A scan asks several requests per commenter, so a careless client
could hurt everyone else's use, and a busy server doesn't get better by being asked for more.

## Decision

Every Arctic Shift request goes through `ArcticShiftClient._get`: it spaces request starts,
caps requests in flight with AIMD (halving on a 429, a slow-down, a 5xx or a network error),
backs off with jitter, tags every request with `meta-app=reddit-post-profiler`, and pauses the
whole client on a 429. When the server keeps saying it's busy, the client stops with
`ServerBusy` instead of falling back to heavier queries, and the parts of a split give up
together. Defaults are 0.75 s between starts and 2 users in parallel. New endpoints or
parameters are used only after they're checked live and recorded in
`.claude/rules/arctic-shift-api.md`.

## Consequences

- Scans are slower than the server could briefly allow, and some users fail on a busy day
  rather than being retried into the ground.
- The archive on R2 (0004) exists partly to take load off the API.
- Tests use an injected fetch and a fake clock; nothing in CI calls the live API, and agents
  are forbidden to.
- Revisit if Arctic Shift publishes different limits, or offers an authenticated tier.
