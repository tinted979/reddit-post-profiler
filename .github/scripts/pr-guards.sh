#!/usr/bin/env bash
# Guards for PRs from claude/* branches: agents' and interactive Claude sessions' alike. Each
# can be waived only by an ack: label that the repository owner applied, which re-runs this.
set -uo pipefail
: "${PR:?}" "${HEAD_REF:?}" "${OWNER:?}" "${GITHUB_REPOSITORY:?}"
case "$HEAD_REF" in claude/*) ;; *) echo "Not a claude/* branch; skipping."; exit 0 ;; esac

base=HEAD^1   # the checkout is the PR's merge commit; its first parent is main
changed=$(git diff --name-only "$base" HEAD)
fail=0

owner_ack() {   # true if label $1 is on the PR and the owner was the last to add it
  gh pr view "$PR" --json labels --jq '.labels[].name' | grep -qx "$1" &&
    gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/events" \
      --jq ".[] | select(.event == \"labeled\" and .label.name == \"$1\") | .actor.login" |
    tail -n 1 | grep -qx "$OWNER"
}

if grep -qE '^(\.github/|\.claude/|CLAUDE\.md$|web/hyparquet\.js$|tools/r2-cors\.json$)' <<<"$changed"; then
  owner_ack ack:sensitive ||
    { echo "::error::This PR changes agent rules, CI or deploy config. Read those files line by line, then add ack:sensitive."; fail=1; }
fi

lines=$(git diff --numstat "$base" HEAD -- . ':!web/tests/fixtures' | awk '{s += $1 + $2} END {print s + 0}')
if [ "$lines" -gt 600 ]; then
  owner_ack ack:large || { echo "::error::$lines changed lines. Split the PR, or add ack:large."; fail=1; }
fi

if ! bash "$(dirname "$0")/test-integrity.sh" "$base"; then
  owner_ack ack:tests || { echo "::error::Tests were removed or skipped. If that's intended, add ack:tests."; fail=1; }
fi
exit $fail
