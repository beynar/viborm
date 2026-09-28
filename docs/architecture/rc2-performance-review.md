# RC 2 performance review

## Scope and decision

Reviewed on 2026-09-28. Retain the bounded performance changes for RC 2,
subject to integrated correctness checks and the normal release gates. No
new cache, driver bypass, admission rule, or public API is introduced.

The production delta was reconstructed from three ordered patches under the
original checkout's `docs/architecture/performance-2026-09-28/`: first
`implementation/production.patch`, then `engine-candidates/combined.patch`,
then `engine-micro/candidate.patch`. No wholesale dirty-checkout copy was used.
The original evidence remains untouched. The handoff named a README that does
not exist; the actual entry report is `report.md` and each stage has its own
report. Local source snapshots, raw workers, harnesses, manifests and profiles
remain in that evidence directory; compact measurement summaries are retained
[here](rc2-performance/).

The measured baseline is `778912983`. Integration starts from released RC 1
source `8a42fcb56`, preserving main's `NativeTypeDeclaration` changes in the
query owner and SQLite adapter. A byte comparison confirmed that these are
the only differences between the six integrated production files and the
measured final source. The release-automation repair in PR #58 is a separate
prerequisite, not a performance change.

## What changes, and why

- Projection lowering returns only the columns its caller needs; recursive
  documents use the same per-field owner without unused alias/name arrays.
- Decoder field names and readers are built together into parallel arrays,
  local to one decoded batch. Per-field wrapper objects disappear.
- Factory-scoped operation classes share methods. Admission, prepared reads,
  and cache codecs stay private to each operation instance.
- Stateless read callbacks are shared; read execution forwards its promise.
  Synchronous preparation failures still reject asynchronously, and writes
  still await their outcome notification.
- Filter/order/selection preparation avoids intermediate collections. Singleton
  boolean predicates still call the adapter's operator; empty predicates retain
  their existing behavior.
- Constant SQL uses the existing string overload, still producing fresh
  fragments. No mutable global SQL fragments are introduced.

Two independent source reviews found no correctness defect. The root reviewed
the combined diff and source identity. Review specifically covered receiver
use, operation/factory isolation, failure ordering, own-key boundaries, alias
order, DISTINCT, recursive carriers, NULL handling, and parser rebinding.
The handle review requested additional concurrent-isolation and provider-read
failure-order witnesses before qualification.

## Evidence and interpretation

The archived measurements used Node 24.21.0, Apple M4 Pro, and in-memory SQLite
through better-sqlite3 12.6.0. Five alternating pairs used fresh processes and
separate timing/allocation workers. They measure the historical specimens,
not the integrated RC 2 artifact or native PostgreSQL/MySQL performance.

1. [Projection/reader/SQL simplifications](rc2-performance/allocation-summary.json):
   sampled allocation fell 3.6–5.0% across five small workloads. Timing was
   inconclusive; large-row allocation was effectively unchanged.
2. [Shared handles and combined engine work](rc2-performance/handles-summary.json):
   lookup CPU fell about 28%, wall time about 13%, and sampled allocation about
   12% against the already optimized first-stage baseline. Other small-operation
   allocation medians fell 7–9%. The 1,000-row timing was effectively unchanged.
   These are combined effects, not independently additive percentages.
3. [Final micro-pass](rc2-performance/micro-summary.json): allocation fell about
   3.8% for filtered20 and 1.8% for rows20. No CPU or wall-time win was established.
   Its initial filtered20 wall median increased 1.6%; an independent
   [adjacent-pair rerun](rc2-performance/adjacent-timing-summary.json) did not
   reproduce a stable regression. Neither protocol proves timing equivalence.

The final measured dist fingerprint was
`3299ea848d57f061696acab2160e1932b21c4548ee4e347467be21670c3bf19f`.
The preceding competitor-comparison build was
`1fd1b895b89ad4e56ea55cd737251b423c4b7a678f108158369a95305fd2eff2`.
The fingerprint hashes lexicographically sorted relative `.mjs` filenames and
their bytes. Do not present the earlier Drizzle/Prisma comparisons as RC 2 timings.

**Evidence correction:** the archived micro-pass report claimed captured bound
parameters matched. That comparator captured SQL text and checked complete
results, not parameter arrays. The later wall-diagnosis stage probe separately
checked prepared SQL and parameters for four read workloads. This narrower
proof is the supported claim.

Allocation means sampled JavaScript churn, not retained heap or RSS. The
200,000-operation retention soak was approximately flat, not a proof against
all leaks. Current Raptor 3 does not call the dormant consumable-result
protocol; these results do not demonstrate zero-copy decoding.

## Qualification

Local correctness qualification completed on 2026-09-28 after disk space was
restored. The clean task-owned commit `03624d412` rebased without conflicts onto
PR #58's exact main revision `b524e692aa1b65457f85778f284490ef1571331a`, becoming
`c47ed1c2a82e8f5407cbda6f16dd52a5091d89af`. `git range-diff` reports the task
patch unchanged. The original dirty checkout remains untouched.

All checks used Node **24.21.0** through
`/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin` at the front of `PATH`.
Repository launchers serialized execution under the shared Git-common-directory
lock and verified process-group teardown. No build, packaging, native-provider
run, or new performance measurement was performed.

| Check | Result | Bounded wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| Nine selected `raptor3` files | 77 tests passed | 4.37 s / 660.5 MiB | [Engine](rc2-performance/integrated-engine-checks.log) |
| Full official instrumentation extension file, `layer-client` | 14 tests passed | 2.77 s / 456.8 MiB | [Client instrumentation](rc2-performance/integrated-client-instrumentation-corrected.log) |
| Complete registered `layer-instrumentation` project | 189 tests in 16 files passed | 2.85 s / 475.3 MiB | [Instrumentation core](rc2-performance/integrated-instrumentation-core.log) |
| `pnpm test:types`, whole-estate native compiler | Passed | 7.39 s / 6981.0 MiB | [Typecheck](rc2-performance/integrated-typecheck.log) |

The engine selection covers prepared operations (including concurrent handle
and factory isolation), projection preparation, both base and placement result
decoders, filters, ordering/projection, cacheable-read vocabulary, read-only
build, and write-outcome composition. The new provider-read failure witness
passed with the complete official instrumentation file. All 280 runtime tests
passed. Runtime checks stayed below the 1536 MiB ceiling; the existing
whole-estate native typecheck used its designated 8192 MiB ceiling.

The first client instrumentation run had one failed assertion (13/14 passed),
retained in [its original receipt](rc2-performance/integrated-client-instrumentation-checks.log).
The new witness had incorrectly copied admission-failure logging order: a
provider error is logged at the statement boundary before the enclosing
operation's inner observer completes. Inspection of the existing driver log
owner confirmed this order. Only the witness's `I.error` expectation moved
before `B.out`; no production repair was needed. The passing rerun and typecheck
used the rebased source plus this one-line test correction, whose file Git blob
is `595be6411a7d7c94278c5f5fb7d0731e47e23157`. Engine and instrumentation-core
sources did not change between their checks and the final test correction.

Commands were `node scripts/run-vitest-safe.mjs run --workspace
vitest.workspace.ts --project=raptor3` with the nine filenames recorded in the
engine receipt, the same launcher with `--project=layer-client` and
`tests/contracts/public-client/official-instrumentation-extension.core.test.ts`,
the same launcher with `--project=layer-instrumentation`, and `pnpm test:types`.
Receipt SHA-256 values are retained in [the checksum file](rc2-performance/integrated-receipts.sha256).

The adapted historical `memo-isolation.review.test.ts` was typechecked, but
has no runtime proof in this qualification. Both attempted selections collected
zero files ([raptor3](rc2-performance/integrated-memo-isolation.log),
[extended-local](rc2-performance/integrated-memo-isolation-corrected.log));
the existing manifest explicitly excludes these historical scratch reviews.
No registration was changed and neither attempt counts as a passing check.

Integrated local checks, required PR CI, and release-artifact gates must name
their executed source. Historical focused tests do not qualify a different
tree. Native providers run in the required CI/release jobs; SQLite-family
receipts alone do not establish those providers' behavior.

## Explicit exclusions

- No indexed three-ORM benchmark or production index change. The diagnostic
  filtered20 speedup came from an index, not this engine patch.
- No client-proxy cache repair: retention of arbitrary unknown property names
  was explicitly deferred by Arnaud. This release does not claim to fix it.
- No decoder redesign, new cache, public compatibility change, or stable V1.
- Homepage edits remain on their separate documentation branch.
