// Scan options: from the form's fields, to and from share links, and in words. No DOM
// access, so it's tested in Node; app.js reads and fills the fields named in FIELD_IDS.

import {
  DEFAULT_BADGES,
  HISTORY_YEARS,
  SCAN_DEFAULTS,
  clampScanNumbers,
  formatBadges,
  parseSubreddits,
  parseUsernames,
  sameBadges,
} from "./core.js";
import { plural } from "./format.js";

// The page's option inputs, by option (includeOp is the checkbox #include-op).
export const FIELD_IDS = Object.freeze({
  exclude: "exclude",
  only: "only-subs",
  years: "years",
  maxUsers: "max-users",
  minCount: "min-count",
  delay: "delay",
  concurrency: "concurrency",
  cacheDays: "cache-days",
});

// Share link parameters, by option. shareParams writes and readShareParams reads exactly
// these, so adding an option means adding it here.
export const SHARE_PARAMS = Object.freeze({
  includeOp: "op",
  exclude: "exclude",
  only: "subs",
  years: "years",
  maxUsers: "max",
  minCount: "min",
  delay: "delay",
  concurrency: "par",
  cacheDays: "cache",
  badges: "badges",
});

// The form's fields as text (what the inputs hold; includeOp a boolean) → the options a
// run uses, clamped to what the tool supports. Missing fields take their defaults.
export function parseOptions(fields) {
  const { includeOp = false, exclude = "", only = "", years = "", maxUsers = "", delay = "", concurrency = "", cacheDays = "" } = fields;
  const num = (text) => Number.parseFloat(text);
  const y = Number(years);
  return {
    includeOp: Boolean(includeOp),
    exclude: parseUsernames(String(exclude).split(/[\s,]+/)),
    only: parseSubreddits(String(only).split(/[\s,]+/)),
    years: HISTORY_YEARS.includes(y) ? y : null,
    ...clampScanNumbers({ maxUsers: num(maxUsers), delay: num(delay), concurrency: num(concurrency), cacheDays: num(cacheDays) }),
  };
}

// Options saved with a queued item or a saved scan, laid over `base` (full options, e.g.
// the form's). The stored ones come from localStorage or IndexedDB, maybe written by an
// older version of the page, so each field is used only if it's valid (numbers clamped
// like the form's); a missing or odd field keeps the base's.
export function mergeOptions(base, stored) {
  const o = stored && typeof stored === "object" ? stored : {};
  const has = (key) => key in o;
  const list = (v, parse, fallback) => (Array.isArray(v) ? parse(v.filter((x) => typeof x === "string")) : fallback);
  const num = (key) => (has(key) ? (typeof o[key] === "number" ? o[key] : NaN) : base[key]);
  return {
    includeOp: typeof o.includeOp === "boolean" ? o.includeOp : base.includeOp,
    exclude: list(o.exclude, parseUsernames, base.exclude),
    only: list(o.only, parseSubreddits, base.only),
    years: has("years") ? (HISTORY_YEARS.includes(o.years) ? o.years : null) : base.years,
    ...clampScanNumbers({
      maxUsers: has("maxUsers") ? o.maxUsers ?? null : base.maxUsers,
      delay: num("delay"),
      concurrency: num("concurrency"),
      cacheDays: num("cacheDays"),
    }),
  };
}

// The "hide subreddits below N" box: a whole number, at least 0.
export function parseMinCount(text) {
  return Math.max(0, Math.floor(Number.parseFloat(text)) || 0);
}

// A share link's query for a post and options, leaving out whatever is at its default.
export function shareParams(postRef, opts, { minCount = 0, badges = DEFAULT_BADGES } = {}) {
  const p = new URLSearchParams();
  const set = (key, value) => p.set(SHARE_PARAMS[key], String(value));
  p.set("post", postRef);
  if (opts.includeOp) set("includeOp", "1");
  if (opts.exclude.length) set("exclude", opts.exclude.join(","));
  if (opts.only.length) set("only", opts.only.join(","));
  if (opts.years) set("years", opts.years);
  if (opts.maxUsers) set("maxUsers", opts.maxUsers);
  if (minCount) set("minCount", minCount);
  if (opts.delay !== SCAN_DEFAULTS.delay) set("delay", opts.delay);
  if (opts.concurrency !== SCAN_DEFAULTS.concurrency) set("concurrency", opts.concurrency);
  if (opts.cacheDays !== SCAN_DEFAULTS.cacheDays) set("cacheDays", opts.cacheDays);
  if (!sameBadges(badges, DEFAULT_BADGES)) set("badges", formatBadges(badges));
  return p;
}

// A share link's query → {post, fields}: the post (or null), and the fields as text for
// each option the link sets (includeOp as a boolean, whether set or not; badges as their
// text form, for parseBadges). parseOptions turns the fields into options.
export function readShareParams(params) {
  const fields = { includeOp: params.get(SHARE_PARAMS.includeOp) === "1" };
  for (const [key, name] of Object.entries(SHARE_PARAMS)) {
    if (key !== "includeOp" && params.has(name)) fields[key] = params.get(name);
  }
  return { post: params.get("post"), fields };
}

// The Options panel's summary: what differs from the defaults ("" if nothing does).
export function optionsSummary(o, badges) {
  const parts = [];
  if (o.includeOp) parts.push("author included");
  if (o.exclude.length) parts.push(`skipping ${plural(o.exclude.length, "user")}`);
  if (o.maxUsers) parts.push(`top ${o.maxUsers}`);
  if (o.only.length) {
    parts.push(o.only.length <= 3 ? `only ${o.only.map((s) => `r/${s}`).join(", ")}` : `only ${o.only.length} subreddits`);
  }
  if (o.years) parts.push(`last ${plural(o.years, "year")}`);
  if (o.cacheDays !== SCAN_DEFAULTS.cacheDays) parts.push(o.cacheDays ? `results kept ${plural(o.cacheDays, "day")}` : "not saving results");
  if (o.delay !== SCAN_DEFAULTS.delay) parts.push(`${o.delay}s between requests`);
  if (o.concurrency !== SCAN_DEFAULTS.concurrency) parts.push(`${o.concurrency} in parallel`);
  if (!sameBadges(badges, DEFAULT_BADGES)) parts.push("custom badges");
  return parts.join(" · ");
}

// A saved or queued scan's options, as short notes for its list entry.
export function scanOptionNotes(o = {}) {
  return [
    o.years && `last ${plural(o.years, "year")}`,
    o.only?.length && `only ${o.only.map((x) => `r/${x}`).join(", ")}`,
    o.maxUsers && `top ${o.maxUsers}`,
    o.includeOp && "author included",
    o.exclude?.length && `skipped ${o.exclude.join(", ")}`,
  ].filter(Boolean);
}
