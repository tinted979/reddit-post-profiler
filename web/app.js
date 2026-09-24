import {
  Aborted,
  ArcticShiftClient,
  buildProfile,
  collectCommenters,
  mapPool,
  parsePostRef,
  parseSubreddits,
  sortedSubreddits,
  toCsv,
} from "./core.js";

const $ = (id) => document.getElementById(id);

const state = {
  post: null,
  profiles: [],
  controller: null,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function readOptions() {
  const maxUsers = parseInt($("max-users").value, 10);
  return {
    includeOp: $("include-op").checked,
    exclude: $("exclude").value.split(/[\s,]+/).filter(Boolean),
    only: parseSubreddits($("only-subs").value.split(/[\s,]+/)),
    years: [1, 5, 10].includes(Number($("years").value)) ? Number($("years").value) : null,
    maxUsers: Number.isFinite(maxUsers) && maxUsers > 0 ? maxUsers : null,
    delay: Math.max(0.25, parseFloat($("delay").value) || 0.5),
    concurrency: Math.min(5, Math.max(1, parseInt($("concurrency").value, 10) || 3)),
  };
}

function minCount() {
  return Math.max(0, parseInt($("min-count").value, 10) || 0);
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function setStatus(text, fraction = null) {
  $("status").hidden = false;
  $("status-text").textContent = text;
  if (fraction !== null) $("bar-fill").style.width = `${Math.round(fraction * 100)}%`;
}

function setRunning(running) {
  $("run").disabled = running;
  $("stop").hidden = !running;
  $("post").readOnly = running;
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderPost(post, commenters) {
  $("post-card").hidden = false;
  $("post-sub").textContent = `r/${post.subreddit}`;
  $("post-title").textContent = post.title || "(untitled post)";
  $("post-title").href = `https://www.reddit.com/r/${post.subreddit}/comments/${post.id}/`;
  let meta = `by u/${post.author} · ${formatDate(post.createdUtc)}`;
  if (commenters) {
    const total = [...commenters.values()].reduce((a, b) => a + b, 0);
    meta += ` · ${total} archived comments from ${commenters.size} users`;
  }
  $("post-meta").textContent = meta;
  for (const n of document.querySelectorAll(".target-name")) n.textContent = `r/${post.subreddit}`;
}

function userCard(profile, post) {
  const subs = sortedSubreddits(profile, post, minCount());
  const before = profile.targetPostsBefore + profile.targetCommentsBefore;
  const pills = el("div", { class: "stats" });
  pills.append(el("span", { class: "pill" }, `${profile.threadComments} in thread`));
  if (profile.error) {
    pills.append(el("span", { class: "pill err", title: profile.error }, "lookup failed"));
  } else {
    pills.append(
      el("span", { class: "pill", title: `posts / comments in r/${post.subreddit} before this post` },
        `before: ${profile.targetPostsBefore} / ${profile.targetCommentsBefore}`),
      el("span", { class: before === 0 ? "pill new" : "pill regular" }, before === 0 ? "new here" : "regular"),
      el("span", { class: "pill" }, `${[...profile.subreddits.values()].filter((c) => c.posts + c.comments > 0).length} subreddits`),
    );
  }

  const top = subs.slice(0, 6).map((s) => `r/${s.name} (${s.total})`).join(" · ");
  const summary = el(
    "summary",
    {},
    el("span", { class: "name" },
      el("a", { href: `https://www.reddit.com/user/${encodeURIComponent(profile.username)}`, target: "_blank", rel: "noopener" },
        `u/${profile.username}`)),
    pills,
    el("div", { class: "top" }, profile.error ? profile.error : top || "No archived posts or comments"),
  );
  // Let the profile link open without toggling the card.
  summary.querySelector("a").addEventListener("click", (e) => e.stopPropagation());

  const card = el("details", { class: "user" }, summary);
  card.dataset.rank = String(profile.rank ?? 0);
  card.dataset.search = [profile.username, ...profile.subreddits.keys()].join(" ").toLowerCase();

  // Build the full table lazily, the first time the card is opened.
  card.addEventListener("toggle", () => {
    if (!card.open || card.querySelector(".subs-wrap, .empty")) return;
    if (!subs.length) {
      card.append(el("p", { class: "empty" }, profile.error || "No archived activity."));
      return;
    }
    const target = post.subreddit.toLowerCase();
    const body = el("tbody");
    for (const s of subs) {
      body.append(
        el("tr", { class: s.name.toLowerCase() === target ? "target" : "" },
          el("td", {}, el("a", { href: `https://www.reddit.com/r/${s.name}/`, target: "_blank", rel: "noopener" }, `r/${s.name}`)),
          el("td", {}, String(s.posts)),
          el("td", {}, String(s.comments)),
          el("td", {}, String(s.total))),
      );
    }
    const table = el("table", { class: "subs" },
      el("thead", {}, el("tr", {}, el("th", {}, "Subreddit"), el("th", {}, "Posts"), el("th", {}, "Comments"), el("th", {}, "Total"))),
      body);
    card.append(el("div", { class: "subs-wrap" }, table));
  });
  return card;
}

function renderUsers() {
  const list = $("users");
  list.replaceChildren(...state.profiles.map((p) => userCard(p, state.post)));
  applyFilter();
}

// Insert a card so the list stays in thread-activity order while results arrive out of order.
function insertCard(card) {
  const rank = Number(card.dataset.rank);
  const after = [...$("users").children].find((c) => Number(c.dataset.rank) > rank);
  $("users").insertBefore(card, after ?? null);
}

function applyFilter() {
  const q = $("filter").value.trim().toLowerCase();
  for (const card of $("users").children) {
    card.hidden = q !== "" && !card.dataset.search.includes(q);
  }
}

function shareUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  const opts = readOptions();
  url.searchParams.set("post", $("post").value.trim());
  if (opts.includeOp) url.searchParams.set("op", "1");
  if (opts.exclude.length) url.searchParams.set("exclude", opts.exclude.join(","));
  if (opts.only.length) url.searchParams.set("subs", opts.only.join(","));
  if (opts.years) url.searchParams.set("years", String(opts.years));
  if (opts.maxUsers) url.searchParams.set("max", String(opts.maxUsers));
  if (minCount()) url.searchParams.set("min", String(minCount()));
  if (opts.delay !== 0.5) url.searchParams.set("delay", String(opts.delay));
  if (opts.concurrency !== 3) url.searchParams.set("par", String(opts.concurrency));
  return url.toString();
}

async function run() {
  showError("");
  let postId;
  try {
    postId = parsePostRef($("post").value);
  } catch (err) {
    showError(err.message);
    return;
  }
  const opts = readOptions();
  history.replaceState(null, "", shareUrl());

  state.controller = new AbortController();
  state.post = null;
  state.profiles = [];
  $("post-card").hidden = true;
  $("results").hidden = true;
  $("users").replaceChildren();
  setRunning(true);
  $("bar-fill").style.width = "0";

  let current = "";
  // Start of the history window, in epoch seconds (null = all time).
  const after = opts.years ? Math.floor(Date.now() / 1000 - opts.years * 365.25 * 86400) : null;
  $("window-note").textContent = after
    ? ` (counting activity since ${new Date(after * 1000).toLocaleDateString(undefined, { dateStyle: "medium" })})`
    : "";

  const client = new ArcticShiftClient({
    delay: opts.delay,
    signal: state.controller.signal,
    onWait: (reason, seconds) => setStatus(`${current} (${reason}, waiting ${Math.round(seconds)}s…)`),
  });

  try {
    current = "Looking up the post…";
    setStatus(current, 0);
    const post = await client.getPost(postId);
    if (!post) {
      showError(`Post ${postId} isn't in the Arctic Shift archive (it may be too new, or removed).`);
      $("status").hidden = true;
      return;
    }
    state.post = post;
    renderPost(post, null);

    current = "Collecting commenters…";
    setStatus(current, 0);
    const commenters = await collectCommenters(client, post, opts);
    renderPost(post, commenters);

    let ranked = [...commenters].sort((a, b) => b[1] - a[1] || a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
    if (opts.maxUsers) ranked = ranked.slice(0, opts.maxUsers);
    if (!ranked.length) {
      setStatus("No commenters to profile.", 1);
      return;
    }
    $("results").hidden = false;

    const slots = [];
    let done = 0;
    let inFlight = 0;
    const progress = () => {
      current = `Profiled ${done} of ${ranked.length}` + (inFlight ? ` (${inFlight} in progress)` : "");
      setStatus(current, done / ranked.length);
    };
    progress();
    await mapPool(ranked, opts.concurrency, async ([username, n], i) => {
      inFlight++;
      progress();
      let profile;
      try {
        profile = await buildProfile(client, username, n, post, { only: opts.only, after });
      } catch (err) {
        if (err instanceof Aborted) throw err;
        profile = {
          username, threadComments: n, targetPostsBefore: 0, targetCommentsBefore: 0,
          subreddits: new Map(), error: err.message,
        };
      } finally {
        inFlight--;
      }
      profile.rank = i;
      slots[i] = profile;
      state.profiles = slots.filter(Boolean);
      done++;
      progress();
      insertCard(userCard(profile, post));
      applyFilter();
    }, state.controller.signal);
    const failed = state.profiles.filter((p) => p.error).length;
    setStatus(`Done: profiled ${state.profiles.length} users${failed ? ` (${failed} failed)` : ""}.`, 1);
  } catch (err) {
    if (err instanceof Aborted) {
      setStatus(`Stopped after ${state.profiles.length} users.`);
    } else {
      showError(err.message);
      $("status").hidden = true;
    }
  } finally {
    setRunning(false);
    state.controller = null;
  }
}

function downloadCsv() {
  if (!state.post) return;
  const blob = new Blob([toCsv(state.profiles, state.post, minCount())], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${state.post.id}_activity.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyLink() {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    $("share").textContent = "Copied!";
  } catch {
    window.prompt("Copy this link:", url);
  }
  setTimeout(() => ($("share").textContent = "Copy link"), 1500);
}

function init() {
  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!state.controller) run();
  });
  $("stop").addEventListener("click", () => state.controller?.abort());
  $("filter").addEventListener("input", applyFilter);
  $("min-count").addEventListener("change", () => state.post && renderUsers());
  $("download").addEventListener("click", downloadCsv);
  $("share").addEventListener("click", copyLink);

  // Pre-fill from a shared link and start straight away.
  const params = new URLSearchParams(window.location.search);
  if (params.get("op") === "1") $("include-op").checked = true;
  if (params.get("exclude")) $("exclude").value = params.get("exclude");
  if (params.get("subs")) $("only-subs").value = params.get("subs");
  if (params.get("years")) $("years").value = params.get("years");
  if (params.get("max")) $("max-users").value = params.get("max");
  if (params.get("min")) $("min-count").value = params.get("min");
  if (params.get("delay")) $("delay").value = params.get("delay");
  if (params.get("par")) $("concurrency").value = params.get("par");
  if (["exclude", "subs", "years", "max", "min", "op", "delay", "par"].some((k) => params.has(k))) {
    $("options").open = true;
  }
  if (params.get("post")) {
    $("post").value = params.get("post");
    run();
  }
}

init();
