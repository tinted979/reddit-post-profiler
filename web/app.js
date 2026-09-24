// The page: reads the form, runs a scan with core.js (several users at a time) and shows
// the results as they arrive. The API and profiling logic live in core.js; saved results
// in cache.js.

import {
  Aborted,
  ArcticShiftClient,
  ArcticShiftError,
  Eta,
  QueryTimeout,
  ServerBusy,
  buildProfile,
  DEFAULT_BADGES,
  activityTier,
  badgeFacts,
  formatBadges,
  parseBadges,
  profileFacts,
  sameBadges,
  tierCounts,
  arcticSearchUrl,
  collectCommenters,
  deserializeProfile,
  mapPool,
  parsePostRef,
  parseSubreddits,
  scanStats,
  serializeProfile,
  sortedSubreddits,
  toCsv,
} from "./core.js";
import { openCache, openScans } from "./cache.js";
import { LinkQueue } from "./queue.js";

const $ = (id) => document.getElementById(id);
const TITLE = document.title;
const DEFAULTS = { delay: 0.5, concurrency: 3, cacheDays: 7 };

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
};

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

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

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
  const num = (id) => Number.parseFloat($(id).value);
  const maxUsers = Math.floor(num("max-users"));
  const years = Number($("years").value);
  const delay = num("delay");
  const concurrency = Math.round(num("concurrency"));
  const cacheDays = num("cache-days");
  return {
    includeOp: $("include-op").checked,
    exclude: $("exclude").value.split(/[\s,]+/).filter(Boolean),
    only: parseSubreddits($("only-subs").value.split(/[\s,]+/)),
    years: [1, 5, 10].includes(years) ? years : null,
    maxUsers: maxUsers > 0 ? maxUsers : null,
    delay: Number.isFinite(delay) ? Math.min(30, Math.max(0.25, delay)) : DEFAULTS.delay,
    concurrency: Number.isFinite(concurrency) ? Math.min(5, Math.max(1, concurrency)) : DEFAULTS.concurrency,
    cacheDays: cacheDays >= 0 ? cacheDays : DEFAULTS.cacheDays,
  };
}

function minCount() {
  return Math.max(0, Math.floor(Number.parseFloat($("min-count").value)) || 0);
}

// Put the options back in the form as they'll be used (after a shared link or a typo).
function showOptions(opts) {
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
  const parts = [];
  if (o.includeOp) parts.push("author included");
  if (o.exclude.length) parts.push(`skipping ${plural(o.exclude.length, "user")}`);
  if (o.maxUsers) parts.push(`top ${o.maxUsers}`);
  if (o.only.length) {
    parts.push(o.only.length <= 3 ? `only ${o.only.map((s) => `r/${s}`).join(", ")}` : `only ${o.only.length} subreddits`);
  }
  if (o.years) parts.push(`last ${plural(o.years, "year")}`);
  if (o.cacheDays !== DEFAULTS.cacheDays) parts.push(o.cacheDays ? `results kept ${plural(o.cacheDays, "day")}` : "not saving results");
  if (o.delay !== DEFAULTS.delay) parts.push(`${o.delay}s between requests`);
  if (o.concurrency !== DEFAULTS.concurrency) parts.push(`${o.concurrency} in parallel`);
  if (!sameBadges(badges, DEFAULT_BADGES)) parts.push("custom badges");
  $("options-summary").textContent = parts.length ? `: ${parts.join(" · ")}` : "";
}

// ---- Badges ----

// The badge rules in use: from the link (badges=), else as last set in this browser, else
// the defaults. Badges are worked out when shown, so changing the rules re-rates every
// result on the page and in saved scans without any requests.
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
  for (const tier of ["occasional", "regular"]) {
    for (const field of ["count", "days", "tenure"]) $(`badge-${tier}-${field}`).value = badges[tier][field];
  }
  renderBadgeLegend();
}

// "3+ posts and comments, on 2+ days, the first 14+ days before"
function describeRule(r) {
  const parts = [`${Math.max(1, r.count)}+ ${r.count === 1 ? "post or comment" : "posts and comments"}`];
  if (r.days > 0) parts.push(`on ${r.days}+ ${r.days === 1 ? "day" : "different days"}`);
  if (r.tenure > 0) parts.push(`the first ${r.tenure}+ ${r.tenure === 1 ? "day" : "days"} before`);
  return parts.join(", ");
}

function renderBadgeLegend() {
  $("badge-legend").replaceChildren(
    el("b", {}, "regular"), ` (${describeRule(badges.regular)}), `,
    el("b", {}, "occasional"), ` (${describeRule(badges.occasional)}) or `,
    el("b", {}, "new here"), " (anyone else).");
}

// Read the inputs; a blank or invalid one keeps its current value.
function readBadges() {
  const rules = { occasional: { ...badges.occasional }, regular: { ...badges.regular } };
  for (const tier of ["occasional", "regular"]) {
    for (const field of ["count", "days", "tenure"]) {
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
function formatEta(seconds) {
  if (seconds === null) return "estimating time left…";
  if (seconds < 5) return "almost done";
  if (seconds < 60) return `about ${Math.ceil(seconds / 5) * 5} s left`;
  if (seconds < 600) {
    const s = Math.ceil(seconds / 10) * 10;
    return `about ${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""} left`;
  }
  const m = Math.ceil(seconds / 60);
  return m < 60 ? `about ${m} min left` : `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

// A measured duration: "4.2 s", "38 s", "1 min 38 s", "1 h 5 min".
function formatDuration(seconds) {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

function tookText({ seconds, profilingSeconds }) {
  const total = formatDuration(seconds);
  return profilingSeconds === null ? total : `${total} (profiling ${formatDuration(profilingSeconds)})`;
}

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
    if (until > status.until) {
      status.until = until;
      status.reason = reason;
    }
    status.timer ??= setInterval(renderStatus, 1000);
    if (seconds >= 10) announce(`Paused: ${reason}. Resuming in ${Math.round(seconds)} seconds.`);
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
function explain(err) {
  if (err instanceof ServerBusy) return "Arctic Shift is overloaded right now. Try again in a few minutes.";
  if (err instanceof QueryTimeout) return "Arctic Shift couldn't count this much history in time.";
  if (err instanceof ArcticShiftError) {
    if (err.status === 429) return "Arctic Shift is limiting requests right now. Wait a minute and try again.";
    if (err.status === null) return "Couldn't reach Arctic Shift. Check your connection and try again.";
    return `Arctic Shift returned an error (HTTP ${err.status}).`;
  }
  return err.message;
}

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
  renderQueue();
  $("stop").hidden = !running;
  $("stop").disabled = false;
  $("stop").textContent = "Stop";
  $("download").textContent = running ? "Download CSV (so far)" : "Download CSV";
  if (!running && state.focusRunAfter) $("run").focus({ preventScroll: true });
  state.focusRunAfter = false;
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
  $("post-title").href = `https://www.reddit.com/r/${post.subreddit}/comments/${post.id}/`;
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
function timelineText(f) {
  if (f.days === null) return " (no timeline saved, so the badge goes by the count alone)";
  let text = `, on ${f.exact ? "" : "at least "}${f.days === 1 ? "1 day" : `${f.days} different days`}`;
  if (f.tenureDays !== null) text += `, the first ${formatAge(f.tenureDays)} before`;
  return text;
}

function formatAge(days) {
  if (days < 1) return "less than a day";
  if (days < 14) return plural(Math.floor(days), "day");
  if (days < 60) return plural(Math.floor(days / 7), "week");
  if (days < 730) return plural(Math.floor(days / 30.44), "month");
  return plural(Math.floor(days / 365.25), "year");
}

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
        el("td", {}, el("a", { href: `https://www.reddit.com/r/${s.name}/`, target: "_blank", rel: "noopener" }, `r/${s.name}`)),
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
  if (queueCurrent === null) history.replaceState(null, "", shareUrl(currentPostRef()));
}

// ---- A run ----

// Scan the post in the box with the options in the form. Resolves with how it ended:
// {kind: "done" | "empty" | "stopped" | "failed" | "invalid" | "offline" | "busy",
//  message, post, profiled, total, failed}.
async function run({ fromQueue = false } = {}) {
  if (state.controller) return { kind: "busy", message: "A scan is already running." };
  const opts = readOptions();
  showOptions(opts);
  showError("");
  $("post").removeAttribute("aria-invalid");
  let postId;
  try {
    postId = parsePostRef($("post").value);
  } catch (err) {
    showError(err.message);
    $("post").setAttribute("aria-invalid", "true");
    $("post").setAttribute("aria-describedby", "error");
    if (!queueRunning()) $("post").focus();
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
  const after = opts.years ? Math.floor(Date.now() / 1000 - opts.years * 365.25 * 86400) : null;
  const runId = ++state.runId;
  const controller = new AbortController();
  Object.assign(state, { controller, post: null, slots: [], shown: 0, beforeKnown: true, after, savedId: null });
  markCurrentScan();
  $("post-card").hidden = true;
  $("results").hidden = true;
  $("users").replaceChildren();
  $("bar").hidden = false;
  clearWaits();
  setRunning(true);
  setProgress(0);

  const cache = openCache(opts.cacheDays);
  const client = new ArcticShiftClient({
    sleep: backgroundSleep,
    delay: opts.delay,
    maxInFlight: opts.concurrency,
    signal: controller.signal,
    onWait: (reason, seconds) => runId === state.runId && onWait(reason, seconds),
    onPause: (until) => runId === state.runId && status.eta?.pause(until),
  });
  const counts = { done: 0, total: 0 };
  let failed = 0;
  let outcome = { kind: "failed", message: "" };
  const ended = (kind, message) => {
    outcome = {
      kind, message, post: state.post, profiled: counts.done, total: counts.total, failed,
      seconds: elapsed().seconds, saved: savedOk,
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
      ...elapsed(),
      fromSaved: fromCache,
      after,
      beforeKnown: state.beforeKnown,
      opts: { only: opts.only, years: opts.years, maxUsers: opts.maxUsers, includeOp: opts.includeOp, exclude: opts.exclude },
      stats: scanStats(profiles, state.post, state.beforeKnown, badges),
      facts: badgeFacts(profiles, state.post), // tier counts under whatever badge rules apply later
    };
    if (await openScans().save(summary, profiles.map(serializeProfile))) {
      savedOk = true;
      state.savedId = state.post.id;
      renderSaved();
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

    setStatus("Collecting commenters…");
    const commenters = await collectCommenters(client, post, opts);
    thread = threadStats(commenters);
    renderPost(post, thread);

    let ranked = [...commenters].sort((a, b) =>
      b[1].count - a[1].count || a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
    if (opts.maxUsers) ranked = ranked.slice(0, opts.maxUsers);
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
        (inFlight ? ` (${inFlight} in progress)` : ""));
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
    await mapPool(ranked, opts.concurrency, async ([username, { count, last }], i) => {
      inFlight++;
      progress();
      let profile;
      try {
        profile = await buildProfile(client, username, count, post, {
          only: opts.only, after, lastCommentUtc: last, cache,
        });
      } catch (err) {
        if (err instanceof Aborted) throw err;
        failed++;
        firstError ??= err;
        profile = {
          username, threadComments: count, targetPostsBefore: 0, targetCommentsBefore: 0,
          subreddits: new Map(), error: explain(err), errorDetail: err.message,
        };
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
    let text = `Done: profiled ${plural(counts.total, "user")}${notes.length ? ` (${notes.join(", ")})` : ""}` +
      ` with ${plural(client.requests, "request")}. Took ${took()}.`;
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
        ` Ran for ${took()}.`;
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
  setTimeout(pumpQueue); // a queue waiting on a manual scan carries on
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

// Like core.js's wait(): resolves after `seconds`, or at once when `signal` aborts.
function backgroundSleep(seconds, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let cancel;
    const done = () => {
      cancel();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    if (workerTimer.ready) {
      cancel = workerTimer.start(seconds * 1000, done);
    } else {
      const t = setTimeout(done, seconds * 1000);
      cancel = () => clearTimeout(t);
    }
    signal?.addEventListener("abort", done);
  });
}

// ---- Scheduler ----

const queue = new LinkQueue();
const QUEUE_GAP = 3; // seconds between queued scans, to go easy on the API
let pumping = false;
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
  $("queue-clear").hidden = !(c.done + c.failed + c.stopped);

  $("queue-list").replaceChildren(...queue.items.map((item) => {
    const [cls, label] = STATUS_PILLS[item.status];
    const actions = el("span", { class: "queue-actions" });
    const name = item.title ? `r/${item.subreddit} · ${item.title}` : item.ref;
    const button = (text, onClick, extra = {}) => {
      const b = el("button", { type: "button", "aria-label": `${text}: ${name}`, ...extra }, text);
      b.addEventListener("click", onClick);
      actions.append(b);
      return b;
    };
    if (item.status === "done" && item.saved) button("Open", () => openSaved(item.postId)).disabled = busy;
    if (item.status === "failed" || item.status === "stopped") button("Retry", () => retryQueued(item.id));
    if (item.status !== "running") button("Remove", () => removeQueued(item.id));
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
}

function addToQueue() {
  const r = queue.add($("queue-input").value, readOptions());
  const notes = [];
  if (r.added) notes.push(`Added ${plural(r.added, "link")}.`);
  if (r.duplicates) notes.push(`${plural(r.duplicates, "link")} already queued.`);
  if (r.invalid.length) notes.push(`Not a post link: ${r.invalid.join(", ")}`);
  if (!notes.length) notes.push("Paste one or more post links first.");
  $("queue-input").value = r.invalid.join("\n"); // leave the bad ones to fix
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
  queue.retry(id);
  renderQueue();
  pumpQueue();
}

function removeQueued(id) {
  queue.remove(id);
  renderQueue();
}

function clearFinishedQueued() {
  queue.clearFinished();
  renderQueue();
}

// Put a queued item's link and options in the form, for run() to use.
function fillFromItem(item) {
  $("post").value = item.ref;
  const o = { ...readOptions(), ...item.opts };
  $("include-op").checked = Boolean(o.includeOp);
  showOptions(o);
}

// Scan the next waiting item, and keep going while the queue is on. Anything that ends
// a scan (including a manual run) calls this, so it's safe to call any time.
async function pumpQueue() {
  if (pumping || !queue.active || state.controller) return;
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
  fillFromItem(item);
  let outcome;
  try {
    outcome = await run({ fromQueue: true });
  } catch (err) {
    outcome = { kind: "failed", message: err.message };
  }
  queueCurrent = null;
  const patch = { note: outcome.message, saved: Boolean(outcome.saved) };
  if (outcome.post) Object.assign(patch, { title: outcome.post.title, subreddit: outcome.post.subreddit });
  if (outcome.kind === "done" || outcome.kind === "empty") {
    patch.status = "done";
    if (outcome.kind === "done") {
      patch.note = `${plural(outcome.profiled, "user")}${outcome.failed ? `, ${outcome.failed} failed` : ""}` +
        ` · took ${formatDuration(outcome.seconds)}`;
    }
  } else if (outcome.kind === "stopped") {
    patch.status = "stopped";
    queue.setActive(false); // Stop means stop, not skip to the next one
  } else if (outcome.kind === "offline" || outcome.kind === "busy") {
    patch.status = "waiting";
    queue.setActive(false);
  } else {
    patch.status = "failed";
  }
  queue.update(item.id, patch);
  renderQueue();
  pumping = false;
  if (!queue.active) return;
  await backgroundSleep(QUEUE_GAP);
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
      new Notification("Reddit Commenter Profiler", { body: text });
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

// The list of saved scans, newest first.
async function renderSaved() {
  const token = ++savedRender;
  const scans = await openScans().list();
  if (token !== savedRender) return; // a newer render started
  $("saved").hidden = !scans.length;
  $("saved-count").textContent = scans.length ? `(${scans.length})` : "";
  $("saved-list").replaceChildren(...scans.map(scanItem));
  markCurrentScan();
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
    `${plural(scan.requests, "request")}`,
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

function scanOptionNotes(o = {}) {
  return [
    o.years && `last ${plural(o.years, "year")}`,
    o.only?.length && `only ${o.only.map((x) => `r/${x}`).join(", ")}`,
    o.maxUsers && `top ${o.maxUsers}`,
    o.includeOp && "author included",
    o.exclude?.length && `skipped ${o.exclude.join(", ")}`,
  ].filter(Boolean);
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
  $("post").value = `https://www.reddit.com/r/${post.subreddit}/comments/${post.id}/`;
  $("include-op").checked = Boolean(o.includeOp);
  showOptions({
    ...readOptions(),
    includeOp: Boolean(o.includeOp),
    exclude: o.exclude ?? [],
    only: o.only ?? [],
    years: o.years ?? null,
    maxUsers: o.maxUsers ?? null,
  });
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
    beforeKnown: summary.beforeKnown ?? true, savedId: id,
  });
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
    `${plural(summary.requests, "request")}. Took ${tookText(summary)}. Opened with no new requests.`;
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
    if (rec) fillFromScan(rec.summary);
    else $("post").value = id;
    run();
  });
}

async function deleteSaved(id) {
  if (state.controller) return;
  await openScans().delete(id);
  if (state.savedId === id) state.savedId = null;
  announce("Saved scan deleted.");
  await renderSaved();
  // The button is gone; keep keyboard focus nearby.
  ($("saved").hidden ? $("post") : $("saved-heading")).focus();
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
  url.search = "";
  url.hash = "";
  url.searchParams.set("post", postRef);
  if (opts.includeOp) url.searchParams.set("op", "1");
  if (opts.exclude.length) url.searchParams.set("exclude", opts.exclude.join(","));
  if (opts.only.length) url.searchParams.set("subs", opts.only.join(","));
  if (opts.years) url.searchParams.set("years", String(opts.years));
  if (opts.maxUsers) url.searchParams.set("max", String(opts.maxUsers));
  if (minCount()) url.searchParams.set("min", String(minCount()));
  if (opts.delay !== DEFAULTS.delay) url.searchParams.set("delay", String(opts.delay));
  if (opts.concurrency !== DEFAULTS.concurrency) url.searchParams.set("par", String(opts.concurrency));
  if (opts.cacheDays !== DEFAULTS.cacheDays) url.searchParams.set("cache", String(opts.cacheDays));
  if (!sameBadges(badges, DEFAULT_BADGES)) url.searchParams.set("badges", formatBadges(badges));
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
  const a = el("a", {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: `${state.post.id}_activity${partial ? "_partial" : ""}.csv`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function clearCache() {
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
    run();
  });
  $("post").addEventListener("input", () => $("post").removeAttribute("aria-invalid"));
  $("stop").addEventListener("click", stop);
  $("filter").addEventListener("input", applyFilter);
  $("min-count").addEventListener("input", debounce(renderUsers, 200));
  $("download").addEventListener("click", downloadCsv);
  $("share").addEventListener("click", copyLink);
  $("clear-cache").addEventListener("click", clearCache);
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
  if (queue.load()) {
    $("scheduler").open = true;
    $("queue-add-note").textContent = "The queue was cut off when the page closed. Press Start queue to carry on.";
  }
  renderQueue();
  for (const type of ["input", "change"]) $("option-fields").addEventListener(type, () => updateOptionsSummary());

  // Pre-fill from a shared link (the Options panel stays closed; its summary lists what's
  // set) and start straight away.
  const params = new URLSearchParams(window.location.search);
  // A link's badge rules apply to this visit without replacing the ones saved here.
  badges = parseBadges(params.get("badges")) ?? storedBadges() ?? DEFAULT_BADGES;
  showBadges();
  const fill = (id, key) => {
    if (params.has(key)) $(id).value = params.get(key);
  };
  $("include-op").checked = params.get("op") === "1";
  fill("exclude", "exclude");
  fill("only-subs", "subs");
  fill("years", "years");
  fill("max-users", "max");
  fill("min-count", "min");
  fill("delay", "delay");
  fill("concurrency", "par");
  fill("cache-days", "cache");
  const opts = readOptions();
  showOptions(opts);
  openCache(opts.cacheDays).prune();
  renderSaved();
  if (params.get("post")) {
    $("post").value = params.get("post");
    run();
  }
}

init();
