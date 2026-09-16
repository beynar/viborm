#!/bin/zsh
export PATH="/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin:$PATH"
O=/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/support-rerun
# source-cost in lane 5 (its git status is small; src/ identity-equal to the main tree)
( cd /private/tmp/viborm-g4-lane-5 && TMPDIR=/private/tmp/viborm-g4-lane-tmp-5 node scripts/measure-raptor3-baseline.mjs --output "$O/source-cost.json" > "$O/source-cost.log" 2>&1; echo "source-cost exit=$? $(date '+%H:%M:%S')" >> "$O/RUN.log" ) &
# cli self-test in the main tree (its lock), quiet machine
( cd /Users/arnaud/code/viborm && node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs > "$O/cli-selftest.log" 2>&1; echo "cli-selftest exit=$? $(date '+%H:%M:%S')" >> "$O/RUN.log" ) &
wait; echo "=== done $(date '+%H:%M:%S')" >> "$O/RUN.log"
