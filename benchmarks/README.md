# Benchmarks

Performance suite for viborm's hot paths, run with vitest's built-in
benchmark runner (tinybench: warmup, mean/p75/p99, relative comparison).

## Suites

- **`e2e-overhead.bench.ts`** — the headline metric. Full client operations vs
  the equivalent raw SQL string on the same in-memory SQLite database. The
  database work is identical, so the gap between each pair is viborm's total
  per-query overhead (validation + query building + result parsing). Goal:
  ratios as close to 1.00x as possible.
- **`query-engine.bench.ts`** — `engine.build()` (args → SQL + params) per
  operation shape, with a hand-written SQL string as the floor.
- **`relation-read-overhead.bench.ts`** — one relation read split into exact
  prepared-SQL execution, prepared result parsing, preparation, and the full
  client operation. Raw and VibORM execute the same SQL and parameters.
- **`relation-read-memory.mjs`** — V8 allocation sampling plus forced-GC
  retained-heap checks for the same relation read. Build the package, then run
  `node --expose-gc benchmarks/relation-read-memory.mjs`. Set
  `VIBORM_RELATION_ROWS=1000` or `10000` to measure large result sets with an
  iteration count scaled to the returned row count. Set
  `VIBORM_FIRST_OPERATION_RETAINED_ONLY=1` for the first operation after the
  initialized client and add
  `VIBORM_FIRST_OPERATION_RETAINED_WORKLOAD=raw` for its raw-driver control.
- **`validation.bench.ts`** — the validation engine vs valibot, zod, and
  arktype through the StandardSchema interface (all JIT-less, matching edge
  runtimes).
- **`cold-start.bench.ts`** — schema definition + `createClient` cost, paid
  once per serverless isolate.
- **`drizzle.bench.ts`** — viborm vs drizzle vs raw on identical schema, data,
  and queries (three in-memory SQLite databases). Note drizzle's
  better-sqlite3 driver is synchronous; viborm pays for a fully async one.
- **`drizzle-memory-cpu.mjs`** — allocated bytes/op (V8 heap sampling), CPU
  µs/op, and ops/sec for the same viborm/drizzle/raw query shapes. Build the
  package, then run `node benchmarks/drizzle-memory-cpu.mjs`. This legacy
  same-process script is exploratory and invalid for keep decisions; use the
  fresh-process operation-pipeline coordinator for evidence.
- **`operation-pipeline-catalog.mjs`** — the immutable single owner of the
  Phase 0 workload/stage matrix.
- **`operation-pipeline-fixtures.mjs`** — fresh databases and immutable seed
  data for each worker.
- **`operation-pipeline-{read,mutation,batch}-workloads.mjs`** — concern-owned
  workload families, composed by `operation-pipeline-workloads.mjs`.
- **`operation-pipeline-worker.mjs`** — measures one catalog stage and mode in
  one fresh process; invoke it through the coordinator, not directly.
- **`operation-pipeline-compare.mjs`** — compares explicit clean baseline and
  candidate worktrees. It runs five fresh child processes per checkout and
  target, alternates checkout order, separates allocation, aggregate CPU, and
  retained-heap modes, and reports median, MAD, min, max, bytes per operation,
  and bytes per returned row.
- **`operation-pipeline-provider-fixtures.mjs`** — provider adapters for the
  generated `provider-*` workload matrix. The provider catalog remains
  exhaustive when a runtime or service leg cannot execute: unavailable legs
  produce a report entry with `status: "skipped"` and an exact reason.

The operation-pipeline catalog distinguishes row cardinality from construction
width. `wide-scalar-select-{1,20,100}` selects that exact number of scalar
fields from one row; `wide-scalar-predicates-10` emits ten scalar predicates;
and `wide-{create,update}-{1,20}` writes that exact number of scalar fields.
`relation-projection-{2,20,100}-depth-{1,2,3}` is the complete adapter JSON
projection matrix: each relation object has exactly the named total field width
at each level of the named relation depth. A non-terminal object's nested
relation key occupies one of those fields. Every width/depth workload records
these dimensions in `witness.workloadShape`, beside its exact SQL and
parameters, so a row-count workload cannot pose as a width proof.

The cross-provider matrix generates identity-only and mixed-scalar reads at
1/20/1,000/10,000 rows, a 100-column read, fixed and variant nested reads,
aggregate, scalar-count, and relation-count reads, one returning write, and
direct, prepared, callback-transaction, fallback-batch, and native-batch
execution forms. Fixture capabilities are explicit: an unsupported form is a
visible capability skip, never a substitute query.
Every workload exposes `provider-execute` (the direct provider method),
`driver-wrapper` (the normalized VibORM wrapper), `unowned-parse` against one
immutable reusable fixture, `provider-parse`, and the complete public `full`
operation. The unowned label is deliberate: repeated parsing of an immutable
fixture measures the public borrowed-row contract. Provider-row ownership and
positional transport were measured and rejected; production does not retain an
owned-row fast path.

The provider dimension catalogs `sqlite3`, `bun-sqlite`, `libsql`, `pglite`,
`pg`, `postgres.js`, `bun-sql`, `mysql2`, `planetscale`, `neon-http`, and `d1`.
SQLite3, local libSQL, and PGlite use fresh in-process databases. PlanetScale
uses a deterministic decoded SDK-result fixture; that seam exposes no transport
byte count, so none is invented. Neon uses a deterministic SDK fetch body and
labels it `deterministic-fetch-body`. PostgreSQL and MySQL2 need
`VIBORM_BENCH_PG_URL`,
`VIBORM_BENCH_POSTGRES_JS_URL`, or `VIBORM_BENCH_MYSQL2_URL`, each pointing at a
disposable benchmark database. Bun SQL additionally needs
`VIBORM_BENCH_BUN_SQL_URL`. The coordinator selects Bun when it is installed;
Bun allocation mode stays a visible skip because the V8 inspector sampler is
not available there. The D1 Workers substrate remains a visible skip until its
deterministic local binding runner exists. No Node substitute is reported as
Bun or Workers evidence. Every catalog shape uses the same schema, seed, public
operation, and raw-result builders across local, service, and deterministic
HTTP fixtures.

Current result-transport keep evidence covers SQLite3 and PGlite only. Other
providers are correctness fixtures, capability skips, or deferred performance
work. PlanetScale starts from a decoded SDK-result fixture, so it cannot prove
wire transport, SDK decode allocation, or response-byte savings. D1 has no
executable benchmark runner and must remain a visible skip.

Retained mode reports signed retained and released heap deltas because a
forced-GC delta can be negative. Negative values are diagnostic, not negative
memory consumption. Regression gating uses total `peakRssBytes`, not only
growth from one process-local starting point.

Bundle footprint is tracked separately by `pnpm size` (size-limit).

## Workflow

```sh
pnpm bench              # run everything, compare within each group
pnpm bench:baseline     # save results to benchmarks/baseline.json (gitignored)
# ...make changes...
pnpm bench:compare      # re-run, show per-bench delta vs the saved baseline
```

Before optimizing: save a baseline. After: compare. Treat >10% regression on
any e2e pair as a blocker; micro-benches are noisier, look at the trend.

Run on AC power, close heavy apps; rme > ~5% means re-run before trusting a
small delta.

## Reproducible operation-pipeline comparison

First make a Phase-0-only commit containing the corrected harness. Prepare that
commit and the candidate commit in two separate, clean worktrees with the same
lockfile. The coordinator deletes ignored `dist` output, rebuilds each checkout
sequentially, rechecks commit and clean state, then refuses differing protocol
hashes, catalogs, or lockfiles for the original catalog. The running coordinator
and both worktrees must share one Git common directory, so one repository-wide
test lock covers them.
The commit-bound protocol identity includes that shared lock script itself.
For generated `provider-*` workloads, the committed coordinator owns the protocol
and dynamically loads each checkout's built package. This permits the fixed
`52eef9ebfc710407e1e5fe6042e2ed5a11adf19e` runtime baseline to use the new
measurement surface without rewriting that historical worktree.

```sh
# Run the complete checked-in matrix. Both SHA arguments must contain all 40
# hexadecimal characters.
pnpm bench:operation-pipeline \
  --baseline-dir /absolute/path/to/baseline \
  --baseline-commit <full-baseline-sha> \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --output /absolute/path/to/report.json

# Measure only the stage owned by one optimization.
pnpm bench:operation-pipeline \
  --baseline-dir /absolute/path/to/baseline \
  --baseline-commit <full-baseline-sha> \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --workloads scalar-find-unique,fixed-singular-rowref-20 \
  --stages prepare,full \
  --modes alloc,cpu \
  --target scalar-find-unique/prepare/cpu/cpuMicrosecondsPerOperation \
  --target fixed-singular-rowref-20/prepare/alloc/allocatedBytesPerOperation

# Cross-provider surface. Its baseline is fixed to the exact Phase-0 commit.
pnpm bench:operation-pipeline \
  --baseline-dir /absolute/path/to/52eef9eb-baseline \
  --baseline-commit 52eef9ebfc710407e1e5fe6042e2ed5a11adf19e \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --providers sqlite3,libsql,pglite,planetscale \
  --workloads provider-identity-1,provider-mixed-scalar-20 \
  --stages provider-execute,driver-wrapper,unowned-parse,provider-parse,full \
  --modes alloc,cpu,retained \
  --target sqlite3/provider-mixed-scalar-20/driver-wrapper/cpu/cpuMicrosecondsPerOperation \
  --output /absolute/path/to/provider-report.json

# Infrastructure check only. One short replicate; never valid as performance
# evidence.
pnpm bench:operation-pipeline --smoke \
  --baseline-dir /absolute/path/to/baseline \
  --baseline-commit <full-baseline-sha> \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --workloads scalar-find-unique --stages prepare --modes cpu
```

Every worker records its exact commit, branch, clean status, Node and V8
versions, platform, architecture, OS, CPU, lockfile SHA-256, iteration counts,
sampling interval, row cardinality, stage sync/async truth, a complete
deterministic semantic digest, a cheap timed checksum, and the exact prepared
SQL, parameters, and statement count when the preparation seam exposes them.
The coordinator rejects semantic, SQL, protocol-field, lockfile, protocol, or
runtime mismatches. Custom iteration or warmup counts remain useful diagnostics
but invalidate keep evidence. A normal report without at least one repeatable
`--target provider/workload/stage/mode/metric` contract remains valid
measurement, but
is not keep-eligible. Every declared target must improve by more than 2×MAD;
non-target noise cannot grant eligibility. Each targeted workload must also
include both its full/allocation and full/CPU evidence pairs. Any significant
measured regression or a full-operation regression above 10% blocks the keep
gate.
The allocation sampler uses 4,096 bytes. Mutation databases are new for every
worker process, so baseline and candidate start every replicate from equal
table and index state.

Allocation mode reports sampled bytes per operation and returned row. CPU mode
reports aggregate CPU and wall microseconds per operation. Retained mode takes
its pre-run sample after two forced collections, records heap immediately after
the timed loop, forces two more collections, then reports retained and released
heap per operation and row. It also reports the fresh process's peak RSS and
peak-RSS growth during the measured interval. Peak RSS is a process-lifetime
high-water mark, not a heap-retention alias. Provider response bytes are present
only when the fixture can count a real or explicitly labelled deterministic
payload; unavailable transport byte counts are omitted rather than estimated.

The coordinator does not create, clean, or install a worktree. Dependency
installation remains an explicit setup step; package rebuilding is deliberately
owned by the coordinator so stale ignored output cannot become evidence.

Composed relation and generated-reference writes currently expose no real
plan-only seam from the built package: `prepare()` declines them and
`prepareBatch()` rejects their postconditions. Their catalog entries therefore
measure only the full operation. No constant or fabricated prepare result is
reported. This includes `variant-row-storage-create-many-100`, which uses the
public `comment.createMany` spelling with 100 alternating article/clip targets
and verifies every persisted row-held target outside timing.

Run `pnpm bench:operation-pipeline:check` for the keep-gate falsifiers and
`pnpm bench:operation-pipeline:describe` to inspect the catalog and commit-bound
protocol identity without starting measurements.
