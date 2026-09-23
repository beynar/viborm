# Raptor 3 — G3P-03 set mutation and preparation

Date: 2026-09-09. Status: **implemented and qualified; independent review
pending. G3P-04 and G3 remain closed.**

## Outcome

G3P-03 adds the minimum private executable set-mutation and atomic-package
slices. It does not change the shipped client route or public API.

[`Commands`](../../../../src/query-engine/raptor3/commands/commands.ts) owns the
one semantic route: scalar `createMany`, scalar `updateMany`, and `deleteMany`
select set execution; a relation-bearing `updateMany` keeps the existing
captured-record series. [`OperationContext`](../../../../src/query-engine/raptor3/shared/operation-context.ts)
owns their physical execution. Each scalar family emits one mutation statement,
uses admitted assignments and predicates, and returns the provider count or the
adapter's existing `RETURNING` projection. There is no select/lock/update loop.
The ordinary relation series keeps provider capture order and performs one
ordinary record body per captured occurrence.

The private factory now exposes
`prepareBatch(modelName, operation, rawArgs)`. It enters the same
[`EngineSchema`](../../../../src/query-engine/raptor3/shared/schema.ts)
admission and command dispatch as `execute`, but creates a preparation-owned
`OperationContext`. That context may queue a complete static operation and its
parser as the existing
[`PreparedBatchOperation`](../../../../src/query-engine/types.ts); it never
reads, dispatches, opens a transaction, or executes a segment. Only its exact
dynamic-planning sentinel becomes `undefined`. Validation, construction, and
provider failures still surface.

The existing [`TransactionOperationOwner`](../../../../src/query-engine/transaction-operation.ts)
and client array owners remain unchanged. The test-only operation view adds one
`executeWith(driver)` override so native witnesses can pass the real borrowed
transaction into the candidate. The array owner still decides between complete
package merging and one sequential caller-owned transaction. Two static nested
creates therefore produce isolated scratch UUIDs and independent result
windows, while one incomplete dynamic member prevents all native batch
dispatch. An unprepared candidate `atomic-array` execute remains the accepted
pre-admission refusal.

No duplicate mutation interpreter, array coordinator, lifecycle, transaction
protocol, public driver flag, sort rule, suppression rule, or retry rule was
added. No existing production implementation was deleted. The existing package,
array, adapter, driver, admission, and ordinary-series owners are retained and
charged whole.

The necessary distinction is now executable in two placements:

- Scalar set execution is proved by SQLite root mutations and by two ordinary
  array members sharing one borrowed PostgreSQL/MySQL transaction. PostgreSQL
  also proves representative multi-row returning; MySQL proves the count arm.
- Relation-bearing `updateMany` is proved on PostgreSQL and MySQL as a captured
  ordered series, then followed by a later `deleteMany` array member. The
  216-cell G2 suite remains its ordinary root/nested regression placement.
- Package completeness is proved by two merged SQLite candidate packages and by
  a dynamic selected series that returns `undefined` before any array dispatch.
  Existing current-client array-owner tests provide the retained-owner
  placement.
- A nested child unique failure is normalized at the base driver's per-query
  batch boundary with the child's context and physical statement index. The
  public array envelope remains `$transaction`; the driver's exact
  statement-attribution channel proves which child statement failed.

The bounded unsupported subset remains explicit: `createMany` duplicate
skipping, relation-bearing `createMany`, mixed/default-only row shapes, bulk
limits and wider returning on non-returning adapters are not implemented by
this prep slice. Wider bulk families, suppression, scoped replay, and progress
belong to later accepted units or G3.

## Validation

The [index](g3-prep-03-index.json) binds the exact source and harness manifests.
The established runner identity is production
`73b252b0e779182ee69fd8c6792a57fc5bb59927d2ed45f8fca6d53e736f186a`
and harness
`2e7a4e89678005b80d359215d8d2abab11fe70e0c4fa95ae85a23f003bc15ea4`.
Every accepted registered `.verified.json` receipt embeds both values. Focused
receipts ran inside the same frozen interval and are bound by the index's exact
file manifest.

The explicit final receipt set is:

| Gate | Result | Receipt |
|---|---:|---|
| G3P-03 SQLite contracts | 4/4 | [`local-final`](receipts/local-final.verified.json) |
| G3P-03 PostgreSQL | 3/3 | [`native-pg-final`](receipts/native-pg-final.verified.json) |
| G3P-03 MySQL | 3/3 | [`native-mysql-final`](receipts/native-mysql-final.verified.json) |
| G1 comparison | 66/66 | [`g1-comparison-final`](receipts/g1-comparison-final.verified.json) |
| G1 transport | 44/44 | [`g1-transport-final`](receipts/g1-transport-final.verified.json) |
| G2 contracts | 216/216 | [`g2-contracts-final`](receipts/g2-contracts-final.verified.json) |
| G2.5 contracts | 6/6 | [`g25-contracts-final`](receipts/g25-contracts-final.verified.json) |
| G2.7 ownership | 6/6 | [`g27-contracts-final`](receipts/g27-contracts-final.verified.json) |
| Existing series-result owner | 14/14 | [`series-regression-final`](receipts/series-regression-final.vitest.json) |
| Existing client array owners | 17/17 | [`array-owner-regression-final`](receipts/array-owner-regression-final.vitest.json) |

Every runtime result has zero failed and zero pending tests. The G3P-03 local
cases prove set statement counts/returning, two-package scratch and result-window
isolation, validation-versus-incomplete preparation, zero dispatch for an
incomplete array, rollback, and exact nested statement attribution. Each native
profile proves three separately reported cases: scalar array commit, scalar
array failure rollback, and relation update-series order before a later array
delete. Both candidate members receive the same borrowed transaction driver and
candidate SQL carries no transaction-control statement.

PostgreSQL used cached image
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`,
runtime 16.14, and final container `40570558a6ce…`. MySQL used cached image
`sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb`,
runtime 8.4.11, and final container `0802439f23ae…`. Both used task-owned
databases, random loopback ports, tmpfs storage, two CPUs, and 1 GiB memory.
Readiness passed before Vitest. Each final post-run inspection reported running,
`OOMKilled=false`, and zero restarts. Both exact containers were removed and the
task-label census was empty.

Whole-estate typecheck reports only the two unchanged Pattern diagnostics at
`pack.ts:1443` and `pack.ts:2633`; the exact output and resource bounds are in
[`typecheck-final-known-pattern-failure.txt`](receipts/typecheck-final-known-pattern-failure.txt).
No G3P-03 source or witness type error remains. This is an honest external
estate failure, not a green typecheck claim.

The initial red receipts are preserved, not relabeled. The local 4/4 target
matrix failed before implementation: scalar set execution refused
`createMany`, and private package observation surfaced the missing
`prepareBatch` capability through the existing operation boundary. No
placeholder SQL execution was established. PostgreSQL and MySQL each failed
3/3: scalar creation was unsupported, the relation-series case reached the
unsupported later `deleteMany`, and the rollback case was blocked before a
provider failure. These are
[`local-red`](receipts/local-red.vitest.json),
[`native-pg-red`](receipts/native-pg-red.vitest.json), and
[`native-mysql-red`](receipts/native-mysql-red.vitest.json).

The first green attempt passed package completeness and incomplete-array
refusal, but failed on a missing import and on a test transport that bypassed
the base driver's per-statement attribution owner. Its
[`receipt`](receipts/local-first-green-failure.vitest.json) remains 2/4. The
production import was repaired once. The test transport now invokes the base
batch executor inside its single SQLite transaction, retaining the public array
envelope while exposing the existing child context/statement index. This is a
harness repair, not a public error change. Before that attempt, the scratch
witness was also corrected from looking for a generated SQL table name to
looking for the UUID parameter carried by the existing fixed batch-reference
table. The old assertion did not describe the actual scratch owner.

The subsequent SQLite/PG/MySQL greens used an earlier harness and are preserved
as `*-interim-green`; they are not in the accepted receipt list. Typecheck then
found erased prepared-row/optional-parameter types and three misplaced native
`@ts-expect-error` directives. The final source maps erased driver rows through
the existing trusted record boundary and materializes required prepared-query
parameters. The witness owner moved the three intentional directives to the
overloaded public `$transaction` call sites where TS2769 is reported. The
registered private test shells remain deliberately outside the public union;
runtime expressions and all three native cases are unchanged.

The [whole-owner cost](g3-prep-03-cost.json) has identity
`830530232c6a03340c24abf13fee6afc7c08b36d95e2c4386139db99dd5d99cd`.
Its manifest is broader than the runner production identity, so the two hashes
are different by scope and algorithm, not source state. The selected command
candidate charges 8,500 production token-lines across the same 28 whole owners
used by accepted G3P-02. The [matched receipt](g3-prep-03-matched-cost.json)
records 8,222 → 8,500, an actual +278 token-line delta: +51 in `commands.ts`,
+40 in `commands/index.ts`, +182 in `operation-context.ts`, and +5 in
`schema.ts`. The other 24 owners remain 6,510 lines in both measurements. The
historical qualified G2.7 narrow scope remains 4,592 lines; it is not a matched
baseline. No proportional discount, bundle reduction, or completion percentage
is claimed.

## Risks

- G3P-03 is pending independent Sol 5.6/high review. This report does not mark
  the unit, G3 preparation, or G3 accepted.
- The shipped client still uses the current engine. These private slices do not
  qualify public cutover or the complete inventory cells.
- The two historical Pattern type errors remain outside this unit. They are
  disclosed and unchanged, but whole-estate typecheck is not green.
- G3P-04 suppression, replay, progress, and lifetime work has not started.
