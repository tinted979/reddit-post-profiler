#!/usr/bin/env bash
# owner-ack.sh LABEL: succeeds if LABEL is on the PR and the repository owner was the last to
# add it, so no token or bot can waive a check by adding the label itself.
set -uo pipefail
: "${1:?label}" "${PR:?}" "${OWNER:?}" "${GITHUB_REPOSITORY:?}"
gh pr view "$PR" --json labels --jq '.labels[].name' | grep -qx "$1" &&
  gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/events" \
    --jq ".[] | select(.event == \"labeled\" and .label.name == \"$1\") | .actor.login" |
  tail -n 1 | grep -qx "$OWNER"
