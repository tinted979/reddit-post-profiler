// Text the page shows: counts, durations, ages, badge rules and error advice. No DOM
// access, so it's tested in Node.

import { ArcticShiftError, QueryTimeout, ServerBusy } from "./core.js";

export const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

// Words for core.js's requestLabel labels, in the order the request breakdown lists them.
const LABEL_TEXT = new Map([
  ["post", "Post"],
  ["recent posts", "Recent activity, posts (whole subreddit)"],
  ["recent comments", "Recent activity, comments (whole subreddit)"],
  ["thread tree", "Thread, comment tree"],
  ["thread pages", "Thread, comment pages"],
  ["lifetime posts", "Lifetime totals per user, posts"],
  ["lifetime comments", "Lifetime totals per user, comments"],
  ["lifetime posts, split", "Lifetime totals per user, posts, split up"],
  ["lifetime comments, split", "Lifetime totals per user, comments, split up"],
  ["interactions", "Lifetime totals per user, interactions"],
  ["before posts", "Before the post per user, post timestamps"],
  ["before comments", "Before the post per user, comment timestamps"],
  ["before posts, count", "Before the post per user, post counts"],
  ["before comments, count", "Before the post per user, comment counts"],
]);

const utcMinute = (t) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// The scan's request breakdown, a line each: the Arctic Shift requests by what they were
// for (client.byLabel), adding up to the total; the retries among them by reason; what
// each recent-activity fetch did (core.js fetchTails); and the archive requests by file.
export function breakdownLines({ requests, byLabel, retries, tails, archive, archiveByFile }) {
  const lines = [`Arctic Shift: ${plural(requests, "request")}`];
  for (const [label, text] of LABEL_TEXT) {
    if (byLabel.get(label)) lines.push(`${text}: ${byLabel.get(label)}`);
  }
  for (const [label, n] of byLabel) {
    if (!LABEL_TEXT.has(label)) lines.push(`${label}: ${n}`);
  }
  if (retries.size) lines.push(`Retries: ${[...retries].map(([why, n]) => `${why} ${n}`).join(", ")} (included above)`);
  if (!tails.length) lines.push("No recent activity was fetched for the whole subreddit.");
  for (const t of tails) {
    const how = t.reachedEnd ? "reached the post"
      : t.error ? `stopped: ${t.error}`
      : t.projected ? `stopped: finishing would take about ${t.projected} pages, more than asking per user`
      : "stopped at the budget";
    const upTo = t.reachedEnd || t.through === null ? "" : `; complete up to ${utcMinute(t.through)}`;
    lines.push(`r/${t.subreddit} ${t.kind} since the archive files: ${t.pages} of ${t.budget} pages, ${how}${upTo}`);
  }
  if (archive !== null && archive !== undefined) {
    const files = [...archiveByFile].sort(([a], [b]) => a.localeCompare(b)).map(([f, n]) => `${f} ${n}`).join(", ");
    lines.push(`Archive: ${plural(archive, "request")}${files ? ` (${files})` : ""}`);
  }
  return lines;
}

// Time left in a scan, rounded up and coarser as it grows.
export function formatEta(seconds) {
  if (seconds === null) return "estimating time left…";
  if (seconds < 5) return "almost done";
  if (seconds < 60) return `about ${Math.ceil(seconds / 5) * 5} s left`;
  if (seconds < 600) {
    const s = Math.ceil(seconds / 10) * 10;
    return `about ${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""} left`;
  }
  const m = Math.ceil(seconds / 60);
  return m < 60 ? `about ${m} min left` : `about ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""} left`;
}

// A measured duration: "4.2 s", "38 s", "1 min 38 s", "1 h 5 min".
export function formatDuration(seconds) {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

// How long ago, in rough units: "3 days", "2 weeks", "5 months", "2 years".
export function formatAge(days) {
  if (days < 1) return "less than a day";
  if (days < 14) return plural(Math.floor(days), "day");
  if (days < 60) return plural(Math.floor(days / 7), "week");
  if (days < 730) return plural(Math.floor(days / 30.44), "month");
  return plural(Math.floor(days / 365.25), "year");
}

// "N Arctic Shift requests and M archive requests" (archive null: from before archive
// requests were counted, so left out).
export function requestsText(arcticShift, archive) {
  const api = plural(arcticShift, "Arctic Shift request");
  return archive === null || archive === undefined ? api : `${api} and ${plural(archive, "archive request")}`;
}

// The end-of-scan note on what the archive answered: sentences that each start with a space,
// or "" if it answered nothing. `archive` is where the files alone end (DumpSource
// covers(…, {withTail: false})), `tailed` where the tab's tail takes them (covers()),
// `tailRequests` how many requests this scan's tail fetch sent, `dumps` the source's
// counters, and `date` formats a time (epoch seconds). "Before" facts are complete up to
// the second before the post.
export function archiveNote({ post, archive, tailed, tailRequests, dumps, date }) {
  if (dumps.broken) return ` The r/${archive.name} archive files stopped answering partway, so Arctic Shift answered for the rest.`;
  let text = "";
  if (dumps.reads > 0) {
    const filesEnd = Math.min(archive.postsThrough, archive.commentsThrough);
    if (post.createdUtc - 1 <= filesEnd) {
      text += ` Activity in r/${archive.name} before the post came from archive files.`;
    } else {
      text += ` Activity in r/${archive.name} before the post, up to ${date(filesEnd)}, came from archive files.`;
      const tailEnd = tailed ? Math.min(tailed.postsThrough, tailed.commentsThrough) : filesEnd;
      const source = tailEnd <= filesEnd ? null
        : tailRequests ? `${plural(tailRequests, "request")} for the whole subreddit`
        : "what an earlier scan in this tab fetched for the whole subreddit";
      if (!source) text += " Activity after that came from Arctic Shift for each user.";
      else if (tailEnd >= post.createdUtc - 1) text += ` Activity from then to the post came from ${source}${tailRequests ? " rather than for each user" : ""}.`;
      else text += ` Activity after that came from ${source}, up to ${date(tailEnd)}, and from Arctic Shift for each user for the rest.`;
    }
  }
  if (dumps.lifetimeReads > 0) {
    text += dumps.lifetimeGaps
      ? " Subreddit counts came from the archive files, plus Arctic Shift for anything between where they end and the post."
      : " Subreddit counts came from the archive files.";
  }
  if (dumps.threadReads > 0) text += " The thread's comments came from the archive files, plus Arctic Shift for those made since.";
  return text;
}

export function tookText({ seconds, profilingSeconds }) {
  const total = formatDuration(seconds);
  return profilingSeconds === null ? total : `${total} (profiling ${formatDuration(profilingSeconds)})`;
}

// One badge rule ({count, days, tenure}) in words.
export function describeRule(r) {
  const parts = [`${Math.max(1, r.count)}+ ${r.count === 1 ? "post or comment" : "posts and comments"}`];
  if (r.days > 0) parts.push(`on ${r.days}+ ${r.days === 1 ? "day" : "different days"}`);
  if (r.tenure > 0) parts.push(`the first ${r.tenure}+ ${r.tenure === 1 ? "day" : "days"} before`);
  return parts.join(", ");
}

// The timeline part of a card's "before" line, from profileFacts.
export function timelineText(f) {
  if (f.days === null) return " (no timeline saved, so the badge goes by the count alone)";
  let text = `, on ${f.exact ? "" : "at least "}${f.days === 1 ? "1 day" : `${f.days} different days`}`;
  if (f.tenureDays !== null) text += `, the first ${formatAge(f.tenureDays)} before`;
  return text;
}

// An error as advice for the person using the page.
export function explain(err) {
  if (err instanceof ServerBusy) return "Arctic Shift is overloaded right now. Try again in a few minutes.";
  if (err instanceof QueryTimeout) return "Arctic Shift couldn't count this much history in time.";
  if (err instanceof ArcticShiftError) {
    if (err.status === 429) return "Arctic Shift is limiting requests right now. Wait a minute and try again.";
    if (err.status === null) return "Couldn't reach Arctic Shift. Check your connection and try again.";
    return `Arctic Shift returned an error (HTTP ${err.status}).`;
  }
  return err.message;
}
