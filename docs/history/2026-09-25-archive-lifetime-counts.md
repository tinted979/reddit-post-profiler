> **History.** This plan was implemented in PR #18 and is kept for the record; it is not current work. Its decision is docs/adr/0004, since superseded by 0005 (a scheduled sync and shared tails) and 0006 (every count stops at the post). For how the code works now, see CLAUDE.md and `.claude/rules/archive.md`.

# Archive lifetime counts for covered `only` scans: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a scan is limited with "Only these subreddits" (`only`) to subreddits the archive covers, build each user's lifetime counts from the archive plus **one** Arctic Shift `interactions` query for the time after the archive ends. Today it takes two aggregate queries per user, so this halves the per-user requests (for example about 134 → 68 for a 66-commenter r/Hasan_Piker post).

**Architecture:**
- `buildProfile` in `web/core.js` tries a new `archiveLifetime(client, dumps, username, wanted, after)` first, whenever `wanted` (the post's subreddit plus `only`) is set and a `dumps` source is given.
- It returns `null` whenever it can't answer: a subreddit that isn't covered, an archive read that fails, or `interactions` refusing or timing out. The existing `lifetimeCounts` path then runs unchanged.
- `DumpSource.timestamps` in `web/dumps.js` remembers each lookup for the scan. The lifetime and "before" steps both need the same author's rows, so the Parquet file is read once, not twice.

**Tech stack:** plain ES modules, `node --test`. No new files in `web/`.

**Spec:** this plan's design decisions below, which extend CLAUDE.md § "Subreddit dumps" and the merged plan `docs/superpowers/plans/2026-09-24-archive-before-facts.md`.

## Design decisions

- **When it applies:** only if `wanted` is non-empty, `dumps` is given, and `dumps.covers(sub)` is non-null for **every** subreddit in `wanted`. Otherwise the aggregates path runs as today.
- **The cutoff:** `cutoff = min over wanted subs of min(postsThrough, commentsThrough)`, one value for both kinds and every subreddit.
  - Archive rows count only if `t <= cutoff`, plus `t > after` when a history window is set.
  - The `interactions` query uses `after = after === null ? cutoff : max(after, cutoff)`.
  - `interactions`' `after` is **exclusive**. This was checked live on 2026-09-24: querying with `after = t` doesn't count an item created at `t`. So the two ranges can't overlap.
  - One cutoff for everything keeps a single `interactions` call correct for both kinds.
- **The result:**
  - It is a `Map<name, {posts, comments}>` holding only the wanted subreddits, keyed by the archive's spelling (`covers().name`). `interactions` rows are matched to it case-insensitively, and rows for other subreddits are ignored.
  - It is returned as `{ counts, partial: true }`, so it's never saved as the user's lifetime profile. Saved profiles hold every subreddit, and this result doesn't.
- **Failures:**
  - An archive read fails with anything except `Aborted`: return `null`.
  - `interactions` throws `QueryTimeout` or `Unsupported`: return `null`.
  - `Aborted`, `ServerBusy`, 429 and network errors are rethrown. This matches `lifetimeCounts`, which also doesn't escalate to heavier queries when the server is struggling.
- **Freshness:** `buildProfile` treats totals fetched now as trusted, and these are: the archive plus `interactions` up to now, the thread's comments included. The needPosts/needComments logic is unchanged.
- **Remembered lookups:**
  - `DumpSource` keeps each `timestamps(kind, subreddit, author)` promise for its lifetime (one scan). Keys are case-insensitive.
  - A rejected lookup is forgotten.
  - `reads` counts actual reads, not remembered ones.
  - Callers must not change the returned array; `core.js` only uses `.filter`.

## Global constraints

- No build step and no npm dependencies. Don't edit `web/hyparquet.js`. Local imports stay in the form `from "./x.js"`.
- `core.js` must not import `dumps.js`.
- API requests go through `ArcticShiftClient`: use the existing `client.interactionCounts(author, { after })`.
- No stored data changes shape. Archive lifetime results are never cached (`partial: true`).
- `cd web && npm test` must pass after every task.
- Branch `claude/archive-lifetime-counts`. Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Don't push until the final review.

## Review focus

1. **Double counting at the cutoff.** An archive comment between `postsThrough` and `commentsThrough` must be counted once, by `interactions`, not also by the archive. *Task 2, "one cutoff for both kinds…".*
2. **A giant account** where `interactions` answers 400 "not supported" must still get correct counts, from the aggregates. *Task 2, "if interactions can't answer…".*
3. **`only` naming a subreddit the archive doesn't cover** must use the aggregates for everything, not a mix. *Task 2, "a subreddit the archive doesn't cover…".*
4. **A history window starting after the archive ends** takes everything from `interactions` with `after = window start`. *Task 2, "a window after the archive's end…".*
5. **These partial results are never cached**, so a later scan without `only` doesn't reuse a profile that lists one subreddit. *Task 2, "archive lifetime counts aren't saved…".*

---

### Task 1: Remember archive lookups for the scan

**Files:** Modify `web/dumps.js`; test `web/tests/dumps.test.js`.

**Interfaces:** Produces `DumpSource.timestamps(kind, subreddit, author)`, with the same signature and results as today, but repeat calls with the same arguments (in any case) return the same promise without reading again.

- [ ] **Step 1: Create the branch**

```bash
git switch main && git pull --ff-only && git switch -c claude/archive-lifetime-counts
```

- [ ] **Step 2: Write the failing test** (append to `web/tests/dumps.test.js`; `openFixtures`, `localFile` and `MANIFEST` already exist there)

```js
test("a lookup is read once per source, whatever the case", async () => {
  let opens = 0;
  const dumps = await openFixtures({ openFile: async (url) => (opens++, localFile(url)) });
  const first = await dumps.timestamps("comments", "Python", "alice");
  const again = await dumps.timestamps("comments", "PYTHON", "Alice");
  assert.equal(again, first); // the same array: no second read
  assert.equal(dumps.reads, 1);
  assert.equal(opens, 1);
});

test("a failed lookup isn't remembered", async () => {
  let fail = true;
  const dumps = await openFixtures({ openFile: async (url) => { if (fail) throw new Error("boom"); return localFile(url); } });
  await assert.rejects(dumps.timestamps("comments", "Python", "alice"), DumpUnavailable);
  fail = false;
  dumps.broken = false; // pretend a new scan's source; the lookup itself must not be cached
  assert.deepEqual(await dumps.timestamps("comments", "Python", "alice"), [1698000000, 1699000000, 1699500000]);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd web && node --test tests/dumps.test.js`
Expected: the first new test FAILS (`reads` is 2 and the arrays aren't identical).

- [ ] **Step 4: Implement.** In `web/dumps.js`:
  - rename the existing `async timestamps(kind, subreddit, author)` method to `async _read(kind, subreddit, author)`, with its body unchanged;
  - in the constructor, add `this._lookups = new Map(); // "kind|sub|author" -> Promise<number[]>, for this scan`;
  - add this method where `timestamps` was, keeping its doc comment and adding the last two sentences shown:

```js
  // Creation times (epoch seconds, oldest first) of every post or comment `author` has in
  // the subreddit's files. Throws Aborted once stopped, else DumpUnavailable. A lookup is
  // read once per source (one scan) and shared; callers must not change the array.
  timestamps(kind, subreddit, author) {
    const key = `${kind}|${String(subreddit).toLowerCase()}|${String(author).toLowerCase()}`;
    let lookup = this._lookups.get(key);
    if (!lookup) {
      lookup = this._read(kind, subreddit, author);
      lookup.catch(() => this._lookups.delete(key));
      this._lookups.set(key, lookup);
    }
    return lookup;
  }
```

- [ ] **Step 5: Run the tests.** `cd web && node --test tests/dumps.test.js` should PASS; then run `npm test`, which must be all green.

- [ ] **Step 6: Commit**

```bash
git add web/dumps.js web/tests/dumps.test.js
git commit -m "DumpSource: read each archive lookup once per scan

The lifetime and before steps both need an author's rows; the second
now reuses the first read. Failed lookups aren't remembered.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Lifetime counts from the archive plus one `interactions` query

**Files:** Modify `web/core.js`, `CLAUDE.md` and `README.md`; test `web/tests/core.test.js`.

**Interfaces:**
- Consumes: `dumps.covers(sub)` → `{name, postsThrough, commentsThrough} | null`; `dumps.timestamps(kind, sub, author)` → `Promise<number[]>`; `client.interactionCounts(author, { after })` → `Map<sub, {posts, comments}>` (throws `Unsupported`/`QueryTimeout`/others); the existing `minOf`, `settleAll`, `Aborted`, `QueryTimeout`, `Unsupported`.
- Produces: `buildProfile(…, { only, dumps, … })` makes one `interactions` request instead of two lifetime aggregates when `only` covers only archived subreddits.

- [ ] **Step 1: Write the failing tests** (append to `web/tests/core.test.js`; `fakeDumps`, `T`, `POST`, `makeClient`, `json`, `searchTimes`, `interactions`, `isInteractions`, `notSupported`, `daily` and `memCache`-style helpers already exist. Check the file for the exact cache helper name used by the cached-profile tests and use it.)

```js
// Lifetime aggregates (every subreddit), interactions (`recent`, for the window after its
// `after`), and "before" searches (none needed when the archive covers the post). Records URLs.
function apiForLifetime({ lifetime = { posts: [], comments: [] }, recent = [], recentAfter = null, interactionsFail = null }) {
  return (u) => {
    if (isInteractions(u)) {
      if (interactionsFail) return interactionsFail();
      if (recentAfter !== null) assert.equal(u.searchParams.get("after"), String(recentAfter));
      return interactions(recent);
    }
    const kind = u.pathname.includes("/posts/") ? "posts" : "comments";
    if (u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit")) {
      return json({ data: lifetime[kind].map(([key, n]) => ({ key, count: String(n) })) });
    }
    return searchTimes(u, []);
  };
}
const lifetimeAggregates = (calls) => calls.filter((u) => u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit"));

test("only covered subreddits: lifetime counts from the archive plus one interactions query", async () => {
  const through = T - 86400;
  const { client, calls } = makeClient(apiForLifetime({ recent: [["Python", 1, 2], ["rust", 9, 9]], recentAfter: through }));
  const dumps = fakeDumps({
    postsThrough: through, commentsThrough: through,
    times: { posts: { alice: [T - 10 * 86400] }, comments: { alice: [T - 30 * 86400, T - 2 * 86400, through] } },
  });
  const p = await buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps });
  assert.equal(lifetimeAggregates(calls).length, 0);
  assert.equal(calls.filter(isInteractions).length, 1);
  assert.deepEqual([...p.subreddits], [["Python", { posts: 1 + 1, comments: 3 + 2 }]]); // rust ignored
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [1, 3]);
});

test("one cutoff for both kinds: nothing between the two ends is counted twice", async () => {
  const postsThrough = T - 5 * 86400;
  const commentsThrough = T - 86400;
  const between = T - 3 * 86400; // after postsThrough, before commentsThrough: interactions' job
  const { client } = makeClient(apiForLifetime({ recent: [["Python", 0, 1]], recentAfter: postsThrough }));
  const dumps = fakeDumps({ postsThrough, commentsThrough, times: { comments: { alice: [T - 20 * 86400, between] } } });
  const p = await buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps });
  assert.equal(p.subreddits.get("Python").comments, 2); // 1 archived up to the cutoff + 1 recent
});

test("a subreddit the archive doesn't cover in only: the aggregates answer for everything", async () => {
  const { client, calls } = makeClient(apiForLifetime({ lifetime: { posts: [], comments: [["Python", 4], ["rust", 2]] } }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, times: { comments: { alice: daily(3) } } });
  const p = await buildProfile(client, "alice", 1, POST, { only: ["Python", "rust"], dumps });
  assert.equal(calls.filter(isInteractions).length, 0);
  assert.equal(lifetimeAggregates(calls).length, 2);
  assert.equal(p.subreddits.get("rust").comments, 2);
});

test("without only, lifetime counts come from the aggregates as before", async () => {
  const { client, calls } = makeClient(apiForLifetime({ lifetime: { posts: [], comments: [["Python", 4]] } }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, times: { comments: { alice: daily(3) } } });
  await buildProfile(client, "alice", 1, POST, { dumps });
  assert.equal(calls.filter(isInteractions).length, 0);
  assert.equal(lifetimeAggregates(calls).length, 2);
});

test("if interactions can't answer, the aggregates do", async () => {
  const { client, calls } = makeClient(apiForLifetime({ lifetime: { posts: [], comments: [["Python", 7]] }, interactionsFail: notSupported }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, times: { comments: { alice: daily(3) } } });
  const p = await buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps });
  assert.equal(lifetimeAggregates(calls).length, 2);
  assert.equal(p.subreddits.get("Python").comments, 7);
});

test("if the archive can't be read, the aggregates answer", async () => {
  const { client, calls } = makeClient(apiForLifetime({ lifetime: { posts: [], comments: [["Python", 7]] }, before: {} }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, fail: new Error("Failed to fetch") });
  const p = await buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps });
  assert.equal(calls.filter(isInteractions).length, 0);
  assert.equal(p.subreddits.get("Python").comments, 7);
});

test("Stop while reading the archive for lifetime counts stops the profile", async () => {
  const { client, calls } = makeClient(apiForLifetime({}));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, fail: new Aborted("stopped") });
  await assert.rejects(buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps }), Aborted);
  assert.equal(calls.length, 0);
});

test("a window after the archive's end: everything comes from interactions after the window start", async () => {
  const through = T - 20 * 86400;
  const after = T - 10 * 86400;
  const { client } = makeClient(apiForLifetime({ recent: [["Python", 0, 2]], recentAfter: after }));
  const dumps = fakeDumps({ postsThrough: through, commentsThrough: through, times: { comments: { alice: [T - 30 * 86400, through] } } });
  const p = await buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps, after });
  assert.equal(p.subreddits.get("Python").comments, 2);
});

test("archive lifetime counts aren't saved as the user's profile", async () => {
  const { client } = makeClient(apiForLifetime({ recent: [["Python", 0, 1]] }));
  const backend = new MemoryBackend();
  const cache = new ProfileCache({ backend, ttlDays: 7 });
  const dumps = fakeDumps({ postsThrough: T - 86400, commentsThrough: T - 86400, times: { comments: { alice: [T - 2 * 86400] } } });
  await buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps, cache });
  assert.equal((await backend.getPrefix("v1|life|")).length, 0);
});
```

`MemoryBackend` and `ProfileCache` are already imported in `core.test.js` from `../cache.js`. The `before: {}` key in one handler call is ignored by `apiForLifetime`, which is harmless.

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && node --test --test-name-pattern="lifetime|interactions|cutoff|only|window after" tests/core.test.js`
Expected: the archive-path tests FAIL, because the aggregates are still queried and `interactions` never is. The fallback tests may already pass.

- [ ] **Step 3: Add `archiveLifetime`** to `web/core.js`, directly after `lifetimeCounts`:

```js
// Lifetime counts from the archive, for a scan limited (`only`) to subreddits it covers:
// each wanted subreddit's items up to one cutoff (the earliest point every file can be
// trusted to), plus one interactions query for everything after it, posts and comments
// together (its `after` is exclusive, so nothing is counted twice). One request instead
// of two aggregates. Returns {counts, partial: true} (only the wanted subreddits, so it's
// never saved as a profile), or null when the archive doesn't cover them all or can't be
// read, or interactions can't answer: the aggregates then answer as usual.
async function archiveLifetime(client, dumps, username, wanted, after) {
  const covered = wanted.map((sub) => dumps.covers(sub));
  if (covered.some((c) => !c)) return null;
  const cutoff = minOf(covered.flatMap((c) => [c.postsThrough, c.commentsThrough]));
  const counts = new Map();
  const byKey = new Map();
  const upToCutoff = (times) => times.filter((t) => t <= cutoff && (after === null || t > after)).length;
  try {
    const perSub = await settleAll(covered.map(async (c) => {
      const [posts, comments] = await settleAll(KINDS.map((k) => dumps.timestamps(k, c.name, username)));
      return [c.name, { posts: upToCutoff(posts), comments: upToCutoff(comments) }];
    }));
    for (const [name, c] of perSub) {
      counts.set(name, c);
      byKey.set(name.toLowerCase(), c);
    }
  } catch (err) {
    if (err instanceof Aborted) throw err;
    return null;
  }
  let recent;
  try {
    recent = await client.interactionCounts(username, { after: after === null ? cutoff : Math.max(after, cutoff) });
  } catch (err) {
    if (err instanceof QueryTimeout || err instanceof Unsupported) return null;
    throw err;
  }
  for (const [sub, c] of recent) {
    const mine = byKey.get(sub.toLowerCase());
    if (!mine) continue;
    mine.posts += c.posts;
    mine.comments += c.comments;
  }
  return { counts, partial: true };
}
```

- [ ] **Step 4: Use it in `buildProfile`.** Replace `const life = await lifetimeCounts(client, username, { wanted, after });` with:

```js
    const life = (wanted && dumps && await archiveLifetime(client, dumps, username, wanted, after))
      ?? await lifetimeCounts(client, username, { wanted, after });
```

Also add to `buildProfile`'s doc comment: "With `only` and `dumps`, when the archive covers every wanted subreddit, lifetime counts come from it plus one interactions query (see archiveLifetime)."

- [ ] **Step 5: Run the tests.** Run `cd web && npm test`; all must pass, old and new.

- [ ] **Step 6: Update the docs**
  - **CLAUDE.md, the `buildProfile` bullet on lifetime counts:** add "With `only` limited to subreddits the archive covers, they come from the archive up to one cutoff plus a single `interactions` query after it (`after` is exclusive; checked live), and aren't cached, since they're partial."
  - **CLAUDE.md, Arctic Shift API facts:** add "`/api/users/interactions/subreddits`'s `after` is exclusive, like search's (an item at exactly `after` isn't counted)."
  - **README.md, "how it works":** after the sentence about archive files, add "If you limit a scan to subreddits the archive covers (Only these subreddits), each user's counts there also come from the files, plus one request for anything newer."

- [ ] **Step 7: Commit**

```bash
git add web/core.js web/tests/core.test.js CLAUDE.md README.md docs/superpowers/plans/2026-09-25-archive-lifetime-counts.md
git commit -m "Lifetime counts from the archive for scans limited to covered subreddits

With only naming subreddits the archive covers, each user's lifetime
counts there come from the archive up to one cutoff plus a single
interactions query after it (after is exclusive, checked live): one
request per user instead of two aggregates. Anything it can't answer
falls back to the aggregates; the partial result is never cached.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

- **Coverage of the design decisions:**
  - When it applies: tests "only covered…", "doesn't cover…" and "without only…".
  - The cutoff and the exclusive `after`: "one cutoff…".
  - Result shape and never cached: "only covered…" and "aren't saved…".
  - Failures: "interactions can't answer…", "archive can't be read…" and "Stop…".
  - The history window: "a window after…".
  - Remembered lookups: Task 1's tests.
- **Placeholders:** Task 2, Step 1 tells the implementer to confirm the cache helper names. `MemoryBackend` and `ProfileCache` are imported in `core.test.js` today, and `isInteractions`, `interactions` and `notSupported` are defined at the top of that file.
- **Names used across tasks:** `timestamps` has the same signature in both tasks. `archiveLifetime` is used only by `buildProfile`.
- **Review focus:** each of the five items names its test.
