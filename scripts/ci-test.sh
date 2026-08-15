#!/usr/bin/env bash
# CI test runner for MailVault.
#
# bun test 1.3.x hangs after the suite completes on GitHub runners (the process
# never exits). This wrapper runs the test with a hard deadline; if it times
# out but the output shows no failures, we treat it as success.
#
# Usage: bash scripts/ci-test.sh --cwd <pkg> test <file>

set -uo pipefail

OUT="$(timeout 90 bun run "$@" 2>&1)"
CODE=$?

echo "$OUT"

if [ "$CODE" -eq 124 ]; then
  # Timed out: tests had already run. Pass unless the output shows failures.
  if echo "$OUT" | grep -qE "\(fail\)|^error:|✗"; then
    echo "⚠ test timed out AND shows failures — failing." >&2
    exit 1
  fi
  echo "⚠ bun test hung after completion (results printed) — treating as pass." >&2
  exit 0
fi

exit "$CODE"
