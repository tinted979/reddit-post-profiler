#!/usr/bin/env bash
# Upload dump builds (from tools/build_dumps.py) to the R2 bucket, then check that the
# public URL serves every file the manifest lists the way the page needs.
#
# Usage, from the repo root:  tools/upload_dumps.sh [dumps-dir]
#
# Needs rclone with a remote named "r2" (override with RCLONE_REMOTE) for the bucket's
# S3 endpoint, set up once with a token limited to Object Read & Write on the bucket:
#
#   rclone config create r2 s3 provider=Cloudflare access_key_id=<id> secret_access_key=<secret> \
#     endpoint=https://<account-id>.r2.cloudflarestorage.com acl=private no_check_bucket=true
#
# (no_check_bucket: a token limited to one bucket may not check or create buckets.)
#
# Order matters: the build files go up first, then the manifest that points at them, so a
# browser never reads a manifest naming files that aren't there yet. Build files are
# never replaced (--ignore-existing; builds are immutable and cached for a year), and
# nothing is deleted: a browser holding the previous manifest (cached 5 minutes) still
# needs the previous build. Old builds can be removed by hand once no manifest names them.

set -euo pipefail

DUMPS="${1:-dumps}"
REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-rpp-db}"
PUBLIC="${DUMPS_URL:-https://rpp-db.tinted979.dev}"
ORIGIN="https://tinted979.github.io"

fail() { echo "error: $*" >&2; exit 1; }

command -v rclone >/dev/null || fail "rclone isn't installed (winget install Rclone.Rclone, or https://rclone.org/install/)"
command -v node >/dev/null || fail "node is needed to read the manifest"
rclone listremotes | grep -qx "$REMOTE:" || fail "no rclone remote named '$REMOTE' (see the top of this script)"
[ -f "$DUMPS/manifest.json" ] || fail "$DUMPS/manifest.json not found: run tools/build_dumps.py first"

# Every file the manifest names, as "path<TAB>bytes", checked to exist locally.
FILES=$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1] + "/manifest.json", "utf8"));
  for (const s of Object.values(m.subreddits)) for (const f of Object.values(s.files)) console.log(f.path + "\t" + f.bytes);
' "$DUMPS")
while IFS=$'\t' read -r path bytes; do
  [ -f "$DUMPS/$path" ] || fail "the manifest names $path, which isn't in $DUMPS"
done <<< "$FILES"

echo "Uploading build files to $REMOTE:$BUCKET/r ..."
rclone copy "$DUMPS/r" "$REMOTE:$BUCKET/r" --ignore-existing \
  --header-upload "Cache-Control: public, max-age=31536000, immutable" \
  --header-upload "Content-Type: application/vnd.apache.parquet" \
  --include "*.parquet" --progress

echo "Uploading manifest.json ..."
rclone copyto "$DUMPS/manifest.json" "$REMOTE:$BUCKET/manifest.json" \
  --header-upload "Cache-Control: public, max-age=300" \
  --header-upload "Content-Type: application/json"

echo "Checking $PUBLIC ..."
problems=0
check() { echo "  $*" >&2; problems=$((problems + 1)); }

# The manifest: readable from the page's origin.
headers=$(curl -s -D - -o /dev/null -H "Origin: $ORIGIN" "$PUBLIC/manifest.json?check=$(date +%s)")
grep -q "^HTTP/[0-9.]* 200" <<< "$headers" || check "manifest.json: not 200: $(head -1 <<< "$headers")"
grep -qi "^access-control-allow-origin: $ORIGIN" <<< "$headers" || check "manifest.json: no CORS header for $ORIGIN"
# ...and not from anywhere else (CORS widened to "*" or another origin by mistake).
headers=$(curl -s -D - -o /dev/null -H "Origin: https://example.com" "$PUBLIC/manifest.json?check=$(date +%s)")
grep -qi "^access-control-allow-origin:" <<< "$headers" && check "manifest.json: CORS allows https://example.com"

# Each Parquet file: a byte range comes back as a range (206, Content-Range with the
# full size), uncompressed, with CORS; a second request should be a cache hit.
while IFS=$'\t' read -r path bytes; do
  url="$PUBLIC/$path"
  before=$problems
  headers=$(curl -s -D - -o /dev/null -H "Origin: $ORIGIN" -H "Range: bytes=0-99" "$url")
  grep -q "^HTTP/[0-9.]* 206" <<< "$headers" || check "$path: not 206: $(head -1 <<< "$headers")"
  grep -qi "^content-range: bytes 0-99/$bytes" <<< "$headers" || check "$path: Content-Range isn't bytes 0-99/$bytes"
  grep -qi "^access-control-allow-origin: $ORIGIN" <<< "$headers" || check "$path: no CORS header for $ORIGIN"
  grep -qi "^content-encoding:" <<< "$headers" && check "$path: served compressed, which breaks range reads"
  cache=$(curl -s -D - -o /dev/null -H "Range: bytes=0-99" "$url" | grep -i "^cf-cache-status:" | tr -d '\r' || true)
  [ "$problems" -eq "$before" ] && echo "  ok: $path (${bytes} bytes; ${cache:-no cf-cache-status})"
done <<< "$FILES"

if [ "$problems" -gt 0 ]; then
  fail "$problems problem(s) found above"
fi
echo "Done: every file in the manifest is served correctly."
