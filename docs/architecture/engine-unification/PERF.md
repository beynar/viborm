# Engine unification — performance record

Method: `pnpm bench:baseline` at the pre-unification anchor `2fa49b6` (git
worktree, identical machine/session), then `pnpm bench:compare` at the
post-unification HEAD (`5906097` + `benchmarks/nested-write.bench.ts`, which
was injected identically into both trees). Ratios are HEAD hz / baseline hz
(higher is better). All runs on in-memory better-sqlite3 unless noted.

## Nested-write path (the code the unification replaced)

| Scenario | Baseline (dual engines) | HEAD (interpreter) | Ratio |
|---|---|---|---|
| create + 2 nested child creates | 19,895 hz | 19,968 hz | 1.00× |
| create + connect existing child | 31,506 hz | 31,454 hz | 1.00× |
| update + nested child create | ~16,4k hz | 18,402 hz | **1.12× faster** |
| update + set (replace membership) | 837 hz | 827 hz | 0.99× (noise) |
| nested to-many upsert (update branch) | 13,822 hz | 16,113 hz | **1.17× faster** |
| connectOrCreate (existing branch) | 16,828 hz | 22,108 hz | **1.31× faster** |

**No performance loss on the rebuilt path.** Creates and set are at parity
(within run noise); the read-driven kinds (update/upsert/connectOrCreate)
got 12–31% faster — consistent with the interpreter's single flat atomic
scope and consolidated record access replacing the old tx engine's
per-step refetches.

## Unchanged paths (regression guard)

e2e read/insert, findMany+include, query building, and validation all sit
at 0.98–1.07× — noise-level parity. The viborm-vs-drizzle and vs-raw
ratios are unchanged from the baseline run.

## The one real cost

`define schema + createClient` (cold-start bench): 118,367 → 101,964 hz =
**0.86× (~+1.4 µs per client instantiation)**, rme ±6–8% so borderline but
plausibly real — the interpreter/mode module surface adds import-time
weight. Absolute cost is ~1.4 µs per serverless isolate; recorded here
rather than optimized, revisit only if cold-start budgets ever tighten.

Baseline JSON is a machine-local artifact (`benchmarks/baseline.json`,
untracked); regenerate with `pnpm bench:baseline` before comparing future
changes.
