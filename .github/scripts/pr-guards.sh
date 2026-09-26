#!/usr/bin/env bash
# Guards for every PR. CI runs the base branch's copy of this script (checks.yml), so a PR
# can't loosen the guards on itself. It never runs the PR's code (only git and gh), so nothing
# in the PR can tamper with its verdict; checks.yml runs it before anything that does
# (tests-guard.sh, which counts the tests).
#
# Agent work is any PR opened by, or with a commit written by, someone other than the owner
# (the writer app's agents, Copilot); Dependabot's action bumps are treated as the owner's.
# It's judged by authorship, not branch name, because an agent can choose any branch name.
# Agent work may never change agent rules, CI or deploy config (nothing waives that; the owner
# applies any Grounding text by hand), and changes to existing tests need ack:tests. The path
# hook only stops an agent's Edit/Write tools; code an agent runs (a test file it wrote) could
# still change those files, so this is the check that holds. Other checks can be waived only
# by an ack: label the owner added, which re-runs this.
set -uo pipefail
: "${PR:?}" "${OWNER:?}" "${GITHUB_REPOSITORY:?}"

base=HEAD^1   # the checkout is the PR's merge commit; its first parent is main
# --no-renames: a move lists both paths, so moving a file out of a protected folder still counts.
changed=$(git diff --name-only --no-renames "$base" HEAD)
fail=0

# Commit authors are whatever the committer wrote, so this fails closed: a login that isn't
# exactly the owner's or Dependabot's, including none (an unlinked email), is agent work, and
# so is a PR with more commits than gh lists (100). Forged authorship can't make agent commits
# pass as the owner's or Dependabot's, because agents can't push to those branches at all: the
# "branches: owner only" ruleset lets only the owner (and Dependabot, on its own branches)
# update any branch but main and claude/<number>-…, the agents' own, whose PRs the writer app
# opens, and a PR's author can't be forged.
authors=$(gh pr view "$PR" --json author,commits --jq '
  (.author.login, (.commits[].authors[0].login), (if (.commits | length) >= 100 then "(too many commits to check)" else empty end))
  | if . == null or . == "" then "(unlinked)" else . end') ||
  { echo "::error::Couldn't read the PR's authors."; exit 1; }
agents=$(grep -vxE "$OWNER|(app/)?dependabot(\[bot\])?" <<<"$authors" | sort -u)
if [ -n "$agents" ]; then
  echo "Agent work: written in part by $(paste -sd, - <<<"$agents")."
fi

owner_ack() { bash "$(dirname "$0")/owner-ack.sh" "$1"; }

protected=$(grep -iE '^(\.github/|\.claude/|CLAUDE\.md$|web/hyparquet\.js$|tools/r2-cors\.json$|tools/publish_build\.sh$)' <<<"$changed")
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
# it for its Edit tool only), nor touch what decides which tests run (web/package.json's test
# script, pytest's config and conftest files, even new ones). Any of that in agent work needs
# the owner's look.
if [ -n "$agents" ]; then
  touched=$( {
    git diff --name-only --no-renames --diff-filter=MD "$base" HEAD -- web/tests tools/tests
    git diff --name-only --no-renames "$base" HEAD -- web/package.json web/.nvmrc \
      ':(glob)**/conftest.py' ':(glob)**/pytest.ini' ':(glob)**/pyproject.toml' ':(glob)**/setup.cfg' ':(glob)**/tox.ini'
  } | sort -u)
  if [ -n "$touched" ]; then
    owner_ack ack:tests || {
      echo "::error::This agent PR changes existing tests or what decides which tests run. Check no assertion got weaker and nothing stopped running, then add ack:tests:"
      while read -r f; do echo "  $f"; done <<<"$touched"
      fail=1
    }
  fi
fi

lines=$(git diff --numstat "$base" HEAD -- . ':!web/tests/fixtures' | awk '{s += $1 + $2} END {print s + 0}')
if [ "$lines" -gt 600 ]; then
  owner_ack ack:large || { echo "::error::$lines changed lines. Split the PR, or add ack:large."; fail=1; }
fi
exit $fail
