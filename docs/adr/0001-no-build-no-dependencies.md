# 0001. No build step and no runtime dependencies

**Status:** Accepted (recorded 2026-09-25; in force since the web app began).

## Context

The whole product is one static page on GitHub Pages that talks to Arctic Shift and the
archive from the visitor's browser. There's no server to hide secrets or run a bundler's
output through, and one maintainer. Every dependency is code shipped to visitors that nobody
here reviews, a supply-chain risk, and a reason for the page to break when something upstream
changes. A bundler would also put a transform between the reviewed source and what runs.

## Decision

The page is plain ES modules under `web/`, served as written. It has no runtime dependencies:
anything it needs is written here, or, for the one exception so far (hyparquet, for reading
Parquet), saved as a pinned copy (`web/hyparquet.js`) that is never edited. The tests may use
development dependencies (today only `fake-indexeddb`). Local modules are imported as
`from "./x.js"`, the one form the deploy step's cache busting rewrites. `rule-guards.sh`
enforces the dependency rule and the import form in CI.

## Consequences

- What's reviewed is exactly what runs, and there's nothing to update but the pinned copy.
- Modules stay small enough to read without a bundler's tree-shaking.
- Features that would come free with a library (a chart, a date picker) cost code here.
- Revisit if the page ever needs something too large or subtle to own, and then prefer
  another pinned, vendored copy over a package manager.
