# 0003. Frozen storage names and versioned keys

**Status:** Accepted (recorded 2026-09-25).

## Context

Visitors keep real work in their browsers: saved scans and cached profile counts in
IndexedDB, and the scan queue and badge rules in localStorage. There's no server copy. The
project started under another name, and the stored names still carry it (`reddit-tool`).
Renaming a database or key, or changing a stored value's shape without telling old data from
new, would silently lose or misread what visitors have saved.

## Decision

The IndexedDB database stays `reddit-tool` and the localStorage keys stay `reddit-tool-*`,
whatever the project is called. Cached values carry a version in their key (`v1|life|…`,
`v1|lifeonly|…`, `v2|before|…`), bumped whenever the stored shape changes, so old records are
simply not found rather than misread. Adding a store or an index bumps `DB_VERSION` and is
handled in `openDb`'s upgrade, with tests that upgrade from every older version. Imported
saved-scan files are untrusted and fully validated.

## Consequences

- Visitors never lose saved work to a rename or a refactor.
- The code carries an old name, and a key bump makes the cache start cold once.
- Reviewers check stored-shape changes for a version bump (a CLAUDE.md rule).
- Revisit only with a deliberate migration that reads the old names and writes the new ones,
  tested against real old data.
