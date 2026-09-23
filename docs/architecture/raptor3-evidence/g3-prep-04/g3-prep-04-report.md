# Raptor 3 — G3P-04 suppression, replay and lifetime

Date: 2026-09-11. Status: **implemented and qualified; independent review
pending. G3P-05 and G3 remain closed.**

## Outcome

G3P-04 extends the selected command representation through its existing owners.
`commands.ts` and `execution.ts` now share one static record-series form;
`relation-body.ts` places relation-bearing nested `createMany` through that same
form. `OperationContext` owns the standalone member rollback region and absorbs
only an exact annotated root `UniqueConstraintError` after the nested rollback
has succeeded. A root conflict discards its prerequisite and descendants, while
a healthy suffix still executes. Descendant unique errors, foreign-key errors,
and rollback cleanup failures remain fatal.

Conditional skip-to-match replanning uses one exact error identity stored in the
current command attempt. It replaces that attempt once without repeating public
admission, replaying acknowledged work, or authorizing a missing INSERT. The
plain borrowed binding still refuses suppression before member effects: a
payload does not grant savepoint authority. G3 must obtain a separately admitted
rollback region from the existing public transaction owner before it can compose
this behavior in callback or array transactions. That public authority
integration is not proved here.

The native MySQL result-publication defect required two bounded production
repairs. The final interactive rule consumes `QueryResult.insertId` only on a
dialect without `RETURNING`, only for the schema-declared generated increment
field, and decodes that value through the existing field codec. Any other
demanded output on that route that cannot be represented refuses before INSERT.
This repairs MySQL generated prerequisite identity without diverting SQLite
from its `RETURNING` rows. The two-repair family budget is exhausted for this
publication failure.

## Validation

The [index](g3-prep-04-index.json) binds production identity
`ec7d4c0a192b216a275c0e3babf66e52cd193bb6ab68ae4d20577915e8be47e4`,
harness identity
`be5e745f02ae826592a313244ecc2f0c43eac7d34affa2fb2f9944a9192be2e0`,
and whole-owner identity
`417f0ce70d2b0be8d591e0932018e66abdedb4aa924972c781951d7031c12ef9`.
Every accepted registered receipt embeds the same runner identity pair.

| Gate | Result | Peak sampled RSS | Receipt |
|---|---:|---:|---|
| G3P-04 SQLite | 5/5 | 504.7 MiB | [`local-final`](receipts/local-final.verified.json) |
| G3P-04 PostgreSQL | 4/4 | 515.0 MiB | [`native-pg-final`](receipts/native-pg-final.verified.json) |
| G3P-04 MySQL | 4/4 | 499.0 MiB | [`native-mysql-final`](receipts/native-mysql-final.verified.json) |
| G1 comparison | 66/66 | 643.8 MiB | [`g1-comparison-final`](receipts/g1-comparison-final.verified.json) |
| G1 transport | 44/44 | 687.3 MiB | [`g1-transport-final`](receipts/g1-transport-final.verified.json) |
| G2 contracts | 216/216 | 772.5 MiB | [`g2-contracts-final`](receipts/g2-contracts-final.verified.json) |
| G2.5 contracts | 6/6 | 523.8 MiB | [`g25-contracts-final`](receipts/g25-contracts-final.verified.json) |
| G2.7 ownership | 6/6 | 482.5 MiB | [`g27-contracts-final`](receipts/g27-contracts-final.verified.json) |
| G3P-03 SQLite | 6/6 | 498.0 MiB | [`g3p03-local-final`](receipts/g3p03-local-final.verified.json) |
| G3P-03 PostgreSQL | 3/3 | 491.6 MiB | [`g3p03-native-pg-final`](receipts/g3p03-native-pg-final.verified.json) |
| G3P-03 MySQL | 3/3 | 495.2 MiB | [`g3p03-native-mysql-final`](receipts/g3p03-native-mysql-final.verified.json) |
| Existing series-result owner | 14/14 | 539.1 MiB | [`series-regression-final`](receipts/series-regression-final.vitest.json) |
| Existing client-array owners | 17/17 | 534.7 MiB | [`array-owner-regression-final`](receipts/array-owner-regression-final.vitest.json) |
| Existing driver/savepoint owners | 52/52 | 460.1 MiB | [`driver-savepoint-regression-final`](receipts/driver-savepoint-regression-final.vitest.json) |

Every runtime result has zero failures and zero pending tests. PostgreSQL used
cached image
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`
at server 16.14; MySQL used cached image
`sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb`
at server 8.4.11. The final containers used random loopback ports, tmpfs data,
two CPUs, 1 GiB memory, and no mounts. Both were healthy before exact removal;
the task-label census is empty. The native witness asserts the established
provider-specific normalized metadata and redacted diagnostics. It makes no
native savepoint-count claim; only PostgreSQL owns the post-outer-rollback
cleanup hook.

The first whole typecheck exposed witness-only narrowing, override-signature,
and generic-subtype diagnostics. Those were repaired without changing runtime
behavior, and all identity-bound gates were rerun on the final harness. The
final [typecheck receipt](receipts/typecheck-final-known-pattern-failure.txt)
contains only the two unchanged Pattern diagnostics at `pack.ts:1443` and
`pack.ts:2633`; no G3P-04 diagnostic remains.

The [whole-owner cost](g3-prep-04-cost.json) is 8,690 token-lines across the same
28 owners as accepted G3P-03. The [matched receipt](g3-prep-04-matched-cost.json)
records an actual increase of 184 token-lines: +1 in `command-attempt.ts`, +23
in `commands.ts`, +49 in `execution.ts`, +19 in `relation-body.ts`, and +92 in
`operation-context.ts`. The historical 4,592-line G2.7 figure is a narrower
scope. This unit makes no bundle, whole-engine reduction, or performance claim.

## Risks

- Independent Sol 5.6/high review has not accepted this unit. G3P-05 stays
  closed until that review passes.
- Plain borrowed suppression is deliberately refused. G3 public transaction
  authority integration, atomic-array composition, and late public operation
  outcome publication remain unproved.
- Whole-estate typecheck is not green because the two historical Pattern
  diagnostics remain outside this unit.
- If the same generated-output publication failure survives this second repair,
  advancement must stop for Arnaud's decision.
