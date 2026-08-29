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
  candidate worktrees. Baseline/candidate targets run five alternating fresh
  processes per checkout; candidate-only targets run five fresh candidate
  processes. Allocation, aggregate CPU, and retained-heap modes report median,
  MAD, min, max, bytes per operation, and bytes per returned row.
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
# Run one explicit same-baseline workload set. Omitting --workloads selects the
# whole catalog and is refused because provider transport and fixed decimal use
# different evidence programs and baselines. Both SHA arguments must contain
# all 40 hexadecimal characters.
pnpm bench:operation-pipeline \
  --baseline-dir /absolute/path/to/baseline \
  --baseline-commit <full-baseline-sha> \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --workloads scalar-find-unique,scalar-find-many-20 \
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
  --target fixed-singular-rowref-20/prepare/alloc/allocatedBytesPerOperation \
  --budget sqlite3/fixed-singular-rowref-20/full/alloc/allocatedBytesPerOperation/absolute/4096

# Cross-provider surface. Its baseline is fixed to the exact Phase-0 commit.
pnpm bench:operation-pipeline \
  --baseline-dir /absolute/path/to/52eef9eb-baseline \
  --baseline-commit 52eef9ebfc710407e1e5fe6042e2ed5a11adf19e \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --providers sqlite3,libsql,pglite,planetscale \
  --workloads provider-identity-1,provider-wide-scalar-100 \
  --stages provider-execute,driver-wrapper,unowned-parse,provider-parse,full \
  --modes alloc,cpu,retained \
  --target sqlite3/provider-wide-scalar-100/driver-wrapper/cpu/cpuMicrosecondsPerOperation \
  --output /absolute/path/to/provider-report.json

# Fixed-decimal closure. The scalar control is measured baseline/candidate;
# decimal workloads run on the candidate only because the baseline has no
# fixed-decimal public API. Add mysql2 to --providers only when its disposable
# Docker URL is available.
pnpm bench:operation-pipeline \
  --baseline-dir /absolute/path/to/1d796d4e-baseline \
  --baseline-commit 1d796d4e01841becfbb2f6805668ef11d270aa0e \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --providers sqlite3,pglite \
  --workloads provider-fixed-decimal-scalar-control,provider-fixed-decimal-row-1,provider-fixed-decimal-row-1000,provider-fixed-decimal-text-row-1,provider-fixed-decimal-text-row-1000,provider-fixed-decimal-floor-1,provider-fixed-decimal-floor-1000,provider-fixed-decimal-arithmetic,provider-fixed-decimal-aggregate,provider-fixed-decimal-list \
  --stages full,decimal-construct \
  --modes alloc,cpu,retained \
  --output /absolute/path/to/fixed-decimal-report.json

# Infrastructure check only. One short replicate; never valid as performance
# evidence.
pnpm bench:operation-pipeline --smoke \
  --baseline-dir /absolute/path/to/baseline \
  --baseline-commit <full-baseline-sha> \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --workloads scalar-find-unique --stages prepare --modes cpu

# Directional extension tuning. This requires an affected workload subset,
# defaults to full/alloc+cpu, and runs two reduced-count alternating pairs.
# Its report is diagnosticOnly and can never authorize a keep.
pnpm bench:operation-pipeline:diagnostic \
  --baseline-dir /absolute/path/to/baseline \
  --baseline-commit <full-baseline-sha> \
  --candidate-dir /absolute/path/to/candidate \
  --candidate-commit <full-candidate-sha> \
  --baseline-arm unextended \
  --candidate-arm request \
  --workloads scalar-find-many-1,flat-create-explicit-id,atomic-batch-100 \
  --output /absolute/path/to/diagnostic-report.json
```

Every worker records its exact commit, branch, clean status, Node and V8
versions, platform, architecture, OS, CPU, lockfile SHA-256, iteration counts,
sampling interval, row cardinality, stage sync/async truth, a complete
deterministic semantic digest, a cheap timed checksum, and the exact prepared
SQL, parameters, and statement count when the preparation seam exposes them.
The coordinator rejects semantic, SQL, protocol-field, lockfile, protocol, or
runtime mismatches. Custom iteration or warmup counts remain useful diagnostics
but invalidate keep evidence. A normal report without at least one repeatable
`--target`, `--ceiling`, or `--budget` contract remains valid measurement, but
is not keep-eligible. Every declared target must improve by more than 2×MAD;
non-target noise cannot grant eligibility. Each targeted workload must also
include both its full/allocation and full/CPU evidence pairs. Any significant
measured regression or a full-operation regression above 10% blocks the keep
gate.

The fixed-decimal catalog marks its decimal workloads as `candidate-only`.
Each of their five fresh-process replicates executes the candidate once and is
reported under `candidateMeasurements`, with absolute allocation, CPU, wall,
retained-heap, and RSS summaries but no invented baseline delta. A candidate-
only workload cannot carry `--target`, `--ceiling`, `--budget`, or
`--row-scaling` contracts. The non-decimal
`provider-fixed-decimal-scalar-control` remains a normal alternating A/B
comparison. Its catalog-owned full allocation and framework-CPU ceilings are
3%, and each ceiling also requires the movement to remain inside 2×MAD.

Fixed-decimal eligibility has one catalog-owned evaluator, separate from the
generic budget and row-scaling CLI. At 1 and 1,000 rows it subtracts a
shape-matched `id + string` full-operation control, the measured difference
between their direct `provider-execute` legs, and a direct ORM-result `Decimal`
constructor floor from the decimal full-operation cost. The provider delta
removes only the physical INTEGER/NUMERIC-to-text work that exact transport
requires. Allocation, CPU, and wall excess must stay within both 10% of the
constructor floor and the additive MADs of all five measured arms. Released
heap keeps the original full/text/constructor formula because its retained
public-result lifetime is not comparable with an ephemeral provider result.
When the floor is zero, the percentage term is omitted. Signed retained heap
never uses a percentage and blocks only positive excess beyond the additive MAD
bound. Peak RSS and peak-RSS growth are non-additive: each compares the decimal
level with the larger control level and
uses the MAD of that same selected control. The 1→1,000 scaling check applies
the same bounds to the difference between the two excesses. Gates consume
per-operation metrics; the report includes the derived per-row values. The
constructor stage creates exactly the declared number of values through the
constructor captured from an actual ORM result, from precomputed canonical
strings. One pre-sized sink is allocated before timing and overwritten on each
run, so every constructed value remains live through the checksum without
charging a new result container to the constructor floor. It performs no
database work inside timing. Retained mode keeps every measured decimal/text public
result graph and every constructor-floor Decimal alive through its first forced
collection, then releases those references and measures their collection.
Missing or skipped fixed-decimal workloads, controls, floors, required modes,
SQLite3, or PGlite
evidence make the report ineligible, so the scalar control cannot authorize a
keep by itself. Fixed-decimal eligibility requires `full` for logical and text
operations, `provider-execute` for their allocation and CPU evidence, and
`decimal-construct` for the floor. Other internal provider/parser stages remain
optional directional evidence.

`--budget provider/workload/stage/mode/metric/absolute/max` and
`--budget provider/workload/stage/mode/metric/percent/max` are the two
discriminated forms of one allowed-overhead contract. Budgets accept only
measured `*PerOperation` metrics. An absolute cap uses the metric's native unit:
bytes for allocation, retained, released, and response-size metrics;
microseconds for CPU and wall metrics. A percentage cap compares the relative
candidate-minus-baseline delta and fails when the baseline cannot produce a
percentage. An improvement has a negative delta and stays below either
non-negative cap. A passed budget may cover an exact metric even when that fixed
overhead is statistically significant or more than the generic 10% limit. The
budget also covers only the mechanically derived same-base per-row projection,
such as
`allocatedBytesPerOperation` → `allocatedBytesPerRow` or
`responseBytesPerOperation` → `responseBytesPerRow`. CPU and wall have no such
pair: declare separate budgets for `cpuMicrosecondsPerOperation` and
`wallMicrosecondsPerOperation` when both fixed costs are expected. A budget
exempts no other metric, does not weaken a separately declared target or
ceiling, and still requires the budgeted workload's complete `full/alloc` and
`full/cpu` evidence. Per-row metrics cannot be budgeted directly; use
`--row-scaling` with a per-operation metric to prove that an accepted fixed cost
does not grow with result cardinality. Strict `--ceiling` contracts remain
independent and can reject the same metric even when its allowed-overhead budget
passes.

Diagnostic mode keeps the same clean-checkout, fresh-process, semantic digest,
checksum, SQL witness, lockfile, catalog, and protocol-hash checks. It uses two
alternating pairs and one fifth of the ordinary iteration count, subject to a
50-operation floor. The ordinary five-pair run remains the final keep evidence.
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

Run cross-provider evidence from the clean candidate checkout. That checkout
can also be the `--candidate-dir`; only the baseline and candidate directories
must differ. When the implementation still lives in a dirty branch, reproduce
the complete candidate in a disposable linked worktree and create a local
temporary commit there. Do not stage, switch, stash, or clean the dirty branch
to satisfy the benchmark. Install the frozen dependencies in both evidence
worktrees, and launch the command from the clean candidate worktree. Use the
baseline declared by the evidence program: cross-provider result transport
keeps `52eef9ebfc710407e1e5fe6042e2ed5a11adf19e`, while fixed decimal uses its
exact pre-feature commit `1d796d4e01841becfbb2f6805668ef11d270aa0e`.
A selection that mixes those programs is refused before build or measurement.
The fixed-decimal program requires the two lockfiles to differ by exactly the
pinned `decimal.js@10.6.0` importer, package, and snapshot entries; equality and
every other delta are refused. The report records that exception as
`fixed-decimal-dependency-only`.

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
