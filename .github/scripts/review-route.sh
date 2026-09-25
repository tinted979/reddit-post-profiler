#!/usr/bin/env bash
# Picks which AI reviewers a PR gets, as a JSON array for agent-review.yml's matrix.
# Usage: review-route.sh FILES ADDED DIFF
#   FILES: the PR's changed paths, one per line; ADDED: the paths it adds; DIFF: its unified diff.
#   ACTION (env): the pull_request event's action; LABEL (env): the label added, if `labeled`.
# The workflow then drops any role whose agent file isn't on the base branch yet.
set -uo pipefail
files=$(cat "$1"); added=$(cat "$2"); diff_file=$3

if [ "${ACTION:-}" = labeled ]; then
  # A review:<role> label runs (or re-runs) that one reviewer, and nothing else does.
  case "${LABEL:-}" in
    review:pr-reviewer|review:architecture-reviewer|review:security-reviewer|review:perf-auditor)
      echo "[\"${LABEL#review:}\"]" ;;
    *) echo '[]' ;;
  esac
  exit 0
fi

# README-only and plan-only PRs get no AI review unless the owner asks with a label.
if ! grep -qvE '^(README\.md$|docs/history/)' <<<"$files"; then echo '[]'; exit 0; fi

roles='["pr-reviewer"'
# Security: CI, agent config, deploy and archive scripts, the CORS policy, the page shell.
if grep -qE '^(\.github/|\.claude/|tools/.*\.sh$|tools/r2-cors\.json$|web/index\.html$)' <<<"$files"; then
  roles+=',"security-reviewer"'
fi
# Architecture: the grounding docs, a new module in web/, or a storage schema change.
if grep -qE '^(CLAUDE\.md$|WORKFLOW\.md$|docs/adr/)' <<<"$files" ||
   grep -qE '^web/[^/]+$' <<<"$added" ||
   grep -qE '^[+-].*\b(DB_VERSION|STORES)\b' "$diff_file"; then
  roles+=',"architecture-reviewer"'
fi
echo "$roles]"
