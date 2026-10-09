# VibORM V1: response to the adversarial review

This report accompanies the V1 remediation branch based on `origin/main`
`a4a5b8dc607a9a8db506bd60ddb5125519d8ab0b`. The original checkout and its
pre-existing changes were preserved. Three GPT-6.1 Sol agents own the driver,
query and migration work; the root agent integrates, reviews and releases it.

**Release checkpoint: held, not published.** Arnaud requires fully unannotated
exported clients and client factories to preserve cyclic relation typing through
declaration emission. The schema-key carrier passes the 118-row
compiler/backend/scaling matrix on TypeScript 5.8 and 7. Artifact28 retains the
same declaration type expressions and passes33 package cases on Node24; its
grouped harness retains all53 compiler/scenario pairs (the original51 plus
recursive JSON on both compilers). Final Node22 and protected CI qualification
remain.
Caller getter annotations are unnecessary. Rebuilding a client from
already-emitted cyclic models is an explicitly accepted remaining limitation.
Version 1.0.0 is prepared, but npm latest
still points to 0.1.0. Documentation and protected CI qualification must
finish before the Release workflow can publish. This document will be updated
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
  advisory lock acquisition. Selected unsupported physical schema objects now
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

The current follow-through found a further runtime defect: fallback array
planning and execution could invoke statement transforms twice. The driver
fix defers transforms to dispatch and retains private prepared-statement
provenance; focused39-test and122-test boundary runs pass. The new runtime
artifact passes local package checks; race fixtures and final protected checks
are still being qualified. CI9 also exposes
two resource failures: Linux docs crosses1548.4MiB during HTML rendering, and
Node22 package checks reach the300s aggregate without an assertion failure.
Memory diagnosis is underway; grouped compiler runs reduce the local package
gate from107.33s to87.15s with exact scenario/source parity;
no test case, consumer check or resource ceiling has been dropped.

| Check | Observed result | Remaining qualification |
|---|---|---|
| Whole-estate native typecheck | Native45 includes the dispatch correction and all fixture/package changes: zero diagnostics,34.84s/5958.1MiB, unchanged8192MiB/300s limits, verified teardown | Final protected CI |
| Core7, four sequential shards | All9624 tests passed; unchanged resource budgets | Final CI revision |
| Focused driver/instrumentation integration |132/132 passed, including actual OTel, Neon SDK mocks and poisoned-row taxonomy | Final CI revision |
| CI6 integration repair |171/171 affected tests pass; SQLite selected-key recovery retains exactly two attempts, direct/array scalar failures retain V2006 metadata, and rejected async validators/callbacks remain contained. All3719 validation tests pass with100% coverage | Final CI revision |
| Root SQLite storage and scalar behavior |20/20 passed; physical storage races and transformed JSON null included | Full provider CI |
| Root client/schema followthrough |48/48 passed; diagnostics and executable docs144/144 passed | Final CI revision |
| Migration coverage and live precision |2075/2075 tests pass all coverage floors; real PGlite precision and MySQL catalog contracts pass | Final CI revision |
| Native PostgreSQL and geospatial behavior |9/9 real PGlite passed, including480 distance points and historical second-offset timezones | Full provider CI |
| Neon TCP/HTTP and concurrency |12/12 live checks passed, including recovery after failed BEGIN | Final CI revision |
| libSQL HTTP rollback |3/3 passed over real HTTP against official sqld0.23.0 | Hosted Turso and newer servers remain unqualified |
| Installed Node22.12/24.14 consumers | All 43 grouped package cases pass on both runtimes, retaining all 51 previous scenarios and adding recursive JSON output. This includes actual value use across 27 public subpaths, CommonJS/SQLite, extension recipes, absent peers and CLI configuration | Final protected CI |
| Exported declarations and cyclic models | Artifact27 completes 118 compiler/backend checks with zero unexpected failures; direct JS5.9/native7 and both working tsdown paths preserve strict TS5.8/native7 consumers. All emitted clients have exact literal links and zero elisions/getter functions; dense graphs pass through 96 models. Maximum child 3.878s/846.4MiB | Raw-model reconstruction remains lossy; stock native plugin lacks its expected peer and OXC requires annotations. Current JS backend retained; [full comparison](declaration-backends.md) |
| Full package qualification | Artifact28 passes33/33 onNode24.14 in87.15s/1218.1MiB; all53 compiler/scenario pairs and source/probe hashes are unchanged. Its34 declarations are equivalent to27 apart from two generated chunk references and one optional parameter label; no type expressions changed. Prior676 concrete equality controls and20 integrity regressions therefore remain applicable | Node22 and final protected CI on28 |
| Documentation build and Worker | The final 352MiB heap passes a fully cold build, including 121 freshly rendered images, in 11.50s/1373.8MiB; the actual checkout warm build passes 10.30s/1376.9MiB on Node24.21. All assets and rendered semantics match the locally inspected output. Link validation, generated-config dry run, nine Worker HTTP/MCP checks and hydrated tabs/search/navigation pass | Linux CI9 still exceeds RSS at1548.4MiB with352heap after all compiler and OG work. Final Linux CI and production deployment remain; the 1536MiB ceiling is unchanged |
| Coverage gates | CI9 now passes the complete Linux coverage lane, including CLI87/87 and all four CLI metrics100%. The disposable .env fixture proves loading before config evaluation and a real SQLite query; production loader code is unchanged | Repeat on the subsequent dispatch fix |
| Driver coverage |2017 passed,680 explicit conditional skips across62 current chunks;96.65% statements/lines,92.76% branches,96.16% functions | Final CI revision |
| Query coverage |3176 tests across242 files pass;94.23% statements/lines,94.33% branches,95.37% functions; peak1356.9MiB | Final CI revision |
| Raptor and reached PGlite contracts | All 1331 Raptor tests across the original 102 files pass on Linux in 100.69s under the unchanged 120s aggregate. All 15 ordinary local shards also pass. Five later stale PGlite expectations are corrected while retaining effects, generated-ID order and provider refusal assertions; the original 14-file/251-test family passes locally in15.14s/1672.1MiB under its existing isolated-PGlite ceiling | Remaining provider stages and final Linux CI |
| [Remote CI8 at 1e64a2a83](https://github.com/beynar/viborm/actions/runs/37882838038) | Both package jobs, core, PostgreSQL/MySQL and Bun/D1 pass. Quality exceeds docs RSS with the previous heap; coverage exposes the environment-dependent test gap; local providers reach five stale PGlite oracles after the repaired Raptor stage passes | All eight protected checks on the final revision, then exact-main push CI |
| [Remote CI9 at997e84a1b](https://github.com/beynar/viborm/actions/runs/37883823754) | Core, coverage, Node24package, PostgreSQL/MySQL and Bun/D1 pass. Docs exceeds RSS during HTML; Node22package reaches300s without an assertion failure; later local provider tests expose the corrected transform duplication and fixture deadlocks | Final revision must pass all eight protected checks, then exact-main push CI |
| Actual D1 |41/41 passed after exact bigint metadata repair; catalog followthrough passes1/1 in actual Workers and2/2 SQLite scope cases, excluding protected internal tables while retaining user tables | Final CI revision |
| Production dependency audit |0 critical,0 high;2 moderate,1 low | Lower advisories remain disclosed |
| Patched dependency behavior | Real Prisma loader/merge, HTTP cache and Drizzle witnesses passed | CI repeats the same gate |


The security changes include compatible dependency updates plus two narrow
patches with actual adversarial fixtures: HTTP cache revalidation rules, and the
Prisma-private deepmerge update with its prior default Map semantics preserved.
The audit is unfiltered. Remaining lower advisories concern sprintf-js,
postcss-selector-parser and KaTeX; they are not hidden by ignore rules.

**Size and complexity.** The frozen production-source whole-perimeter count is
147,293 production-source lines versus 141,375 at the reviewed upstream revision:
+5,918, or 4.19%. Tests grew 3.28%, scripts 0.75% including the temporary
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
