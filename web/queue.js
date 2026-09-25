// The scheduler's queue of posts to scan one after another. It's kept in localStorage, so
// a reload or a closed tab doesn't lose it; a scan cut off that way goes back to waiting.
// Each item keeps the options that were set when it was added.

import { parsePostRef } from "./core.js";

// Named before the project became Reddit Post Profiler; kept so visitors' saved data survives.
export const QUEUE_KEY = "reddit-tool-queue";
const KEY = QUEUE_KEY;
// Most scans waiting at once: the queue runs unattended, so keep it from piling up a day's
// worth of requests on the free API.
export const MAX_WAITING = 25;
// Most users profiled in parallel by a queued scan, which runs unattended.
export const QUEUE_CONCURRENCY = 2;

// Statuses: waiting → running → done | failed | stopped.
const FINISHED = new Set(["done", "failed", "stopped"]);
// Items that count against MAX_WAITING, and that a post can't be queued twice among.
const isPending = (item) => item.status === "waiting" || item.status === "running";

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked
  }
}

// Split pasted text into post references: one per line or comma. A line is only split on
// spaces if every part looks like a link or a post id (5-8 characters with a digit), so a
// stray phrase like "see this" is reported as one bad entry, not taken as the bare post
// ids "see" and "this".
const LINKISH = /[/.]|^(?:t3_)?(?=[a-z]*\d)[0-9a-z]{5,8}$/i;

export function splitRefs(text) {
  const refs = [];
  for (const part of text.split(/[\n,]+/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1 && !words.every((w) => LINKISH.test(w))) refs.push(words.join(" "));
    else refs.push(...words);
  }
  return refs;
}

export class LinkQueue {
  constructor({ storage = browserStorage(), now = () => Date.now() / 1000 } = {}) {
    this._storage = storage;
    this._now = now;
    this.items = [];
    this.active = false; // started, and not paused
    this._next = 1;
  }

  // Restore the saved queue. Returns true if it was cut off mid-run (the page closed).
  // readOnly: just show it (another tab runs the queue), so change and save nothing.
  load({ readOnly = false } = {}) {
    let data = null;
    try {
      data = JSON.parse(this._storage?.getItem(KEY) ?? "null");
    } catch {
      data = null;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    this.items = items.filter((i) => i && typeof i.postId === "string" && typeof i.ref === "string");
    if (readOnly) {
      this.active = Boolean(data?.active);
      return false;
    }
    let interrupted = Boolean(data?.active);
    for (const item of this.items) {
      if (item.status === "running") {
        Object.assign(item, { status: "waiting", note: "" });
        interrupted = true;
      }
      if (!["waiting", ...FINISHED].includes(item.status)) item.status = "waiting";
    }
    this.active = false;
    this._next = Math.max(0, ...this.items.map((i) => Number(i.id) || 0)) + 1;
    this.save();
    return interrupted && this.items.some((i) => i.status === "waiting");
  }

  save() {
    try {
      this._storage?.setItem(KEY, JSON.stringify({ active: this.active, items: this.items }));
    } catch {
      // Out of quota or blocked: the queue still works until the page closes.
    }
  }

  // Add the post links in `text` (one per line, or separated by commas or spaces) with
  // these options. Links already waiting or running are skipped, and links past
  // MAX_WAITING are returned in `full`.
  add(text, opts) {
    const result = { added: 0, duplicates: 0, invalid: [], full: [] };
    let pending = this.items.filter(isPending).length;
    for (const ref of splitRefs(text)) {
      let postId;
      try {
        postId = parsePostRef(ref);
      } catch {
        result.invalid.push(ref);
        continue;
      }
      if (this.items.some((i) => i.postId === postId && isPending(i))) {
        result.duplicates++;
        continue;
      }
      if (pending >= MAX_WAITING) {
        result.full.push(ref);
        continue;
      }
      pending++;
      this.items.push({
        id: String(this._next++), ref, postId, opts, status: "waiting", note: "", addedAt: this._now(),
      });
      result.added++;
    }
    if (result.added) this.save();
    return result;
  }

  get(id) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  // The next item to run, or null.
  next() {
    return this.items.find((i) => i.status === "waiting") ?? null;
  }

  update(id, patch) {
    const item = this.get(id);
    if (item) Object.assign(item, patch);
    this.save();
    return item;
  }

  // Run a finished item again (at the end of the queue). Returns null, or why it can't:
  // "duplicate" (the post is already waiting or running) or "full" (MAX_WAITING reached).
  retry(id) {
    const item = this.get(id);
    if (!item || !FINISHED.has(item.status)) return null;
    const pending = this.items.filter(isPending);
    if (pending.some((i) => i.postId === item.postId)) return "duplicate";
    if (pending.length >= MAX_WAITING) return "full";
    this.items = this.items.filter((i) => i !== item);
    this.items.push(Object.assign(item, { status: "waiting", note: "" }));
    this.save();
    return null;
  }

  remove(id) {
    this.items = this.items.filter((i) => i.id !== id || i.status === "running");
    this.save();
  }

  clearFinished() {
    this.items = this.items.filter((i) => !FINISHED.has(i.status));
    this.save();
  }

  setActive(active) {
    this.active = active;
    this.save();
  }

  counts() {
    const c = { waiting: 0, running: 0, done: 0, failed: 0, stopped: 0, total: this.items.length };
    for (const i of this.items) c[i.status]++;
    return c;
  }
}
