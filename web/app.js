// The page: reads the form, runs a scan with core.js (several users at a time) and shows
// the results as they arrive. The API and profiling logic live in core.js; saved results
// in cache.js.

import {
  Aborted,
  ArcticShiftClient,
  BADGE_FIELDS,
  BADGE_TIERS,
  Eta,
  buildProfile,
  DEFAULT_BADGES,
  activityTier,
  badgeFacts,
  parseBadges,
  profileFacts,
  formatBadges,
  sameBadges,
  tierCounts,
  arcticSearchUrl,
  collectCommenters,
  deserializeProfile,
  emptyProfile,
  estimateScan,
  fetchTails,
  exportScans,
  parseScanExport,
  LARGE_SCAN,
  mapPool,
  parsePostRef,
  redditPostUrl,
  redditSubredditUrl,
  DAY,
  scanStats,
  serializeProfile,
  sortedSubreddits,
  toCsv,
  wait,
} from "./core.js";
import { openCache, openScans } from "./cache.js";
import { describeRule, explain, formatDuration, formatEta, plural, requestsText, timelineText, tookText } from "./format.js";
import { FIELD_IDS, mergeOptions, optionsSummary, parseMinCount, parseOptions, readShareParams, scanOptionNotes, shareParams } from "./options.js";
import { DumpSource, TailStore } from "./dumps.js";
import { LinkQueue, MAX_WAITING, QUEUE_CONCURRENCY, QUEUE_KEY } from "./queue.js";

const $ = (id) => document.getElementById(id);
const TITLE = document.title;

const state = {
  runId: 0, // bumped for every run; callbacks from an older run are ignored
  controller: null, // AbortController of the run in progress
  focusRunAfter: false,
  post: null,
  slots: [], // profiles by rank (thread activity); has gaps while a run is going
  shown: 0, // cards passing the filter
  beforeKnown: true, // false when the post is older than the history window
  after: null, // start of the history window (epoch seconds), null = all time
  savedId: null, // post id of the saved scan on show, if one was opened
  // Post id the address bar links to while its results are on show: set by a manual run,
  // null for a saved or queued scan, whose link would start a fresh scan on reload.
  urlPost: null,
};
// Covered subreddits' activity since their archive files end, kept for this tab's scans, so
// the next scan (a queued one in the same subreddit, say) asks only for what's new.
const tails = new TailStore();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// ---- Options ----

// The options as a run will use them, clamped to what the tool supports.
function readOptions() {
  const fields = { includeOp: $("include-op").checked };
  for (const [key, id] of Object.entries(FIELD_IDS)) fields[key] = $(id).value;
  return parseOptions(fields);
}

function minCount() {
  return parseMinCount($("min-count").value);
}

// Put the options back in the form as they'll be used (after a shared link or a typo).
function showOptions(opts) {
  $("include-op").checked = opts.includeOp;
  $("exclude").value = opts.exclude.join(", ");
  $("only-subs").value = opts.only.join(", ");
  $("years").value = opts.years ?? "";
  $("max-users").value = opts.maxUsers ?? "";
  $("delay").value = opts.delay;
  $("concurrency").value = opts.concurrency;
  $("cache-days").value = opts.cacheDays;
  $("min-count").value = minCount();
  updateOptionsSummary(opts);
}

// "Options: author included · top 20 · last 5 years", so settings from a shared link are
// visible without opening the panel.
function updateOptionsSummary(o = readOptions()) {
  const text = optionsSummary(o, badges);
  $("options-summary").textContent = text ? `: ${text}` : "";
}

// ---- Badges ----

// The badge rules in use: from the link (badges=), else as last set in this browser, else
// the defaults. Badges are worked out when shown, so changing the rules re-rates every
// result on the page and in saved scans without any requests.
// Named before the project became Reddit Post Profiler; kept so visitors' saved data survives.
const BADGE_KEY = "reddit-tool-badges";
let badges = DEFAULT_BADGES;

function storedBadges() {
  try {
    return parseBadges(localStorage.getItem(BADGE_KEY));
  } catch {
    return null;
  }
}

function showBadges() {
  for (const tier of BADGE_TIERS) {
    for (const field of BADGE_FIELDS) $(`badge-${tier}-${field}`).value = badges[tier][field];
  }
  renderBadgeLegend();
}

// "3+ posts and comments, on 2+ days, the first 14+ days before"
function renderBadgeLegend() {
  $("badge-legend").replaceChildren(
    el("b", {}, "regular"), ` (${describeRule(badges.regular)}), `,
    el("b", {}, "occasional"), ` (${describeRule(badges.occasional)}) or `,
    el("b", {}, "new here"), " (anyone else).");
}

// Read the inputs; a blank or invalid one keeps its current value.
function readBadges() {
  const rules = { occasional: { ...badges.occasional }, regular: { ...badges.regular } };
  for (const tier of BADGE_TIERS) {
    for (const field of BADGE_FIELDS) {
      const n = Math.floor(Number.parseFloat($(`badge-${tier}-${field}`).value));
      if (Number.isFinite(n) && n >= 0) rules[tier][field] = Math.min(n, 99999);
    }
  }
  return rules;
}

function setBadges(rules, { remember = true } = {}) {
  badges = rules;
  if (remember) {
    try {
      if (sameBadges(rules, DEFAULT_BADGES)) localStorage.removeItem(BADGE_KEY);
      else localStorage.setItem(BADGE_KEY, formatBadges(rules));
    } catch {
      // Storage blocked: the rules still apply until the page closes.
    }
  }
  renderBadgeLegend();
  updateOptionsSummary();
  rerateBadges();
}

const rerateBadges = debounce(() => {
  renderUsers();
  renderSaved();
}, 200);

// ---- Status ----

// eta: the running scan's Eta (null when not profiling); etaTimer ticks it every second.
const status = { text: "", waits: 0, until: 0, reason: "", timer: null, eta: null, etaTimer: null };

function renderStatus() {
  const left = Math.ceil(status.until - Date.now() / 1000);
  const wait = status.waits > 0 && left > 0 ? ` (${status.reason}, resuming in ${left}s)` : "";
  const eta = status.eta ? formatEta(status.eta.secondsLeft()) : "";
  $("status-text").textContent = status.text + wait + (eta ? ` · ${eta}` : "");
}

// Rounded so it doesn't flicker: 5 s steps under a minute, 10 s under 10 minutes.
function startEta(total) {
  stopEta();
  status.eta = new Eta(total);
  status.etaTimer = setInterval(renderStatus, 1000);
}

function stopEta() {
  clearInterval(status.etaTimer);
  Object.assign(status, { eta: null, etaTimer: null });
}

function setStatus(text) {
  status.text = text;
  $("status").hidden = false;
  renderStatus();
}

// The client reports each request that starts (reason, seconds) or stops (null) waiting
// out a rate limit or a busy server.
function onWait(reason, seconds) {
  if (reason) {
    status.waits++;
    const until = Date.now() / 1000 + seconds;
    // Every request waiting out one pause reports it, a moment apart: announce the pause
    // once, and again only if a later wait pushes its end out by more than a few seconds.
    if (seconds >= 10 && until > status.until + 5) {
      announce(`Paused: ${reason}. Resuming in ${Math.round(seconds)} seconds.`);
    }
    if (until > status.until) {
      status.until = until;
      status.reason = reason;
    }
    status.timer ??= setInterval(renderStatus, 1000);
  } else if (--status.waits <= 0) {
    clearWaits();
  }
  renderStatus();
}

function clearWaits() {
  clearInterval(status.timer);
  Object.assign(status, { waits: 0, until: 0, timer: null });
}

function setProgress(fraction) {
  const pct = Math.round(fraction * 100);
  $("bar-fill").style.width = `${pct}%`;
  $("bar").setAttribute("aria-valuenow", String(pct));
  const queued = queue.counts().waiting;
  document.title = state.controller ? `(${pct}%${queued ? `, ${queued} queued` : ""}) ${TITLE}` : TITLE;
}

// Screen readers hear these (milestones only, not every progress tick).
function announce(text) {
  $("announce").textContent = text;
}

// Plain-language explanation of an error from core.js; the raw message goes in details.
function showError(message, detail = null) {
  const box = $("error");
  box.replaceChildren();
  box.hidden = !message;
  if (!message) return;
  box.append(el("p", {}, message));
  if (detail && detail !== message) box.append(el("details", {}, el("summary", {}, "Details"), detail));
}

function setRunning(running) {
  $("run").disabled = running;
  $("post").readOnly = running;
  $("option-fields").disabled = running;
  for (const b of $("saved-list").querySelectorAll("button")) b.disabled = running;
  $("scans-delete-all").disabled = running;
  renderQueue();
  // Stop is about to disappear: don't strand keyboard focus on it.
  if (!running && document.activeElement === $("stop")) state.focusRunAfter = true;
  $("stop").hidden = !running;
  $("stop").disabled = false;
  $("stop").textContent = "Stop";
  $("download").textContent = running ? "Download CSV (so far)" : "Download CSV";
  if (!running && state.focusRunAfter) $("run").focus({ preventScroll: true });
  state.focusRunAfter = false;
}

// Before a large scan, show its rough cost and ask how many users to profile. Resolves
// "top", "all" or "cancel" (also on Stop).
function askLargeScan(est, signal) {
  if (signal.aborted) return Promise.resolve("cancel"); // Stop was pressed while estimating
  const box = $("confirm");
  const time = formatDuration(Math.max(1, Math.round(est.seconds / 60)) * 60); // whole minutes: it's rough
  $("confirm-text").textContent =
    `This thread has ${est.users.toLocaleString()} commenters to profile` +
    (est.saved ? `, ${est.saved.toLocaleString()} with saved results` : "") +
    `. Profiling them all takes roughly ${est.requests.toLocaleString()} requests (about ${time}) ` +
    "to the free Arctic Shift API. The most active commenters usually tell you most of what you need.";
  $("confirm-top").textContent = `Profile the top ${LARGE_SCAN}`;
  $("confirm-all").textContent = `Profile all ${est.users.toLocaleString()}`;
  box.hidden = false;
  $("confirm-top").focus();
  announce($("confirm-text").textContent);
  return new Promise((resolve) => {
    const done = (choice) => {
      // Keep keyboard focus nearby: on Stop while profiling, on Analyze after a cancel.
      if (box.contains(document.activeElement)) {
        if (choice === "cancel") state.focusRunAfter = true;
        else $("stop").focus({ preventScroll: true });
      }
      box.hidden = true;
      for (const [id, fn] of handlers) $(id).removeEventListener("click", fn);
      signal.removeEventListener("abort", onAbort);
      resolve(choice);
    };
    const handlers = [["confirm-top", () => done("top")], ["confirm-all", () => done("all")],
      ["confirm-cancel", () => done("cancel")]];
    for (const [id, fn] of handlers) $(id).addEventListener("click", fn);
    const onAbort = () => done("cancel");
    signal.addEventListener("abort", onAbort);
  });
}

function stop() {
  if (!state.controller) return;
  state.focusRunAfter = document.activeElement === $("stop");
  state.controller.abort();
  $("stop").disabled = true;
  $("stop").textContent = "Stopping…";
}

// ---- Post and user cards ----

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Commenters in the archive and their comments (a scan's commenters map → numbers).
function threadStats(commenters) {
  const people = [...commenters.values()].filter((c) => c.count > 0);
  return { people: people.length, comments: people.reduce((n, c) => n + c.count, 0) };
}

function renderPost(post, thread) {
  $("post-card").hidden = false;
  $("post-sub").textContent = `r/${post.subreddit}`;
  $("post-title").textContent = post.title || "(untitled post)";
  $("post-title").href = redditPostUrl(post);
  let meta = `by u/${post.author} · ${formatDate(post.createdUtc)}`;
  let title = "";
  if (thread) {
    meta += ` · ${plural(thread.people, "commenter")} with ${plural(thread.comments, "comment")} in the archive`;
    title = "Not counting deleted accounts, AutoModerator or skipped users. " +
      `Reddit counted ${plural(post.numComments, "comment")} when the post was archived.`;
  }
  $("post-meta").textContent = meta;
  $("post-meta").title = title;
  for (const n of document.querySelectorAll(".target-name")) n.textContent = `r/${post.subreddit}`;
}

function renderWindowNote(after) {
  if (after === null) {
    $("window-note").textContent = "";
    return;
  }
  const since = new Date(after * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
  $("window-note").textContent = ` Only activity since ${since} is counted` +
    (state.beforeKnown ? "." : `; this post is older than that, so there's no "before" to count.`);
}

// The badge for a user's activity in the post's subreddit before the post.
function activity(profile, post) {
  const sub = `r/${post.subreddit}`;
  if (!state.beforeKnown) {
    return { cls: "pill", text: "before: outside window", title: `This post is older than the history window` };
  }
  const { targetPostsBefore: posts, targetCommentsBefore: comments } = profile;
  if (posts + comments === 0) {
    return { cls: "pill new", text: "new here", title: `No posts or comments in ${sub} before this post` };
  }
  const counts = [posts && plural(posts, "post"), comments && plural(comments, "comment")].filter(Boolean).join(", ");
  const facts = profileFacts(profile, post);
  const tier = activityTier(facts, badges);
  const detail = `${counts} in ${sub} before this post${timelineText(facts)}`;
  return { cls: `pill ${tier}`, text: `${TIER_LABELS[tier]} · ${counts} before`, title: detail, detail };
}

const TIER_LABELS = { new: "new here", occasional: "occasional", regular: "regular" };

// ", on 12 different days, the first 5 months before" (or why there's no timeline).
const searchWords = new WeakMap();

function userCard(profile, post) {
  // The post's subreddit leads, in the summary line and the table.
  const subs = sortedSubreddits(profile, post, minCount(), { targetFirst: true });
  const active = subs.filter((s) => s.total > 0);
  const pills = el("span", { class: "stats" }, el("span", { class: "pill" }, `${profile.threadComments} in thread`));
  let label;
  if (profile.error) {
    pills.append(el("span", { class: "pill err" }, "lookup failed"));
    label = `u/${profile.username}: lookup failed`;
  } else {
    const a = activity(profile, post);
    pills.append(
      el("span", { class: a.cls, title: a.title }, a.text),
      el("span", { class: "pill", title: "Subreddits with archived posts or comments" }, plural(active.length, "subreddit")),
    );
    label = `u/${profile.username}: ${profile.threadComments} in thread, ${a.text}, ${plural(active.length, "subreddit")}`;
  }
  if (profile.cached) {
    pills.append(el("span", { class: "pill saved", title: "Reused from an earlier scan in this browser" }, "saved"));
    label += ", saved";
  }

  const top = active.slice(0, 6).map((s) => `r/${s.name} (${s.total})`).join(" · ");
  const summary = el("summary", { "aria-label": label },
    el("span", { class: "name" }, `u/${profile.username}`),
    pills,
    el("span", { class: "top" }, profile.error || top || "No archived posts or comments"));
  const card = el("details", { class: "user" }, summary);
  card.dataset.rank = String(profile.rank);
  searchWords.set(card, [profile.username, ...active.map((s) => s.name)].map((w) => w.toLowerCase()));

  // Build the panel the first time the card is opened.
  card.addEventListener("toggle", () => {
    if (!card.open || card.querySelector(".panel")) return;
    const profileUrl = `https://www.reddit.com/user/${encodeURIComponent(profile.username)}/`;
    const panel = el("div", { class: "panel" },
      el("p", { class: "panel-links" },
        el("a", { href: profileUrl, target: "_blank", rel: "noopener" }, `u/${profile.username} on Reddit ↗`)));
    const a = profile.error ? null : activity(profile, post);
    if (a?.detail) panel.append(el("p", { class: "facts" }, `${a.detail[0].toUpperCase()}${a.detail.slice(1)}.`));
    if (profile.error) panel.append(el("p", { class: "empty" }, profile.errorDetail || profile.error));
    else if (!subs.length) panel.append(el("p", { class: "empty" }, "No archived activity."));
    else panel.append(subredditTable(subs, post, profile.username));
    card.append(panel);
  });
  return card;
}

function subredditTable(subs, post, username) {
  const target = post.subreddit.toLowerCase();
  // A count links to those posts or comments on Arctic Shift, over the same history window.
  const countCell = (kind, n, sub) => el("td", {}, !n ? "0" :
    el("a", {
      href: arcticSearchUrl(kind, username, sub, state.after),
      target: "_blank",
      rel: "noopener",
      "aria-label": `${n} ${n === 1 ? kind.slice(0, -1) : kind} in r/${sub} on Arctic Shift`,
    }, String(n)));
  const body = el("tbody");
  for (const s of subs) {
    body.append(
      el("tr", { class: s.name.toLowerCase() === target ? "target" : "" },
        el("td", {}, el("a", { href: redditSubredditUrl(s.name), target: "_blank", rel: "noopener" }, `r/${s.name}`)),
        countCell("posts", s.posts, s.name),
        countCell("comments", s.comments, s.name),
        el("td", {}, String(s.total))),
    );
  }
  return el("div", { class: "subs-wrap" },
    el("table", { class: "subs" },
      el("thead", {}, el("tr", {},
        el("th", { scope: "col" }, "Subreddit"), el("th", { scope: "col" }, "Posts"),
        el("th", { scope: "col" }, "Comments"), el("th", { scope: "col" }, "Total"))),
      body));
}

// ---- Filter and list ----

// Filter terms, ignoring "r/" and "u/" prefixes; a user must match every term.
function filterTerms() {
  return $("filter").value.toLowerCase().split(/[\s,]+/).map((t) => t.replace(/^\/?[ru]\//, "")).filter(Boolean);
}

function matches(card, terms) {
  const words = searchWords.get(card) ?? [];
  return terms.every((t) => words.some((w) => w.includes(t)));
}

function updateFilterNote(terms) {
  const total = $("users").childElementCount;
  $("filter-note").textContent = !terms.length ? ""
    : state.shown ? `Showing ${state.shown} of ${plural(total, "user")}`
    : `No users match “${$("filter").value.trim()}”`;
}

function applyFilter() {
  const terms = filterTerms();
  state.shown = 0;
  for (const card of $("users").children) {
    card.hidden = !matches(card, terms);
    if (!card.hidden) state.shown++;
  }
  updateFilterNote(terms);
}

// Insert a card so the list stays in thread-activity order while results arrive out of
// order. They mostly arrive in order, so search from the end.
function insertCard(card) {
  const list = $("users");
  const rank = Number(card.dataset.rank);
  let next = null;
  for (let c = list.lastElementChild; c && Number(c.dataset.rank) > rank; c = c.previousElementSibling) next = c;
  list.insertBefore(card, next);
  const terms = filterTerms();
  card.hidden = !matches(card, terms);
  if (!card.hidden) state.shown++;
  updateFilterNote(terms);
}

// Rebuild every card (after the minimum changes), keeping open ones open.
function renderUsers() {
  if (!state.post) return;
  const open = new Set([...$("users").querySelectorAll(".user[open]")].map((c) => c.dataset.rank));
  const cards = state.slots.filter(Boolean).map((p) => {
    const card = userCard(p, state.post);
    if (open.has(card.dataset.rank)) card.open = true;
    return card;
  });
  $("users").replaceChildren(...cards);
  applyFilter();
  // Re-rating (badges, min count) keeps a manual run's link up to date.
  if (state.urlPost) history.replaceState(null, "", shareUrl(state.urlPost));
}

// ---- A run ----

// Scan the post in the box with the options in the form. Resolves with how it ended:
// {kind: "done" | "empty" | "stopped" | "failed" | "invalid" | "offline" | "busy",
//  message, post, profiled, total, failed}.
// Scan a post. A manual run takes the post and options from the form (and puts the options
// back as they'll be used); a queued run passes its own and leaves the form alone, so
// whatever someone is typing there meanwhile stays put.
async function run({ fromQueue = false, postRef = null, opts = null } = {}) {
  if (state.controller) return { kind: "busy", message: "A scan is already running." };
  if (!fromQueue) {
    postRef = $("post").value;
    opts = readOptions();
    showOptions(opts);
    $("post").removeAttribute("aria-invalid");
  }
  showError("");
  let postId;
  try {
    postId = parsePostRef(postRef);
  } catch (err) {
    showError(err.message);
    if (!fromQueue) {
      $("post").setAttribute("aria-invalid", "true");
      $("post").setAttribute("aria-describedby", "error");
      if (!queueRunning()) $("post").focus();
    }
    return { kind: "invalid", message: err.message };
  }
  if (navigator.onLine === false) {
    const message = "You're offline. Connect to the internet and try again.";
    showError(message);
    return { kind: "offline", message };
  }
  // A queued scan leaves the address alone: reloading would start it again outside the queue.
  if (!fromQueue) history.replaceState(null, "", shareUrl(postId, opts));

  // Start of the history window, in epoch seconds (null = all time).
  const after = opts.years ? Math.floor(Date.now() / 1000 - opts.years * 365.25 * DAY) : null;
  const runId = ++state.runId;
  const controller = new AbortController();
  Object.assign(state, {
    controller, post: null, slots: [], shown: 0, beforeKnown: true, after, savedId: null,
    urlPost: fromQueue ? null : postId,
  });
  markCurrentScan();
  // The post, results and saved list are about to be hidden or disabled, and Analyze and
  // the options too (Enter in an option field starts a scan):
  // keyboard focus on any of them moves to Stop once it shows (below), instead of being
  // dropped.
  const refocus = ["post-card", "results", "saved-list", "run", "option-fields"].some((id) => $(id).contains(document.activeElement));
  $("post-card").hidden = true;
  $("results").hidden = true;
  $("users").replaceChildren();
  $("bar").hidden = false;
  clearWaits();
  setRunning(true);
  setProgress(0);

  const cache = openCache(opts.cacheDays);
  // Unattended queued scans go easier on the API.
  const concurrency = fromQueue ? Math.min(QUEUE_CONCURRENCY, opts.concurrency) : opts.concurrency;
  const client = new ArcticShiftClient({
    sleep: backgroundSleep,
    delay: opts.delay,
    maxInFlight: concurrency,
    signal: controller.signal,
    onWait: (reason, seconds) => runId === state.runId && onWait(reason, seconds),
    onPause: (until) => runId === state.runId && status.eta?.pause(until),
  });
  const counts = { done: 0, total: 0 };
  // Requests to the archive server (R2): the manifest and each range read. The API's are
  // client.requests.
  let archiveRequests = 0;
  let failed = 0;
  let capped = null; // commenters in the thread, when only the top LARGE_SCAN were profiled
  let outcome = { kind: "failed", message: "" };
  const ended = (kind, message) => {
    outcome = {
      kind, message, post: state.post, profiled: counts.done, total: counts.total, failed,
      seconds: elapsed().seconds, saved: savedOk, capped,
    };
  };
  let thread = null;
  let fromCache = 0;
  let savedOk = false;
  // Snapshot the scan for the saved list (a stopped one too, if anyone was profiled).
  const save = async (complete) => {
    if (!opts.cacheDays || !counts.done || !state.post) return;
    const profiles = state.slots.filter(Boolean);
    const summary = {
      id: state.post.id,
      post: state.post,
      scannedAt: Date.now() / 1000,
      complete,
      total: counts.total,
      thread,
      requests: client.requests,
      archiveRequests,
      ...elapsed(),
      fromSaved: fromCache,
      after,
      beforeKnown: state.beforeKnown,
      opts: {
        only: opts.only, years: opts.years, maxUsers: capped ? LARGE_SCAN : opts.maxUsers,
        includeOp: opts.includeOp, exclude: opts.exclude,
      },
      stats: scanStats(profiles, state.post, state.beforeKnown, badges),
      facts: badgeFacts(profiles, state.post), // tier counts under whatever badge rules apply later
    };
    // A scan where every lookup failed isn't saved ("empty"), and a stopped one doesn't
    // replace a complete scan of the post ("kept").
    const result = await openScans().save(summary, profiles.map(serializeProfile));
    if (runId !== state.runId) return;
    if (result === "saved") {
      savedOk = true;
      state.savedId = state.post.id;
      renderSaved();
    } else if (result === "kept") {
      setStatus(`${status.text} The complete scan of this post saved earlier was kept.`);
    }
  };
  // Real time taken, shown when the run ends so it can be compared with the estimate
  // (which covers the profiling part only).
  const startedAt = performance.now();
  let profilingAt = null;
  const elapsed = () => {
    const now = performance.now();
    return { seconds: (now - startedAt) / 1000, profilingSeconds: profilingAt === null ? null : (now - profilingAt) / 1000 };
  };
  const took = () => tookText(elapsed());
  const fail = (text) => {
    $("bar").hidden = true;
    setStatus(`Failed after ${took()}.`);
    return text;
  };

  try {
    setStatus("Looking up the post…");
    // Only now is the status line (and Stop in it) shown on a first scan.
    if (refocus) $("stop").focus({ preventScroll: true });
    announce("Looking up the post…");
    const post = await client.getPost(postId);
    if (!post) {
      const message = `Post ${postId} isn't in the Arctic Shift archive. It may have been removed, or be too new: posts usually appear within minutes.`;
      showError(fail(message));
      ended("failed", "Not in the Arctic Shift archive (yet).");
      return outcome;
    }
    state.post = post;
    state.beforeKnown = after === null || post.createdUtc > after;
    renderPost(post, null);
    renderWindowNote(after);

    // Archive files for the post's subreddit, if there are any: "before" facts come from
    // them rather than Arctic Shift searches. No manifest, or a broken one, means the API.
    const dumps = await DumpSource.open({ signal: controller.signal, onRequest: () => archiveRequests++, tails });
    // Where the files alone end, for the end-of-scan note.
    const archive = dumps?.covers(post.subreddit, { withTail: false }) ?? null;
    // What the files don't have yet, fetched once for the scan rather than per commenter.
    let tailRequests = 0;
    if (dumps) {
      setStatus("Checking recent activity…");
      const sent = client.requests;
      await fetchTails(client, dumps, post, { only: opts.only });
      tailRequests = client.requests - sent;
    }

    setStatus("Collecting commenters…");
    const commenters = await collectCommenters(client, post, opts);
    thread = threadStats(commenters);
    renderPost(post, thread);

    let ranked = [...commenters].sort((a, b) =>
      b[1].count - a[1].count || a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
    if (opts.maxUsers) ranked = ranked.slice(0, opts.maxUsers);
    // A big thread asks first (unless a limit was set): all of it can take thousands of
    // requests. A queued scan has nobody to ask, so it takes the top ones.
    else if (ranked.length > LARGE_SCAN) {
      setStatus("Checking saved results…");
      const est = await estimateScan(cache, ranked.map(([u]) => u), { after, delay: opts.delay, concurrency });
      if (!fromQueue) setStatus(`Found ${plural(ranked.length, "commenter")}.`);
      const choice = fromQueue ? "top" : await askLargeScan(est, controller.signal);
      if (choice === "cancel") {
        $("bar").hidden = true;
        const text = `Cancelled. To profile fewer, set “Only the N most active commenters” in Options. Took ${took()}.`;
        setStatus(text);
        ended("stopped", "Cancelled before profiling.");
        return outcome;
      }
      if (choice === "top") {
        capped = ranked.length;
        ranked = ranked.slice(0, LARGE_SCAN);
      }
    }
    if (!ranked.length) {
      $("bar").hidden = true;
      const text = post.numComments
        ? "None of this post's archived comments are from accounts that can be profiled."
        : "This post has no archived comments yet.";
      setStatus(`${text} Took ${took()}.`);
      announce(text);
      ended("empty", text);
      return outcome;
    }
    $("results").hidden = false;
    updateFilterNote(filterTerms());

    counts.total = ranked.length;
    let inFlight = 0;
    let firstError = null;
    let milestone = 0.25;
    const progress = () => {
      setStatus(`Profiled ${counts.done} of ${counts.total}` +
        (fromCache ? `, ${fromCache} from saved results` : "") +
        (inFlight ? ` (${inFlight} in progress)` : "") +
        `. ${requestsText(client.requests, archiveRequests)} so far`);
      setProgress(counts.done / counts.total);
      onQueueProgress(counts);
      if (counts.done >= milestone * counts.total && counts.done < counts.total) {
        announce(`Profiled ${counts.done} of ${counts.total}.`);
        while (counts.done >= milestone * counts.total) milestone += 0.25;
      }
    };
    announce(`Found ${plural(counts.total, "commenter")}. Profiling…`);
    startEta(counts.total);
    profilingAt = performance.now();
    progress();
    await mapPool(ranked, concurrency, async ([username, { count, last }], i) => {
      inFlight++;
      progress();
      let profile;
      try {
        profile = await buildProfile(client, username, count, post, {
          only: opts.only, after, lastCommentUtc: last, cache, dumps,
        });
      } catch (err) {
        if (err instanceof Aborted) throw err;
        failed++;
        firstError ??= err;
        profile = { ...emptyProfile(username, count), error: explain(err), errorDetail: err.message };
      } finally {
        inFlight--;
      }
      profile.rank = i;
      if (profile.cached) fromCache++;
      state.slots[i] = profile;
      counts.done++;
      if (runId === state.runId) status.eta?.record(profile.cached);
      progress();
      insertCard(userCard(profile, post));
    }, controller.signal);

    stopEta();
    const notes = [fromCache && `${fromCache} from saved results`, failed && `${failed} failed`].filter(Boolean);
    const who = capped ? `the top ${counts.total} of ${plural(capped, "commenter")}` : plural(counts.total, "user");
    let text = `Done: profiled ${who}${notes.length ? ` (${notes.join(", ")})` : ""}` +
      ` with ${requestsText(client.requests, archiveRequests)}. Took ${took()}.`;
    if (archive) {
      if (dumps.broken) {
        text += ` The r/${archive.name} archive files stopped answering partway, so Arctic Shift answered for the rest.`;
      } else {
        if (dumps.reads > 0) {
          const upTo = new Date(Math.min(archive.postsThrough, archive.commentsThrough) * 1000)
            .toLocaleDateString(undefined, { dateStyle: "medium" });
          text += ` Activity in r/${archive.name} before the post, up to ${upTo}, came from archive files.`;
          const tailed = dumps.covers(post.subreddit);
          if (tailRequests) {
            text += ` Activity since then came from ${plural(tailRequests, "request")} for the whole subreddit rather than for each user.`;
          } else if (tailed && Math.min(tailed.postsThrough, tailed.commentsThrough) > Math.min(archive.postsThrough, archive.commentsThrough)) {
            text += " Activity since then came from what an earlier scan in this tab fetched for the whole subreddit.";
          }
        }
        if (dumps.lifetimeReads > 0) {
          text += " Subreddit counts came from the archive files plus Arctic Shift for anything newer.";
        }
      }
    }
    if (failed && failed < counts.total && opts.cacheDays > 0) {
      text += " Press Analyze to retry the failed ones; the rest are reused.";
    }
    setStatus(text);
    announce(text);
    await save(true);
    ended("done", text);
    if (failed === counts.total) {
      showError(`Every lookup failed. ${explain(firstError)}`, firstError.message);
      ended("failed", `Every lookup failed. ${explain(firstError)}`);
    }
  } catch (err) {
    if (runId === state.runId) stopEta();
    if (err instanceof Aborted) {
      const text = (counts.total ? `Stopped after ${counts.done} of ${plural(counts.total, "user")}.` : "Stopped.") +
        ` Ran for ${took()} with ${requestsText(client.requests, archiveRequests)}.`;
      setStatus(text);
      announce(text);
      await save(false);
      ended("stopped", text);
    } else {
      showError(fail(explain(err)), err.message);
      announce(explain(err));
      ended("failed", explain(err));
    }
  } finally {
    controller.abort(); // stop anything still in flight
    if (runId === state.runId) {
      state.controller = null;
      clearWaits();
      stopEta();
      renderStatus();
      setRunning(false);
      document.title = TITLE;
    }
  }
  // A queue waiting on a manual scan carries on. (A queued scan's own pump continues after
  // its gap between scans; starting it here too would skip the gap.)
  if (!fromQueue) setTimeout(pumpQueue);
  return outcome;
}

// ---- Background timers ----

// Browsers slow a hidden tab's timers to about one a minute after a few minutes, which
// would stall a long queue between requests. A worker's timers aren't slowed like that,
// so the client's waits run on one once it has answered a first ping (if workers are
// blocked, plain timers are used).
const workerTimer = (() => {
  const timer = { ready: false, start: null };
  try {
    const src = "onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);";
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    const pending = new Map();
    let next = 0;
    worker.onmessage = (e) => {
      if (e.data === 0) timer.ready = true;
      const done = pending.get(e.data);
      pending.delete(e.data);
      done?.();
    };
    timer.start = (ms, done) => {
      const id = ++next;
      pending.set(id, done);
      worker.postMessage({ id, ms });
      return () => pending.delete(id);
    };
    worker.postMessage({ id: 0, ms: 0 });
  } catch {
    // No workers: plain timers.
  }
  return timer;
})();

// core.js's wait() on the worker's timer once it's ready: resolves after `seconds`, or at
// once when `signal` aborts.
function backgroundSleep(seconds, signal = null) {
  return wait(seconds, signal, workerTimer.ready ? workerTimer.start : undefined);
}

// ---- Scheduler ----

const queue = new LinkQueue();
const QUEUE_GAP = 3; // seconds between queued scans, to go easy on the API
let pumping = false;
// No queued scan starts before this (epoch seconds): the gap after the last one holds
// whoever calls pumpQueue (Retry, Start, a manual scan ending), and one wait covers it.
let gapUntil = 0;
let gapWaiting = false;
// Only one tab runs the queue (it's shared through localStorage, so two tabs would overwrite
// each other's changes). The others show it read-only until that tab closes.
let queueOwner = false;
const QUEUE_LOCK = "reddit-tool-queue";
let queueCurrent = null; // id of the queued item being scanned

function queueRunning() {
  return queue.active || queueCurrent !== null;
}

const STATUS_PILLS = {
  waiting: ["", "waiting"],
  running: ["running", "scanning"],
  done: ["regular", "done"],
  failed: ["err", "failed"],
  stopped: ["", "stopped"],
};

function renderQueue() {
  // Where keyboard focus is, noted before anything changes: the list is rebuilt below, and
  // Clear finished may hide itself, so focus is put back afterwards.
  const list = $("queue-list");
  const clear = $("queue-clear");
  const clearHadFocus = document.activeElement === clear;
  const focusedRow = list.contains(document.activeElement) ? document.activeElement.closest("li") : null;
  const focused = focusedRow && {
    id: focusedRow.dataset.id,
    text: document.activeElement.textContent,
    index: [...list.children].indexOf(focusedRow),
  };

  const c = queue.counts();
  const busy = state.controller !== null;
  const parts = [];
  if (c.running) parts.push("scanning");
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (c.done) parts.push(`${c.done} done`);
  if (c.failed) parts.push(`${c.failed} failed`);
  $("queue-summary").textContent = parts.length ? `: ${parts.join(" · ")}` : "";

  const toggle = $("queue-toggle");
  if (queue.active) {
    toggle.textContent = "Pause queue";
    toggle.disabled = false;
  } else {
    toggle.textContent = queueCurrent ? "Resume queue" : "Start queue";
    toggle.disabled = !c.waiting && !queueCurrent;
  }
  for (const id of ["queue-input", "queue-add", "queue-clear"]) $(id).disabled = !queueOwner;
  if (!queueOwner) toggle.disabled = true;
  clear.hidden = !(c.done + c.failed + c.stopped);
  if (clear.hidden && clearHadFocus) focusQueueControls();

  list.replaceChildren(...queue.items.map((item) => {
    const [cls, label] = STATUS_PILLS[item.status];
    const actions = el("span", { class: "queue-actions" });
    const name = item.title ? `r/${item.subreddit} · ${item.title}` : item.ref;
    const button = (text, onClick, extra = {}) => {
      const b = el("button", { type: "button", "aria-label": `${text}: ${name}`, ...extra }, text);
      b.addEventListener("click", onClick);
      actions.append(b);
      return b;
    };
    // `saved` is set when the scan ends; the saved scan may have been deleted since.
    const openable = item.saved && (savedIds === null || savedIds.has(item.postId));
    if (item.status === "done" && openable) button("Open", () => openSaved(item.postId)).disabled = busy;
    if (item.status === "failed" || item.status === "stopped") button("Retry", () => retryQueued(item.id)).disabled = !queueOwner;
    if (item.status !== "running") button("Remove", () => removeQueued(item.id)).disabled = !queueOwner;
    const note = [item.note, ...scanOptionNotes(item.opts)].filter(Boolean).join(" · ");
    const li = el("li", { class: "queue-item" },
      el("span", { class: `pill ${cls}` }, label),
      el("span", { class: "queue-ref" }, name),
      actions,
      el("span", { class: "queue-note" }, note));
    li.dataset.status = item.status;
    li.dataset.id = item.id;
    return li;
  }));
  if (focused) restoreQueueFocus(focused);
}

// After the queue list is rebuilt: focus the same button in the same row, else another
// button there (a Retry became a Remove), else one in the row that took its place or the
// one before (the row was removed), else the queue's controls.
function restoreQueueFocus({ id, text, index }) {
  const enabled = (row) => [...(row?.querySelectorAll("button") ?? [])].filter((b) => !b.disabled);
  const rows = [...$("queue-list").children];
  const same = enabled(rows.find((row) => row.dataset.id === id));
  const target = same.find((b) => b.textContent === text) ?? same[0] ??
    enabled(rows[Math.min(index, rows.length - 1)])[0] ?? enabled(rows[index - 1])[0];
  if (target) target.focus({ preventScroll: true });
  else focusQueueControls();
}

function focusQueueControls() {
  const target = [$("queue-toggle"), $("queue-input")].find((e) => !e.disabled) ?? $("scheduler").querySelector("summary");
  target.focus({ preventScroll: true });
}

function addToQueue() {
  const r = queue.add($("queue-input").value, readOptions());
  const notes = [];
  if (r.added) notes.push(`Added ${plural(r.added, "link")}.`);
  if (r.duplicates) notes.push(`${plural(r.duplicates, "link")} already queued.`);
  if (r.full.length) notes.push(`The queue holds ${MAX_WAITING} scans at a time: ${plural(r.full.length, "link")} not added yet.`);
  if (r.invalid.length) notes.push(`Not a post link: ${r.invalid.join(", ")}`);
  if (!notes.length) notes.push("Paste one or more post links first.");
  $("queue-input").value = [...r.invalid, ...r.full].join("\n"); // leave the bad and unadded ones
  $("queue-add-note").textContent = notes.join(" ");
  renderQueue();
}

function toggleQueue() {
  if (queue.active) {
    queue.setActive(false);
    announce(queueCurrent ? "Queue paused after this scan." : "Queue paused.");
  } else {
    queue.setActive(true);
    announce("Queue started.");
    pumpQueue();
  }
  renderQueue();
}

function retryQueued(id) {
  const why = queue.retry(id);
  if (why === "duplicate") $("queue-add-note").textContent = "That post is already queued.";
  if (why === "full") $("queue-add-note").textContent = `The queue holds ${MAX_WAITING} scans at a time. Try again once one has run.`;
  renderQueue();
  pumpQueue();
}

// Take the queue if no other tab has it, else show it read-only and take it when that tab
// closes. Without Web Locks (old browsers), every tab runs its own copy as before.
function claimQueue() {
  const locks = navigator.locks;
  if (!locks) return useQueue(true);
  const hold = () => new Promise(() => {}); // kept until the page closes
  locks.request(QUEUE_LOCK, { ifAvailable: true }, (lock) => {
    if (lock) {
      useQueue(true);
      return hold();
    }
    useQueue(false);
    locks.request(QUEUE_LOCK, () => {
      useQueue(true);
      return hold();
    });
    return undefined;
  }).catch(() => useQueue(true));
}

function useQueue(owner) {
  queueOwner = owner;
  const interrupted = queue.load({ readOnly: !owner });
  if (!owner) {
    $("queue-add-note").textContent = "The scheduler is open in another tab of this site, so it's shown here read-only. It becomes usable here when that tab is closed.";
  } else if (interrupted) {
    $("scheduler").open = true;
    $("queue-add-note").textContent = "The queue was cut off when the page closed. Press Start queue to carry on.";
  } else if ($("queue-add-note").textContent.startsWith("The scheduler is open")) {
    $("queue-add-note").textContent = "";
  }
  renderQueue();
}

function removeQueued(id) {
  queue.remove(id);
  renderQueue();
}

function clearFinishedQueued() {
  queue.clearFinished();
  renderQueue();
}

// Scan the next waiting item, and keep going while the queue is on. Anything that ends
// a scan (including a manual run) calls this, so it's safe to call any time.
async function pumpQueue() {
  if (!queueOwner || pumping || !queue.active || state.controller) return;
  const gap = gapUntil - Date.now() / 1000;
  if (gap > 0) {
    if (gapWaiting) return; // already waiting it out
    gapWaiting = true;
    await backgroundSleep(gap);
    gapWaiting = false;
    pumpQueue();
    return;
  }
  const item = queue.next();
  if (!item) {
    queue.setActive(false);
    renderQueue();
    queueFinished();
    return;
  }
  pumping = true;
  queueCurrent = item.id;
  queue.update(item.id, { status: "running", note: "Starting…" });
  renderQueue();
  let outcome;
  try {
    // The item's options as it was added, over the form's for any it lacks (an item from
    // an older page); straight to run(), not through the form.
    outcome = await run({ fromQueue: true, postRef: item.ref, opts: mergeOptions(readOptions(), item.opts) });
  } catch (err) {
    outcome = { kind: "failed", message: err.message };
  }
  queueCurrent = null;
  const patch = { note: outcome.message, saved: Boolean(outcome.saved) };
  if (outcome.post) Object.assign(patch, { title: outcome.post.title, subreddit: outcome.post.subreddit });
  if (outcome.kind === "done" || outcome.kind === "empty") {
    patch.status = "done";
    if (outcome.kind === "done") {
      patch.note = `${outcome.capped ? `top ${outcome.profiled} of ${outcome.capped}` : plural(outcome.profiled, "user")}${outcome.failed ? `, ${outcome.failed} failed` : ""}` +
        ` · took ${formatDuration(outcome.seconds)}`;
    }
  } else if (outcome.kind === "stopped") {
    patch.status = "stopped";
    queue.setActive(false); // Stop means stop, not skip to the next one
  } else if (outcome.kind === "offline") {
    patch.status = "waiting";
    queue.setActive(false);
  } else {
    patch.status = "failed";
  }
  queue.update(item.id, patch);
  renderQueue();
  pumping = false;
  gapUntil = Date.now() / 1000 + QUEUE_GAP;
  pumpQueue();
}

// Live progress of the queued scan, on its row.
function onQueueProgress(counts) {
  if (queueCurrent === null) return;
  const note = $("queue-list").querySelector(`[data-id="${queueCurrent}"] .queue-note`);
  if (!note) return;
  const eta = status.eta ? formatEta(status.eta.secondsLeft()) : "";
  note.textContent = `Profiled ${counts.done} of ${counts.total}${eta ? ` · ${eta}` : ""}`;
}

function queueFinished() {
  const c = queue.counts();
  const text = `Queue finished: ${c.done} done${c.failed ? `, ${c.failed} failed` : ""}` +
    `${c.stopped ? `, ${c.stopped} stopped` : ""}.`;
  $("queue-add-note").textContent = text;
  announce(text);
  document.title = `✓ ${TITLE}`;
  if ($("queue-notify").checked && globalThis.Notification?.permission === "granted") {
    try {
      new Notification("Reddit Post Profiler", { body: text });
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  }
}

async function onNotifyChange() {
  const box = $("queue-notify");
  if (!box.checked) return;
  if (!globalThis.Notification) {
    box.checked = false;
    $("queue-add-note").textContent = "This browser can't show notifications.";
    return;
  }
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") {
    box.checked = false;
    $("queue-add-note").textContent = "Notifications are blocked for this site in your browser settings.";
  }
}

// ---- Saved scans ----

let savedRender = 0;
// Post ids with a saved scan, as of the last renderSaved (null until the first).
let savedIds = null;

// The list of saved scans, newest first.
async function renderSaved() {
  const token = ++savedRender;
  const scans = await openScans().list();
  if (token !== savedRender) return; // a newer render started
  const ids = new Set(scans.map((s) => s.id));
  const changed = savedIds === null || ids.size !== savedIds.size || [...ids].some((id) => !savedIds.has(id));
  savedIds = ids;
  if (changed) renderQueue(); // its Open buttons follow the saved scans
  $("saved-count").textContent = scans.length ? `(${scans.length})` : "";
  $("saved-legend").hidden = !scans.length;
  $("saved-empty").hidden = Boolean(scans.length);
  $("scans-export").hidden = !scans.length;
  $("scans-delete-all").hidden = !scans.length;
  $("saved-list").replaceChildren(...scans.map(scanItem));
  markCurrentScan();
  showStorageUsed();
}

// How much this site keeps in the browser (saved scans, saved results and the queue).
async function showStorageUsed() {
  let usage = null;
  try {
    usage = (await navigator.storage?.estimate?.())?.usage ?? null;
  } catch {
    // Not available here.
  }
  const mb = usage / 1e6;
  $("storage-used").textContent = usage === null ? ""
    : `Saved data uses ${mb < 0.1 ? "under 0.1" : mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB of this browser's storage.`;
}

function savedNote(text) {
  $("saved-note").textContent = text;
}

async function exportSaved() {
  const { scans, failed } = await openScans().exportAll();
  if (!scans.length) return savedNote(failed ? "The saved scans couldn't be read, so nothing was exported." : "Nothing to export.");
  offerDownload(new Blob([exportScans(scans)], { type: "application/json" }),
    `rpp-saved-scans-${new Date().toISOString().slice(0, 10)}.json`);
  savedNote(`Exported ${plural(scans.length, "scan")}.` +
    (failed ? ` ${plural(failed, "scan")} couldn't be read and ${failed === 1 ? "isn't" : "aren't"} in the file.` : ""));
}

async function importSaved() {
  const input = $("scans-file");
  const file = input.files?.[0];
  input.value = ""; // so choosing the same file again still fires
  if (!file) return;
  let parsed;
  try {
    if (file.size > 200e6) throw new Error("That file is too big to be a saved-scans export.");
    parsed = parseScanExport(await file.text());
  } catch (err) {
    savedNote(err.message);
    return;
  }
  const r = await openScans().importAll(parsed.scans);
  const notes = [
    `Imported ${plural(r.added + r.replaced, "scan")}`,
    r.replaced && `${r.replaced} replacing older copies`,
    r.kept && `${r.kept} skipped (the copy here is as new or complete, or the scan has no results)`,
    parsed.invalid && `${parsed.invalid} unreadable`,
    r.failed && `${r.failed} not saved (browser storage is full or blocked)`,
  ].filter(Boolean);
  savedNote(`${notes.join("; ")}.`);
  announce($("saved-note").textContent);
  await renderSaved();
}

async function deleteAllSaved() {
  if (state.controller) return;
  const n = (await openScans().list()).length;
  if (!n || !window.confirm(`${n === 1 ? "Delete the saved scan" : `Delete all ${n} saved scans`}? This can't be undone. Export first to keep a copy.`)) return;
  await openScans().clear();
  state.savedId = null;
  savedNote(`Deleted ${plural(n, "saved scan")}.`);
  announce($("saved-note").textContent);
  await renderSaved();
  $("saved-heading").focus();
}

function scanItem(scan) {
  const { post, stats } = scan;
  const pill = (cls, text, title) => el("span", { class: `pill ${cls}`, title }, text);
  const running = state.controller !== null;
  const open = el("button", { type: "button", class: "scan-title", "aria-describedby": `scan-meta-${post.id}` },
    post.title || "(untitled post)");
  open.addEventListener("click", () => openSaved(post.id));
  const again = el("button", { type: "button", "aria-label": `Scan “${post.title}” again` }, "Scan again");
  again.addEventListener("click", () => scanAgain(post.id));
  const del = el("button", { type: "button", "aria-label": `Delete saved scan of “${post.title}”` }, "Delete");
  del.addEventListener("click", () => deleteSaved(post.id));
  for (const b of [open, again, del]) b.disabled = running;

  const pills = el("div", { class: "scan-stats" },
    pill("", scan.complete ? plural(stats.profiled, "user") : `${stats.profiled} of ${plural(scan.total, "user")}`,
      scan.complete ? "Users profiled" : "Stopped before every user was profiled"));
  if (scan.beforeKnown) {
    const tiers = Array.isArray(scan.facts) ? tierCounts(scan.facts, badges) : stats;
    const where = `in r/${post.subreddit} before the post`;
    pills.append(
      pill("regular", `${tiers.regular} regular`, `${describeRule(badges.regular)} ${where}`),
      pill("occasional", `${tiers.occasional} occasional`, `${describeRule(badges.occasional)} ${where}`),
      pill("new", `${tiers.new} new here`, `Below the occasional badge ${where}`));
  }
  if (stats.failed) pills.append(pill("err", `${stats.failed} failed`, "Lookups that failed"));
  pills.append(pill("", plural(stats.subreddits, "subreddit"), "Subreddits these users are active in"));

  const meta = [
    `Scanned ${formatDate(scan.scannedAt)}`,
    scan.thread && `${plural(scan.thread.comments, "comment")} from ${plural(scan.thread.people, "commenter")}`,
    requestsText(scan.requests, scan.archiveRequests),
    `took ${tookText(scan)}`,
    !scan.complete && "stopped early",
    ...scanOptionNotes(scan.opts),
  ].filter(Boolean).join(" · ");

  const li = el("li", { class: "scan" },
    el("div", {},
      el("div", { class: "post-sub" }, `r/${post.subreddit} · by u/${post.author} · ${formatDate(post.createdUtc)}`),
      open,
      pills,
      el("div", { class: "scan-meta", id: `scan-meta-${post.id}` }, meta)),
    el("div", { class: "scan-actions" }, again, del));
  li.dataset.id = post.id;
  return li;
}

function markCurrentScan() {
  for (const li of $("saved-list").children) {
    if (li.dataset.id === state.savedId) li.setAttribute("aria-current", "true");
    else li.removeAttribute("aria-current");
  }
}

// Put a saved scan's post and options (not pace or caching) back in the form.
function fillFromScan(summary) {
  const { post, opts: o = {} } = summary;
  $("post").value = redditPostUrl(post);
  // The scan's own options (which ones it saved) over the form's for the rest.
  showOptions(mergeOptions(readOptions(), {
    includeOp: Boolean(o.includeOp), exclude: o.exclude ?? [], only: o.only ?? [], years: o.years ?? null, maxUsers: o.maxUsers ?? null,
  }));
}

// Show a saved scan's users, as they were when it was saved, with no requests.
async function openSaved(id) {
  if (state.controller) return;
  const rec = await openScans().load(id);
  if (state.controller) return;
  if (!rec) {
    showError("That saved scan couldn't be read. It may have been deleted in another tab.");
    renderSaved();
    return;
  }
  const { summary } = rec;
  state.runId++;
  const slots = [];
  rec.profiles.forEach((d, i) => {
    const p = deserializeProfile(d);
    p.rank ??= i;
    slots[p.rank] = p;
  });
  Object.assign(state, {
    post: summary.post, slots, shown: 0, after: summary.after ?? null,
    beforeKnown: summary.beforeKnown ?? true, savedId: id, urlPost: null,
  });
  // A saved scan opens with no requests; a ?post= link left over from an earlier run would
  // start a fresh one on reload.
  history.replaceState(null, "", location.pathname);
  showError("");
  fillFromScan(summary);
  renderPost(summary.post, summary.thread);
  renderWindowNote(state.after);
  $("results").hidden = false;
  renderUsers();
  markCurrentScan();

  const profiled = summary.complete
    ? `profiled ${plural(summary.stats.profiled, "user")}`
    : `stopped after ${summary.stats.profiled} of ${plural(summary.total, "user")}`;
  const text = `Saved scan from ${formatDate(summary.scannedAt)}: ${profiled} with ` +
    `${requestsText(summary.requests, summary.archiveRequests)}. Took ${tookText(summary)}. Opened with no new requests.`;
  clearWaits();
  $("bar").hidden = true;
  setStatus(text);
  announce(`Opened saved scan of ${summary.post.title}.`);
  document.title = TITLE;
  $("post-card").scrollIntoView({ block: "start" });
}

function scanAgain(id) {
  if (state.controller) return;
  openScans().load(id).then((rec) => {
    if (state.controller) return; // a queued scan started meanwhile; leave its form alone
    if (rec) fillFromScan(rec.summary);
    else $("post").value = id;
    run();
  });
}

async function deleteSaved(id) {
  if (state.controller) return;
  if (!(await openScans().delete(id))) {
    savedNote("That saved scan couldn't be deleted: browser storage isn't responding. Try again, or reload the page.");
    announce($("saved-note").textContent);
    return; // the scan and its Delete button stay, so focus does too
  }
  if (state.savedId === id) state.savedId = null;
  announce("Saved scan deleted.");
  await renderSaved();
  // The button is gone; keep keyboard focus nearby.
  $("saved-heading").focus();
}

// ---- Sharing, CSV, saved results ----

// The post in the box, as a bare id when it can be parsed.
function currentPostRef() {
  try {
    return parsePostRef($("post").value);
  } catch {
    return state.post?.id ?? $("post").value.trim();
  }
}

function shareUrl(postRef, opts = readOptions()) {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = shareParams(postRef, opts, { minCount: minCount(), badges }).toString();
  return url.toString();
}

function flash(button, text, original, ms = 2000) {
  button.textContent = text;
  setTimeout(() => (button.textContent = original), ms);
}

async function copyLink() {
  const url = shareUrl(currentPostRef());
  try {
    await navigator.clipboard.writeText(url);
    flash($("share"), "Copied!", "Copy link", 1500);
    announce("Link copied.");
  } catch {
    window.prompt("Copy this link:", url);
  }
}

function downloadCsv() {
  if (!state.post) return;
  const partial = state.controller !== null;
  const csv = toCsv(state.slots.filter(Boolean), state.post, minCount(), { rules: badges, beforeKnown: state.beforeKnown });
  offerDownload(new Blob([csv], { type: "text/csv" }), `${state.post.id}_activity${partial ? "_partial" : ""}.csv`);
}

// Save `blob` as a file named `filename`.
function offerDownload(blob, filename) {
  const a = el("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function clearCache() {
  const saved = (await openScans().list()).length;
  if (saved && !window.confirm(`This also deletes ${saved === 1 ? "your saved scan" : `all ${saved} saved scans`}. ` +
    "This can't be undone. Export them first to keep a copy. Clear everything?")) return;
  const [n, scans] = await Promise.all([openCache(0).clear(), openScans().clear()]);
  const text = n || scans ? `Cleared ${plural(n, "saved result")} and ${plural(scans, "scan")}` : "Nothing saved";
  state.savedId = null;
  renderSaved();
  flash($("clear-cache"), text, "Clear saved results");
  announce(text);
}

function init() {
  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    // Enter in a badge box shouldn't start a scan: badges never need requests.
    if ($("badge-fields").contains(document.activeElement)) return;
    run();
  });
  $("post").addEventListener("input", () => $("post").removeAttribute("aria-invalid"));
  $("stop").addEventListener("click", stop);
  $("filter").addEventListener("input", applyFilter);
  $("min-count").addEventListener("input", debounce(renderUsers, 200));
  $("download").addEventListener("click", downloadCsv);
  $("share").addEventListener("click", copyLink);
  $("clear-cache").addEventListener("click", clearCache);
  $("scans-export").addEventListener("click", exportSaved);
  $("scans-import").addEventListener("click", () => $("scans-file").click());
  $("scans-file").addEventListener("change", importSaved);
  $("scans-delete-all").addEventListener("click", deleteAllSaved);
  $("badge-fields").addEventListener("input", () => setBadges(readBadges()));
  $("badge-fields").addEventListener("change", showBadges); // tidy up blanks on leaving a box
  $("badge-reset").addEventListener("click", () => {
    setBadges(DEFAULT_BADGES);
    showBadges();
    announce("Badges reset to the defaults.");
  });
  $("queue-add").addEventListener("click", addToQueue);
  $("queue-toggle").addEventListener("click", toggleQueue);
  $("queue-clear").addEventListener("click", clearFinishedQueued);
  $("queue-notify").addEventListener("change", onNotifyChange);
  window.addEventListener("beforeunload", (e) => {
    if (state.controller) e.preventDefault(); // a scan would be cut off
  });
  claimQueue();
  window.addEventListener("storage", (e) => {
    if (!queueOwner && e.key === QUEUE_KEY) useQueue(false); // follow the owning tab's changes
  });
  for (const type of ["input", "change"]) $("option-fields").addEventListener(type, () => updateOptionsSummary());

  // Pre-fill from a shared link (the Options panel stays closed; its summary lists what's
  // set) and start straight away.
  const { post, fields } = readShareParams(new URLSearchParams(window.location.search));
  // A link's badge rules apply to this visit without replacing the ones saved here.
  badges = parseBadges(fields.badges ?? null) ?? storedBadges() ?? DEFAULT_BADGES;
  showBadges();
  $("include-op").checked = fields.includeOp;
  for (const [key, id] of Object.entries(FIELD_IDS)) {
    if (key in fields) $(id).value = fields[key];
  }
  const opts = readOptions();
  showOptions(opts);
  // Clear out old saved results, at most once a day. A share link's scan waits for it, so
  // its own reads don't queue behind the prune.
  const pruned = openCache(opts.cacheDays).pruneDaily();
  renderSaved();
  if (post) {
    $("post").value = post;
    pruned.finally(() => run());
  }
}

init();
