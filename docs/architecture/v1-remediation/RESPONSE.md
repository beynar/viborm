# VibORM V1: response to the adversarial review

This report accompanies the V1 remediation branch based on `origin/main`
`a4a5b8dc607a9a8db506bd60ddb5125519d8ab0b`. The original checkout and its
pre-existing changes were preserved. Three GPT-6.1 Sol agents own the driver,
query and migration work; the root agent integrates, reviews and releases it.

**Release checkpoint: not published.** Version 1.0.0 is prepared, but npm latest
still points to 0.1.0. Package, integration and protected CI qualification must
finish before the Release workflow can publish. This document will be updated
with the actual release evidence. Passing tests below describe their recorded
revision; a later edit requires the affected check to run again.

The accepted scope is to repair confirmed defects and explicitly retain product
gaps. It does not include SQL Server, Studio, cross-schema relationships, replicas,
new auth adapters, arbitrary geometry, or a general SQL query-builder product.
The [555-item ledger](findings.json) accounts for every indexed finding and PB-1–8
with its original title, severity, review classification, disposition and evidence.
A product gap is not a fixed defect; implemented-unverified means work remains.

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
- SQLite JSON comparisons use structural equality. PostgreSQL boolean aggregates
  use supported operators. Native string domains keep native identity comparison
  while text predicates use explicit supported text operations.
- Migration changes protect managed scope, physical constraint identity,
  decimal/temporal carriers, enum transitions, namespace qualification, and
  advisory lock acquisition. Selected unsupported physical schema objects are
  being given explicit pre-effect refusals; the missing declaration features
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

| Check | Observed result | Remaining qualification |
|---|---|---|
| Whole-estate native typecheck15 | Passed,27.40s,5290.0MiB /8192MiB | Final CI revision |
| Core7, four sequential shards | All9624 tests passed; unchanged resource budgets | Final CI revision |
| Focused driver/instrumentation integration |132/132 passed, including actual OTel, Neon SDK mocks and poisoned-row taxonomy | Final CI revision |
| Root SQLite storage and scalar behavior |20/20 passed; physical storage races and transformed JSON null included | Full provider CI |
| Root client/schema followthrough |48/48 passed; diagnostics and executable docs144/144 passed | Final CI revision |
| Migration core and live precision |1973/1973 core;66 Time6;3/3 real PGlite;67 transformed-default and78 SQL-contract checks | Full provider CI |
| Native PostgreSQL and geospatial behavior |8/8 real PGlite passed, including480 distance points | Full provider CI |
| Neon concurrency and row-lock schedule |5/5 passed | Final affected-driver rerun |
| Exported declarations and cyclic models | Minimal cyclic-type correction saved and native-checked | Fresh immutable package consumer proof |
| Production dependency audit |0 critical,0 high;2 moderate,1 low | Lower advisories remain disclosed |
| Patched dependency behavior | Real Prisma loader/merge, HTTP cache and Drizzle witnesses passed | CI repeats the same gate |


The security changes include compatible dependency updates plus two narrow
patches with actual adversarial fixtures: HTTP cache revalidation rules, and the
Prisma-private deepmerge update with its prior default Map semantics preserved.
The audit is unfiltered. Remaining lower advisories concern sprintf-js,
postcss-selector-parser and KaTeX; they are not hidden by ignore rules.

**Size and complexity.** The latest provisional whole-perimeter count is
146,400 production-source lines versus141,375 at the reviewed upstream revision:
+5,025, or3.55%. Tests grew2.06%, scripts0.11%, live documentation0.04%, and
benchmarks were unchanged. Counts include new files and moves. They will be
recomputed after the final batch. This is controlled growth, not LOC parity.
New behavior remains with existing semantic owners, but the architecture has
not become small.

**What V1 still is not.** It has no SQL Server or CockroachDB contract, Studio,
read-replica router, cross-schema relation graph, first-class views/generated
columns, streaming API, maintained auth adapters, or migration import tool.
Provider qualification is per concrete driver; family resemblance is not hosted
execution evidence. PlanetScale and other conditional surfaces must retain their
published tier. Nested clause typos can still pass TypeScript at the explicitly pinned depths;
runtime validation refuses unknown keys. Getter-level relation key checking and
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

Zero codegen is still a real advantage. So are the polymorphic model and the
work already invested in exact value transport. But “zero codegen” is not the
same thing as zero complexity; the compiler was simply volunteered to do the
work during every edit. The remaining large-schema cost needs measurements,
not another paragraph declaring that inference is naturally O(1).

V1 earns its name by making ordinary operations trustworthy, publishing the
actual supported surface, and admitting where the product ends. It does not earn
it by having the longest constitution in the ORM aisle. The next useful boast
is a user successfully shipping something with it.
