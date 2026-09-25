#!/usr/bin/env bash
# Guards for every PR. CI runs the base branch's copy of this script (checks.yml), so a PR
# can't loosen the guards on itself.
#
# Agent work is any PR opened by, or with a commit written by, someone other than the owner
# (the Claude App's writers, Copilot); Dependabot's action bumps are treated as the owner's.
# It's judged by authorship, not branch name, because an agent can choose any branch name.
# Agent work may never change agent rules, CI or deploy config (nothing waives that; the owner
# applies any Grounding text by hand), and changes to existing tests need ack:tests. The path
# hook only stops an agent's Edit/Write tools; code an agent runs (a test file it wrote) could
# still change those files, so this is the check that holds. Other checks can be waived only
# by an ack: label the owner added, which re-runs this.
set -uo pipefail
: "${PR:?}" "${OWNER:?}" "${GITHUB_REPOSITORY:?}"

base=HEAD^1   # the checkout is the PR's merge commit; its first parent is main
changed=$(git diff --name-only "$base" HEAD)
fail=0

authors=$(gh pr view "$PR" --json author,commits --jq '.author.login, (.commits[].authors[0].login)') ||
  { echo "::error::Couldn't read the PR's authors."; exit 1; }
agents=$(grep -vxE "$OWNER|(app/)?dependabot(\[bot\])?" <<<"$authors" | sort -u)
if [ -n "$agents" ]; then
  echo "Agent work: written in part by $(paste -sd, - <<<"$agents")."
fi

owner_ack() {   # true if label $1 is on the PR and the owner was the last to add it
  gh pr view "$PR" --json labels --jq '.labels[].name' | grep -qx "$1" &&
    gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/events" \
      --jq ".[] | select(.event == \"labeled\" and .label.name == \"$1\") | .actor.login" |
    tail -n 1 | grep -qx "$OWNER"
}

protected=$(grep -iE '^(\.github/|\.claude/|CLAUDE\.md$|web/hyparquet\.js$|tools/r2-cors\.json$)' <<<"$changed")
if [ -n "$protected" ]; then
  if [ -n "$agents" ]; then
    echo "::error::Agent work changed files only a human may change; no label waives this. Close the PR, or make the change yourself on another branch:"
    while read -r f; do echo "  $f"; done <<<"$protected"
    fail=1
  else
    owner_ack ack:sensitive ||
      { echo "::error::This PR changes agent rules, CI or deploy config. Read those files line by line, then add ack:sensitive."; fail=1; }
  fi
fi

# Agents may add tests but not change or delete existing ones (the refactorer's hook enforces
# it for its Edit tool only), so any such change in agent work needs the owner's look.
if [ -n "$agents" ]; then
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
