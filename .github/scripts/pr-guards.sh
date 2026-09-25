#!/usr/bin/env bash
# Guards for PRs from claude/* branches: agents' and interactive Claude sessions' alike. CI runs
# the base branch's copy of this script (checks.yml), so a PR can't loosen the guards on itself.
#
# Writer branches (claude/<issue>-<slug>, pushed by agent-write.yml) may never change agent
# rules, CI or deploy config: nothing waives that, and the owner applies any Grounding text by
# hand. The path hook only stops an agent's Edit/Write tools; code an agent runs (a test file
# it wrote) could still change those files, so this is the check that holds. Other checks can
# be waived only by an ack: label the repository owner added, which re-runs this.
set -uo pipefail
: "${PR:?}" "${HEAD_REF:?}" "${OWNER:?}" "${GITHUB_REPOSITORY:?}"
case "$HEAD_REF" in claude/*) ;; *) echo "Not a claude/* branch; skipping."; exit 0 ;; esac
writer=0
case "$HEAD_REF" in claude/[0-9]*-*) writer=1 ;; esac

base=HEAD^1   # the checkout is the PR's merge commit; its first parent is main
changed=$(git diff --name-only "$base" HEAD)
fail=0

owner_ack() {   # true if label $1 is on the PR and the owner was the last to add it
  gh pr view "$PR" --json labels --jq '.labels[].name' | grep -qx "$1" &&
    gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/events" \
      --jq ".[] | select(.event == \"labeled\" and .label.name == \"$1\") | .actor.login" |
    tail -n 1 | grep -qx "$OWNER"
}

protected=$(grep -iE '^(\.github/|\.claude/|CLAUDE\.md$|web/hyparquet\.js$|tools/r2-cors\.json$)' <<<"$changed")
if [ -n "$protected" ]; then
  if [ "$writer" = 1 ]; then
    echo "::error::An agent branch changed files only a human may change; no label waives this. Close the PR, or apply the change yourself on another branch:"
    while read -r f; do echo "  $f"; done <<<"$protected"
    fail=1
  else
    owner_ack ack:sensitive ||
      { echo "::error::This PR changes agent rules, CI or deploy config. Read those files line by line, then add ack:sensitive."; fail=1; }
  fi
fi

# Agents may add tests but not change or delete existing ones (a refactorer's hook enforces
# it for its Edit tool only), so on a writer branch any such change needs the owner's look.
if [ "$writer" = 1 ]; then
  touched=$(git diff --name-only --diff-filter=MDR "$base" HEAD -- web/tests tools/tests)
  if [ -n "$touched" ]; then
    owner_ack ack:tests || {
      echo "::error::This agent PR changes or deletes existing tests. Check no assertion got weaker, then add ack:tests:"
      while read -r f; do echo "  $f"; done <<<"$touched"
      fail=1
    }
  fi
fi

lines=$(git diff --numstat "$base" HEAD -- . ':!web/tests/fixtures' | awk '{s += $1 + $2} END {print s + 0}')
if [ "$lines" -gt 600 ]; then
  owner_ack ack:large || { echo "::error::$lines changed lines. Split the PR, or add ack:large."; fail=1; }
fi

bash "$(dirname "$0")/test-integrity.sh" "$base"
case $? in
  0) ;;
  1) owner_ack ack:tests || { echo "::error::Tests were removed or skipped. If that's intended, add ack:tests."; fail=1; } ;;
  *) echo "::error::The tests couldn't be counted (see above). ack:tests doesn't waive this; re-run the job."; fail=1 ;;
esac
exit $fail
