# Distinct-truth compression baseline (Phase 0, unit 0.1)

Pinned baseline for `docs/architecture/query-engine-distinct-truth-compression-plan.md`
Phase 0. Every number is a measurement taken at the commit named here, in the
clean implementation worktree. Later phases compare against this file.

## 1. Repository state

| Item | Value |
| --- | --- |
| Branch | `by-query-engine-distinct-truth-compression` |
| HEAD | `a04c5999` ("docs: plan distinct query engine truth ownership", stacked on the closing lift commit `7a05d156`) |
| Worktree | clean — zero dirty files at measurement |

The shared workspace retains ~74 unrelated dirty/untracked user entries
(client, result-parser, validation, benchmark, documentation WIP). None of it is
in this worktree; none of it is touched by this plan.

## 2. Structural census

Tool of record: `scripts/query-engine-structure.mjs` (same as the lift's A1).
Every value reproduces the plan's expected baseline exactly.

| Metric | `src/query-engine` | `write-engine` alone |
| --- | --- | --- |
| TypeScript files | 118 | 34 |
| Physical LOC | 42,281 | 23,841 |
| Token-bearing LOC | 31,299 | 17,013 |
| Functions | 1,572 | 857 |
| Branch nodes | 3,658 | 1,714 |
| Runtime import cycles | 1 component / 6 files | **0** |

The one whole-layer cycle is the pre-existing six-file `builders/` component
(correlation-utils, many-to-many-utils, relation-data-builder,
relation-filter-builder, where-builder, where-unique-builder).

Refusal inventory: **15** `new UnsupportedOperationError` construction sites in
`src/query-engine/write-engine`, expressing ten write-engine invariants
(`docs/architecture/guard-ownership-ledger.md` owns the reasoning;
`tests/contracts/engine/write/operation-construction-inventory.test.ts` owns the
counts and re-resolves all 19 classified src-wide coordinates — re-verified at
this HEAD).

## 3. Green baseline (sequential, memory-capped launchers)

| Command | Result |
| --- | --- |
| `pnpm test:types` ×3 warm | green; 22.49 / 24.94 / 21.80 → **median 22.49 s** (measured while four read-only census subagents loaded the machine; the lift's A1 median 16.71 s was quiet-machine — the final §8.5 comparison re-measures three warm runs on a quiet machine rather than comparing across load states) |
| `pnpm test:layer:query-engine` | 45 files / **794** tests passed |
| `pnpm package:build` | green (2.9 s) |
| `pnpm test` | 215 files / **4,998** tests passed |

### Closing-lift reconciliation (plan §6.1)

The closing lift recorded `pnpm test` 215/5,046 and layer 796 — measured in the
shared workspace with user WIP present. The committed tree holds 4,998/794.
Attribution measured, not assumed: the user's 17 dirty test files add ~60
`it(`/`test(` declarations (+1,220 lines) that exist only in the shared working
tree. **4,998 and 794 are the clean-tree baselines all phase comparisons use.**

The D1/workerd collection failure (`@paralleldrive/cuid2` top-level init) is a
recorded pre-existing baseline failure, re-verified only at final validation;
it is never counted as passed and never as a compression regression.

## 4. Preflight counts (plan §6.2)

Measured by four read-only census lanes; full evidence with per-site file:line
tables in the session records. Headlines:

| Fact | Count at HEAD |
| --- | --- |
| `BoundRelation.kind` decision sites | 58 grouped sites / 80 comparisons across 15 files (+12 via `isPolymorphicChildHeldRelation`/`isChildHeldRelation`); axis split: position 26, membership 23, cardinality 5, cross-product 4; **no `switch` on `.kind` exists anywhere** |
| Raw `RelationInfo.type`/`isToOne`/`isToMany` branches outside `bindRelation` | 19 (12 read-side) |
| `getManyToManyJoinInfo()` production call sites | **14** (plan corrected from ~16) |
| Child-entry `switch (entry.kind)` dispatchers | 7; the ordinary/polymorphic duplication is `interpretPolymorphicChildHeld` vs the ordinary triple, all reaching the same 8 leaf builders |
| `RelationMembershipBinding` construction sites | 23 (9 raw literals bypassing both binders) |
| `planningOutputs` | 1 declaration + 9 src call sites; §3.8 confirmed — no production custom subset exists |
| Statement-reference walkers | **7** in src (FragmentValidator ×1, OperationExecutor ×5, mutation-projection-fold ×1) |
| `Failure→Error` construction | 2 line-parallel owners; the floor message literal exists ×3 |
| `RecordSeriesOperation.mode` | declared; sole reader unreachable for a series (9.6 verified) |
| `processRelationOperations` | 1 call site; all 10 `buildUpdate` callers pass scalar-only data (9.4 confirmed dead — its deletion removes a silent drop, not a loud failure) |
| Pseudo-operations | **three** — `createManyAndReturn`, `updateManyAndReturn`, `deleteManyAndReturn` (13 membership tables); Phase 11 must include the third |
| Inverse scanners | 2 runtime (`getInverseRelationMap` — 9 call sites, not the ledger's seven — and `findInverseRelationState`, sole consumer `bindRelation`); they disagree on empty `.fields()` AND on unnamed ambiguity (silent first candidate vs thrown `Ambiguous relation`) |
| Model-key helpers | `getPrimaryKeyFields` 30 consumers (total, `["id"]` fallback, constraint order); cursor's `getCanonicalIdentityFields` differs in precedence, member order (shape-order re-sort), and fallback (`[]`); `getTargetIdentityFields` 7 flat-overlap consumers; `getForeignKeyTargetFields` 1 |

## 5. Witness verification (plan unit 0.1 items 3–6)

15 of 17 fast-path witness families EXIST with named coordinates; the C4
row-key≠reference-key pin, the `relationWriteKeys` polymorphic-drop pin, and
the 15/19 guard census all re-verified at HEAD.

Gaps closed by this phase's one new file,
`tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts`:

- **self-relation M2M read SQL had no witness of any kind** (only behavioral
  junction-row assertions);
- read-side SQL pins were substring-only (`toContain`/`toMatch`), while
  Phase 7's keep gate diffs byte-identical serialized SQL + parameters. The new
  file pins complete statements for the scalar-FK, compound-FK, polymorphic
  inverse, ordinary M2M, self-M2M, lateral, and correlated-subquery strategies.

Recorded, deliberately not pinned: `buildCorrelation`'s junction refusal
(`builders/correlation-utils.ts:56-61`) is unreachable — all four callers
dispatch M2M away first — and has zero coverage in either direction. If Phase 7
deletes it, the honest gate is those four dispatch coordinates, not a green run.

## 6. Phase-0 plan corrections (unit 0.1 action 2)

Two live-code-differs corrections were applied to the plan document:
`getManyToManyJoinInfo` call-site count 16 → 14, and the Phase 2 preamble now
records the second scanner disagreement (unnamed ambiguity) beside the named
empty-`.fields()` one.

**The baseline is green. Phase 1 may proceed.**
