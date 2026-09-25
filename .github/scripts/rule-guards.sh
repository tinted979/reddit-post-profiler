#!/usr/bin/env bash
# The CLAUDE.md "Rules for changes" that a grep can decide. Runs on every push and PR, so no
# review, AI or human, has to spend attention on them.
# Usage: rule-guards.sh [WEB_DIR]   (default: this repository's web/; the tests pass a copy)
set -uo pipefail
cd "${1:-$(dirname "$0")/../../web}" || exit 2
fail=0

# The page's own modules; hyparquet.js is a vendored build that isn't edited here.
src=()
for f in ./*.js; do [ "$f" = ./hyparquet.js ] || src+=("$f"); done

if grep -nE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write' "${src[@]}"; then
  echo "::error::Untrusted input rule: put text in with textContent/el(), never HTML strings."; fail=1
fi
if grep -nE '\bfetch\(' "${src[@]}" | grep -vE '^\./(core|dumps)\.js:'; then
  echo "::error::API rule: requests go through ArcticShiftClient or DumpSource (core.js, dumps.js)."; fail=1
fi
if grep -nE '\bfrom "[^"]*"' "${src[@]}" | grep -vE 'from "\./[A-Za-z0-9_-]+\.js"'; then
  echo '::error::Imports rule: local imports must be written from "./x.js".'; fail=1
fi
# The deploy's missing-file check and cache busting only see `from "./x.js"`, so fail on any
# other way of loading a local file: a side-effect import, any dynamic import(), single quotes,
# or a relative new URL or Worker from a string or template literal.
if grep -nE "import\s*\(\s*[^)[:space:]]|import\s+['\"]|from\s*'\./|new URL\(\s*[^A-Za-z_[:space:]]\.|new Worker\(\s*[^A-Za-z_[:space:]]" ./*.js; then
  echo '::error::Imports rule: load local modules with: import … from "./x.js".'; fail=1
fi
# The site has no dependencies. The tests have one dev dependency, fake-indexeddb.
if ! node -e '
  const p = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
  const dev = Object.keys(p.devDependencies ?? {}).filter((d) => d !== "fake-indexeddb");
  process.exit(Object.keys(p.dependencies ?? {}).length || dev.length ? 1 : 0);'; then
  echo "::error::The web app has no dependencies, and its tests only fake-indexeddb (web/package.json)."; fail=1
fi
exit $fail
