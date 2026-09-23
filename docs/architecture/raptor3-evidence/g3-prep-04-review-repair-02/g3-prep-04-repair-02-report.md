# Raptor 3 — G3P-04 second independent-review repair

Date: 2026-09-11. Status: **second and final bounded repair of the borrowed
pre-effect suppression family implemented and qualified; independent verification
pending. G3P-05 and G3 remain closed.**

## Outcome

This package preserves both the original [reviewed G3P-04
handoff](../g3-prep-04/g3-prep-04-report.md) and its [first repair
package](../g3-prep-04-review-repair/g3-prep-04-repair-report.md). The reviewer
accepted the recovery-authority and terminal-series repairs, but found that the
pre-effect suppression rule did not escape a `Choose` when both arms existed.

`OperationContext` now owns a direct suppression-capability requirement.
`Commands.analyze` invokes that requirement through its existing semantic
traversal for every statically constructed suppressed record. Because the same
traversal already analyzes both `Choose` arms, an unsupported borrowed
suppression in either the found or missing arm refuses before the enclosing
root can emit SQL. Ordinary branch-local refusals keep their conditional timing.
There is no second payload walker, permission flag, string-error match, or broad
refusal propagation rule. The runtime member boundary keeps the same
context-owned rule for dynamic series.

The first repair's other two rules are unchanged. Attempt replacement still
requires the qualified standalone physical batch route; borrowed execution
preserves the original failure. Selected static record series still retain
successful complete identities and publish terminal state once in input order.

## Validation

The [repair index](g3-prep-04-repair-02-index.json) binds production
`939810eee04971c33ff625047ba7bc8187e8b078e0567d5dc09d2f0ed5a8e5c3`,
harness
`4c8c2c4a4330655fcab55d203977bfe726240072af0ad7c2d37c4b388db941f9`,
and whole-owner identity
`0cd8da7e085fbfe46e3a39437d2a34bae42bda9fb054b41653cd9e690be1e52e`.
Every accepted registered receipt embeds the same runner identity pair.

Before the second repair, the five-case local gate passed the three accepted
first-repair cases and failed both new `Choose` cases. The found-arm candidate
tape was `SELECT, UPDATE, SELECT, SELECT`; the missing-arm tape was `SELECT,
UPDATE, SELECT`. Both let the enclosing parent update commit before the caller caught
V5001. After the repair, all five cases emit zero candidate statements and
leave the parent unchanged.

| Gate | Result | Peak sampled RSS | Receipt |
|---|---:|---:|---|
| Review SQLite | 5/5 | 513.6 MiB | [`local-review-final`](receipts/local-review-final.verified.json) |
| Original G3P-04 SQLite | 5/5 | 517.1 MiB | [`local-original-final`](receipts/local-original-final.verified.json) |
| G3P-04 MySQL | 4/4 | 546.8 MiB | [`native-mysql-final`](receipts/native-mysql-final.verified.json) |
| G3P-04 PostgreSQL | 4/4 | 500.3 MiB | [`native-pg-final`](receipts/native-pg-final.verified.json) |
| G1 comparison | 66/66 | 711.8 MiB | [`g1-comparison-final`](receipts/g1-comparison-final.verified.json) |
| G1 transport | 44/44 | 645.4 MiB | [`g1-transport-final`](receipts/g1-transport-final.verified.json) |
| G2 contracts | 216/216 | 785.3 MiB | [`g2-contracts-final`](receipts/g2-contracts-final.verified.json) |
| G2.5 contracts | 6/6 | 466.4 MiB | [`g25-contracts-final`](receipts/g25-contracts-final.verified.json) |
| G2.7 ownership | 6/6 | 487.9 MiB | [`g27-contracts-final`](receipts/g27-contracts-final.verified.json) |
| G3P-03 SQLite | 6/6 | 485.3 MiB | [`g3p03-local-final`](receipts/g3p03-local-final.verified.json) |
| G3P-03 MySQL | 3/3 | 496.0 MiB | [`g3p03-native-mysql-final`](receipts/g3p03-native-mysql-final.verified.json) |
| G3P-03 PostgreSQL | 3/3 | 461.0 MiB | [`g3p03-native-pg-final`](receipts/g3p03-native-pg-final.verified.json) |
| Existing series-result owner | 14/14 | 486.0 MiB | [`series-regression-final`](receipts/series-regression-final.vitest.json) |
| Existing client-array owners | 17/17 | 536.9 MiB | [`array-owner-regression-final`](receipts/array-owner-regression-final.vitest.json) |
| Existing driver/savepoint owners | 52/52 | 483.9 MiB | [`driver-savepoint-regression-final`](receipts/driver-savepoint-regression-final.vitest.json) |

Every accepted runtime result has zero failures and zero pending tests. The G2
contracts include the existing conditional-upsert suite, which passes 11/11 and
pins unrelated branch-local refusal timing. The native G3P-04 witness contains
four top-level tests per provider; its fixture executes seven live worlds on
MySQL and eight on PostgreSQL because the cleanup witness is PostgreSQL-only.

PostgreSQL used cached image
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`
at server 16.14. MySQL used cached image
`sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb`
at server 8.4.11. All four final and retained containers used random loopback
ports, tmpfs data, two CPUs, 1 GiB memory, and no user database mounts. They
passed readiness, reported zero restarts and `OOMKilled=false`, and were removed
exactly. The task-label census is empty.

Witness interfaces were typechecked before provider qualification. The final
[typecheck receipt](receipts/typecheck-final-known-pattern-failure.txt) contains
only the two unchanged historical Pattern diagnostics at `pack.ts:1443` and
`pack.ts:2633`; no G3P-04 source or witness diagnostic remains.

The [whole-owner cost](g3-prep-04-repair-02-cost.json) and [matched
receipt](g3-prep-04-repair-02-matched-cost.json) record 8,745 token-lines across
the same 28 owners: +4 from the first 8,741-line repair package and +55 from the
reviewed 8,690-line handoff. The historical 4,592-line G2.7 figure is a narrower
scope. This unit makes no bundle, completion-percentage, or performance claim.

## Risks

- Independent review has not yet accepted the second repair. G3P-05 stays
  closed.
- The two-repair budget for the borrowed pre-effect suppression family is
  exhausted. If the same minimized failure survives, work stops for Arnaud's
  decision instead of adding another placement patch.
- Plain borrowed suppression and replay remain deliberately refused. G3 public
  transaction authority integration and atomic-array composition are unproved.
- Whole-estate typecheck remains non-green only because of the two disclosed
  historical Pattern diagnostics.
