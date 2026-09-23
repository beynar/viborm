# Raptor 3 — G3P-03 independent-review repairs

Date: 2026-09-09. Status: **two bounded review repairs implemented and
qualified; same-reviewer verification pending. G3P-04 and G3 remain closed.**

## Outcome

This repair bundle preserves the original [reviewed G3P-03
handoff](../g3-prep-03/g3-prep-03-report.md) unchanged and records the two P1
repairs requested by its independent reviewer.

[`OperationContext`](../../../../src/query-engine/raptor3/shared/operation-context.ts)
now installs the completed-result parser for an admitted empty `createMany`
before returning from preparation. The package is complete with zero queries:
`parseResult([])` returns `{ count: 0 }`, or `[]` for the selected form. No
dummy SQL or completion protocol was added. The existing array owner accepts
that zero-width first result window before a nonempty package, dispatches one
INSERT, and returns both member results in order.

[`Commands`](../../../../src/query-engine/raptor3/commands/commands.ts) now owns
the existing `updateMany` `limit`/`select`/`omit` refusal once, before deciding
between scalar set execution and a relation-bearing record series. Both routes
therefore raise `UnsupportedOperationError` before capture or mutation. No
limit, returning, admission guard, downstream defense, or public contract was
added.

The separately owned native witness is unchanged at SHA-256
`13f1496138c387a6e363c715bf9111efc6dcd2b68b15376946782daa919d7d1b`.
The existing package, transaction, array, admission, series, adapter, and driver
owners remain unchanged.

## Validation

The [repair index](g3-prep-03-repair-index.json) binds production
`81ab6b0979d4b078e67c5623cc52760aa209aa4b1961da8a485fac17286db262`,
harness `56b44be4dbb2b3533f548a5efa6c1ad6f5159151f86f1bee418f7ac3395b478c`,
and whole-owner cost identity
`bf57f363d7aab7a7648d86cdac0cbc515a031b9b319f75cd64bfaefba0316d09`.
Every accepted registered receipt embeds the same runner identity pair.

The focused red collected six local tests. The original four passed. The empty
package assertion failed because preparation returned `undefined`; the
relation-bearing refusal assertion failed because preparation resolved
`undefined` instead of raising `UnsupportedOperationError`. The exact
[`red receipt`](receipts/local-review-red.vitest.json) is preserved.

The explicit final receipt set is:

| Gate | Result | Receipt |
|---|---:|---|
| G3P-03 SQLite contracts | 6/6 | [`local-final`](receipts/local-final.verified.json) |
| G3P-03 PostgreSQL | 3/3 | [`native-pg-final`](receipts/native-pg-final.verified.json) |
| G3P-03 MySQL | 3/3 | [`native-mysql-final`](receipts/native-mysql-final.verified.json) |
| G1 comparison | 66/66 | [`g1-comparison-final`](receipts/g1-comparison-final.verified.json) |
| G1 transport | 44/44 | [`g1-transport-final`](receipts/g1-transport-final.verified.json) |
| G2 contracts | 216/216 | [`g2-contracts-final`](receipts/g2-contracts-final.verified.json) |
| G2.5 contracts | 6/6 | [`g25-contracts-final`](receipts/g25-contracts-final.verified.json) |
| G2.7 ownership | 6/6 | [`g27-contracts-final`](receipts/g27-contracts-final.verified.json) |
| Existing series-result owner | 14/14 | [`series-regression-final`](receipts/series-regression-final.vitest.json) |
| Existing client array owners | 17/17 | [`array-owner-regression-final`](receipts/array-owner-regression-final.vitest.json) |

All runtime results have zero failures and zero pending tests. PostgreSQL used
the cached 16.14 image and task-owned container `3ad5dad8b024…`; MySQL used the
cached 8.4.11 image and task-owned container `d9d5f075ee80…`. Each passed
readiness, ran with two CPUs, 1 GiB memory, random loopback exposure, and tmpfs
storage, then reported running, `OOMKilled=false`, and zero restarts. Both exact
containers were removed; the task-label census is empty.

One attempted focused series command selected `layer-query-engine`, collected
zero tests, and is preserved as a non-qualifying [setup
receipt](receipts/series-regression-setup-failure.vitest.json). The established
`layer-write-engine` invocation then collected and passed all 14 tests. It is
not counted as an engine failure or accepted evidence.

Whole-estate typecheck reports only the two unchanged Pattern diagnostics at
`pack.ts:1443` and `pack.ts:2633`; the exact output is
[`typecheck-final-known-pattern-failure.txt`](receipts/typecheck-final-known-pattern-failure.txt).
No G3P-03 source or witness diagnostic remains.

The [whole-owner cost](g3-prep-03-repair-cost.json) is 8,506 token-lines across
the same 28 owners. The [matched receipt](g3-prep-03-repair-matched-cost.json)
records 8,222 → 8,506 from accepted G3P-02, an actual +284. Relative to the
reviewed 8,500-line G3P-03 handoff, this repair is +6 lines in
`operation-context.ts`; the guard relocation changes no token-line count. The
historical 4,592-line G2.7 figure remains a narrower scope. No proportional
discount, bundle reduction, or completion percentage is claimed.

## Risks

- The same independent reviewer has not yet verified these two repairs. This
  bundle does not mark G3P-03, G3 preparation, or G3 accepted.
- Whole-estate typecheck remains non-green because of the two historical Pattern
  diagnostics. They are unchanged and outside this unit.
- G3P-04 suppression, replay, progress, and lifetime work has not started.
