#!/usr/bin/env bash
# Fails if a change removes tests or adds skip/only/todo markers, compared with its base.
# Usage: test-integrity.sh [BASE]   (default HEAD^1: on a pull_request checkout, HEAD is the
# merge commit and its first parent is main). Run from the repository root.
# Exits 1 if tests were removed or skipped, and 2 if it couldn't count them (a checkout, npm ci
# or uv failure), so a setup problem never passes for a change in the tests.
set -uo pipefail
base="${1:-HEAD^1}"
tmp=$(mktemp -d)
trap 'git worktree remove --force "$tmp/base" >/dev/null 2>&1; rm -rf "$tmp"' EXIT
git worktree add --detach "$tmp/base" "$base" >/dev/null 2>&1 || { echo "::error::can't check out $base"; exit 2; }

# Each count installs what its tests need first, and fails (rather than coming out low) if
# that doesn't work: without fake-indexeddb the IndexedDB test file fails to load, and the
# count would drop. A failing test still counts; checks / test reports failures. NODE_TEST_CONTEXT
# is unset so a run inside node --test (this script's own tests) still reports TAP.
PY_DEPS=(--with "duckdb>=1.1,<2" --with pytest)
count() {   # count KIND DIR: how many node or py tests DIR has
  case "$1" in
    node)
      (cd "$2/web" && npm ci --silent --no-audit --no-fund >/dev/null 2>&1) ||
        { echo "::error::npm ci failed in $2/web, so its tests can't be counted." >&2; return 1; }
      (cd "$2/web" && { env -u NODE_TEST_CONTEXT node --test --test-reporter=tap 2>/dev/null || true; }) |
        awk '/^# tests /{n=$3} END{print n+0}' ;;
    py)
      (cd "$2" && uv run -q "${PY_DEPS[@]}" python -c "import duckdb, pytest" >/dev/null 2>&1) ||
        { echo "::error::uv couldn't set up the Python tests in $2, so they can't be counted." >&2; return 1; }
      (cd "$2" && { uv run -q "${PY_DEPS[@]}" pytest tools --collect-only -q 2>/dev/null || true; }) |
        awk '/tests? collected/{n=$1} END{print n+0}' ;;
  esac
}

fail=0
for kind in node py; do
  b=$(count "$kind" "$tmp/base") && h=$(count "$kind" .) || exit 2
  echo "$kind tests: base $b, this change $h"
  if [ "$h" -lt "$b" ]; then echo "::error::$kind test count dropped from $b to $h."; fail=1; fi
done
if git diff "$base" HEAD -- web/tests tools/tests |
   grep -E '^\+.*(\.(skip|only|todo)\(|\{ *(skip|only|todo): *true|pytest\.mark\.(skip|xfail))'; then
  echo "::error::A test was marked skip/only/todo."; fail=1
fi
exit $fail
