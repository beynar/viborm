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

---

# P5 — the default flip A/B (V1 runtime vs V2 engine, same process)

Method: `benchmarks/p5-flip-ab.bench.ts`. The `queryEngine: "v1" | "v2"` escape
hatch runs identical workloads through the frozen V1 runtime and the flipped V2
engine on two in-memory SQLite databases seeded identically (200 rows), one
process. Ratios are **V1 hz / V2 hz** (>1 means V2 is *slower*). Single run,
rme ±2–5%; the write ratios are far outside noise and mechanistically explained.

| Operation | V1 hz | V2 hz | V1/V2 | Verdict |
|---|---|---|---|---|
| findMany (take 50) | 14,455 | 12,710 | 1.14× | V2 −12% (regression) |
| findUnique | 59,716 | 47,311 | 1.26× | V2 −21% (regression) |
| updateMany | 36,116 | 29,902 | 1.21× | V2 −17% (regression) |
| upsert (update branch) | 33,913 | 18,401 | **1.84×** | V2 −46% (regression) |
| scalar update | 49,953 | 21,118 | **2.37×** | V2 −58% (regression) |

**All five exceed the ±10% gate — recorded as P5 conflicts, not parity.**

**Named suspect: V2's plan-then-execute issues extra statements/round-trips.**
On a returning driver V1 folds a scalar update into one `UPDATE … RETURNING`;
V2's `UpdateOperation` always plans a `SELECT … FOR UPDATE` locate, then the
`UPDATE`, then a terminal `SELECT` refetch — three statements where V1 runs one,
which on in-memory SQLite tracks the ~2.37× wall-clock gap almost exactly.
`upsert` pays the same locate+mutate+refetch tax (1.84×). Reads regress a
smaller, fixed amount (12–26%) from per-call routing/construction overhead
(`PendingOperation.createRouted` → `constructRoutedOperation` builds a fresh V2
operation object and compiles its fragment on every call, where V1's prepared
path is lighter).

This is architectural, not a bug: the atom model's "plan reads, then execute a
linear fragment" is inherently more statements than V1's `RETURNING`-folded
mutation. Closing it means teaching V2 to fold the locate/terminal into the
mutation on returning drivers (a `RETURNING` fast path) — real work, out of P5's
soak scope. **Until then the default-ON flip carries a measured write-path
regression; this is a blocking conflict for declaring the flip production-clean,
recorded honestly here rather than smoothed over.**
