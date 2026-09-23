# Raptor 3 — G3P-04 independent-review repairs

Date: 2026-09-11. Status: **three bounded review repairs implemented and
qualified; independent verification pending. G3P-05 and G3 remain closed.**

## Outcome

This package preserves the original [reviewed G3P-04
handoff](../g3-prep-04/g3-prep-04-report.md) and records its three requested
P1 repairs.

`OperationContext` now derives suppression refusal from its existing execution
ownership. `Commands.analyze` attaches that refusal to a statically constructed
suppressed record and propagates it to the enclosing root before any root or
nested effect. The runtime member boundary reuses the same rule. A nested
borrowed `createMany(skipDuplicates)` therefore refuses with the enclosing
operation attribution before its parent UPDATE; a caller that catches the
error can commit only its own statements.

`OperationContext` also owns recovery permission. Exact INSERT and conditional
assertion recovery require the qualified standalone physical batch route and
its existing rejection proof. Borrowed and batch-preparation executions cannot
replace an attempt. Producer attribution remains available to legal
root-conflict suppression, but it grants no replay authority. A borrowed exact
failure surfaces by object identity after the original SELECT and INSERT.

Selected static record series retain each successful root's complete identity,
finish all members, and then use one ordinary `Queries` projection over an
exact OR predicate. The adapter's searched CASE restores input order. The
existing decoder enforces the expected row count. Later reparenting is visible
in returned scalar fields; a later primary-key move keeps the established exact
refusal. Skipped roots contribute neither identity nor result. There is no
UNION, injected carrier field, second result interpreter, or identity fallback.

## Validation

The [repair index](g3-prep-04-repair-index.json) binds production
`8670590ac1cb085f0a77190271ad2509ae302928e91269242ff62415f631b18b`,
harness
`8f6f82782bdc87e4081b16f572d6824d548b782036b5777658acb7938128d1d7`,
and whole-owner identity
`0b6956afac1a4878bdd1be656aca144a32ac16ab55f8fde2101d128d90fe3e0d`.
Every accepted registered receipt embeds the same runner identity pair.

The new local red gate failed all three cases on the reviewed source: nested
borrowed execution emitted two candidate statements, borrowed exact recovery
resolved instead of surfacing the injected failure, and the first returned
record kept a stale foreign key. The native red runs each collected four tests
and stopped at the new nested witness because the refusal named `createMany`
instead of the enclosing `update`; that observed attribution failure masked the
later zero-statement assertion and is not evidence that the masked assertion ran.
The initial zero-collection receipt is preserved as registration setup, not as
a semantic failure.

| Gate | Result | Peak sampled RSS | Receipt |
|---|---:|---:|---|
| Review SQLite | 3/3 | 502.1 MiB | [`local-review-final`](receipts/local-review-final.verified.json) |
| Original G3P-04 SQLite | 5/5 | 510.6 MiB | [`local-original-final`](receipts/local-original-final.verified.json) |
| G3P-04 MySQL | 4/4 | 540.8 MiB | [`native-mysql-final`](receipts/native-mysql-final.verified.json) |
| G3P-04 PostgreSQL | 4/4 | 517.8 MiB | [`native-pg-final`](receipts/native-pg-final.verified.json) |
| G1 comparison | 66/66 | 701.5 MiB | [`g1-comparison-final`](receipts/g1-comparison-final.verified.json) |
| G1 transport | 44/44 | 686.7 MiB | [`g1-transport-final`](receipts/g1-transport-final.verified.json) |
| G2 contracts | 216/216 | 781.0 MiB | [`g2-contracts-final`](receipts/g2-contracts-final.verified.json) |
| G2.5 contracts | 6/6 | 506.9 MiB | [`g25-contracts-final`](receipts/g25-contracts-final.verified.json) |
| G2.7 ownership | 6/6 | 497.7 MiB | [`g27-contracts-final`](receipts/g27-contracts-final.verified.json) |
| G3P-03 SQLite | 6/6 | 501.1 MiB | [`g3p03-local-final`](receipts/g3p03-local-final.verified.json) |
| G3P-03 MySQL | 3/3 | 531.2 MiB | [`g3p03-native-mysql-final`](receipts/g3p03-native-mysql-final.verified.json) |
| G3P-03 PostgreSQL | 3/3 | 516.4 MiB | [`g3p03-native-pg-final`](receipts/g3p03-native-pg-final.verified.json) |
| Existing series-result owner | 14/14 | 512.7 MiB | [`series-regression-final`](receipts/series-regression-final.vitest.json) |
| Existing client-array owners | 17/17 | 555.7 MiB | [`array-owner-regression-final`](receipts/array-owner-regression-final.vitest.json) |
| Existing driver/savepoint owners | 52/52 | 495.5 MiB | [`driver-savepoint-regression-final`](receipts/driver-savepoint-regression-final.vitest.json) |

Every accepted runtime result has zero failures and zero pending tests. The
native witness contains four top-level tests per provider; its fixture executes
seven live worlds on MySQL and eight on PostgreSQL because the cleanup witness
is PostgreSQL-only. PostgreSQL used cached image
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`
at server 16.14. MySQL used cached image
`sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb`
at server 8.4.11. All four final/retained containers used random loopback
ports, tmpfs data, two CPUs, 1 GiB memory, and no mounts. They passed readiness,
reported zero restarts and `OOMKilled=false`, and were removed exactly. The
task-label census is empty.

Witness interfaces were typechecked before native qualification. The final
[typecheck receipt](receipts/typecheck-final-known-pattern-failure.txt) contains
only the two unchanged Pattern diagnostics at `pack.ts:1443` and
`pack.ts:2633`; no G3P-04 source or witness diagnostic remains.

The [whole-owner cost](g3-prep-04-repair-cost.json) is 8,741 token-lines across
the same 28 owners. The [matched receipt](g3-prep-04-repair-matched-cost.json)
records +51 from the reviewed 8,690-line handoff: +1 in `commands.ts`, +12 in
`operation-context.ts`, +38 in `query.ts`, and no token-line change in
`execution.ts`. The historical 4,592-line G2.7 figure is a narrower scope. This
unit makes no bundle, completion-percentage, or performance claim.

## Risks

- Independent review has not yet accepted these repairs. G3P-05 stays closed.
- Plain borrowed suppression and replay remain deliberately refused. G3 public
  transaction authority integration and atomic-array composition are unproved.
- Whole-estate typecheck remains non-green only because of the two disclosed
  historical Pattern diagnostics.
