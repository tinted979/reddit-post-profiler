#!/usr/bin/env bash
# Publish one subreddit's new build to the R2 bucket, from a bundle made by
# `check_upload.py merge-one`. The archive sync's publish job runs this and nothing else,
# since it's the one step that holds the R2 token (docs/adr/0005): it uses only rclone, curl,
# sha256sum and coreutils (no Node or Python), and it treats the bundle as untrusted, checking
# every name in it before any rclone call. upload_dumps.sh --only runs it too.
#
# Usage, from the repo root:  tools/publish_build.sh BUNDLE
#
# BUNDLE holds exactly: key, version and live.sha256 (one line each); manifest.json (the live
# manifest with this subreddit's entry replaced); r/<key>/<version>/{posts_by_author,
# comments_by_author,comments_by_link}.parquet; and r/<key>/published.json (the publish log).
#
# Steps, in this order; the first that fails stops it:
#  1. The live manifest on R2 is still the one the bundle was made from (its sha256), so a
#     publish in between isn't overwritten.
#  2. r/<key>/<version>/ isn't on R2 yet: builds are never replaced.
#  3. The build files go up (--immutable; cached a year) ...
#  4. ... and each is checked through the public URL: a byte range comes back as a range
#     (206, with the full size), uncompressed.
#  5. The live manifest is checked again, and only then replaced (cached 5 minutes).
#  6. Last, the publish log (cached 5 minutes), which pruning reads.
# A build uploaded in step 3 that goes no further is left unreferenced, never deleted here.
#
# RCLONE and CURL name the programs (the tests pass fakes); RCLONE_REMOTE (default r2),
# R2_BUCKET (rpp-db) and DUMPS_URL (https://rpp-db.tinted979.dev) say where to publish.

set -euo pipefail

RCLONE="${RCLONE:-rclone}"
CURL="${CURL:-curl}"
REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-rpp-db}"
PUBLIC="${DUMPS_URL:-https://rpp-db.tinted979.dev}"
FILES=(posts_by_author comments_by_author comments_by_link)
# The manifest and the log are small; anything bigger isn't one.
MAX_JSON_BYTES=1048576

fail() { echo "error: $*" >&2; exit 1; }

[ $# -eq 1 ] || fail "usage: $0 BUNDLE"
BUNDLE="$1"
[ -d "$BUNDLE" ] && [ ! -L "$BUNDLE" ] || fail "$BUNDLE isn't a directory"
for tool in "$RCLONE" "$CURL" sha256sum; do
  command -v "$tool" >/dev/null || fail "$tool isn't installed"
done

# The bundle: nothing but regular files, exactly the ones a build's publish needs.
[ -z "$(find "$BUNDLE" -type l -print -quit)" ] || fail "the bundle holds a symlink"
[ -z "$(find "$BUNDLE" -mindepth 1 ! -type f ! -type d -print -quit)" ] || fail "the bundle holds something that isn't a file"
# A bundle file of one line matching $2 (an extended regex, anchored): its value.
field() {
  local value
  [ -f "$BUNDLE/$1" ] || fail "the bundle has no $1"
  value=$(cat "$BUNDLE/$1")
  [[ "$value" =~ $2 ]] || fail "the bundle's $1 isn't usable"
  printf '%s' "$value"
}
KEY=$(field key '^[a-z0-9_]{2,21}$')
VERSION=$(field version '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$')
LIVE_SHA=$(field live.sha256 '^[0-9a-f]{64}$')
BUILD="r/$KEY/$VERSION"
want=(key version live.sha256 manifest.json "r/$KEY/published.json")
for f in "${FILES[@]}"; do want+=("$BUILD/$f.parquet"); done
got=$(cd "$BUNDLE" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
[ "$got" = "$(printf '%s\n' "${want[@]}" | LC_ALL=C sort)" ] ||
  fail "the bundle isn't exactly one build of r/$KEY: it has $(tr '\n' ' ' <<< "$got")"
for json in manifest.json "r/$KEY/published.json"; do
  [ "$(wc -c < "$BUNDLE/$json")" -le "$MAX_JSON_BYTES" ] || fail "the bundle's $json is too big"
done
for f in "${FILES[@]}"; do
  grep -qF "\"$BUILD/$f.parquet\"" "$BUNDLE/manifest.json" || fail "the bundle's manifest doesn't name $BUILD/$f.parquet"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Step 1 (and 5): the live manifest is the one the bundle was made from. Read from R2 itself,
# not the public URL, whose edge cache can be minutes behind.
unchanged() {
  "$RCLONE" cat "$REMOTE:$BUCKET/manifest.json" > "$work/live.json" || fail "couldn't read the live manifest from $REMOTE:$BUCKET"
  [ "$(sha256sum < "$work/live.json" | cut -d' ' -f1)" = "$LIVE_SHA" ] ||
    fail "the live manifest changed since this bundle was made (another publish?): build again from the new one"
}
echo "Publishing $BUILD/ to $REMOTE:$BUCKET ..."
unchanged

# Step 2: never over an existing build. No directory there is fine; any other failure (auth,
# network) stops here, since an empty answer would switch this check off.
if listing=$("$RCLONE" lsf "$REMOTE:$BUCKET/$BUILD/" 2> "$work/lsf.err"); then
  [ -z "$listing" ] || fail "$BUILD/ is already on R2: builds are never replaced"
else
  grep -qi "directory not found" "$work/lsf.err" || fail "couldn't check R2 for $BUILD/: $(head -1 "$work/lsf.err")"
fi

# Steps 3 and 4.
"$RCLONE" copy "$BUNDLE/$BUILD" "$REMOTE:$BUCKET/$BUILD" --immutable \
  --header-upload "Cache-Control: public, max-age=31536000, immutable" \
  --header-upload "Content-Type: application/vnd.apache.parquet" \
  --include "*.parquet"
problems=0
for f in "${FILES[@]}"; do
  path="$BUILD/$f.parquet"
  bytes=$(wc -c < "$BUNDLE/$path")
  bytes=${bytes//[[:space:]]/}
  headers=$("$CURL" -s --max-time 30 -D - -o /dev/null -H "Range: bytes=0-99" "$PUBLIC/$path" || true)
  if ! grep -q "^HTTP/[0-9.]* 206" <<< "$headers"; then
    echo "  $path: not 206: $(head -1 <<< "$headers")" >&2; problems=$((problems + 1))
  elif ! grep -qiE "^content-range: bytes 0-99/$bytes"$'\r?$' <<< "$headers"; then
    echo "  $path: Content-Range isn't bytes 0-99/$bytes" >&2; problems=$((problems + 1))
  elif grep -qi "^content-encoding:" <<< "$headers"; then
    echo "  $path: served compressed, which breaks range reads" >&2; problems=$((problems + 1))
  else
    echo "  ok: $path ($bytes bytes)"
  fi
done
[ "$problems" -eq 0 ] || fail "the manifest was not uploaded, so the live one still stands"

# Steps 5 and 6.
unchanged
"$RCLONE" copyto "$BUNDLE/manifest.json" "$REMOTE:$BUCKET/manifest.json" \
  --header-upload "Cache-Control: public, max-age=300" \
  --header-upload "Content-Type: application/json"
"$RCLONE" copyto "$BUNDLE/r/$KEY/published.json" "$REMOTE:$BUCKET/r/$KEY/published.json" \
  --header-upload "Cache-Control: public, max-age=300" \
  --header-upload "Content-Type: application/json"
echo "Done: $BUILD/ is live."
