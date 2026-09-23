# Final-review recursive placement red

The existing repeated-occurrence owner gained one bounded SQLite witness. One
shared enclosing `RecordCommand` contains a selected-series/capture pair and is
placed in both arms of one root `Choice`. The present row activates the first
arm.

The pre-repair candidate deterministically failed during real execution with
`Series capture has no occurrence target` at
`src/query-engine/raptor3/commands/commands.ts:481`. The four earlier tests in
the file passed. This isolates the source-keyed recursive replacement map: the
second arm's descendants replaced the first arm's descendant correspondence,
so the active arm's capture did not receive its local series occurrence.

Command:

```text
/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node scripts/run-vitest-safe.mjs --rss-limit-mb=1536 --wall-limit-ms=120000 run --project raptor3 tests/raptor3/core-structure/repeated-occurrence-ownership.test.ts
```

Result: 4 passed, 1 failed; 2.85 seconds wall; 499.6 MiB peak sampled RSS;
wrapper teardown verified.
