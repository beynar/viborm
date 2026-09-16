# Performance pass 2 — allocation shape and reuse, within the rules (Arnaud, 16:55 2026-09-16)

Read `common.md` in full — Arnaud re-affirmed its twelve "Rules we learned
the hard way" for this pass, word for word; they bound every item below —
then `g4/cutover/perf-diagnosis.md` (§2 ranked breakdown, §4.2 cause 2, §4.3
cause 3 with its change B, §6 negative results), `g4/perf/note.md` (pass 1:
what was done, §4 "what was NOT taken", the next-candidates list),
`g4/cutover-proposal.md` §10–§12 (the identity-3 cells and the integrator
addendum), the private guide `src/query-engine/raptor3/AGENTS.md`, and
`src/sql/sql.ts` (a `Sql` fragment is immutable: readonly strings and values,
flattened lazily). Base: commit `ff5e77ca` (the committed pass-1 tree; the
main tree carries this pass). Never commit, stage, reset, stash or delete;
never run Biome `--write` on a whole file; one mode per Bash call with
bounded timeouts; restore falsifications from a scratch copy; touch neither
the shipped engine nor `benchmarks/**` (a measurement protocol path — if a
benchmark change seems needed, stop and report it).

Scope decided by Arnaud: squeeze the preparation cost as far as the rules
allow, with **no behaviour change** — every public answer, refusal sentence,
error class and meta, committed state, statement count, round-trip count and
the frozen fast-path counts stay identical.

## The cells that block, and their shapes (identity 3, `g4/cutover/performance-identity3.json`)

| Cell | Operation | Shipped B | Candidate N | Ratio | Budget |
| --- | --- | ---: | ---: | ---: | ---: |
| `scalar-find-unique/prepare` | `user.findUnique({ where: { id: "user_42" } })` | 13.65 µs/op | 19.85 | 1.454 | N ≤ 14.3 |
| `fixed-collection-rowref-1000/prepare` | `user.findMany({ where: { id: { startsWith: "user_" } }, orderBy: { id: "asc" }, select: { id: true, posts: { select: { title: true } } }, take: 1000 })` (`benchmarks/operation-pipeline-read-workloads.mjs:224-240`) — an EXPLICIT select with a nested relation select, so the default-projection memo of item 2 does not cover it; only per-field memos or item 3 can | 47.55 | 66.62 | 1.401 | N ≤ 49.9 |
| `bulk-update-returning-100/prepare` | `user.updateMany({ where: { id: { in: ids₁₀₀ } }, data: { age: { increment: 1 } } })` | 44.52 | 66.07 | 1.484 | N ≤ 46.7 |
| `fixed-collection-rowref-20/prepare` | same as rowref-1000 with `take: 20` | — | — | 1.051 / wall 1.20 (pass 1) | 5 % |

The measured cell is the package seam (`prepareOperationPlan` → `prepareBatch`),
so `OperationContext` construction, admission, `Queries.read`/`Commands.plan`
and the batch publication all count.

## Work, in this order

0. **Re-profile before any edit.** The pass-1 tree moved every number, so the
   diagnosis's §2 table is stale. For each of the three blocking cells:
   the ranked self-time breakdown as in §2 (CPU profile, allocation sampling
   at 128 B, `--trace-gc`), both engines, in a scratch copy of the main tree
   with `pnpm package:build` — NOT the perf worktrees, which the measurement
   unit owns. Write it as §0 of `g4/perf2/note.md`, then the
   decision-elimination gate per item (required behaviour, current owner,
   proposed change, the invariant that makes the removed work unnecessary,
   the falsifier) BEFORE the first production edit. Every later item names
   the ranked row it removes and reports the µs/op and bytes/op it actually
   removed.
1. **Rule 7 — pure reads allocate no write machinery.** `OperationContext`'s
   field block and constructor (`shared/operation-context.ts:111-260`)
   allocate for EVERY operation — a `findUnique` included — `attempt = new
   TransportAttempt()`, `committedMembers`, `memberAttribution`,
   `continuations`, `preparedGuards`, `answeredFailures`,
   `correlationId = crypto.randomUUID()` and whatever else the profile
   shows. Make each exist only when its owner first needs it (a lazily
   created field with `??=` or a getter, exactly like the two sentinels of
   pass 1), preserving initialisation-order semantics; check every reader
   for an "empty collection" assumption (`.size`, `.length`, iteration,
   `has`) so an absent collection reads as empty. Rule 3 forbids the
   alternatives: no read/write subclasses, no policy booleans, no second
   context class. Extend the audit to `Commands`, `relation-body.ts` and
   `execution.ts` for anything a read never needs. Falsifier: the
   allocation profile of `scalar-find-unique/prepare` shows the context's
   constructor and field block near the shipped engine's equivalent
   (state the B/op before and after); every read mode byte-identical; the
   write estate green.
2. **Rule 1 — immutable schema facts are resolved once.** Memoise per model
   (WeakMap keyed by the model object, like `EngineSchema.physicalField`),
   per (model, field) or per (model, field, alias) what the profile shows
   recomputed from the schema alone on every operation: `projectedColumn`,
   `scalarShape`/`leaf`, `table`/`column`, `identityOrder`, `totalOrder`,
   and the default projection's `selected` object and prepared field list
   (`Queries.prepareProjection` builds `Object.fromEntries(scalarFieldNames
   .filter(…).map(…))` per read when `args.select` is absent). A shared
   `Sql` fragment is safe because `Sql` is immutable — verify no consumer
   mutates or identity-compares one. The memo may hold NOTHING that came
   from an admitted input or from a database (rule 5: capture is not
   permanent truth): when `args.select`/`args.include`/`omit` shape the
   projection, prepare per operation as today, reusing only the per-field
   memoised pieces. Falsifier: bytes/op of `prepareProjection`,
   `lowerProjection`, `projectedColumn` on the read cells, the `--trace-gc`
   scavenge profile moving toward the shipped engine's (count and
   per-scavenge ms), results byte-identical.
3. **Measure, then decide on reuse.** Re-run the A/B after items 1–2. Only
   if a read cell is still over budget AND the profile attributes the
   residual to re-deriving the same structure per operation (diagnosis
   §4.3), implement reuse of the value-independent half of a prepared read
   — and only as ONE representation: the prepared projection, its lowered
   `Sql`, the shape, the decoder and the order terms without cursor values
   memoised per (model, operation, projection structure), the key supplied
   by the ONE admission walker (`EngineSchema.admit` attaching a structural
   token as a by-product of the walk it already does — never a second walk
   of the public syntax), values bound per operation by the same lowering
   owner from the admitted args (rule 4: admission, defaults and transforms
   still run once per input; nothing is replayed), bounded per `Queries`
   (one per engine and adapter). If it would need a second representation
   of the predicate (a template beside the prepared predicate), a second
   walker, or anything observed in the memo, STOP this item, write the
   decision-elimination answer that says why, and report the residual
   instead. Falsifiers: `fixed-collection-rowref-1000/prepare` falls by more
   than E; two successive identical calls publish byte-identical SQL
   (existing pin); the same structure with a different value publishes the
   same text with different parameters (new pin); a schema-equal second
   client does not see the first client's memo unless the memo is keyed by
   the model object it shares.
4. **Writes: `bulk-update-returning-100/prepare`, profile-driven.**
   `Commands.plan`, `Queries.updateValue`/`updateAssignment`,
   `prepareSelector`/`listValue` for an `in` list of 100 ids, the RETURNING
   projection, the set-mutation window. Pure allocation and derivation
   trims only, each named with its µs/op; rule 9 (one update language, no
   JavaScript arithmetic beside SQL), rule 6 (set-oriented bulk work), rule
   11 (no codec per verb) are the walls.

Never: cache absence or any observed fact; a second public-syntax walker; a
per-command or read/write class; a policy bag; a speculative hook; a codec
per verb; a change of statement or round-trip counts; a change of refusal
identities. If an item cannot reach its falsifier without crossing a rule,
the item is not taken and the note says so — Arnaud: "never waive a
contract for a deadline".

## Measurement before hand-off

As in pass 1: the A/B instrument (`scratchpad/perf-diag/` or equivalent) in
a scratch copy of the main tree with `pnpm package:build`, 3–5 alternating
fresh-process pairs, both engines, for the four cells above plus
`nested-conditional-found/full` and `scalar-find-unique/full`, CPU and wall
per operation before and after each item (cumulative), plus `--trace-gc`
and allocation sampling before and after. The formal 20-cell series runs
after the freeze; your numbers are attribution, not the verdict.

## Checks and record

Run, one per Bash call: `g4-unit02-author`, `g4-unit02-mysql-contracts` and
`g4-unit02-pg-contracts` (ports from `docker port …`; PostgreSQL 55729,
MySQL 55730 at the time of writing), `g4-read-contracts`,
`g4-route-lifecycle`, `g4-route-admission`, `g4-route-cache`,
`g4-route-transactions`, `g4-lifecycle-events`, `g4-lifecycle-admission`,
`g3-execution-review`, `g3-bulk-series`, `g3-transaction-array`,
`g3-suppression-retry`, `g2-contracts`, `g2-generated`, `g1-transport`,
`g2-transport`, `g3-generated-transport-smoke`, `g29-result-progress`,
`g2-mysql-contracts`, `g2-mysql-baseline`, `g2-pg-contracts`, and
`node scripts/run-typecheck.mjs` (only the two Pattern diagnostics). Frozen
fast-path counts must not move. Write `g4/perf2/note.md` (§0 profile, the
gate, then per item: the change, the invariant, the falsifier measured, the
A/B numbers, receipts under `g4/perf2/receipts/`), `g4/perf2/perf-pass-2.patch`
(`git diff ff5e77ca`, proper headers for new files), recapture identity
after the last edit, report the cost census (candidate core and whole tree,
before and after; the guide's ceilings apply).

## Exit and return value

Structured summary: unit, summary, location, notePath, patchPath, items
(taken / not taken with the rule that stopped it), measurements (cell →
before/after CPU and wall µs/op, both engines, cumulative per item), suites,
native, typecheck, cost, cellCounts, identity, blockers, unverifiedClaims.
