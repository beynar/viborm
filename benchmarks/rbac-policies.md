# RBAC policy benchmark

Build the current package, then run this benchmark sequentially, without another
test, typecheck or benchmark process in the workspace:

```sh
pnpm package:build
RBAC_BENCH_OUTPUT=/tmp/viborm-rbac-policies.json node scripts/run-node-safe.mjs 768 180000 benchmarks/rbac-policies.mjs
```

The output path must not already exist. The command uses the normal 1536 MiB
sampled process-group RSS ceiling and a three-minute wall bound. No database URL,
credential, persistent database, migration or external service is used in the
default SQLite lane. It owns one fresh in-memory database and closes it on completion.

An optional PostgreSQL lane accepts `RBAC_BENCH_PROVIDER=pg` and
`RBAC_BENCH_PG_URL` pointing to a **loopback** PostgreSQL server. Supply the URL
through the environment; the benchmark never prints it. It creates a random
schema inside one transaction on a pool capped at one connection and rolls the
transaction back on completion, so it does not touch existing tables or leave
schema objects behind. The role needs permission to create a schema. Per-statement
timeout is 15 seconds. The same bounded launcher and memory ceiling apply.

Run the PostgreSQL lane once with `RBAC_BENCH_JIT=default`, and again with
`RBAC_BENCH_JIT=off`, using distinct output paths. `on` is also accepted; it
enables JIT but retains the server's cost thresholds rather than forcing every
query to compile. JSON includes effective JIT settings and a separate
`EXPLAIN (ANALYZE, FORMAT JSON)` observation per query: plan-node count, estimated
total cost, planning/execution time, and JIT details when PostgreSQL reports them.
EXPLAIN runs outside the measured intervals. A null JIT observation means this
query did not report JIT work; enabling the setting alone is not proof it ran.

Defaults are 10,000 documents, 100 organizations, 1,000 memberships, roughly
3,334 shares, trees of up to 16 nodes, 50-row pages, 10 warmup pairs and 100
measured pairs per workload. Override with `RBAC_BENCH_ROWS` (1,000–100,000),
`RBAC_BENCH_SAMPLES` (10–1,000), and `RBAC_BENCH_WARMUPS` (1–100). Larger inputs
may exceed the fixed command wall bound; report a failed bounded run honestly.

Four workloads measure ownership, organization membership, direct sharing, and
recursive ancestor ownership. Each compares a plain VibORM query with its
equivalent explicit `where` to an RBAC client carrying the corresponding actor
rule. All operation mappings are explicit. There is no level inheritance or
public policy helper in the benchmark.

Before timing, both variants must return the complete independently calculated
set of permitted document IDs. Every measured page is checked afterward. The
fixture contains both permitted and denied rows. Indexed membership, share,
ownership, organization and parent keys represent ordinary application indexes;
Provider statistics are collected after seeding.

Each pair alternates which variant runs first. The measured interval includes
the full ORM operation and provider execution, but excludes assertions and setup.
Statement capture runs separately, so the timing does not include a measurement
extension. JSON records p50/p95/min/max, every sample, SQL UTF-8 byte count,
parameter count, SQL hash, runtime/hardware metadata, and hashes of the actual
built JavaScript and benchmark. Preserve the JSON with any reported numbers.

These are warm read measurements from one local process. They do not establish
production latency, mutation cost, network cost, concurrent revocation behavior,
or superiority to another ORM. SQLite cannot establish PostgreSQL JIT performance;
use the optional PostgreSQL lane for that evidence. SQL bytes and parameter
counts describe generated statement size, not planner complexity. For a change
comparison, use the repository's clean-commit, fresh-process evidence procedure;
do not present a single run as a statistically established speed improvement.


## Observed run — 17 October 2026

Executed on an Apple M4 Pro with Node 24.22.0, SQLite 3.53.2 and local
PostgreSQL 16.14, using the default 10,000-document fixture and 100 measured
pairs per workload. The JSON records the exact runtime versions, build and
harness fingerprints, dirty-worktree status, and all samples. These are
observations of this development build, not release or competitor benchmarks.

| Workload | SQLite baseline / RBAC p50 (ms) | PostgreSQL default JIT baseline / RBAC p50 (ms) | PostgreSQL JIT off baseline / RBAC p50 (ms) |
| --- | --- | --- | --- |
| Ownership | 0.053 / 0.061 | 0.378 / 0.395 | 0.438 / 0.455 |
| Organization membership | 0.156 / 0.159 | 0.596 / 0.594 | 0.754 / 0.754 |
| Direct sharing | 0.592 / 0.595 | 0.787 / 0.794 | 1.008 / 1.011 |
| Recursive folder ownership | 3.782 / 3.780 | 38.435 / 38.164 | 33.702 / 33.798 |

The PostgreSQL recursive protected query reported 33 JIT functions and 4.59 ms
of JIT work in the separate EXPLAIN observation. The other three protected
queries reported no JIT work. The off run's lower recursive median is consistent
with that cost, but these separate single-process runs do not establish a
statistically significant improvement or a universal setting recommendation.
The largest protected statement was 933 bytes; each query used two or three
parameters. Baseline and protected queries returned identical expected rows.

Raw evidence: [SQLite](results/rbac-2026-10-17/sqlite.json),
[PostgreSQL default JIT](results/rbac-2026-10-17/postgres-jit-default.json), and
[PostgreSQL JIT off](results/rbac-2026-10-17/postgres-jit-off.json).
