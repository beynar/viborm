# G3-01 independent review

Review assignment: Sol 5.6/high. The runtime does not expose a model identifier
that I can independently inspect. Review date: 2026-09-14.

## Outcome

**Accepted with no production construction change.** The G3-01 handoff may
advance to G3-02. I found no missing construction fact that justifies a new
command kind, bulk interpreter, scope carrier, or per-position path.

The zero-diff result is not a compression claim. No production decision or code
was deleted in this unit, and none should be manufactured to create a saving.
Scalar bulk operations already enter `Commands.execute` with admitted row
objects and the operation-level `select`/`omit`, `limit`, and
`skipDuplicates` facts. They deliberately lower through the existing
set-mutation owner rather than through an ordered record-series tree.
Relation-bearing bulk already has the different structure it needs:
`RecordSeriesCommand` contains ordinary `RecordCommand` occurrences, while
`SelectedSeries` retains its selection, template, limit, and update/delete
mutation. Those two representations correspond to two real execution
semantics: set mutation and ordered record bodies.

The five red cases stop at explicit physical capability boundaries:

- mixed-shape and default-only scalar `createMany` stop in
  `OperationContext.createMany`;
- scalar duplicate suppression, scalar update returning with a limit, and
  delete returning stop in `Commands.execute` before their existing physical
  owners run.

These failures do not show that admission lost a row shape, defaulted value,
projection, limit, suppression request, or predicate. The passing `createMany`
omit control also shows that omit normalization already reaches the existing
selection/result path. G3-02 should remove or narrow the refusals only as it
extends `OperationContext`, `Queries`, and `CommandExecution`; it should not
invent another construction language.

## Validation

This was a read-only source and evidence review. I did not run a validator.

- The frozen engine directory has no working-tree production diff. The new
  source is one six-case contract plus registration and evidence files.
- The reviewed bulk receipt
  (`g3/unit01/red-reviewed/vitest.json`, SHA-256 `1ac15985…`) records exactly
  **1 pass / 5 failures** under Node 24.21.0. The passing case is `createMany`
  omit. Each failure message names the current explicit missing capability; it
  is not a crash or an inferred result.
- The preserved G3P-03 receipt records **6/6**. It covers scalar set mutation,
  complete and incomplete array packaging, isolated result windows, and exact
  nested statement attribution.
- The preserved CS composition receipt records **4/4**. It exercises the same
  selected-series construction through active and untaken choice arms, nested
  series, terminal results, and limit zero. This is the relevant second-position
  evidence for the existing relation-bearing construction owner.
- The final reviewed test (SHA-256 `a3a05d06…`) now makes both disputed facts
  observable: default-only returned identities equal stored identity order, and
  limited-update returned `{ id, score }` rows equal the exact two changed rows
  while one eligible row remains unchanged. These assertion-only changes occur
  after the reviewed red run; the five pre-assertion refusals are unaffected,
  and G3-02 must execute the strengthened assertions green.
- The new mode is registered as exactly one file with six tests, is included in
  the fixed local inventory, and refuses test-name and profile filters. The
  original registered source identity is production
  `f45a9697cd83b5df938099d712a35fff986f67604bf32f5c2f3d5c5b312697a9`
  and harness
  `1b3fe6c3b2bca27e90fb3f81876af6c27e526a719c0b43a0e0495ae17a30033c`.
  The reviewed red rerun used harness `ce220014…`; the final assertion edit
  changes the harness again, so G3-02 must capture its fresh exact identity.

The evidence correctly remains a red handoff, not a passing gate or a claim
that C08-C11 are complete.

## Required G3-02 obligations

1. Correct the durable Raptor 3 guide when G3-02 lands. Its statement that scalar
   `createMany` lowers to one set-oriented statement conflicts with the accepted
   contiguous-row-shape contract and this witness's three runs. The precise rule
   is one set-oriented statement per contiguous physical row-shape run, subject
   to the existing bind partition; scalar `updateMany` and `deleteMany` retain
   their single-predicate statement rule.
2. Keep the next implementation at the existing owners. Mixed/default row
   grouping, generated results, scalar suppression, update limit plus returning,
   and delete pre-state returning are G3-02 physical/result obligations. Provider
   coverage, borrowed ownership, suppression rollback, progress, array
   packageability, and deeper cross-position failures remain G3-02/G3-03 work;
   this unit's baseline receipts do not qualify them.

## Risks

There is no construction blocker in the reviewed handoff. Final acceptance of
the new bulk mode remains unsound until the five missing capabilities execute
the strengthened contract green on source-bound evidence. The guide mismatch
in obligation 1 can misdirect implementation toward an invalid one-statement
scalar `createMany` rule, but it does not justify a production construction
change.
