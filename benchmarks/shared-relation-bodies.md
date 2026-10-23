# Shared relation bodies: PostgreSQL measurement

**Status: a record of the 2026-10-17 measurement, not the current default.** Every PostgreSQL driver shares relation bodies by default since 1.3.0 (`sharedRelationBodies: false` turns it off): a server that bounds the relations one statement references, PlanetScale Neki's 256, needs the shared form. The point-lookup regressions below come from PostgreSQL materializing the shared `WITH` member and producing it row by row before the lookup finds its key. Since 1.3.3 a body that reads no other shared body is written `NOT MATERIALIZED`, so PostgreSQL inlines it into each use (`benchmarks/perf-1.3.3.md` §0: a nested include under a `posts some` policy went from 19.7 ms to 1.5 ms at 100k posts). This invoice fixture has not been re-run since, so the table below shows the materialized form only.

At the time, the conclusion was: sharing helps list and count queries but causes repeatable point-lookup regressions. It is an execution strategy with workload-dependent cost, not a universally beneficial SQL compression.

Five fresh Node processes compared the same freshly built package with the public `PgDriver({ sharedRelationBodies: false/true })` option. Every query ran through `base.$extends(rbac(...)).$as(actor)`. No handwritten SQL substituted for the timed ORM operation. Production source and defaults were not changed.

## Fixture and method

- PostgreSQL 16.14 in local Docker; Node 24.22.0; Apple M4 Pro.
- 100,000 organizations, 200,000 invoices, 191,100 memberships. An invoice is visible when the actor belongs to its seller OR buyer organization.
- Actors belong to 100 organizations (narrow), 1,000 (medium), or 90,000 (broad stress case); respectively 400, 4,000 and 180,000 invoices are permitted. Every actor also has genuinely denied invoices.
- Membership indexes cover both `(organizationId, userId)` and `(userId, organizationId)`. Invoice primary key and both organization foreign keys are indexed. Statistics are collected with ANALYZE.
- JIT is off on both sides, isolating SQL sharing. work_mem is the server default 4 MiB.
- Per case and process: 5 warmup pairs, 30 measured pairs, alternating which setting runs first. Case order rotates between processes. In total, 6,300 timed operations have their returned values checked outside timing.
- Timing includes ORM argument handling, SQL construction, pool/provider round trip and result parsing. Policy construction, capture hooks, correctness assertions, and savepoint/rollback commands are outside timing.
- Three EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) observations per side/case/process run separately. Those instrumented times are not the latency samples.
- One random schema and one connection per process, inside a transaction always rolled back. All five runs verified the namespace disappeared. Writes are rolled back to a savepoint between invocations; all labels are verified restored.
- Full visible ID sets are checked against independent arithmetic expectations for both settings before timing. A zero-membership actor is denied. Each measured operation also checks its exact returned value.
- SQL capture proves sharing activates for the repeated read predicates. The single-relation control and this scalar update path emit identical SQL and parameter values under both settings.

## Results

Values below are the **median of the five process medians**, in milliseconds. The ratio interval contains the five paired process ratios (enabled / disabled). Less than 1 is faster with sharing. This interval is not a confidence interval.

| Memberships | Operation | Disabled ms | Enabled ms | Paired ratio range |
|---:|---|---:|---:|---:|
| 100 | One invoice, permitted late match | 0.739 | 0.903 | 1.18–1.28× |
| 100 | One invoice, permission denied | 0.634 | 0.736 | 1.05–1.20× |
| 100 | First 50 invoices | 4.220 | 4.153 | 0.96–1.06× |
| 100 | 50 invoices after offset | 15.835 | 15.664 | 0.98–1.00× |
| 100 | Count all permitted invoices | 20.756 | 21.258 | 0.99–1.02× |
| 100 | Update among 1,000 candidates | 1.624 | 1.789 | 0.99–1.10× |
| 100 | Single relation, first 50 (control) | 1.179 | 1.213 | 0.96–1.07× |
| 1,000 | One invoice, permitted late match | 0.748 | 4.137 | 2.24–5.60× |
| 1,000 | One invoice, permission denied | 0.768 | 4.709 | 3.23–8.01× |
| 1,000 | First 50 invoices | 9.704 | 5.698 | 0.59–0.72× |
| 1,000 | 50 invoices after offset | 15.055 | 11.116 | 0.71–0.74× |
| 1,000 | Count all permitted invoices | 27.633 | 23.600 | 0.81–0.88× |
| 1,000 | Update among 1,000 candidates | 17.474 | 17.639 | 0.98–1.09× |
| 1,000 | Single relation, first 50 (control) | 9.188 | 9.474 | 0.95–1.05× |
| 90,000 | One invoice, permitted late match | 1.195 | 24.726 | 10.89–21.57× |
| 90,000 | One invoice, permission denied | 1.153 | 30.306 | 11.58–31.11× |
| 90,000 | First 50 invoices | 60.883 | 47.848 | 0.75–0.82× |
| 90,000 | 50 invoices after offset | 63.043 | 50.616 | 0.70–0.83× |
| 90,000 | Count all permitted invoices | 82.880 | 74.064 | 0.80–0.89× |
| 90,000 | Update among 1,000 candidates | 98.001 | 98.277 | 0.95–1.00× |
| 90,000 | Single relation, first 50 (control) | 0.504 | 0.532 | 0.83–1.21× |

The permitted point lookup deliberately targets a later matching organization: invoice 180001, whose seller is organization 80001. This tests a normal keyed lookup where the shared set cannot stop at its first qualifying organization. It is not a random average over all invoice IDs. The denied lookup targets an existing forbidden invoice, not a nonexistent key.

The page offset is 200 permitted rows for the narrow actor and 1,000 for the other actors; all page cases return 50 rows. The update changes **2 / 20 / 900 authorized rows** among 1,000 candidates for narrow / medium / broad actors, respectively. It does not change 1,000 rows in each case.

## What the plans show

For the medium permitted point lookup, without sharing PostgreSQL uses indexed probes that touch one organization and one membership. With sharing it builds a hash of the actor’s 1,000 memberships and scans 80,001 organization rows before the shared CTE yields the matching key. The CTE produces 801 rows. In the broad case it reads 90,000 memberships and produces 72,001 CTE rows before finding the same organization. The second OR arm is short-circuited in these permitted lookups.

This is **partial, demand-driven CTE production**, not proof that PostgreSQL always computes the whole shared result upfront. It is still much more work than the unshared indexed lookup.

For the first page, the unshared PostgreSQL plan builds the qualifying organization set twice. The shared plan builds it once, then reuses it for seller and buyer membership tests. This explains the repeatable list improvements. Broad shared plans also spill temporary data (154 blocks read/written in the recorded page/denial/count observations).

For example, the first-page statement shrinks from 719 to 650 bytes and from 3 parameters to 2. A permitted unique read shrinks from 731 to 662 bytes while becoming slower: SQL size alone is not an execution-cost measurement.

The scalar update of `label` follows a path where the option does not currently change the SQL: 1,312 bytes and 6 parameters under both settings. It remains an explicit no-effect case. Preliminary harness checks initially assumed every repeated write predicate would be shared and stopped on this mismatch; SQL inspection established the actual behavior before the five retained runs. No production change was made to force the benchmark expectation.

## Interpretation and limits

- The enabled strategy made medium/broad point lookups slower and list/count queries faster in every retained run. This rejects an unconditional enabled default for the current implementation. It does not establish that disabling sharing is optimal for every workload.
- Other work on the host increased latency during run 3 and part of run 4. All five runs are retained; paired order alternates. The large directional effects also appear in runs 1, 2 and 5. Small changes, especially controls with identical SQL, are inconclusive.
- This is a warm synthetic fixture and one PostgreSQL version, not a production throughput or tail-latency claim. p95 values and every individual sample are retained, but 30 samples per process do not support strong tail estimates.
- Tables are freshly seeded and analyzed inside a rollback-only transaction. They cannot be VACUUMed there; index-only scans perform heap fetches. A vacuumed long-lived database can behave differently.
- Savepoint rollback restores logical rows, but repeated writes still generate physical MVCC work. Bulk-update numbers are descriptive warm repeated-write timings.
- Broad membership is a stress case; 1,000 memberships is also larger than many ordinary users. Narrow memberships show small point-lookup overhead and little read benefit.
- Nothing here measures D1, constrained PostgreSQL providers, JIT-on interactions, recursive policies or arbitrary permission graphs. Provider SQL limits can independently justify sharing.

## Reproduce and evidence

```sh
pnpm package:build
# Supply a loopback PostgreSQL URL privately through SHARED_BENCH_PG_URL.
SHARED_BENCH_OUTPUT=/tmp/shared-bodies-run.json \
  SHARED_BENCH_SAMPLES=30 SHARED_BENCH_WARMUPS=5 SHARED_BENCH_ROTATION=0 \
  node scripts/run-node-safe.mjs 768 180000 benchmarks/shared-relation-bodies.mjs
```

Run sequentially five times with rotations 0–4 and distinct output paths. The harness refuses non-loopback hosts and existing output files. It creates no persistent schema objects and does not touch existing tables. Each recorded process finished within the 180-second bound and below 192 MiB sampled process-group RSS; the package build also passed its bounded launcher.

- [Harness](shared-relation-bodies.mjs)
- [Summary and every process median](results/shared-relation-bodies-2026-10-17/summary.json)
- [Receipt checksums](results/shared-relation-bodies-2026-10-17/receipts.json)
- [Run 1: samples, generated SQL, parameters and full plans](results/shared-relation-bodies-2026-10-17/run-1.json.gz)
- [Run 2: samples, generated SQL, parameters and full plans](results/shared-relation-bodies-2026-10-17/run-2.json.gz)
- [Run 3: samples, generated SQL, parameters and full plans](results/shared-relation-bodies-2026-10-17/run-3.json.gz)
- [Run 4: samples, generated SQL, parameters and full plans](results/shared-relation-bodies-2026-10-17/run-4.json.gz)
- [Run 5: samples, generated SQL, parameters and full plans](results/shared-relation-bodies-2026-10-17/run-5.json.gz)

JSON receipts are gzip-compressed without content changes; checksums cover both original JSON and archives. They record commit, runtime, build and harness fingerprints. All five measured fingerprints agree. The exact measured source is retained in [measured-harness.mjs.gz](results/shared-relation-bodies-2026-10-17/measured-harness.mjs.gz). Two subsequent lint-only edits add a numeric separator and apply De Morgan’s law to the deterministic denied-row finder; neither touches timing or query construction. The final harness passed Biome and a complete 21-case verification run (two sample pairs per case). That verification reproduced every expected answer, query argument, SQL statement (apart from the random namespace), and parameter list from the measured harness, with successful cleanup. Its receipt is [final-verification.json.gz](results/shared-relation-bodies-2026-10-17/final-verification.json.gz). A read-only subagent independently reviewed the harness and the first two runs’ plans and confirmed the mixed result.

Commit measured: `bb2d8f78bf9135b189a3b384b21ab06946589949`.
Build SHA-256: `26c0434a72ddd49e6858466a228292483aa973bbfd1dfd7b4a65a5a5ad3e5cc5`.
Harness SHA-256: `f04f00245ebdf45fb9db6c186b26fd068088fe910b9545e9a4eb84d1cd05fb5c`.
