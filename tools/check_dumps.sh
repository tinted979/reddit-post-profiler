#!/usr/bin/env bash
# Check that the archive (the R2 bucket behind the public URL) serves the page what it
# needs. Nothing here writes anything or needs credentials.
#
# Usage, from the repo root:
#   tools/check_dumps.sh                  everything, against the live manifest
#   tools/check_dumps.sh manifest         the live manifest: CORS, and the page accepts it
#   tools/check_dumps.sh cors             preflights, from every origin in tools/r2-cors.json
#   tools/check_dumps.sh files [MANIFEST] each file in MANIFEST (default: the live one)
#
# upload_dumps.sh runs `files` on a new build before its manifest goes up, and `manifest`
# after. .github/workflows/archive-check.yml runs it all weekly, so a changed Cloudflare
# setting (compression, a challenge page, CORS) shows up as a failed run instead of the
# page quietly switching the archive off and sending every scan back to the API.

set -euo pipefail

PUBLIC="${DUMPS_URL:-https://rpp-db.tinted979.dev}"
CORS_FILE="tools/r2-cors.json"

fail() { echo "error: $*" >&2; exit 1; }
# curl for the checks. A host that can't be reached must go through the checks' own
# messages (HTTP 000, no headers) rather than end the script with no word under set -e.
fetch() { curl -s --max-time 30 "$@" || true; }
# A header line from `curl -D -`, matched whole (headers end in \r).
has_header() { grep -qiE "^$1"$'\r?$' <<< "$2"; }

for tool in curl node; do
  command -v "$tool" >/dev/null || fail "$tool isn't installed"
done
[ -f "$CORS_FILE" ] || fail "run this from the repo root ($CORS_FILE not found)"

# The origins the bucket's CORS policy allows (the first is the live page's).
mapfile -t ORIGINS < <(node -e '
  const rules = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const o of rules.flatMap((r) => r.AllowedOrigins)) console.log(o);
' "$CORS_FILE")
[ "${#ORIGINS[@]}" -gt 0 ] || fail "$CORS_FILE lists no origins"
PAGE="${ORIGINS[0]}"
OTHER="https://example.com"

problems=0
check() { echo "  $*" >&2; problems=$((problems + 1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The live manifest, saved to $work/live.json.
live_manifest() {
  [ -s "$work/live.json" ] && return
  local status
  status=$(fetch -o "$work/live.json" -w '%{http_code}' "$PUBLIC/manifest.json?check=$(date +%s)")
  [ "$status" = 200 ] || fail "couldn't read the live manifest (HTTP $status)"
}

# "path<TAB>bytes" for each file a manifest names.
files_in() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const s of Object.values(m.subreddits)) for (const f of Object.values(s.files)) console.log(f.path + "\t" + f.bytes);
  ' "$1"
}

check_manifest() {
  echo "Checking $PUBLIC/manifest.json ..."
  local headers
  headers=$(fetch -D - -o /dev/null -H "Origin: $PAGE" "$PUBLIC/manifest.json?check=$(date +%s)")
  grep -q "^HTTP/[0-9.]* 200" <<< "$headers" || check "manifest.json: not 200: $(head -1 <<< "$headers")"
  has_header "access-control-allow-origin: $PAGE" "$headers" || check "manifest.json: no CORS header for $PAGE"
  headers=$(fetch -D - -o /dev/null -H "Origin: $OTHER" "$PUBLIC/manifest.json?check=$(date +%s)")
  grep -qi "^access-control-allow-origin:" <<< "$headers" && check "manifest.json: CORS allows $OTHER"
  # The page's own parser: a subreddit it leaves out (a bad path, a future cutoff, a
  # format it doesn't read) is one the page silently gets from the API instead.
  live_manifest
  local verdict
  # shellcheck disable=SC2016 # ${...} below is a JavaScript template literal, not shell
  verdict=$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parseManifest } from "./web/dumps.js";
    const raw = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const listed = Object.keys(raw.subreddits ?? {});
    const kept = parseManifest(raw);
    const dropped = listed.filter((k) => !kept.has(k));
    if (!listed.length) console.log("lists no subreddits");
    else if (dropped.length) console.log(`the page ignores r/${dropped.join(", r/")} (format ${raw.format})`);
    else console.log(`ok: ${listed.length} subreddit(s)`);
  ' "$work/live.json" 2>&1 || true)
  case "$verdict" in
    ok:*) echo "  $verdict" ;;
    *) check "manifest.json: $verdict" ;;
  esac
}

check_cors() {
  live_manifest
  local path headers origin
  path=$(files_in "$work/live.json" | head -1 | cut -f1)
  [ -n "$path" ] || { check "no file to check preflights against"; return; }
  echo "Checking preflights for $path ..."
  # The page asks for byte ranges, so the browser sends a preflight first: it must pass
  # for every origin the policy allows (the live page, local development) ...
  for origin in "${ORIGINS[@]}"; do
    headers=$(fetch -D - -o /dev/null -X OPTIONS -H "Origin: $origin" \
      -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" "$PUBLIC/$path")
    grep -q "^HTTP/[0-9.]* 20[04]" <<< "$headers" || check "preflight from $origin: $(head -1 <<< "$headers")"
    has_header "access-control-allow-origin: $origin" "$headers" || check "preflight from $origin: origin not allowed"
    grep -qiE "^access-control-allow-headers:.*\brange\b" <<< "$headers" || check "preflight from $origin: Range not allowed"
  done
  # ... and fail for any other.
  headers=$(fetch -D - -o /dev/null -X OPTIONS -H "Origin: $OTHER" \
    -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" "$PUBLIC/$path")
  grep -qi "^access-control-allow-origin:" <<< "$headers" && check "preflight from $OTHER is allowed"
  [ "$problems" -eq 0 ] && echo "  ok: ${ORIGINS[*]} allowed, $OTHER refused"
}

check_files() {
  local manifest="${1:-}"
  if [ -z "$manifest" ]; then
    live_manifest
    manifest="$work/live.json"
  fi
  local list
  list=$(files_in "$manifest")
  [ -n "$list" ] || { check "the manifest lists no files"; return; }
  echo "Checking the files at $PUBLIC ..."
  local path bytes url before headers cache
  while IFS=$'\t' read -r path bytes; do
    url="$PUBLIC/$path"
    before=$problems
    headers=$(fetch -D - -o /dev/null -H "Origin: $PAGE" -H "Range: bytes=0-99" "$url")
    grep -q "^HTTP/[0-9.]* 206" <<< "$headers" || check "$path: not 206: $(head -1 <<< "$headers")"
    has_header "content-range: bytes 0-99/$bytes" "$headers" || check "$path: Content-Range isn't bytes 0-99/$bytes"
    has_header "access-control-allow-origin: $PAGE" "$headers" || check "$path: no CORS header for $PAGE"
    grep -qiE "^access-control-expose-headers:.*\bcontent-range\b" <<< "$headers" ||
      check "$path: Content-Range isn't exposed to the page"
    grep -qi "^content-encoding:" <<< "$headers" && check "$path: served compressed, which breaks range reads"
    # For information: whether the edge cache holds the file yet.
    cache=$(grep -i "^cf-cache-status:" <<< "$headers" | tr -d '\r' || true)
    [ "$problems" -eq "$before" ] && echo "  ok: $path (${bytes} bytes; ${cache:-no cf-cache-status})"
  done <<< "$list"
}

case "${1:-all}" in
  manifest) check_manifest ;;
  cors) check_cors ;;
  files) check_files "${2:-}" ;;
  all) check_manifest; check_cors; check_files ;;
  *) fail "usage: $0 [all|manifest|cors|files [MANIFEST]]" ;;
esac

[ "$problems" -eq 0 ] || fail "$problems problem(s) found above"
echo "Done: the archive is served correctly."
