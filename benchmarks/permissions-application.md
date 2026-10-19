# Permissions application performance

Measured 2026-10-18 on Node 24.22.0, macOS 26.5.1 arm64, against VibORM's large
acceptance policy. This is not a measurement of Pyxel's policy or its hosted
runtime. The reuse measurements below exclude database queries; the separate
cold-start measurements include the first governed read.

## Application reuse

| Phase | Before, median ms | After, median ms |
| --- | ---: | ---: |
| Explicit `policy.compile(schema)` inspection | 473.35 | 539.79 |
| Repeated `base.$extends(policy)` | 494.17 | 0.30 |
| Fresh client with reused policy/schema | not measured | 0.30 |
| Apply captured precompiled rows definition | 16.51 | 0.07 |
| Fresh client with precompiled rows definition | 15.91 | 0.08 |
| `$as(actor)` | 0.008 | 0.008 |

Each application phase has 20 sequential samples, including its first call;
actor binding has 100. Raw samples, first-call timings and the final source
fingerprints are in [the evidence directory](results/permissions-application-2026-10-18/).
These are directional local measurements, not performance assertions in CI.
Explicit compilation stays fresh; the before/after difference in that row is
run-to-run variation, not a claimed optimization in this first stage. Its first
application still compiled and admitted the policy (600 ms in that run). The
second stage below addresses that initial cost.

## Cold compilation and first query

Five fresh Node/Vitest processes per revision, run serially with the same large
acceptance policy and a new in-memory SQLite database in each process:

| Phase | Before, median ms | After, median ms |
| --- | ---: | ---: |
| Create policy and first `$extends` | 547.62 | 229.25 |
| First `$as` and governed `page.findMany` | 6.72 | 6.74 |
| Combined | 554.63 | 235.97 |

Initial application is **58% faster (2.39×)**. The first query is unchanged;
the optimization removes work rather than deferring it to that query. Imports,
schema/base-client construction, connection setup and fixture DDL are excluded,
so these are extension timings, not whole-isolate startup. The read selects IDs
from an empty fixture with all relevant actor values supplied. Raw samples and
compiler source fingerprints are in [cold.json](results/permissions-application-2026-10-18/cold.json).
The before revision already includes the application-reuse changes above.

CPU profiling found almost all compilation time in the simplifier's checks that
removing a redundant condition preserves actor dependencies. Three local changes
remove repeated work: conjunction decomposition retains stable member identities
within one compilation, each successful reduction carries its existing full
judgment into the next check, and identical dependency guards are recognized
before invoking the implication prover. There is no persistent equality cache
over caller-owned values. Compilation remains eager, and invalid policies still
fail synchronously at `$extends`.

The acceptance policy's compiled output is byte-for-byte identical before and
after. This structural comparison supplements the authorization tests; timings
are manual diagnostics and add no CI performance assertion.

With the final compiler, the separate repeated-application benchmark measures
0.295 ms for `$extends(policy)`, 0.283 ms for a fresh client with the same
policy/schema, and 0.007 ms for `$as`. Explicit fresh compilation measures
166.69 ms once the process is warm. These samples are also recorded in `cold.json`;
they are distinct from the fresh-process samples above.

## Shared structure (third stage)

The compiled acceptance policy holds 3,573 distinct objects but 26,939 when
every shared sub-predicate is counted where it is read: a relation's target
predicate is inlined wherever it appears. Profiling the second stage found most of
the remaining time in work repeated over those copies. Structural equality was
recomputed by deep comparison, and the simplifier rebuilt the same large read
guards (median 65 KB as JSON) for each candidate removal. Core admission also
parsed, cycle-checked and scanned each inlined copy again.

Five fresh processes per revision, interleaved before/after under unrelated
machine load (raw samples in [sharing.json](results/permissions-application-2026-10-18/sharing.json)):

| Phase | Second stage, median ms | Third stage, median ms |
| --- | ---: | ---: |
| Create policy and first `$extends` | 254.43 | 67.76 |
| First `$as` and governed `page.findMany` | 7.85 | 7.63 |
| Combined | 262.42 | 75.55 |

The second stage's own measurement on a quieter machine was 229 ms (above), so
application is about 3.4–3.75× faster than that stage and 8× faster than the
original 548 ms. The first query is unchanged. Warm fresh compilation measures
34–39 ms (was 167 ms); repeated application stays at about 0.33 ms.

Changes, all compilation- or admission-local:

- **Compiler:** each compilation keys values structurally once (numbers by
  `Object.is`, valid dates by instant, records and arrays member by member,
  anything else by identity). Equality, duplicate removal and the implication
  cache use those keys. Read guards are built once per distinct operands and
  their negations derived once. Keys and guards are discarded with the
  compilation; nothing persists over caller-owned values.
- **Admission:** one `admitRows` call parses each shared sub-predicate once per
  model `where` schema and shares the admitted value. Only successes are kept,
  so a refusal is still reported where it is reached. Cycle checks and control
  reference collection likewise visit each shared object once.

The compiled acceptance output is again byte-for-byte identical: 430,140 bytes,
SHA-256 `7a3d8cbf3ab1e2ce80a15eeba723bd37df749f82d5a1b79e1e512d469c609763`.

Where the remaining ~68 ms goes, from per-phase timers in single cold runs:
compilation about 48 ms (roughly a third of it the placement and move
simplification), core admission about 12 ms, and client extension and copying
the rest. With simplification removed entirely, the eager path would still
take about 48 ms, because lowering every rule and admitting every predicate
remains. Getting well below 50 ms would require compiling each model on first
use, which was considered and not adopted: it moves policy errors or
compilation cost to the first query of each model.

## Per-model compilation (1.3.2)

1.3.2 compiles a model the first time a call needs it (the earlier stages
above kept compilation eager). The compiled output is unchanged: the
acceptance policy still compiles to 430,140 bytes, SHA-256 `7a3d8cbf…`,
now pinned by `tests/unit/permissions/compile.core.test.ts`, and compiling
models one at a time in any order gives the same bytes.

What a cold isolate pays depends on its first query. A query on a model at
the centre of the policy reaches most models through its relations (the
related rows' rules are part of its statement), so it pays about what the
eager application did; one on a peripheral model pays for that model and the
few it reads. Five interleaved fresh-process samples of this file's cold
benchmark (first read on `page`, the acceptance policy's centre) measured
main ≈ 134 ms against ≈ 122 ms, within the noise. On a 40-model production
policy, from source on a loaded machine: a first query on
`memberNotifications` ≈ 5× faster than 1.3.1, `organizationBilling` 2–4×,
`document` ≈ 40 %, `page` unchanged. Warm fresh clients: ≈ 1.4 ms to apply
(1.3 ms with the 1.3.1 build). Details: `docs/architecture/permissions-1-3-2-plan.md` §9.

## What is reused

One `permissions(config)` instance keeps a private rows definition for each
unchanged schema object. Declaration values, key enumeration, descriptors and
schema entries are checked before reuse. A change rebuilds that definition.
Only ordinary data can enter the cache; accessors, opaque values such as Date,
nonstandard arrays and uncloneable compiled values retain the uncached path.
Rule callbacks must remain pure, as documented; changing closed-over state is
not a supported way to change a policy.

Core reuses successful admission of deeply immutable rows within the same schema
registry, with a schema-entry check. Custom scalar validators retain normal
admission. Control-reference names are memoized for immutable admitted rows;
each receiving chain still validates its own controls. Neither cache retains a
client, driver, actor, scope binding or transaction. Weak keys follow policy,
schema, registry and rows lifetimes; only the latest declaration revision is
retained per policy/schema. This retains preparation data in exchange for avoiding
repeated work; retained heap size was not measured.

Client and method factories still run for each application. Public
`policy.compile(schema)` results are independent of private application data.
No authorization result or query result is cached by this change. Mutable or
freshly reconstructed arbitrary extension definitions do not gain this reuse.

## Reproduce

Keep the policy and schema objects outside the request handler. The benchmark
covers both a reused base client and a fresh client with those same objects.

```sh
VIBORM_POLICY_TIMINGS=1 node scripts/run-vitest-safe.mjs run \
  --workspace vitest.workspace.ts --project=provider-sqlite3 \
  tests/providers/local/sqlite3-permissions-reuse.test.ts
```

The regression tests cover rule reevaluation counts, declaration and schema
changes, missing chain controls, getter/proxy revocation, Date operands, unsafe
arrays, public inspection isolation, separate databases, actor/scope bindings
and transactions. The normal test run skips timing measurement.

For a cold sample, run this command in a fresh process; repeat it for independent
samples:

```sh
VIBORM_POLICY_COLD_TIMINGS=1 node scripts/run-vitest-safe.mjs run \
  --workspace vitest.workspace.ts --project=provider-sqlite3 \
  tests/providers/local/sqlite3-permissions-reuse.test.ts \
  -t 'measure cold permissions'
```

The application benchmark also accepts `VIBORM_POLICY_CPU_PROFILE=/tmp/policy.cpuprofile`
to profile five fresh explicit compilations, and
`VIBORM_POLICY_COMPILED_OUTPUT=/tmp/policy.json` to capture the compiled result.

## Application-reuse verification and cost

- Whole-estate typecheck passed, 51.03 s and 6,546.6 MiB peak sampled RSS within
  the existing 8,192 MiB ceiling.
- Extension coverage: 973 tests passed, two intentional skips; statements,
  branches, functions and lines all 100% under the unchanged gate.
- Manual DST: 100 seeds × 96 generated operations, exact replay, 200 migration
  worlds; all passed. DST remains outside CI.
- Package build and packed Permissions/soft-delete consumer checks passed; docs
  validation found no broken links. Consumer gzip sizes: pg 180,567 B, D1 179,947 B,
  pg plus Permissions 190,939 B, standalone Permissions 30,020 B. The size limits
  follow the existing approved OD-17 measured-growth rule; memory, wall-time and
  coverage gates are unchanged.

## Cold-compiler verification and cost

- Whole-estate typecheck passed: 33.38 s, 6,518.1 MiB peak sampled RSS within
  the unchanged 8,192 MiB ceiling.
- All 973 extension tests passed, with three intentional skips (two manual
  benchmarks and the existing provider case); all four coverage metrics remain
  100%. This includes the independent permission oracle and actor-dependency
  regression cases.
- The final acceptance output matches the baseline exactly: 430,140 bytes,
  SHA-256 `7a3d8cbf3ab1e2ce80a15eeba723bd37df749f82d5a1b79e1e512d469c609763`.
- Package build, both packed Permissions/soft-delete consumers and size checks
  passed. Standalone Permissions grows by 22 B gzip to 30,042 B; pg plus
  Permissions grows by 28 B to 190,967 B. No additional size-limit increase.
- Manual DST passed again: 100 seeds × 96 generated operations, exact replay
  and 200 migration worlds. It remains outside CI.
- Docs link validation, changed-code formatting and `git diff --check` passed.

This adds one compilation-local memo and carries an existing judgment between
reductions; it adds no public concept or execution mode. It does retain the
decomposed members until compilation completes. Retained-heap cost and hosted
Pyxel cold starts have not been measured.

## Shared-structure verification and cost

- Whole-estate typecheck passed: 33.78 s, 6,458.9 MiB peak sampled RSS within
  the unchanged 8,192 MiB ceiling.
- All 973 extension tests passed with three intentional skips; statements,
  branches, functions and lines are 100%. New tests pin the equality
  semantics (`-0`, invalid dates, opaque values) and shared admission (parsed
  once, value shared, refusals unchanged). The validation layer's 1,084 tests
  passed.
- Manual DST passed: 100 seeds × 96 generated operations, exact replay and 200
  migration worlds. It remains outside CI.
- Package build, packed consumer runtime (25) and type (29) checks, and size
  checks passed after raising three limits by the
  approved OD-17 rule: pg plus Permissions 191,498 B gzip (+531 B), standalone
  Permissions 30,407 B (+365 B), every public entry 411,254 B (+500 B).
