# 0004. A static per-subreddit archive on R2, read with range requests

**Status:** Superseded by 0005 (accepted 2026-09-25; built in PRs #17 and #18, plans in docs/history/).

## Context

"Before" facts and subreddit-limited lifetime counts cost several Arctic Shift requests per
commenter (0002). Arctic Shift publishes per-subreddit dumps, so the same facts can be read
from files. The page has no server (0001), so the files must be static and readable from the
browser, and a scan should read only the few kilobytes it needs, not megabytes.

## Decision

`tools/build_dumps.py` turns a subreddit's dump into Parquet files sorted by their lookup key
(Snappy, ~10k-row groups), plus a manifest, in a new `r/<sub>/<version>/` that is never
overwritten. `tools/upload_dumps.sh` uploads them to the R2 bucket `rpp-db`, served through
Cloudflare's cache at `https://rpp-db.tinted979.dev`, checking the build before the manifest
goes live. The page (`DumpSource`) treats the manifest as untrusted, reads one author's rows
with hyparquet range requests (skipping row groups by min/max), and falls back to the API for
anything the files don't cover or when a read fails. CORS allows only the page's origin (and
`localhost:8000` for development), and
`archive-check.yml` checks the live archive weekly.

## Consequences

- Covered subreddits need far fewer API requests, and repeat reads come from the edge cache.
- The owner runs builds and uploads by hand, and keeps the zone settings (no challenge pages
  on this host) that a cross-origin fetch needs.
- The files' format is a contract between `build_dumps.py` and `dumps.js` (`FORMAT` /
  `DUMP_FORMAT`, checked by `tools/tests/test_contract.py`).
- Revisit if R2's pricing or Cloudflare's security defaults change, or if Arctic Shift offers
  the same data through an API.
