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

Local qualification is paused: the filesystem had only about 227 MiB free
after integration. No integrated tests, typecheck, build, or new performance
measurement has run. The two requested witnesses are written but unexecuted.
Do not interpret source-review acceptance as release readiness. Free several
GiB before starting the bounded validation runners.

PR #58 merged as `b524e692a` after all eight CI jobs passed; its merged tree
matches reviewed head `4d7984ff8`. Before opening the RC 2 pull request, rebase
this task-owned checkpoint onto that main revision (or inspect any newer main
delta). The original dirty checkout and local homepage branch remain untouched.

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
