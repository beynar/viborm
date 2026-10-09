# VibORM V1: response to the adversarial review

This report accompanies the V1 remediation branch based on `origin/main`
`a4a5b8dc607a9a8db506bd60ddb5125519d8ab0b`. The original checkout and its
pre-existing changes were preserved. Three GPT-6.1 Sol agents own the driver,
query and migration work; the root agent integrates, reviews and releases it.

**Release checkpoint: held, not published.** Arnaud requires fully unannotated
exported clients and client factories to preserve cyclic relation typing through
declaration emission. The schema-key carrier passes the 118-row
compiler/backend/scaling matrix on TypeScript 5.8 and 7. Artifact32 retains that
client representation and adds the qualified PostgreSQL rename/enum correction.
CI11 passes all 33 package cases on both Node22 and Node24. The current harness
retains all 53 compiler/scenario pairs (the original 51 plus recursive JSON on
both compilers). Final provider, package and protected-main
qualification remain.
Caller getter annotations are unnecessary. Rebuilding a client from
already-emitted cyclic models is an explicitly accepted remaining limitation.
Version 1.0.0 is prepared, but npm latest
still points to 0.1.0. The Linux documentation build now passes; the remaining provider and protected
CI qualification must finish before the Release workflow can publish. This document will be updated
with the actual release evidence. Passing tests below describe their recorded
revision; a later edit requires the affected check to run again.

The accepted scope is to repair confirmed defects and explicitly retain product
gaps. It does not include SQL Server, Studio, cross-schema relationships, replicas,
new auth adapters, arbitrary geometry, or a general SQL query-builder product.
The [555-item ledger](findings.json) accounts for every indexed finding and PB-1–8
with its original title, severity, review classification, disposition and evidence.
A [readable finding-by-finding response](FINDINGS.md) is generated from that ledger.
A product gap is not a fixed defect; implemented-unverified means work remains.
The current disposition is 289 verified repairs, 163 product gaps, 92 documented
contracts, 4 release-dependent findings, 2 implemented but unverified documentation
findings, 4 non-defects and 1 refuted claim. There are no unassigned pending rows.

**What changed.**

- Driver lifetimes, transaction failure propagation, rollback-only behavior,
  raw integer transport and current Neon HTTP execution have focused regression
  coverage. Failed cleanup quarantines the exact handle instead of silently
  creating a replacement. Supplied transports retain their ownership contract.
- Real Neon fixtures now exercise TCP and HTTP values, exact dates including
  year zero, races between upserts/connectOrCreate, and a lock-observed limited
  mutation schedule. Tests use uniquely owned fixtures; no hosted table was
  dropped or truncated.
- Query corrections cover counts under join fan-out, predicate rechecks after
  PostgreSQL lock waits, nested write selection, skipDuplicates admission,
  updatedAt behavior, recursive bounds, literal SQL operands, and cache isolation
  and invalidation. Unsupported batch shapes fail before DML.
- Scalars retain defaults and refinements across modifiers. Identifier formats
  no longer accidentally generate foreign-key values. Decimal/DateTime/JSON and
  vector boundaries use their existing semantic owners; invalid or lossy provider
  crossings are refused instead of producing plausible values.
- Rejected async validators and filter callbacks cannot leak unhandled promise
  rejections. Prepared array results retain the same scalar-error attribution
  as ordinary queries. Recursive JSON result types bypass cosmetic remapping
  without losing their domain, finite custom outputs or selected-field checks.
- SQLite JSON comparisons use structural equality. PostgreSQL boolean aggregates
  use supported operators. Native string domains keep native identity comparison
  while text predicates use explicit supported text operations.
- Migration changes protect managed scope, physical constraint identity,
  decimal/temporal carriers, enum transitions, namespace qualification, and
  advisory lock acquisition. PostgreSQL rename planning now mirrors the exact
  physical PK rename; generated key names agree in forward SQL and rollback,
  including long names. Enum SQL runs after the native renames it depends on
  and retains renamed scalar/array defaults and replacement metadata.
  Selected unsupported physical schema objects now
  receive explicit pre-effect refusals; the missing declaration features
  remain product gaps.
- Public client types now preserve multi-key groupBy results, false/dynamic
  selectors, Promise compatibility, select/include exclusivity and singular
  recursive-node restrictions. Exported declarations and driver-specific entry
  points are tested as installed tarballs, including TypeScript 5.8.
- Model delegates now expose real reflection surfaces and writable operation
  descriptors so ordinary spies and stubs can work. SQL keywords are no longer
  incorrectly reserved model names; the actual Promise hook remains protected.
- Provider debugging gets explicit false-default detail and caller-location
  disclosure. Default redaction remains. Validation errors identify model and
  path; schema errors include existing repair hints. Default logs contain no
  added ANSI escapes.
- Documentation now describes the shipped CLI, persistent PGlite quickstart,
  raw physical values, conditional provider capabilities and current query
  internals. Stale unpublished-API and false cache-prefix examples were removed.

**Evidence at this checkpoint.**

The current follow-through found two related runtime defects. Fallback array
planning and execution could invoke statement transforms twice. Deferring them
to dispatch fixes that duplication, but CI10 then catches a later transform
changing SQLite storage after an earlier protected guard. The sequential owner
now prepares each transform inside its own observation before any provider
effect. Its 60 focused tests and 122 boundary tests pass, including observed
and unobserved storage races, exact error attribution and statement logging.
Artifact30 contains this correction and the subsequent upsert guard validation
fix. Earlier runtime artifacts must not be published. The
formerly deadlocked shared PGlite groups now pass190,154 and241 tests, preserving
their race and mutation assertions; the corrected cache group passes205.

CI10 also retains two resource failures: Linux docs crosses1536.6MiB, and one
Node22 package case reaches30s during its third compiler process. The positive
and expected-lossy consumers now share one strict emitted-only program. Every
diagnostic must belong to the negative control; both TS5.8 and7 pass locally,
and intentionally poisoned positive probes fail both. Cold docs now pass with
a 384 MiB heap, within the original 768 MiB allowance. Forced-GC experiments
were rejected. The saved build also requests immediate reclamation of freed
native pages; its small macOS difference is inconclusive. The combined candidate
passes Linux CI11 at 1,362.7 MiB. The 1,536 MiB RSS ceiling is unchanged. No test scenario or
consumer assertion has been dropped.

| Check | Observed result | Remaining qualification |
|---|---|---|
| Whole-estate native typecheck | Native50 includes the artifact32 migration correction: zero diagnostics, 34.80s/5958.6MiB, unchanged 8192MiB/300s limits, verified teardown. The subsequent coverage controls and golden string need final CI | Final protected CI |
| Core7, four sequential shards | All9624 tests passed; unchanged resource budgets | Final CI revision |
| Focused driver/instrumentation integration |132/132 passed, including actual OTel, Neon SDK mocks and poisoned-row taxonomy | Final CI revision |
| CI6 integration repair |171/171 affected tests pass; SQLite selected-key recovery retains exactly two attempts, direct/array scalar failures retain V2006 metadata, and rejected async validators/callbacks remain contained. All3719 validation tests pass with100% coverage | Final CI revision |
| Root SQLite storage and scalar behavior |20/20 passed; physical storage races and transformed JSON null included | Full provider CI |
| Root client/schema followthrough |48/48 passed; diagnostics and executable docs144/144 passed | Final CI revision |
| Migration coverage and live precision | Artifact32 source passes all 2,099 tests across 131 files in 14.90s/1109.3MiB, with verified teardown. Coverage is 98.49% statements/lines, 97.32% branches and 99.46% functions against unchanged floors. Its 720 ordering permutations and all 19 original live carrier cases pass; the complete shared8 provider group passes 192 tests | Final protected CI |
| Native PostgreSQL and geospatial behavior |9/9 real PGlite passed, including480 distance points and historical second-offset timezones | Full provider CI |
| Neon TCP/HTTP and concurrency | All 12 live checks pass on artifact29 source in 7.69s/527.1MiB, including recovery after failed BEGIN, owned/supplied drivers, rollback and exact concurrent-write witnesses; teardown verified | Hosted fixtures are retained empty; no destructive cleanup |
| libSQL HTTP rollback |3/3 passed over real HTTP against official sqld0.23.0 | Hosted Turso and newer servers remain unqualified |
| Installed Node22.12/24 consumers | CI11 passes all33 grouped cases on both runtimes, retaining all53 compiler/scenario pairs. Node22 takes257.80s/1217.0MiB; Node24 takes225.96s/1215.2MiB, with unchanged limits and verified teardown. This includes actual value use across27 public subpaths, CommonJS/SQLite, extension recipes, absent peers and CLI configuration | The subsequent migration correction needs affected checks; protected-main and exact Node22.0 release-artifact proof remain |
| Exported declarations and cyclic models | Artifact27 completes 118 compiler/backend checks with zero unexpected failures; direct JS5.9/native7 and both working tsdown paths preserve strict TS5.8/native7 consumers. All emitted clients have exact literal links and zero elisions/getter functions; dense graphs pass through 96 models. Maximum child 3.878s/846.4MiB | Raw-model reconstruction remains lossy; stock native plugin lacks its expected peer and OXC requires annotations. Current JS backend retained; [full comparison](declaration-backends.md) |
| Full package qualification | Artifact32 builds in 2.15s/1024.5MiB; its archive is 2,055,036 bytes. The client representation is unchanged, but migration declarations changed and require package requalification. Artifact30's recorded equivalence to the earlier 118-row experiment is historical evidence; no repeat is claimed for32 | CI11 passes all 33 cases on Node22 and Node24 for artifact30's source. Final package, provider and protected-main checks still govern artifact32 |
| Documentation build and Worker | CI11 Linux build passes120 pages/121 fresh images in23.32s/1362.7MiB under the unchanged1536MiB ceiling, with verified teardown; generated-config Worker dry run passes1.37s/371.6MiB. The archived output contains145 HTML,137 JS,2 CSS,27 fonts and121 PNG. Local output parity preserves the nine Worker HTTP/MCP checks and hydrated tabs/search/navigation evidence | Final production deployment and readback remain; the previous CI10 failure is retained as historical evidence |
| Coverage gates | CI11 passes the complete Linux coverage lane, including the dispatch fix. Client coverage is 96.27% statements/lines, 94.04% branches and 97.56% functions; cache is 98.9%, 98.35% and 100%. All floors remain unchanged | Repeat on the subsequent migration correction |
| Driver coverage | CI11 passes: 96.68% statements/lines, 92.94% branches, 96.17% functions | Final CI revision |
| Query coverage |3176 tests across242 files pass;94.23% statements/lines,94.33% branches,95.37% functions; peak1356.9MiB | Final CI revision |
| Raptor and reached PGlite contracts | All 1331 Raptor tests across the original 102 files pass on Linux in 100.69s under the unchanged 120s aggregate. All 15 ordinary local shards also pass. Five later stale PGlite expectations are corrected while retaining effects, generated-ID order and provider refusal assertions; the original 14-file/251-test family passes locally in15.14s/1672.1MiB under its existing isolated-PGlite ceiling | Remaining provider stages and final Linux CI |
| [Remote CI8 at 1e64a2a83](https://github.com/beynar/viborm/actions/runs/37882838038) | Both package jobs, core, PostgreSQL/MySQL and Bun/D1 pass. Quality exceeds docs RSS with the previous heap; coverage exposes the environment-dependent test gap; local providers reach five stale PGlite oracles after the repaired Raptor stage passes | All eight protected checks on the final revision, then exact-main push CI |
| [Remote CI9 at997e84a1b](https://github.com/beynar/viborm/actions/runs/37883823754) | Core, coverage, Node24package, PostgreSQL/MySQL and Bun/D1 pass. Docs exceeds RSS during HTML; Node22package reaches300s without an assertion failure; later local provider tests expose the corrected transform duplication and fixture deadlocks | Final revision must pass all eight protected checks, then exact-main push CI |
| [Remote CI10 at f861f224b](https://github.com/beynar/viborm/actions/runs/37885400152) | Core, Node24 package, PostgreSQL/MySQL and Bun/D1 pass. The SQLite guard-ordering defect is now repaired and passes182 focused/boundary tests. Its two stale physical-dispatch oracles are corrected; the Node22 third-compiler timeout has a stricter combined-consumer check. Docs exceeds RSS with the previous352MiB heap | The next revision must pass all eight protected checks, then exact-main push CI |
| [Remote CI11 at58dd26646](https://github.com/beynar/viborm/actions/runs/37889590572) | Seven jobs pass, including both package runtimes, coverage and Linux documentation. Local providers reproduce 44 shared6 failures, now corrected and locally qualified with 163 tests. Shared7 also passes 229 tests. The later PostgreSQL rename-projection mismatch is repaired in artifact31 with its original preservation tests unchanged | Remaining providers and affected coverage, then all eight final checks and exact-main push CI |
| Actual D1 |41/41 passed after exact bigint metadata repair; catalog followthrough passes1/1 in actual Workers and2/2 SQLite scope cases, excluding protected internal tables while retaining user tables | Final CI revision |
| Production dependency audit |0 critical,0 high;2 moderate,1 low | Lower advisories remain disclosed |
| Patched dependency behavior | Real Prisma loader/merge, HTTP cache and Drizzle witnesses passed | CI repeats the same gate |


The security changes include compatible dependency updates plus two narrow
patches with actual adversarial fixtures: HTTP cache revalidation rules, and the
Prisma-private deepmerge update with its prior default Map semantics preserved.
The audit is unfiltered. Remaining lower advisories concern sprintf-js,
postcss-selector-parser and KaTeX; they are not hidden by ignore rules.

**Size and complexity.** The frozen production-source whole-perimeter count is
147,587 source-tree lines versus 141,375 at the reviewed upstream revision:
+6,212, or 4.39%, including source guides. Tests grew 3.54%, scripts 0.57% after removing the temporary
58-line memory diagnostic, live documentation 0.31%, and
benchmarks were unchanged. Counts include new files and both sides of moves,
comments and blank lines. No resource-policy amendment was applied.
Root build configuration and workflows are
separate from production source. This is controlled growth, not LOC parity.
New behavior remains with existing semantic owners, but the architecture has
not become small.

**What V1 still is not.** It has no SQL Server or CockroachDB contract, Studio,
read-replica router, cross-schema relation graph, first-class views/generated
columns, streaming API, maintained auth adapters, or migration import tool.
Provider qualification is per concrete driver; family resemblance is not hosted
execution evidence. PlanetScale and other conditional surfaces must retain their
published tier. Ordinary nested-WHERE field keys are now checked, but scalar
operators, variant filters, nested projections and nested mutation keys retain
explicitly pinned static gaps; runtime validation refuses unknown keys.
Getter-level relation key checking and
static foreign-key/relation-write exclusivity remain incomplete. Dynamic schema
types, complex generic wrappers, verbose hovers and large-schema editor cost
remain limitations. No new benchmark establishes a
speed advantage over Prisma or Drizzle, and no CI badge establishes adoption or
independent maintainership.

**A fresh roast.**

VibORM set out to eliminate code generation and accidentally built a legal
system. Every value has a semantic owner, every owner has a jurisdiction, and
before a boolean reaches PostgreSQL someone has filed three briefs explaining
why nobody else is allowed to know it is a boolean.

The architecture can explain the lifetime of a result array more precisely than
most companies can explain their payroll. That rigor pays off in the difficult
cases. It looked less impressive while an ordinary exported client could not
emit a declaration and a model called `order` was treated like contraband.

The old debugging experience was a locked evidence room with a helpful sign:
“Query execution failed.” Privacy is a good default. Destroying the clue and
then congratulating yourself on redaction is not a debugging strategy.

The test estate is enormous. That is useful when its tests enter through the
public API and touch the real provider. A thousand passing assertions about an
internal alias do not compensate for one customer who cannot install the
package without collecting every optional driver like supermarket stickers.

The documentation build was scanning sixteen thousand dependency files for
CSS classes and keeping three configuration graphs alive. Nothing says
“lightweight ORM” like the brochure requiring a memory investigation before
the database package can ship.

Zero codegen is still a real advantage. So are the polymorphic model and the
work already invested in exact value transport. But “zero codegen” is not the
same thing as zero complexity; the compiler was simply volunteered to do the
work during every edit. The remaining large-schema cost needs measurements,
not another paragraph declaring that inference is naturally O(1).

V1 earns its name by making ordinary operations trustworthy, publishing the
actual supported surface, and admitting where the product ends. It does not earn
it by having the longest constitution in the ORM aisle. The next useful boast
is a user successfully shipping something with it.
