#!/usr/bin/env bash
# Fails if a change removes tests or adds skip/only/todo markers, compared with its base.
# Usage: test-integrity.sh [BASE]   (default HEAD^1: on a pull_request checkout, HEAD is the
# merge commit and its first parent is main). Run from the repository root.
set -uo pipefail
base="${1:-HEAD^1}"
tmp=$(mktemp -d)
trap 'git worktree remove --force "$tmp/base" >/dev/null 2>&1; rm -rf "$tmp"' EXIT
git worktree add --detach "$tmp/base" "$base" >/dev/null 2>&1 || { echo "::error::can't check out $base"; exit 1; }

# The web tests need fake-indexeddb installed, or the IndexedDB test file fails to load and
# the count comes out low. NODE_TEST_CONTEXT is unset so a run inside node --test (the
# script's own tests) still reports TAP.
count() {   # count KIND DIR: how many node or py tests DIR has
  case "$1" in
    node) (cd "$2/web" && npm ci --silent --no-audit --no-fund >/dev/null 2>&1; env -u NODE_TEST_CONTEXT node --test --test-reporter=tap 2>/dev/null) |
            awk '/^# tests /{n=$3} END{print n+0}' ;;
    py) (cd "$2" && uv run -q --with "duckdb>=1.1,<2" --with pytest pytest tools --collect-only -q 2>/dev/null) |
          awk '/tests? collected/{n=$1} END{print n+0}' ;;
  esac
}

fail=0
for kind in node py; do
  b=$(count "$kind" "$tmp/base"); h=$(count "$kind" .)
  echo "$kind tests: base $b, this change $h"
  if [ "$h" -lt "$b" ]; then echo "::error::$kind test count dropped from $b to $h."; fail=1; fi
done
if git diff "$base" HEAD -- web/tests tools/tests |
   grep -E '^\+.*(\.(skip|only|todo)\(|\{ *(skip|only|todo): *true|pytest\.mark\.(skip|xfail))'; then
  echo "::error::A test was marked skip/only/todo."; fail=1
fi
exit $fail
