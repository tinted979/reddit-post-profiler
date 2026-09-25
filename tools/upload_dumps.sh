#!/usr/bin/env bash
# Upload dump builds (from tools/build_dumps.py) to the R2 bucket, checking that the
# public URL serves every file the way the page needs before the manifest points at it.
#
# Usage, from the repo root:  tools/upload_dumps.sh [dumps-dir] [--drop KEY ...] [--allow-format-change]
#
# Needs rclone with a remote named "r2" (override with RCLONE_REMOTE) for the bucket's
# S3 endpoint, set up once with a token limited to Object Read & Write on the bucket:
#
#   rclone config create r2 s3 provider=Cloudflare access_key_id=<id> secret_access_key=<secret> \
#     endpoint=https://<account-id>.r2.cloudflarestorage.com acl=private no_check_bucket=true
#
# (no_check_bucket: a token limited to one bucket may not check or create buckets.)
#
# Steps, in this order:
#  1. Preflight (tools/check_upload.py): the manifest about to go up replaces the live one
#     whole, so it must keep every live subreddit (--drop KEY removes one on purpose), and
#     a new build's r/<sub>/<version>/ mustn't already exist on R2 (its files wouldn't be
#     replaced, so the manifest's byte sizes wouldn't match what's served).
#  2. Build files go up (never replaced: --ignore-existing; immutable, cached a year), and
#     each is checked through the public URL (tools/check_dumps.sh files): a byte range
#     comes back as a range (206, with the full size), uncompressed, with CORS.
#  3. Only then the manifest goes up (cached 5 minutes) and is checked (check_dumps.sh
#     manifest and cors), so a browser never reads a manifest naming files that aren't
#     there or aren't served right.
# Nothing is deleted: a browser holding the previous manifest still needs the previous
# build. Old builds can be removed by hand once no manifest names them.

set -euo pipefail

DUMPS="dumps"
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then
  DUMPS="$1"
  shift
fi
REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-rpp-db}"
PUBLIC="${DUMPS_URL:-https://rpp-db.tinted979.dev}"

fail() { echo "error: $*" >&2; exit 1; }
# curl for the checks. A host that can't be reached must go through the checks' own
# messages (HTTP 000, no headers) rather than end the script with no word under set -e.
fetch() { curl -s --max-time 30 "$@" || true; }

for tool in rclone node curl uv; do
  command -v "$tool" >/dev/null || fail "$tool isn't installed"
done
rclone listremotes | grep -qx "$REMOTE:" || fail "no rclone remote named '$REMOTE' (see the top of this script)"
[ -f "$DUMPS/manifest.json" ] || fail "$DUMPS/manifest.json not found: run tools/build_dumps.py first"

# Every file the manifest names, as "path<TAB>bytes", checked to exist locally.
FILES=$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1] + "/manifest.json", "utf8"));
  for (const s of Object.values(m.subreddits)) for (const f of Object.values(s.files)) console.log(f.path + "\t" + f.bytes);
' "$DUMPS")
[ -n "$FILES" ] || fail "$DUMPS/manifest.json lists no files"
while IFS=$'\t' read -r path _; do
  [ -f "$DUMPS/$path" ] || fail "the manifest names $path, which isn't in $DUMPS"
done <<< "$FILES"

echo "Checking against what's live ..."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
status=$(fetch -o "$work/live.json" -w '%{http_code}' "$PUBLIC/manifest.json?check=$(date +%s)")
case "$status" in
  200) ;;
  404) : > "$work/live.json" ;; # nothing live yet
  *) fail "couldn't read the live manifest (HTTP $status)" ;;
esac
# No r/ yet means no builds; any other failure (auth, network) must stop here, since an
# empty list would switch off the "already on R2" check.
if ! rclone lsf -R --dirs-only --max-depth 2 "$REMOTE:$BUCKET/r" > "$work/builds.txt" 2> "$work/lsf.err"; then
  grep -qi "directory not found" "$work/lsf.err" || fail "couldn't list the builds on R2: $(head -1 "$work/lsf.err")"
  : > "$work/builds.txt"
fi
uv run --quiet tools/check_upload.py "$DUMPS/manifest.json" "$work/live.json" "$work/builds.txt" "$@" ||
  fail "nothing was uploaded"

echo "Uploading build files to $REMOTE:$BUCKET/r ..."
rclone copy "$DUMPS/r" "$REMOTE:$BUCKET/r" --ignore-existing \
  --header-upload "Cache-Control: public, max-age=31536000, immutable" \
  --header-upload "Content-Type: application/vnd.apache.parquet" \
  --include "*.parquet" --progress

DUMPS_URL="$PUBLIC" tools/check_dumps.sh files "$DUMPS/manifest.json" ||
  fail "the manifest was not uploaded, so the live one still stands"

echo "Uploading manifest.json ..."
rclone copyto "$DUMPS/manifest.json" "$REMOTE:$BUCKET/manifest.json" \
  --header-upload "Cache-Control: public, max-age=300" \
  --header-upload "Content-Type: application/json"

DUMPS_URL="$PUBLIC" tools/check_dumps.sh manifest
DUMPS_URL="$PUBLIC" tools/check_dumps.sh cors
echo "Done: every file in the manifest is served correctly."
