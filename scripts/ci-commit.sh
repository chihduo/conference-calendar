#!/usr/bin/env bash
# Commit data/ and push, surviving a main that moved while the job ran.
#
# Three jobs write to this repo (nightly refresh, issue-driven add, and a human),
# so losing a push race is routine rather than exceptional. Failing the run would
# throw away several minutes of fetching for no reason.
#
#   scripts/ci-commit.sh "commit message"
set -euo pipefail
MSG="${1:?usage: ci-commit.sh <message>}"

git config user.name  'deadline-bot'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

git add data/
if git diff --staged --quiet; then echo 'No changes.'; exit 0; fi
git commit -q -m "$MSG"

for attempt in 1 2 3; do
  if git pull --rebase -q origin main 2>/dev/null; then
    if git push -q origin HEAD:main 2>/dev/null; then
      echo "pushed on attempt $attempt"; exit 0
    fi
  elif git status --porcelain | grep -q '^UU data/_review_queue.json'; then
    # The review queue is regenerated, not merged: every writer rewrites it
    # wholesale, so replaying ours on top is the correct resolution rather than
    # a convenient one. Conference files conflicting is a real conflict and
    # deliberately still aborts.
    echo 'review queue conflicted; keeping the replayed copy'
    git checkout --theirs data/_review_queue.json
    git add data/_review_queue.json
    GIT_EDITOR=true git rebase --continue >/dev/null
    if git push -q origin HEAD:main 2>/dev/null; then
      echo "pushed on attempt $attempt"; exit 0
    fi
  else
    git rebase --abort 2>/dev/null || true
  fi
  echo "push race lost, retrying ($attempt/3)"
  sleep $((attempt * 5))
done

echo '::error::could not push after 3 attempts'
exit 1
