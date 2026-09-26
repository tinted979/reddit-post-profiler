---
paths:
  - "web/app.js"
  - "web/index.html"
  - "web/style.css"
  - "web/options.js"
  - "web/format.js"
  - "web/tests/options.test.js"
  - "web/tests/format.test.js"
  - "web/tests/page.test.js"
  - "web/tests/archived-only.test.js"
---
# web/app.js, the page, options.js and format.js

Moved from CLAUDE.md's web app architecture.

- **`options.js`:** scan options without the DOM. `parseOptions` turns the form's fields (as text, keyed like `FIELD_IDS`, the inputs' ids) into the options a run uses, clamped with `clampScanNumbers` (`SCAN_LIMITS` in `core.js`; anything not a finite number, such as a link's `cache=Infinity`, takes its default). `shareParams`/`readShareParams` write and read share links from one table, `SHARE_PARAMS` (`op`, `exclude`, `subs`, `archived`, `years`, `max`, `min`, `delay`, `par`, `cache`, `badges`; `post` is written first, outside the table; `op` and `archived` are checkboxes, on as `1`); a new option goes in that table, and a test checks every param is both written and read. Also `optionsSummary`, `scanOptionNotes`, and for *Only subreddits in the archive* (`onlyArchived`), `scanOnly` (the typed subreddits plus the archive's list at scan time; null when that list can't be read) and `archivedNote` (the note beside the checkbox).
- **`format.js`:** the page's text helpers without the DOM: `plural`, `formatEta`, `formatDuration`, `formatAge`, `requestsText`, `tookText`, `breakdownLines` (the request breakdown), `archiveNote` (the end-of-scan note on what the archive answered), `describeRule`, `timelineText`, and `explain` (an error as advice).
- **`app.js`** handles the DOM only:
  - It reads the option fields listed in `FIELD_IDS` and the two checkboxes (`#include-op`, `#only-archived`) and hands them to `options.js`, and fills them from a share link the same way. Ticking *Only subreddits in the archive* reads the archive's list for the note beside it (a slower answer to an earlier tick is dropped); a run resolves the option with `scanOnly` once it has opened the archive, and stops with a message if the list can't be read. Saved scans and queue items keep the flag and the typed subreddits, so a rescan uses the archive as it is then. Badge rules live outside `#option-fields` (editable during a run) and are remembered in localStorage (`reddit-tool-badges`); a link's `badges=` applies without being saved.
  - Before profiling, a run opens the archive (`DumpSource.open` with the tab's one `TailStore`, so a later scan asks only for what's new) and calls `fetchTails` once. It passes `interactionsFirst: true` to `buildProfile` and `estimateScan` (docs/adr/0007).
  - It runs `mapPool(buildProfile)` and inserts cards in thread-activity order as results arrive.
  - It renders the status line, progress and ETA, and builds the CSV with `toCsv`. The status line shows Arctic Shift requests (`client.requests`) and archive requests (`archiveRequests`, from `DumpSource`'s `onRequest`) separately, during and after a scan; saved scan summaries keep both (`requests`, `archiveRequests`; the latter is null for scans saved before it existed and is left out of the text). When a run ends (done, stopped or failed), a collapsible *Request breakdown* under it (`#breakdown`, lines from `format.js`'s `breakdownLines`) lists the Arctic Shift requests by purpose (`client.byLabel`, adding up to the total), the retries among them (`client.retries`), what each recent-activity fetch did (`fetchTails`' report) and the archive requests by file (`dumps.js`'s `archiveFileName` of `onRequest`'s URL). It covers the last run only: it's hidden while a run goes and when a saved scan is opened, and isn't saved.
  - Every count stops at the post (docs/adr/0006): the history window (`years`) counts back from the post once it's known, the links from counts to Arctic Shift carry `before=<post time>`, and new saved scans record `countsTo: "post"`. A scan saved before that (no `countsTo`) says so when opened, and its links stay unbounded, as its counts were.
  - The address bar gets a share link (`state.urlPost`) only for a manual run's results; a saved scan clears it and a queued scan leaves it, since reloading either would start a fresh scan.
  - Every run has a `runId`. Callbacks from an older run must check it before touching shared state.
  - `run()` resolves with an outcome (`done`, `empty`, `stopped`, `failed`, …). A manual run reads the post and options from the form; the scheduler (`pumpQueue`) passes a queued item's own, `run({ fromQueue: true, postRef, opts })`, with `opts` from `mergeOptions(readOptions(), item.opts)` (options.js: stored options checked field by field over the form's), and never touches the form, so whatever someone types there meanwhile stays. The scheduler continues after each scan (with a short gap); every manual run's end calls `pumpQueue` (from `run()`'s `finally`, so early returns do too), so a queue waiting on a manual scan resumes. Queued scans don't write the URL, since a reload would re-run them outside the queue.
  - The client's waits use `backgroundSleep`, which runs on a Web Worker timer (Chrome throttles hidden-tab timers to about once a minute after 5 minutes; worker timers aren't) and falls back to `setTimeout` until the worker has answered a ping.

Accessibility is maintained. The last check with axe-core reported 0 violations in both light and dark mode. Screen readers get milestones through `#announce`, not every progress tick. Colour pairs in `style.css` are chosen for at least 4.5:1 contrast, and input edges (`--control-border`) for at least 3:1 against the surface and background (WCAG 1.4.11, which axe doesn't check).
