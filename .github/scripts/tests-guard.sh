#!/usr/bin/env bash
# Fails if a PR removes tests or adds skip/only/todo markers (test-integrity.sh), unless the
# owner added ack:tests. It checks the label first, because counting the tests runs the PR's
# own code (npm ci, node --test, pytest), and that code could tamper with anything this job
# does afterwards. So checks.yml runs this last, after pr-guards.sh has given its verdict; its
# own result is only as trustworthy as the PR's code. Needs PR, OWNER, GITHUB_REPOSITORY.
set -uo pipefail
here=$(dirname "$0")
if bash "$here/owner-ack.sh" ack:tests; then
  echo "The owner added ack:tests, so test removals and skips are accepted."
  exit 0
fi
bash "$here/test-integrity.sh" "${1:-HEAD^1}"
case $? in
  0) exit 0 ;;
  1) echo "::error::Tests were removed or skipped. If that's intended, add ack:tests."; exit 1 ;;
  *) echo "::error::The tests couldn't be counted (see above). ack:tests doesn't waive this; re-run the job."; exit 1 ;;
esac
