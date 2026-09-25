// Text the page shows: counts, durations, ages, badge rules and error advice. No DOM
// access, so it's tested in Node.

import { ArcticShiftError, QueryTimeout, ServerBusy } from "./core.js";

export const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

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
