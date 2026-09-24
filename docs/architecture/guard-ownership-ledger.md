# Guard ownership ledger — `UnsupportedOperationError` construction sites

Package O, unit O1 of the query-engine limitation lift
(`docs/architecture/limitation-lift-plan.md` §6 Package O). Built at commit
`0ccd6abf`, 2026-08-11, by reading every construction site, its callers, its
pinned witnesses, and the test that asserts its message.

This document was built as an **analysis** in unit O1 and has since been
**EXECUTED** in units O2/O3 (same package, 2026-08-11, on top of `0ccd6abf`).
Every disposition below now records what happened, not what was proposed; the
witness-first protocol was followed for each change — run the named falsifier at
HEAD, apply the change, re-run, keep it only when the invariant is honestly owned
elsewhere. Three O1 findings did not survive measurement and are recorded as
disagreements at the end.

The gate (unit O4) then re-measured the lane rather than accepting it, ran the
architecture review §O4 requires above the band, and recorded both here.

> **Relation spellings before 2026-08-22.** This ledger is LIVE and is appended
> to, but the Package O analysis and the dated update notes below were measured
> against the retired six-factory relation API. Read their declarations as the
> history they are: the shipped language is two factories, `s.toOne` and
> `s.toMany`, and every cardinality, ownership and junction fact is derived by
> one schema-wide resolver
> ([`global-relation-cardinality-plan.md`](./global-relation-cardinality-plan.md)).
> The appendix and addendum at the end of this file record which guards that
> language deleted, and why.

> **CURRENT RELATION-STATE VOCABULARY (2026-08-22).** The bound membership is the
> physical owner. Its OwnWrite projections spell junction storage as
> `RelationMembershipScope.kind: "junction"` and
> `MembershipReadOrientation: "junction"`. The separate retired-discriminant
> AST census in `tests/fixtures/relation-language-census.ts` proves executable
> `"manyToMany"` state arms remain absent without banning many-to-many topology
> prose, fixture names, behavior names, or contract IDs.

> **PACKAGE D UPDATE (2026-08-13).** Selected shared-primary-key create,
> connect, connectOrCreate, update, and upsert now publish one exact arm-local
> value. The former `CreateOperation.assertSharedPkResolved` and
> `RecordUpdateCompiler.recordSharedKeyFold` sites are retired. Two execution
> boundaries were added for the new consumed-value transport: unresolved batch
> scratch may not cross a publication boundary, and a taken create arm cannot
> publish a database-produced field when batch execution can neither return it nor
> forward an exact consumed value. Package B separately owns PostgreSQL insertId
> lowering. Older site tables below are the Package O historical audit; this note
> supersedes their sites 4/20 dispositions.
>
> **PACKAGE E UPDATE (2026-08-13).** A singular child-held to-one supplier that
> PRODUCES its row now carries a composed `update`, as a nested
> `RecordSeriesStep` of exactly one member captured through the edge's exact
> physical-membership predicate. Cluster 8's site is DELETED and nothing replaces
> it. At that checkpoint the raw census was **13 write-engine / 15 query-engine /
> 17 whole `src`**, executable in `operation-construction-inventory.test.ts`, whose
> count-evolution block carries the 14 → 13 entry.
>
> **PACKAGE F UPDATE (2026-08-13).** An unnameable skipped junction target — a row
> whose generated key means the conflict fires on a constraint no `whereUnique`
> can spell — is now ONE savepoint-scoped series member holding the target subtree
> and its join row. Cluster 4's site 8 is RETIRED; cluster 13 records the site 31
> that took its position, with a SUBSTRATE invariant rather than an identity one.
> The raw census is unchanged at **13 / 15 / 17**, and so is the distinct-invariant
> total, over a strictly smaller set of refused shapes.
>
> **PACKAGE G UPDATE (2026-08-14).** Cluster 1 loses THREE of its four sites and
> gains none. Sites 2 and 3 spelled ONE sentence with a swapped noun; their
> acceptance predicates and INSERT ordering differ for real and both positions
> survive, but the VERDICT is now one owner,
> `RecordUpdateCompiler.requireRewrittenReferenceValue`, answering in the plan's
> three states — a value, an exact `null` (a CONTRADICTION, refused as
> `NestedWriteError`), and an unrepresentable operand (UNREACHABLE behind the parse
> boundary and CLASS IV legality, so `QueryEngineError`). Site 5 is FOLDED into
> site 15: the before-root target now demands the value from its own fresh subtree
> (`FreshRecordPart.requireRootReferenced`), which refuses under the fourth
> `FreshReferencePosition`, `beforeRootTarget`, with a byte-identical sentence.
> Every formerly-refused payload still refuses at the same phase with zero effects,
> witnessed on both positions and both substrates. The raw census is
> **10 write-engine / 12 query-engine / 14 whole `src`**, pinned by
> `operation-construction-inventory.test.ts`, whose count-evolution block carries
> the 13 → 10 entry. NOT taken, deliberately: the three `QueryEngineError` twins on
> the update root's polymorphic paths (item N2) read the same predicate and say the
> same thing in the engine-fault class; folding them CONVERTS a class on paths with
> no behavioral witness, and item N18 records that such a conversion owes one first.

> **COMPOUND-JUNCTION UPDATE (2026-08-14).** Package O's converted site 17 was
> already absent from the raw census. Its separate query/migration refusal is now
> retired too: one schema-owned complete `JunctionSide` group feeds migration,
> reads, writes, guards, cascades, and generated-value transport. At that checkpoint,
> raw counts remained **10 / 12 / 14**; the extra non-census engine-owned refusal
> invariant disappeared.
> Older site-17 and N11 rows below are Package-O history, not current capability.

> **GENERATED-OUTPUT UPDATE (2026-08-14).** Default batch operations now keep an
> exact fold where possible or carry the producer's own `RETURNING` through guarded
> committed segments. The static later-race-pin refusal is retired: an actual loser
> surfaces its original unique error with committed progress and is not retried.
> Site 28 remains only for an indivisible shared batch with no exact cross-statement
> output lowering, and site 32 now owns the missing compiler-continuation premise.
> At that checkpoint the raw census was **9 write-engine / 11 query-engine / 13
> whole `src`**.

> **BATCH-ONLY RECORD-SERIES UPDATE (2026-08-14).** Site 31 is RETIRED. Every
> no-transaction driver with a native atomic batch can run a safe progressive
> series after normalized awaited success. `supportsOrderedCommittedSegments`
> only strengthens callback-before-decode attribution; it is not an eligibility
> gate. A skippable root is isolated as its own atomic segment, and normalized
> row count suppresses that member before descendants run. This is safe only when
> no write or nested series precedes the root. A before-root effect remains a
> typed pre-effect refusal through site 27 because skipping would preserve the
> wrong prefix. The live raw census is **8 write-engine / 10 query-engine / 12
> whole `src`**.

> **NEXT CAPABILITY PLANS (2026-08-15).** The constructor census is an audit
> checksum, not the product backlog. The decision-complete
> [five-site lift plan](five-capability-lift-plan.md) owns sites 13, 19, 26, 27,
> and 28: it unifies sites 13 and 27's temporal row-key work as selected-row
> continuity while keeping site 27's bind-budget concern separate. The
> independent [exact fixed-decimal plan](fixed-decimal-plan.md) owns site 24,
> scalar/list representation, arithmetic, and schema evolution. Both plans
> record the boundaries that must remain; neither changes the live census until
> implementation lands.

> **EXACT FIXED-DECIMAL UPDATE.** Site 24 is **RETIRED**. SQLite now stores a
> decimal as its unscaled integer coefficient, so ordering, aggregating and
> arithmetic over a decimal are EXACT on every supported dialect and there is
> nothing left to refuse: `builders/decimal-portability.ts`,
> `AdapterCapabilities.supportsExactDecimal`, and all sixteen call sites are
> deleted in one unit with the exact SQLite lowering that replaces them
> (`git grep -c "assertExactDecimal\(Operation\|Aggregate\)(" e59b671a --
> src/query-engine/` sums to 16 across 8 files: aggregate-utils 1,
> orderby-builder 1, relation-orderby-builder 1, set-builder 4, where-builder 4,
> cursor-order 2, groupby 2, groupby-having 1).
> Cluster 12 is empty. The retired refusal's public-spelling enumeration is now
> `tests/contracts/engine/query/decimal-exact-surface.test.ts`, where every
> spelling must return the SAME EXACT ANSWER on PGlite and SQLite3.
>
> Two typed boundaries introduced by that lowering remain outside this ledger's
> `UnsupportedOperationError` census. The widened `_sum` HAVING operand past a
> provider's own aggregate domain uses `describeWidenedSumRefusal` and raises a
> `QueryEngineError` before I/O from `operations/groupby-having.ts`; SQLite
> carries 18 coefficient digits and saturates silently past them. Effectful
> MySQL migrations use `proveExactValueSessionMode` and raise a `MigrationError`
> before effects when the pinned session is non-strict. Ordinary arithmetic has
> its own same-statement exactness guard, so migration admission is not what
> makes runtime arithmetic fail loudly.

> **FIVE-CAPABILITY PACKAGE 1 UPDATE (2026-08-17).** Site 26 is RETIRED. Raw
> methods now return lazy, promise-compatible transaction operations that share
> the array coordinator with model operations. Validation, legacy warnings, and
> I/O begin only on await or transaction submission; client and scope ownership
> remain fail-closed. This package removes one whole-`src` constructor and no
> query-engine or write-engine constructor.

> **FIVE-CAPABILITY COMPLETION UPDATE (2026-08-17).** Packages 2–5 narrow four
> live sites without adding or deleting another construction position. Site 13
> now admits stable correlated update/found-upsert re-entry and follows the same
> selected row across an enclosing key transition. Site 27 no longer refuses a
> splittable create-many or junction insert merely because its compiled bind count
> exceeds the driver budget; the semantic builder chunks it and the executor keeps
> only indivisible-capacity and unsafe-placement refusals. Site 28 admits RETURNING
> scalar folds and snapshot-safe PostgreSQL-family mutation DAGs inside an
> indivisible array member. Site 19 admits a non-returning plural generated row key
> when an explicit addressable alternate unique locates the inserted row. The live
> constructor census is therefore **8 write-engine / 10 query-engine / 11 whole
> `src`**. Focused PGlite/SQLite contracts, the Package-3 real workerd D1
> contract, and the credential-free Neon HTTP fake are green evidence in this
> branch; this note does not claim the unrun Docker or hosted legs proposed by
> the plan.

> **DISTINCT-TRUTH PHASE 2 (2026-08-11, after this ledger closed).** Site 11
> (`RelationWritePart.assertOwnedFkAbsentFromUpdateData`, cluster 3) is DELETED,
> by its own recorded retirement path (named future unit 1): the two inverse
> scanners' candidate filters are aligned on `fields.length > 0` and one
> schema-layer resolver (`src/schema/relation/inverse.ts`) owns candidate
> discovery, so the zero-argument `.fields()` divergence — the site's only
> route — is unrepresentable and the parse omission refuses the spelled owned
> FK as `Unknown key` on EVERY schema. Measured before deletion: all four
> degenerate payloads now refuse at validation with zero statements
> (re-authored in `nested-update-owned-fk.test.ts`). The invariant count is
> unchanged at that phase because site 12 still owned cluster 3's adopt-seam half.
> Package C has since folded that decision into the selected-record final-assignment
> owner and narrowed site 13. That paragraph describes the Package C checkpoint;
> the later **14 write-engine / 16 query-engine / 18 whole `src`** figure was the
> Package D checkpoint, not the current census. The live table below is
> authoritative at **8 / 10 / 11** and is pinned by
> `operation-construction-inventory.test.ts`.
>
> Two more facts of the same change, both reviewed and ratified: (a) the
> alignment rides a SECOND, inert axis — candidates are now filtered to
> `manyToOne`/`oneToOne` everywhere, where the deleted engine scanners accepted
> any fields-bearing relation; no public builder can construct the divergent
> shape. (b) On the degenerate fields-less to-one over a NULLABLE foreign key,
> the aligned omission also makes `disconnect` AVAILABLE where the old schema
> refused it as `Unknown key` — the degenerate spelling now behaves exactly
> like its ordinary equivalent, witnessed in `nested-update-owned-fk.test.ts`.
> Cluster 3's disposition text and the future-unit list below are left as the
> lift wrote them; this note is the correction of record.

**Start here:** [What O2/O3 executed](#what-o2o3-executed) ·
[the §O3 audit](#o3-the-five-question-audit-on-every-survivor) ·
[disagreements](#disagreements-with-o1s-analysis-measured-in-o2o3) ·
[the §O4 adjudication record](#o4--the-architecture-review-adjudication-record) ·
[what the gate changed](#the-package-o-gate--what-it-changed-and-the-three-adversarial-findings-it-sustained).
The executable companion is
`tests/contracts/engine/write/operation-construction-inventory.test.ts`, which
counts the positions and re-resolves every coordinate; this file owns the
reasoning. When they disagree, that file is right about what is there.

## Raw census, three scopes

The third column is LIVE, re-measured at each note above; it is no longer the
O2/O3 number, because seven packages have moved it since.

| Scope | Command | O1 (at `0ccd6abf`) | O2/O3 | Live (after five-capability lift) |
|---|---|---|---|---|
| write-engine | `rg -c "new UnsupportedOperationError" src/query-engine/write-engine` | 21 | 15 | **8** |
| query-engine | `rg -c "new UnsupportedOperationError" src/query-engine` | 24 | 17 | **10** |
| whole `src` | `rg -c "new UnsupportedOperationError" src` | 26 | 19 | **11** |

Residual Packages H and I each moved none of the three. H narrowed one refusal's
REACH without touching a construction site, declined to add a provider capability,
and declined one class conversion (see the Package H note under cluster 13). I
added one CONJUNCT to the guard H narrowed and no site at all. Track A then retired
the static later-race-pin site, and the batch-only series lift retired site 31. The
live per-site table below supersedes every
coordinate in the historical cluster tables that follow it.

---

## Current live site table (SUPERSEDES the cluster coordinates below)

Re-measured site by site on 2026-08-17 with `rg -n "new UnsupportedOperationError("
src`, every owner declaration re-resolved by line, and every named falsifier RUN.
The cluster tables further down are the Package O *audit* and keep their O-era
coordinates on purpose — they record what a site was called when it was reasoned
about. **This table is what is there now.** Where the two disagree, this one is
right about the tree and `operation-construction-inventory.test.ts` is right about
both, because it executes.

Six of these eleven carry a name or a position the cluster tables never had:
sites 4, 13, 20, 27, 28 and 32 were introduced or renamed by the residual,
generated-output, and selected-row-continuity passes. Former sites 29 and 30 are retired by exact output
merge and guarded `RETURNING` segmentation. Site 33's static later-race refusal is
retired; site 31's blanket batch attribution refusal is retired; site 32 owns the
remaining continuation-premise boundary.

| # | Site (throw / owner declaration) | Owner | Invariant — the invalid state it alone names | First knowable boundary | Falsifier, RUN | Bucket |
|---:|---|---|---|---|---|---|
| 4 | `write-engine/final-root-assignment.ts:87` / `:41` | `FinalRootAssignmentTruth.contribute`, raising through `refuseFinalAssignment` | Two contributions claim DIFFERENT final values for one physical root column, or an equality that cannot be proved. | The record's own assignment ledger, seeded at construction and continued per `compile(known)` — the only point that has every contributor for one column. | `parity-e-shared-pk.test.ts` (38) · `shared-pk-update-root.test.ts` (71) · `adopt-owned-fk-agreement.test.ts` (31). All GREEN. | SC |
| 13 | `write-engine/RelationUpsertPart.ts:1113` / `:1109` | `refuseIncomingParentMutation` | Either a same-incoming delete/global-adopt target mutation lacks a selected continuation, or a correlated re-entry itself changes the incoming parent's row key and cannot publish that second final tuple to its enclosing compiler. Stable correlated update and found-upsert are accepted. | The relation seam owns the general overlap; `RecordUpdateCompiler` owns the key-changing re-entry, and both call this one message owner. | `nested-arm-dispatch.test.ts`: exact selected update/found-upsert and outer key transition succeed; same-incoming delete and inner key change retain distinct exact refusals. | SC |
| 15 | `write-engine/CreateOperation.ts:3520` / `:3512` | `requireRecordReferenced` (position selects the noun) | A fresh record cannot publish the referenced column an edge at this position needs — neither its primary key, nor knowable in its own create data, nor produced by its own INSERT. | Construction, in `CreateOperation`: `recordReferenced` is total over what an INSERT can publish. | `parity-f-fresh-field.test.ts` · `parent-held-lookup.test.ts` · `fresh-produced-field.test.ts` · `compound-relation-adoption.test.ts`. | MSI |
| 19 | `write-engine/CreateOperation.ts:3624` / `:3606` | `producedReference` | A NON-returning adapter is asked for a plural database-assigned row key and the create source supplies no complete explicit addressable alternate unique, so no post-insert read can name the row. | This boundary has adapter capability, database-assigned arity, and the create plan's proven post-write locator. | `residual-refusal-falsifiers.test.ts`: scalar and mapped-compound alternate locators publish exact keys; omitted/defaulted, null, `Sql`, raw-index-only, incomplete, and absent locators do not qualify; the unnameable row keeps the exact refusal and the RETURNING control performs no locator read. | PSI |
| 20 | `write-engine/CreateOperation.ts:3995` / `:3984` | `assertSelectedSharedPkValue` | The selected arm folding this record's OWN primary key resolves to `null`/absent, so the fresh root would key on nothing. | `compile(known)`, after the selected arm's planning lookup has exposed the referenced value and before the fresh root INSERT is built. | `residual-refusal-falsifiers.test.ts`: public alternate-unique connect resolves a nullable referenced key to `null`, raises this exact typed sentence, and leaves the root table empty; the concrete-key twin succeeds. | MSI |
| 27 | `write-engine/OperationExecutor.ts:1920` / `:1915` | `executionRefusal` | The active driver cannot execute one compiled unit exactly. Live reasons include an indivisible statement above its verified bind limit and progressive placement that would strand an effect before a skipped root. Splittable create-many and junction inserts are chunked before this boundary, and an enclosing key transition is no longer itself a refusal. | The executor is the first boundary with the active driver, final compiled bind count, and progressive placement/segment facts. | `create-many-bind-budget.core.test.ts` · `junction-progressive-preflight.test.ts` · `progressive-parent-rowkey.test.ts` · `record-series-contract.test.ts`. | PSI |
| 28 | `write-engine/OperationExecutor.ts:2397` / `:2387` | `assertIndivisibleGeneratedOutput` | An indivisible shared batch still needs provider-generated output across internal statements after the compiler tried its exact scalar and mutation-DAG folds. | The executor, before `_executeBatch`; default operations have already taken an exact fold or segmented route, and array operations cannot segment. | `mutation-dependency-fold.test.ts` pins accepted scalar/CTE folds and the retained relation projection over a sibling-mutated table; `extended-where-unique.test.ts` and `produced-compound-identity.test.ts` pin accepted explicit-array scalar outputs. | PSI |
| 32 | `write-engine/OperationExecutor.ts:2415` / `:2402` | `crossedReferenceContinuationGuards` | SQL crosses a provider-produced value into a later segment, but its publisher supplies no exact row premise to prevent wrong-owner reuse between segments. | Whole-fragment generated-output preflight, where the dependency edge and publisher batch facts meet. | `operation-construction-inventory.test.ts` pins the owner coordinate; continuation shape and identity are falsified in `fragment-validator.core.test.ts`, and live exact-membership races are pinned in `generated-output-continuation-race.test.ts`. | PSI |
| 22 | `query-engine/relation-key-legality.ts` | `assertSingleTargetMembershipMoveAppliesToRecords` | One named target-row membership or singular member-junction slot is applied to N > 1 roots: the last root would take it from the rest. | Only after capture — no schema can express an N-dependent rule. | `parity-k-update-many.test.ts` · `update-many-relation-series.test.ts` · `polymorphic-collection-write-family.test.ts`. | SC |
| 25 | `drivers/shared/transaction-options.ts:144` / `:139` | `refuseTransactionOption` | The driver does not implement the requested transaction option. | The driver capability boundary. | `transaction-options-behavior.core.test.ts` (layer-drivers). | PSI |

**Site 15's position note, measured at this pass.** `parity-f-fresh-field.test.ts`'s
"a nested create leaf" row was RED and it was not the stale-batch class. A child-held
nested `create` now carries an `incomingMembership` exactly as the adopt kinds do — the
seam the composed-supplier and record-series work needed — and that binding is built
from `childEdgeMembers` BEFORE `childFkAssign` runs, so the WHOLE-VALUE parent source
asks first and position `parentId` answers where the row expected `childEdge`. Same
site, same class, same construction phase, zero effects; only the noun moved, and it
moved to the one that is now true. The row's old comment claimed the create leaf and the
connect leaf "reach the SAME site by two payload paths" — they still reach one site, but
no longer one POSITION, and the witness now says so.

**The Package-I gaps were closed, and Track A retired one of those sites.**
`residual-refusal-falsifiers.test.ts` still reaches sites 19 and 20 through their
distinct first-knowable boundaries and pairs each refusal with its accepted control.
Former site 29 is now an acceptance contract: ordered provider results materialize an
output-only `consumedValue` alias after one native batch, while the same source used by
later SQL drives segmentation. The retained tests distinguish that merge from an
over-broad `Sql` refusal.

**The residual-I guard conjunct, which is not a site.** `completeTargetPresenceGuard`
gained an optional `membership` argument and `relation-membership.ts` gained
`resolveCorrelatedMembershipProgressivePremise`. No `UnsupportedOperationError` was
added, moved or deleted; every ordinary child-held progressive entrance now asserts the
exact membership tuple beside row liveness when its reference key differs. The reason is
under the Package H note below.

The executable census owner is
`tests/contracts/engine/write/operation-construction-inventory.test.ts`, which
pins the write-engine number and re-resolves every classified coordinate; when
this file and that one disagree, that one is right about what is there. §O4's
8–12 band is adjudicated against the **write-engine** scope — the set every
count-evolution entry in that file governs. The live census is **8 write-engine,
10 query-engine, 11 whole `src`**, so the write-engine count meets the band. The
mandatory review conducted when the count exceeded the band remains historical
evidence below; it is no longer the reason the current count is accepted. This
section does not guess a new invariant total: the live table above classifies every
surviving site, while the Package-O invariant arithmetic below is explicitly its
historical checkpoint. Site numbering is N3's throughout and is NOT renumbered.

> **CORRECTION AT THE PACKAGE O GATE (2026-08-11).** The O2/O3 draft of this file
> headlined 11/12 and the base as 12. Both were an undercount by one, and the
> undercount is inherited: it comes from counting **cluster 4 as one invariant**
> when its own row — and N3's original inventory text, and this document's own
> cluster-4 heading ("2 sites, TWO contracts") — argue it is two. Site 7 refuses
> because *the public meaning of a skipped root's nested effects is unchosen*
> (bucket DPC, boundary = the product contract) and site 8 refuses because *a
> skipped row produces no identity for its join row* (bucket MSI, boundary = the
> per-row join value). Different invalid states, different first-knowable
> boundaries, different falsifiers, neither answering the other. Counted as two,
> the arithmetic is: base 13 → **12** as `UnsupportedOperationError`, **13**
> engine-owned. The architecture review reached the same three numbers
> independently (see [the §O4 adjudication record](#o4-the-architecture-review-adjudication-record)),
> and the write-engine 10 the draft printed was right only because two errors
> cancelled there. `forbidden-shapes-reference.md` §12 and
> `operation-construction-inventory.test.ts` carry the same correction.

> **SUBSEQUENT OUTCOME (2026-08-13).** The relation-bearing bulk pass chose the
> suppress-the-whole-subtree contract and retired site 7. The arithmetic above
> remains the Package O historical record; the live cluster and census below
> reflect the delivered owner set.

## Column meanings (plan §6 O1)

- **Site** — file, function, and the live public route that reaches it.
- **Invariant** — one sentence naming the invalid domain state.
- **First knowable boundary** — the earliest trusted owner that can determine it.
- **Unique reachable failure** — a concrete input this site catches that no
  earlier site catches.
- **Falsifier** — the existing test that goes red if the guard is removed, or
  `NONE`.
- **Bucket** — N3's classification (`SC` semantic contradiction, `MSI` missing
  stable identity, `PSI` provider/substrate impossible, `DPC` deferred product
  contract, `UFF` unimplemented future feature).
- **Disposition** — keep · move-to-owner · replace-with-representation · delete.

Site numbers are N3's, so this ledger and the inventory narrative can be read
side by side.

---

## Cluster 1 — an unresolvable referenced value (7 sites in O1 → 4 after O2)

§O2 row 2, "fresh referenced field publication". Final owner per the plan:
CreateOperation demand publication, plus **one** selected-transition owner when
the value comes from UPDATE. Site 20 is moved out of this cluster into cluster 6
(see the disagreements section).

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| ~~2~~ | **RETIRED (residual G, split).** `RecordUpdateCompiler.ts:1800` · `postTransitionReference` · `client.M.update({ where, data: { <member of a COMPOUND non-cascade referenced key>: null, <childRel>: { create } } })` | A member of the reference the root SET rewrites has no post-transition value the fresh child can name (`null` names no row; an `Sql` value exists only after the database evaluates it). | Compile, inside the compiler — the per-member derivation pairs the located pre-value with the SET operand, and the located row exists only after planning. | `bay.update({ where: {id}, data: { slot: null, pads: { create } } })` on a `(area, slot)` compound reference: the arity-1 branch (site 3) is not entered, so only this site answers. | `parity-d-transition.test.ts:805` ("a rewritten column with no construction value") and `compiled-key-transition-behavior.ts:234` (+ `.test.ts` / `-docker.test.ts`). **The `"membership"` position gap is CLOSED** — residual Package G both witnessed it (`sql-operand-boundary-behavior.ts`, "the same null reaches the same owner through an ADOPT arm, at compile") and removed the noun that named it; see the post-O2/O3 gap list. The "UNPINNED" this cell carried was true when the row was written and is retired with the site. | MSI | **keep** (owner of the per-member derivation, established by Package D) |
| ~~3~~ | **RETIRED (residual G, split).** `RecordUpdateCompiler.ts:2017` · `resolveCreateParent` · `client.M.update({ where, data: { <arity-1 NON-PK referenced unique>: null \| Sql, <childRel>: { create } } })` | Same invariant as site 2, on the single-member non-primary-key branch. | Same. | `counter.update({ data: { token: null, tags: { create } } })` — arity 1, `token` not a PK member, so site 2's per-member path is never built. | `sql-operand-boundary-behavior.ts:186` ("null on a nullable referenced column is the ONE arm that reaches the engine") via `sql-operand-boundary.test.ts` / `-docker.test.ts`. | MSI | **KEPT — disposition reversed on measurement** (disagreement 1). It refuses a strictly WIDER operand set than site 2 and its accepted arm orders the INSERT differently; delegating would accept operands refused today. |
| ~~5~~ | **RETIRED → 15 (residual G, folded).** `RecordUpdateCompiler.ts:3612` · `beforeTargetReferencedValue` · `client.M.update({ where, data: { <parentHeldToOne>: { create: {…} } } })` | A before-root create target's referenced column is neither that record's primary key nor a knowable value in its own create data. | Construction — the subtree's `rootReferenced` is total over what an INSERT can publish. | An update root whose parent-held `create` target references a column the target's create data does not spell and the INSERT does not produce. | `parity-f-fresh-field.test.ts:858`; `parent-held-lookup-behavior.ts:619` via `parent-held-lookup.test.ts`. | MSI | **keep** — this is the plan's "one selected-transition owner when the value comes from UPDATE". |
| 14 | `CreateOperation.ts:991` · `interpretPolymorphicRelation` · `client.M.create({ data: { <direct polymorphic>: { create: {…} } } })` | A before-parent polymorphic create target's referenced column is unknowable. | Construction, in `CreateOperation`. | Nothing measured. Its own `connectOrCreate` twin — at `:1016` when this row was written, `:1027` at HEAD — states the SAME SENTENCE BYTE-IDENTICALLY as a `QueryEngineError`, one branch away. | **NONE** | MSI | **DONE — folded into site 15**, `requireRecordReferenced("beforeParentTarget")`. Its `query-engine` prefix was normalised to `query-engine-v2`, matching its three siblings; nothing pinned the difference. Its `connectOrCreate` twin keeps its `QueryEngineError` class and now shares the owner's message builder — disagreement 3. |
| 15 | **CURRENT COORDINATE: `CreateOperation.ts:3520`, declared `:3512`.** Historical: `CreateOperation.ts:2772` (declared `:2764`; N3 read the pre-fold position at `:1789`/`:1781`) · `requireRecordReferenced`, formerly `targetReferencedValue` · `client.M.create({ data: { <parentHeldToOne>: { create: {…} } } })` | A before-parent create target's referenced column is neither its primary key nor knowable in its create data. | Construction, in `CreateOperation`. | The create-root twin of site 5: a before-parent target referencing an absent nullable unique. | `parity-f-fresh-field.test.ts:842`. | MSI | **DONE — this IS the owner now.** `requireRecordReferenced(record, referencedField, relationName, position)`; the position selects the noun, the decision is made once. |
| 16 | `CreateOperation.ts:2109` · `referencedValue` · `client.M.create({ data: { <childHeld rel>: { create } } })` | THIS record's referenced column, which a child's foreign key must carry, is neither its primary key nor knowable in its own create data. | Construction, in `CreateOperation`. | A fresh parent whose child edge references a non-primary-key column the create data omits (`fresh-produced-field`'s `latches`/`slot`). | `parity-f-fresh-field.test.ts:813`, `:819`; `fresh-produced-field.test.ts:481`; `fresh-produced-field-behavior.ts:339`. | MSI | **DONE — folded into site 15**, position `childEdge`. |
| 18 | `CreateOperation.ts:2193` · `referencedParentSource` · adopt / junction / polymorphic child edge under `client.M.create` | The parent id a child edge consumes is unresolvable for the named referenced column. | Construction, in `CreateOperation`. | The whole-value parent-source spelling of site 16 (`compound-relation-adoption`'s `spots`/`slot`). | `parity-f-fresh-field.test.ts:830`; `compound-relation-adoption-behavior.ts:318` via `compound-relation-adoption.test.ts`. | MSI | **DONE — folded into site 15**, position `parentId`. |

**Compression note (EXECUTED).** All seven read one predicate family
(`recordReferenced` / `rootReferenced` returning `undefined`) and say one thing.
The plan calls this "the largest single compression opportunity in Package O, and
arithmetic rather than judgement". Sites 5 and 15 remain two owners (update root
vs create root) because §O2 names both; 14, 16 and 18 joined 15 behind one
construction site that takes a position argument, exactly as Package D did for
site 2. Site 2 kept its own owner and site 3 was measured and kept
(disagreement 1), so this cluster is 4 sites: 2, 3, 5 and 15.

**RESIDUAL PACKAGE G CLOSED IT (2026-08-14): the cluster is ONE site, 15.** The
compression note above stopped one step short, and the step it stopped at was the
right one to stop at with Package O's information — §O2 licensed two owners, and
disagreement 1 had just measured that sites 2 and 3 refuse DIFFERENT operand sets.
Residual §G1 supplied the missing distinction: the operand sets differ because the
two positions know different things (one has the located pre-value and can derive
portable arithmetic from it; the other runs before any read), while the VERDICT
they reach is the same in both. Splitting "what may I accept" from "what do I say
when I cannot" left the first with each position and gave the second one owner.
Site 5 needed no such split at all — it read the fresh subtree's own
`rootReferenced` and re-spelled site 15's sentence, so it simply asks the subtree
to answer now (`requireRootReferenced`). What the cluster refuses is unchanged;
what says so is one owner plus one contradiction owner outside this class.

**"ONE site, 15" is a CENSUS claim, and residual Package H narrows it to that, because
as a claim about DECISIONS it overstates.** The census is right: cluster 1 has one
`UnsupportedOperationError` construction site. What survives outside that class is a
same-predicate DOUBLE decision, and it is recorded here rather than left for a reader
to discover:

- `RecordUpdateCompiler.requireRewrittenReferenceValue` decides "is this rewritten
  reference member worth an exact value" for the two §G2 positions — `null` is a
  `NestedWriteError`, unrepresentable is a `QueryEngineError`;
- `operations/mutation-identity.getUpdatedPrimaryKeyValue` decides the same predicate
  for the branch that never reaches it — a ROW-KEY member the locator PINS, where
  `resolveCreateParent` derives the post value directly and an underivable operand
  raises that function's own pre-existing `QueryEngineError` ("Cannot determine the
  updated primary key …").

Package G did not create that split and did not touch the second owner; it is older
than the consolidation. Neither position is a census site, no public payload was
measured onto the pinned-locator path, and it therefore carries no falsifier. Stated
so that "one owner" is not read as "one decision" — `forbidden-shapes-reference.md`
§2.5 carries the same correction.

---

## Cluster 2 — nested bulk data carries relation writes (4 sites in O1 → 1 after O2)

§O2 row 4, "relation-bearing bulk capability". Package L REJECTED both lifts, so
this cluster gets no expiry: the wall stands and only its duplication is O's
business. `relation-key-legality.findRelationBearingUpdateManyData` reads
`relationWriteKeys` (EVERY entry of the parsed relation collection — Package K's
fix, since Phase 6 one entry per key rather than a union of two maps); the two
write-engine copies read relation programs alone, which is why deleting them
removed a blind spot as well as a duplicate. Site 22 is now the only expression.

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 22 | `relation-key-legality.ts:173` (declared `:167`; N3 read the junction arm at `:162`; coordinates are O1-era — the executable census re-anchors them per phase, Phase 6: `:170`/`:164`) · `assertSelectedUpdateManyDataIsScalar` · nested selected-record data carrying `<m2m>: { updateMany: { data: { <relation> } } }` | A set-based UPDATE publishes no per-row identity a descendant write can correlate to. | This boundary: the enclosing selected record's data, parsed once, before any Part is built. | `board.update > posts.update > marks.updateMany.data.notes.create` — the junction wording. | `junction-adopt-create-relations.test.ts:678` ("the updateMany sibling keeps the boundary"). | MSI | **KEPT — and it is now the only expression of this invariant** (sites 9, 10 and 23 fold into it). |
| 23 | `relation-key-legality.ts:166` · same function, ordinary arm | Same invariant, ordinary to-many wording. | Same. | `writer.update > books.update > pages.updateMany.data.tag.connect`. | `upsert-untaken-arm-legality.test.ts:163`; `inverse-to-one-update-depth.test.ts:643`. | MSI | **DONE — merged into site 22.** One construction site, the noun chosen from `invalid.isJunction`; both messages survive byte-identically, both falsifiers green. |
| 9 | `RelationJunctionPart.ts:2354` · `scalarOnly` · junction `updateMany` entry, during part construction | Same invariant. | Site 22 already owns it; this is downstream of it on every measured route. | **None found.** Every path into `buildJunctionParts` case `updateMany` is preceded by `assertSelectedUpdateManyDataIsScalar` (`RelationJunctionPart.ts:2020`, `RelationWritePart.ts:647`/`:277`, `RecordUpdateCompiler.ts:1116`, `RelationUpsertPart.ts:1118`) or by the root's `NestedWriteError` owner (`UpdateOperation.ts:202`). A create-root junction cannot carry `updateMany` at all (`ToManyCreateSchema` answers `Unknown key`). | **NONE-DISTINGUISHING** — the one test asserting its sentence (`junction-adopt-create-relations.test.ts:678`) is answered by site 22. | MSI | **DONE — deleted.** ALSO A CORRECTNESS ITEM, and the reason the deletion is an improvement rather than a subtraction: it read `Object.keys(relations).length` — the map-only question Package K proved is a silent wrong answer for a direct polymorphic key — and was the fourth reader K did not reach. |
| 10 | `RelationWritePart.ts:691` · `parseScalarUpdateData` · a **junction target's** own `<toMany>: { updateMany: { data: { <relation> } } }`, folded through `nested-target-parts.ts:354` | Same invariant. | Site 22 owns it wherever the target's legality runs eagerly. | The ONE unshadowed position: `nested-target-parts.foldJunctionTargetRelation` case `updateMany` pushes `buildToManyUpdateManyParts` UNCONDITIONALLY, while `RecordUpdateCompiler.ts:1674`/`:2236` gate the same call on `updateManyCarriesRelations`. Under a junction adopt target whose legality closure is deferred, the Part is constructed first. | **NONE-DISTINGUISHING** — its sentence is byte-identical to site 23's, and the two candidate tests are pinned by site 23. | MSI | **DONE — moved to the owner.** `buildJunctionTargetRelationParts` now calls `assertSelectedUpdateManyDataIsScalar` at its seam and the Part-level throw is deleted. The "one unshadowed position" was MEASURED and is not live — disagreement 4. |

---

## Cluster 3 — a second provenance for the relation-owned foreign key (2 sites)

§O2 row 6, "relation-owned FK disagreement → canonical relation-membership input
boundary". Both already share ONE message owner,
`messages.ts:124 relationOwnsForeignKey` — the precedent for how this estate
deduplicates a sentence without hiding a decision.

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 11 | `RelationWritePart.ts:1250` (declared `:1240`; N3 read them at `:1244`/`:1234`) · `assertOwnedFkAbsentFromUpdateData` (four call positions, at HEAD `:1274`, `:1316`, `:1345`, `:1371`) · nested `update` / to-one `update` / inverse upsert found arm / nested `updateMany` data spelling the relation-owned FK | A nested update spells, as a scalar assignment, the column the enclosing relation owns — a second contradicting provenance that can move the located child away. | The parse boundary owns it for every ordinary schema (Package N1's `UpdateWithOmittedFk`). It arrives here only on a schema where the two scanners DISAGREE: `getInverseRelationMap` tests `state.fields` for truthiness, `bindRelation` tests `fields && fields.length > 0`, so `.fields()` with zero arguments omits nothing and still binds child-held. | **PACKAGE N's MEASUREMENT, cited as N's and not re-run here:** on the divergent schema, `posts.updateMany.data.userId` reparented the row and returned success before the Package N gate wired position 4. Package O did not re-measure the four positions — it kept all four, which is the direction that needs no new measurement, and records the borrowed provenance rather than presenting it as its own. | `nested-update-owned-fk.test.ts:459`, `:596` ("the retained engine guard still catches what the parse cannot omit") — three of the four positions. | SC | **keep**. RETIREMENT PATH (not O's to take blind): align `getInverseRelationMap`'s candidate filter with `bindRelation`'s length test and the whole site loses its route. `buildToManyUpdateParts` (`:1268`) has **no measured live route** — the targeted arm dies earlier in the engine's own scanner — but Package N's gate warns explicitly: **re-measure an arm's binding behaviour before reading "no live route" as licence to delete a call position** (the implementer note had this backwards; `updateMany` was the dead-looking one that was actually open). |
| 12 | former `RelationUpsertPart.withoutAgreeingOwnedFk` | The same second provenance, including partial compound spellings. | `RecordUpdateCompiler`'s physical-column assignment owner, seeded at construction and continued at compile. | None outside the ledger: agreeing partial/full compound members are absorbed; disagreement, null, arithmetic, and unprovable equality use the ledger's one contradiction. | `adopt-owned-fk-agreement-behavior.ts` via the local and Docker contracts. | SC | **DONE — folded into site 4's final-assignment owner.** |

---

## Cluster 4 — `skipDuplicates` without an identity (0 surviving sites)

N3 originally recorded two invariants. The relation-bearing bulk pass chose the
root contract: a skipped root suppresses its complete nested subtree, retiring
site 7. **Residual Package F (2026-08-13) retired site 8 the same way**, and this
cluster is now empty. Package F temporarily replaced the identity fact with the
substrate fact recorded in the historical cluster 13 below; the later batch-only
series lift retired that fact too.

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 7 | `CreateManyRecordSeries.ts:126` · the former constructor refusal | A skipped root's nested effects needed one public meaning. | The product decision. | A relation-bearing root beside `skipDuplicates`. | `create-many-relation-series.test.ts`; `create-many-relation-series-behavior.ts`. | DPC | **retired** — the chosen contract suppresses the entire member subtree. Interactive drivers use the member savepoint; batch-only drivers isolate the skippable root as one atomic segment and inspect normalized row count. |
| 8 | `RelationJunctionPart.ts:1374` · `resolveCreatePk` · `client.M.update({ where, data: { <m2m>: { createMany: { data, skipDuplicates: true } } } })` with a database-generated target primary key | A skipped row produces no identity, so its join row has nothing to reference. | This boundary — whether the target key is database-generated is a schema fact, but whether a row was skipped is only knowable per row at execution, so the refusal must stand where the join value is resolved. | Junction `createMany` + `skipDuplicates` where `targetPkField` is `increment` (and the compound-unique variant where the constraint is incomplete). | was `junction-skip-adoption-behavior.ts:608`, `:652`, `:681`; those three cases are now POSITIVE witnesses in the same file. | MSI | **RETIRED by residual Package F.** The invariant was true of the LEAF, and the leaf is no longer where the shape goes. `routeJunctionCreateManyRow` gives an unnameable row the `suppress` answer and routes it through the per-record series a relation-bearing junction row already used: the target subtree and its join row are ONE savepoint-scoped member, so a root conflict rolls that member back and the series continues. The join value is never asked for, because the member that would have written it does not exist. Mixed lists preserve per-row meanings as ordered route runs. `resolveCreatePk` no longer takes a `skipDuplicates` argument at all. |

---

## Cluster 5 — plural fresh row-key publication (retired)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 21 | Former `UpsertOperation.createArmIdentity` fall-through · `client.M.upsert({ where, create: {…}, update })` | The create arm needed every database-assigned member of its compound row key before its terminal read. | Compile, and only when the create arm is taken. | Two absent increment members. | `produced-compound-identity.test.ts` (field-keyed outputs, live PostgreSQL DDL, exact terminal row, untaken update arm). | MSI | **retired by residual-lift Package A** — the taken scalar fallback lazily delegates to `FreshRecordPart`; `CreateOperation` publishes all members through existing outputs. Known and singular-generated upsert fast paths remain inline. |

---

## Cluster 6 — a shared primary key with no one final value (2 sites, two roots)

§O2 row 7 territory ("stable mutation identity"). **Disagreement with N3**: site
20 is listed there under cluster 1; it is the create-root twin of site 4 and
belongs here. This does not change the invariant count — cluster 1 loses a site,
cluster 6 gains one.

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 4 | **RELOCATED (residual C/D; coordinate re-measured at residual I): the throw is `write-engine/final-root-assignment.ts:87`, `FinalRootAssignmentTruth.contribute` raising through `refuseFinalAssignment` (declared `:41`). `recordSharedKeyFold` is retired; the shared-key disjuncts now enter the one physical-column ledger with every other contributor, which is why the invariant below reads wider than "shared primary key".** Historical: `RecordUpdateCompiler.ts:3533` · `recordSharedKeyFold` · `client.M.update({ where, data: { <parentHeldToOne whose FK is M's own row key>: { create \| connectOrCreate \| upsert \| connect } } })` | The arm that folds a member of this record's own row key names no one final value for it (absent, `null`, or a root SET that DISAGREES with the fold). | Construction — Package E narrowed the site from refusing a SHAPE to refusing an ARM THAT NAMES NO VALUE, which is exactly what is knowable here. | A shared-PK `connect` resolved by a correlated lookup subquery (no construction value), and a shared-PK `create` beside a root SET spelling the same column with a different value. | `parity-e-shared-pk.test.ts:645`, `:670`, `:690`; `shared-pk-update-root-behavior.ts:399` via `shared-pk-update-root.test.ts` / `-docker.test.ts`. | MSI (+ one SC arm) | **keep**. N3's `(*)` flag stands: the "root SET disagrees" arm is SC while "no value"/`NULL` are MSI. Recommend NOT splitting the sentence — a disagreeing SET is the same "no ONE final value" fact from the other side, and a second site would be a second owner. |
| 20 | **CURRENT COORDINATE: `CreateOperation.ts:3995`, declared `:3984`, `assertSelectedSharedPkValue`.** Historical: `CreateOperation.ts:3154` (declared `:3140`; N3 read it at `:3091`) · `assertSharedPkResolved` · `client.M.create({ data: { <parentHeldToOne whose FK is M's primary key>: { create \| connect \| connectOrCreate } } })` | Same invariant at the create root: the shared key is not a compile-time literal. | `compile(known)`, after the chosen arm's lookup exposes its referenced tuple and before the root INSERT. A fresh record has no located row, so the update-root derivation cannot apply. | A public alternate-unique `connect` locates one target whose nullable referenced key is `null`; without this site the root INSERT reaches the provider with no key. | `residual-refusal-falsifiers.test.ts` (typed exact refusal, zero root rows, concrete control). | MSI | **keep** |

---

## Cluster 7 — a single-target membership move across N>1 roots (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 22 | `relation-key-legality.ts` · `assertSingleTargetMembershipMoveAppliesToRecords` · `client.M.updateMany({ where: <matches ≥2 rows>, data: { <exclusive relation>: { connect \| connectOrCreate \| set: <naming ≥1 existing target> } } })` | A membership stored on one target row or in one singular member-junction slot cannot be applied to more than one source row: the last root updated would take it from the others. | **Nothing earlier can know it** — the count is only known after capture. No schema can own an N-dependent rule. The relation-legality owner serves root and nested record series; their shells provide only the captured count and parsed programs. | The same payload at N = 1 builds its member and runs; at N = 2 it refuses before member zero writes. Plural junctions and empty spellings (`set: []`, `connect: []`, `connectOrCreate: []`) are deliberately NOT refused. | `parity-k-update-many.test.ts`; `update-many-relation-series.test.ts`; `polymorphic-collection-write-family.test.ts`. | SC | **keep** — one owner for target-row and singular-junction forms. |

---

## Cluster 8 — a composed producing supplier + modify (retired)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 6 | Former `RecordUpdateCompiler.composeToOneEntries` unsupported arm · `client.M.update({ where, data: { <toOne>: { create \| connectOrCreate: …, update: … } } })` | The lattice admitted the shape and the engine had no channel carrying a row's identity from an INSERT into the selected-record compiler that must then modify it. | That dispatch, while the modify was assumed to be located by a PLANNING read. | None: the shape executes. | `supplier-continuation-behavior.ts` (both arms, the vacate-prefixed forms, the recursion, the rollback) via `supplier-continuation.test.ts`; the step shape in `parity-h-to-one-lattice.test.ts` "child-held create + update plans no probe and compiles a series". | UFF | **RETIRED by residual-lift Package E** — the stated expiry was met by NOT building the channel it named. Membership after supply is the selector: the modify became a nested `RecordSeriesStep` of exactly one member, captured through the edge's exact physical-membership predicate after the supplier's own Parts and compiled by the ordinary `RecordUpdateCompiler` against the captured complete row key. `composeToOneEntries` survives as a pure classification reader over `builders/to-one-composition.ts` with only its pre-existing engine-fault `QueryEngineError` under it, and the `connect` supplier's direct selected path is byte-identical. |

Nothing replaced this site. The composition classification moved to one shared
owner (`builders/to-one-composition.ts`) that BOTH `RecordUpdateCompiler` and
`OwnWriteRelation` read, which also closes non-census item N5 ("one invariant,
two writers"): the analyzer no longer re-derives which payloads compose. The
substrate boundary is the record series' own — a provider with neither an
interactive transaction nor native atomic batch declines the nested series.
On any batch-only provider the placement's complete-parent and membership guard
is repeated in every later write batch or the member refuses before it writes;
ordered commit callbacks only strengthen attribution.

---

## Cluster 9 — a compound child edge into a junction (1 site in O1 → 0 after O3)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 17 | `CreateOperation.ts:2168` (declared `:2162`; N3 read the throw at `:2139`) · `edgeParentId` · `client.M.create({ data: { <manyToMany rel>: {…} } })` where `M` has a COMPOUND primary key | A junction side is one column today, so a compound parent row key has no junction representation. | **The schema** — a compound-PK model with an m2m relation is knowable at schema build. Plan §N2 forbids sealing it there ("do not add a validation seal that makes the future topology unreachable"; "do not restate it as a validation rule merely to move the error earlier"), so the site is retained AGAINST O3 clause 1 by explicit plan mandate. This is the one survivor that fails the letter of the one-guard rule and is kept by ruling. | **O1 CLAIMED** it reached the compound-M2M fact one statement EARLIER than `builders/correlation-utils.ts:155 getRequiredSinglePrimaryKeyField` (a `QueryEngineError`), the only other engine owner and invisible to the census grep. **MEASURED FALSE — it never reached the fact at all** (disagreement 2); that function answers every public payload first, at the record-program boundary. | **NONE, and unwritable** | UFF | **CONVERTED to a `QueryEngineError`** naming a structural invariant (disagreement 2). The falsifier could not be written because the claim was false: `OwnWriteAnalyzer` answers this payload first. §7.4 is intact — the fact is still refused in the ENGINE, by `getRequiredSinglePrimaryKeyField`, and has NOT been restated as a validation rule. |

---

## Cluster 10 — depth on an upsert's update arm (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 13 | `RelationUpsertPart.ts:1113` · `refuseIncomingParentMutation` (`:1109`) | A same-incoming delete/global-adopt mutation has no selected continuation, or a correlated re-entry itself changes the incoming row key and cannot publish its second final tuple outward. | The relation overlap seam for the general arm; the selected-record compiler for the key-changing arm. | Stable correlated update/found-upsert, including an enclosing key transition, now executes against the exact selected row. Delete and an inner key change keep distinct exact refusals. | `nested-arm-dispatch.test.ts` same-edge continuity and retained-boundary matrix. | SC | **keep, narrowed by selected-row continuity.** |

---

## Cluster 11 — publication on a batch substrate (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 19 | **CURRENT COORDINATE: `CreateOperation.ts:3624`, declared `:3606`.** Historical: `CreateOperation.ts:2850` (declared `:2839`; N3 read it at `:2788`) · `producedReference` | A plural database-assigned row key on a non-returning adapter has no complete stable selector only when the source supplies no complete explicit addressable alternate unique. | This boundary, where adapter capability, database-assigned arity, and proven post-write locator meet. | The same schema publishes through RETURNING; scalar and mapped-compound alternate uniques locate the non-returning focused read. Null, omitted/defaulted, `Sql`, incomplete, and raw-index-only candidates do not. | `residual-refusal-falsifiers.test.ts`. | PSI | **keep, narrowed to the unnameable row** |

Residual-lift Package B adds one distinct executor position: a fragment already
declares an `insertId`, but the active adapter has no exact statement-local batch
lowering. PostgreSQL deliberately omits `storeLastInsertId` because `lastval()`
is session-global and trigger-sensitive. `OperationExecutor.compileToEntries`
refuses before `_executeBatch`; `fresh-produced-field.test.ts` pins both the
missing lowering and zero provider effects. This is not site 19 repeated: site
19 has no identity output to transport; this site has an output and no exact
provider lowering. The write-engine raw census therefore returns 12 → 13 after
Package B, with one new first-knowable invariant.

The generated-output pass narrows that paragraph. Default operations may materialize
`RETURNING` values between guarded segments, so site 28 now belongs only to an
indivisible atomic fragment such as explicit `$transaction([...])`. Former sites 29
and 30 are retired. The static later-race-pin refusal is retired too: an actual loser
surfaces its unique error with committed progress and is not retried. Site 32 owns the
one remaining weak-segmentation fact: every crossed provider output must carry the
compiler's exact continuation premise. At that checkpoint the raw census was
**9 / 11 / 13**. The later batch-only series lift retired site 31, making that
checkpoint **8 / 10 / 12**. Five-capability Package 1 then retired site 26, so
the current census is **8 / 10 / 11**.

---

## Cluster 12 — decimal portability (0 sites, RETIRED)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 24 | former `builders/decimal-portability.ts:56` · `assertExactDecimalOperation` | SQLite had no exact decimal type, so ordering, aggregating or doing arithmetic on a decimal would have round-tripped a 64-bit float. | — | — | inverted into `decimal-exact-surface.test.ts`, where every spelling that used to be refused must now answer identically on PGlite and SQLite3. | — | **RETIRED — the premise is false.** A decimal column on SQLite is the unscaled integer coefficient of the field's declared `precision`/`scale`, so comparison and ordering are integer comparison, `_min`/`_max`/`_sum` are integer aggregates, and multiply/divide/`_avg` are guarded integer quotient/remainder expressions rounded half-to-even. The capability flag it read (`supportsExactDecimal`) is deleted with it. |

---

## Cluster 13 — historical savepoint-only suppression (retired)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 31 | Historical construction at `junction-create-many-routing.assertSeriesSkipAttributable`, shared by both create-series families. | Package F assumed suppression required an interactive savepoint because one submitted batch could not distinguish a root conflict from a descendant conflict. | The former shared routing owner. | Both plain batch and ordered-callback batch drivers. | The former refusal rows were retargeted to execution and exact state. | PSI | **RETIRED.** The executor isolates the skippable root in one atomic segment and observes normalized row count before dispatching descendants. `supportsOrderedCommittedSegments` strengthens attribution only. A prior write or nested series still refuses pre-effect through site 27 because it would survive the skipped root. |

This cluster is history, not current doctrine. Root and nested record series now
share the same atomic-segment execution owner. The only retained root-skip wall is
the narrow wrong-data case where a write or nested series precedes the skippable
root; site 27 refuses that member before any segment dispatch.

---

## Residual Package H — historical progressive audit, then narrowed

No census site was added, deleted, or converted. What H owed the ledger is the
reasoning behind three refusals to change something.

**1. The H-era `progressiveSeriesRefusal` reason list is historical.** At H it
covered: no atomic batch substrate, no positive bind
limit, a statement or boundary guard over capacity, a capture or member-planning
WRITE, `skipDuplicates` without root-versus-descendant attribution, an unguardable
nested boundary, and the two final-result-read invariants. The current lowering no
longer requires an optional positive bind-limit declaration, and it no longer
blanket-refuses root-conflict suppression. It isolates a skippable root and reads
normalized row count. The retained wrong-data case is a write or nested series
before that root, because a skip would leave the prior effect committed. The
five-capability lift then removed two more broad reasons. Semantic create-many and
junction insert owners chunk splittable compiled statements to the active driver's
verified bind budget; only an indivisible over-limit unit reaches the executor
refusal. Selected-row continuity also makes an enclosing row-key move executable:
the relation placement supplies only before-root/after-root phase, and
`RecordUpdateCompiler.selectedRowKeyAt` supplies the complete captured or final key.
The literal constructor is now the general `executionRefusal` owner shared by these
distinct provider-execution subjects; sharing that message constructor does not merge
their invariants.

**2. Every ordinary child-held `RecordSeriesStep` placement carries the same two
semantic facts.** `RelationWritePart` has two temporal positions, and one correlation
kind selects both sources together. Captured existing-member `updateMany` uses the READ-
side row key and referenced tuple. Supplier continuation uses the WRITE-side row key and
referenced tuple the supplier stored. `progressive-parent-rowkey.test.ts` and
`supplier-continuation.test.ts` pin the two replacement-owner races separately.

`RelationJunctionPart` remains row-key-only because its source side references the
parent's primary key. The inverse POLYMORPHIC placement likewise references the target's
one scalar primary key (schema rule P009). Those placements cannot carry a non-row-key
membership premise and their guard SQL is byte-identical.

**1b. RESIDUAL I — the case H1's own lift admitted, closed with a conjunct rather than a
site.** An ordinary child-held edge can have a parent row key and child REFERENCE key that
differ: the guard re-pins `id`, while every member writes a `code`-like value captured one
segment earlier, and between two commits that value can move to another row. §H1 names
both halves — "an exact … referenced value proves membership, not parent row identity …
keep that pair in a distinct exact-membership guard when the progressive boundary needs
it; the parent liveness guard still uses every `ModelKeyCatalog.rowKey` member".
`resolveCorrelatedMembershipProgressivePremise` applies that rule uniformly and selects
READ/READ for existing members or WRITE/WRITE for a supplied member. An unstateable
premise (an opaque lookup, or a value still `Sql`) declines the placement through the same
`unsupported` answer rather than guarding half of it.

MEASURED without the premise, on public payloads, with a concurrent writer between the two
segments: existing-member and supplier-continuation operations both RESOLVED under the
replacement owner. The fresh series wrote `spokes [[sp1, H1]]` where `H1` had become
`h-other`'s code. The junction and polymorphic placements still pass no extra premise and
their guard SQL remains byte-identical.

It is not a second guard for one invariant. The failure it alone catches is nameable and
the liveness guard cannot see it: the parent row still exists, and the value the children
reference has moved to a different row.

**3. Two class conversions the plan ALLOWED were declined.** §H3 permits translating
the two final-result-read branches ("a final result read unexpectedly contains a
nested record series" / "… a write") to `QueryEngineError` as taxonomy cleanup. They
are trusted-compiler invariants with no reachable payload, and this estate's
conversion law — item N18, applied by Package G to the polymorphic twins — says a
conversion owes a behavioral witness first. None can be written, so the class stays
and the reason is recorded instead. §H2's Neon capability remains declined because
no hosted proof exists: `NEON_TEST_DATABASE_URL` is unset and the hosted suite skips.
The credential-free fake now proves the local callback seam only — notification is
awaited after the native transaction promise resolves and before cardinality/result
parsing, and provider rejection does not notify. It cannot prove hosted durability,
visibility, atomic order, normalization, or failure attribution, so
`supportsOrderedCommittedSegments` stays false. That flag now controls stronger
callback-before-decode attribution only. It does not control general series
eligibility. The same credential-free file pins that Neon reaches and awaits its
native batch route; it still makes no hosted durability claim
(`neon-committed-segments-capability.test.ts`).

---

## Non-census items (near-guards the briefs named)

Not `UnsupportedOperationError` construction sites, so invisible to §O4's grep —
recorded because they express, shadow, or silently replace a guard decision.

| Item | Location | Fact | Disposition |
|---|---|---|---|
| N1 · byte-identical twin of site 14 | `CreateOperation.ts:1027` (was `:1016` before the fold) | The `connectOrCreate` branch states site 14's sentence BYTE-IDENTICALLY as a `QueryEngineError`. One invariant, two classes, half of it uncounted (Package F's For-O item, coordinates drifted from `:912`/`:936`). | Fold into the cluster-1 owner with site 14; a class conversion owes a behavioral witness. |
| N2 · the polymorphic `QueryEngineError` family | `RecordUpdateCompiler.ts:939`, `:964`, `:1164` | Three more copies of "cannot resolve referenced field '<f>' for relation '<r>'" in the engine-fault class, on the update root's polymorphic paths. | Same invariant as cluster 1; unify wording/owner or record why the class differs. |
| N3 · dead PK guard | `ManyAndReturnOperation.ts:820` (`pkSelect`) — **one of FIVE, see the correction below the table** | `getPrimaryKeyFields` is TOTAL (`return ["id"]`), so `fields.length === 0` is unreachable. Package K deleted its own copy of this shape at the gate rather than keep a check whose coverage cannot be named. | **DONE — deleted.** |
| N4 · dead PK guard | `RecordUpdateCompiler.ts:563` | Same dead shape, `parentPrimaryKeys.length === 0`. | **DONE — deleted.** |
| N5 · one invariant, two writers | former `RecordUpdateCompiler.composeToOneEntries` + `OwnWriteRelation.resolveComposedSupplierSelector` | `composeToOneEntries` decided which payloads compose; `resolveComposedSupplierSelector` re-derived the same rule so the analyzer's decision read matched the compiled locator. They agreed by construction and NOTHING enforced it; widening one without the other makes the analyzer report a dependency the plan does not have. | **DONE — the honest repair, taken by residual Package E.** `builders/to-one-composition.ts` owns the one reading `(vacate?, supplier, modify?)` plus how the modify is located (`suppliedSelector` / `membershipCapture`); the compiler lowers it and the analyzer consumes the SAME classification instead of re-deriving connect-only semantics. |
| N6 · single owner whose violation is silent data loss | `routing.ts:311 relationBearingRow` | If the predicate ever answers "no" for a row that carries relations, `CreateManyOperation.buildValueGroups` DROPS the relation keys silently. Unreachable today, test-caught only. | Keep; record the class. |
| N7 · the nested twin of N6 | `builders/values-builder.ts:81 buildValueGroups` | Package L measured the same hazard on the nested insert path: `buildValueGroups` iterates `scalarFieldNames` with no unknown-key guard, so validation-widening alone would be silent data loss. ONE ledger row, TWO instances. | Keep; record the class. Any future nested-bulk widening must add the unknown-key answer FIRST. |
| N8 · dead abstraction | `target-projection.ts:200 capturedTargetConstraint` | ZERO production consumers (`rg` finds only `target-projection.core.test.ts`). Package C kept it under the plan mandate with the explicit rule "if Package D lands without consuming it, Package O deletes it"; Package D refused it on SHAPE (the occupied predicate is a where over the CHILD scope pairing FOREIGN fields, not a target-side row-key constraint) and recorded that at its owner. | **DONE — deleted**, with its unit test (its only caller in the repository). The refusal-on-shape reasoning moved to a grave comment at the owner. |
| N9 · junction transition-blindness | `RecordUpdateCompiler.ts:~1187` (junction early-return, before `interpretReferencedKeyTransition`) | A junction edge is classified before the transition is, so a pair that opts out of the implicit `ON UPDATE CASCADE` has no engine owner — and the update ROOT has none either. Both fail closed at the constraint with identical statements and no partial effect, so the CONSTRAINT is the owner and an arm-side refusal would be an asymmetric duplicate. | Keep as measured-not-guarded; pinned three ways in `nested-arm-dispatch.test.ts`'s "B1 RESIDUE" block. |
| N10 · type-forced series guards | `record-series.ts` `parseResult` / `cacheKeyArgs` | `parseResult` is now falsified for BOTH series names (J did `createMany`, K added `updateMany`). `cacheKeyArgs` remains "reached, NOT distinguishable" — the same sentence arrives by the same absence for scalar bulk. | Keep; record `cacheKeyArgs` as the one series guard with no distinguishing falsifier. |
| N11 · compound-M2M twins across layers | `builders/correlation-utils.ts:155` (`QueryEngineError`) + `migrations/serializer.ts:661` (raw `Error`) | Near-identical sentences that are NOT byte-identical ("uses a compound primary key" vs "uses compound primary key"). Neither is a census site; site 17 reaches the same fact earlier. | Record. Unify the wording when `JunctionSide` lands, not before. |
| N12 · unasserted race pin | `UpsertOperation.ts:701 annotateCreateRacePin` | Never asserts that a step matched; any future owner rewriting a create arm's steps by id reintroduces Package M's hazard and only the new pin catches it. | Record for the final report. |
| N13 · the root-level owner that shadows cluster 2 | `relation-key-legality.ts:66 assertUpdateManyRelationsAreCompilable` | Throws `NestedWriteError`, never an `UnsupportedOperationError`. Package L's brief listed it among "4 census sites unchanged"; it has never been one. It answers FIRST at the update root (`UpdateOperation.ts:202`, `UpsertOperation.ts:447`), which is why cluster 2's sites are only reachable one level deeper. | Record; it is why sites 22/23 are nested-only. |
| N14 · ARCH-7 coverage gap | — | No test drives an inverse to-one upsert on a child-held edge under a shared-PK fold into the guarded regime (every current entrance is a scalar key move). Package E raised it, Package K declined it as a witness with no home. | **Still open.** A coverage gap, not a guard; it belongs to whoever next owns `RelationUpsertPart` + `RecordUpdateCompiler` territory. |
| N15 · determinism boundary | `target-projection.ts sortCapturedRowKeys` | Raw bigint keys differ by provider (`"9"`, `9`, or `9n`), so sorting them directly produced different member order. | **DONE** — capture keys now pass through the existing scalar result decoder before sorting, giving every provider one canonical order. |
| N16 · the fourth blind reader | `RelationJunctionPart.ts:2349` inside site 9 | Reads `relations` alone, the map-only question Package K proved is a measured silent wrong answer for a direct polymorphic key. K routed three readers through `relationWriteKeys`; this is the fourth. | **DONE — died with site 9.** |
| N17 · substrate-refusal asymmetry inside `execute` | `record-series.ts` / the executor's series branch | On a driver with NEITHER substrate, a non-series operation gets `noAtomicSubstrateError` and a series gets `withTransaction`'s wording — two sentences for one substrate fact. The earlier H note that used Neon as a batch-only refusal witness is superseded: any native atomic batch is now sufficient for safe progressive series, and the Neon fake reaches the awaited batch route without asserting hosted commit facts. The corner this row names remains only a driver with NEITHER substrate. | Record. Not a census site and not a guard decision — one fact, two messages. |
| N18 · one sentence, two error classes, one message builder | `CreateOperation.ts:3383 unresolvedFreshReferenceMessage`, consumed by `requireRecordReferenced` (`:2764`, `UnsupportedOperationError`) and by the polymorphic `connectOrCreate` branch (`:1027`, `QueryEngineError`) | O2 gave the twin the owner's message BUILDER so the two sentences cannot drift. That is not the "common unsupported function" §O2 forbids — the builder returns a string, each caller keeps its own condition and constructs its own error, and `requireRecordReferenced` has exactly one condition under it — but it does now couple a user-facing refusal's text to an engine-fault's text across two classes: editing the `beforeParentTarget` sentence rewrites an `INTERNAL_ERROR` message too. | Record, do not change. The alternative (two copies) is the drift this replaced. Whoever writes the polymorphic witness that pays the conversion law's debt collapses the pair and this row with it. |

**CORRECTION AT THE PACKAGE O GATE — the dead-PK-guard class has FIVE members,
not two (rows N3/N4).** The O2/O3 draft recorded "the two pre-existing instances"
as though that were exhaustive over the repository. It is exhaustive only over
what Package K handed on. The same dead predicate — `getPrimaryKeyFields(model)`
answered with `length === 0`, against a function that is total and answers
`["id"]` — also stands at `DeleteOperation.ts:105`, `UpdateOperation.ts:259` and
`UpsertOperation.ts:223`. **Those three stay, and the doctrine is not being
applied unevenly:** each is a member of the N7-U-A converted family, each names
the boundary that answers instead (the where-unique parse), and each is PINNED by
a behavioral witness in `operation-construction-witnesses.test.ts` — `:344` for
the update root, `:796` for upsert and delete — asserting that the parse boundary
answers FIRST and that the site does not. That is this estate's recorded
disposition for a branch unreachable by construction: convert it, name its owner,
pin it. The two Package O deleted carried no witness and named no owner; deleting
a pinned member would delete its witness with it. If a future package retires the
family it retires all five together, and it owes the five witnesses a rerun.

---

## Disagreements with N3's classification (O1)

1. **Site 20 is cluster 6, not cluster 1.** It is the create-root twin of site 4
   (same invariant, different root, genuinely different trust boundary), not a
   member of the unresolvable-referenced-value family. Cluster 1 → 7 sites,
   cluster 6 → 2 sites; the invariant total is unchanged at 12.
2. **Cluster 2 is one invariant with ONE owner and THREE shadows**, not four
   co-equal expressions. Sites 22 and 23 are two throw tokens of a single
   decision; site 9 is dominated on every measured route; site 10 has exactly
   one unshadowed position and it is an ordering accident
   (`nested-target-parts.ts:354` does not gate on `updateManyCarriesRelations`
   while its two siblings do).
3. **Sites 2 and 3 emit a BYTE-IDENTICAL sentence** for the `"nested create"`
   position. `parity-d-transition.test.ts:828`'s comment claims the sentence has
   ONE emitter (`postTransitionReference`); at HEAD it has two. The comment is
   false and must be corrected with whatever the compress lane does to site 3.
4. **Site 17 fails O3 clause 1 by the letter** (the invalid state is first
   knowable at the schema) and is retained by explicit plan mandate (§N2's "do
   not add a validation seal", §7.4's "not a semantic seal"). It is the only
   survivor in that position and the ledger names it rather than pretending the
   boundary is the engine's.
5. **N3's `(*)` on site 4 is sustained but its remedy is declined**: splitting
   one shipped sentence into an MSI site and an SC site would create a second
   owner for one fact seen from two sides.

## Falsifier gap list, as O1 found it (superseded below)

| Site | Gap |
|---|---|
| 14 · `CreateOperation.ts:991` | **NONE.** No test asserts the polymorphic before-parent sentence; its byte-identical `QueryEngineError` twin sits one branch away at `:1016`. |
| 17 · `CreateOperation.ts:2139` | **NONE.** No test constructs a compound-primary-key model carrying a many-to-many relation at `create`. This is plan §7.4's own anchor and should get a witness. |
| 10 · `RelationWritePart.ts:691` | **NONE-DISTINGUISHING.** Byte-identical to site 23; both candidate tests are answered by site 23. Its one unshadowed route (`nested-target-parts.ts:354`) is unmeasured. |
| 9 · `RelationJunctionPart.ts:2354` | **NONE-DISTINGUISHING.** Byte-identical to site 22, which answers the only test asserting the sentence. |
| 2 · `"membership"` position (`RecordUpdateCompiler.ts:2621`) | The SITE has a falsifier; this POSITION does not. No test asserts `update membership on relation …`. |
| N10 · `cacheKeyArgs` (non-census) | Reached, not distinguishable — the same sentence arrives by the same absence for scalar bulk. |
| N14 · ARCH-7 (non-census) | No inverse to-one upsert on a child-held edge under a shared-PK fold into the guarded regime. |

## What O2/O3 executed

Every row below was applied witness-first: the named falsifier ran green at
HEAD, the change went in, the falsifier and its family ran green again. Full
runs: the `coverage-write-engine` project (3,098 passed / 354 skipped), the
query-engine and operation-schemas layers, `pnpm test:types`, and the focused
falsifier files named per row.

| Move | Sites | Δ | Falsifier that gated it |
|---|---|---|---|
| Cluster 2 merged to ONE owner: sites 22 + 23 became one construction site choosing its noun from `invalid.isJunction`; site 9 (`RelationJunctionPart.scalarOnly`) and site 10 (`RelationWritePart.parseScalarUpdateData`) deleted, with `nested-target-parts.buildJunctionTargetRelationParts` now calling the owner at the one seam that lacked it | 9, 10, 23 | −3 | `junction-adopt-create-relations.test.ts:678`, `upsert-untaken-arm-legality.test.ts:163`, `inverse-to-one-update-depth.test.ts:643` — all green before and after, with both sentences byte-identical |
| Cluster 1 merged to ONE owner: `CreateOperation.requireRecordReferenced(record, referencedField, relationName, position)`, §O2 row 2's "CreateOperation demand publication" | 14, 15, 16, 18 | −3 | `parity-f-fresh-field.test.ts:813/:819/:830/:842`, `fresh-produced-field.test.ts:481`, `compound-relation-adoption-behavior.ts:318` — every pinned sentence unchanged |
| Site 17 CONVERTED to a `QueryEngineError` naming a structural invariant (see disagreement 2) | 17 | −1 | NEW: `operation-construction-witnesses.test.ts`, "a compound primary key carrying a many-to-many relation" |
| `capturedTargetConstraint` deleted with its unit test (N8) | — | 0 | its unit test was its only caller in the repository; deleted with it |
| The two dead PK guards deleted (N3, N4) | — | 0 | deleting turns nothing red, which IS the falsification for a guard whose state is unreachable |

Three O1 dispositions were NOT executed, each for a measured reason: site 3
(disagreement 1), site 11's retirement path (recorded future unit below), and
the class conversion of site 14's `QueryEngineError` twin (no reachable payload
exists to witness it — see disagreement 3).

### Named future units (measured, deliberately not done here)

This list is the single home for the lift's named future work. The plan
(`limitation-lift-plan.md` §12) points here rather than keeping a second copy.

1. **Align `getInverseRelationMap`'s candidate filter with `bindRelation`'s**
   (`src/schema/relation/types.ts:246`). `getInverseRelationMap` tests
   `state.fields` for TRUTHINESS and `bindRelation` tests
   `fields && fields.length > 0`, so a relation spelled `.fields()` with zero
   arguments binds child-held in the engine while the parse boundary omits
   nothing — which is the only route left into site 11. Aligning them would
   retire that site. NOT DONE: that function is a schema-layer owner consumed by
   `create.ts` and `update.ts` at seven call sites, and changing its answer
   changes which keys the public create/update surfaces OMIT — a validation and
   type-surface change on a schema spelling, not a guard compression. Package O
   compresses guards; it does not change schema semantics. Whoever takes it owes
   the degenerate-schema witnesses in `nested-update-owned-fk.test.ts` a rerun.
2. ~~**A produced-identity selector channel for `RecordUpdateCompiler`** — site 6's
   stated expiry, inherited from Package H unchanged.~~ **CLOSED by residual-lift
   Package E, and NOT by building this channel.** The unit was stated as an
   implementation ("a final reference into an earlier INSERT's outputs, consumed
   by `writeWhere`"), and the measurement was that the composition does not need
   one: membership after supply already names the row exactly, so the modify is a
   nested one-member record series located by the edge's own physical-membership
   predicate. Recorded because a future reader would otherwise look for a channel
   that was deliberately never built. Non-census item N5 ("one invariant, two
   writers") closes with it: `builders/to-one-composition.ts` is now the single
   composition reading that `RecordUpdateCompiler` and `OwnWriteRelation` share.
3. ~~**`JunctionSide` compound many-to-many topology** — plan §6 N2.~~
   **CLOSED by the residual compound-junction pass.** One bound `JunctionSide`
   now carries every ordered physical-to-row-key member. Query, write, migration,
   introspection, and validation consumers use that complete group.
4. **Reconcile the arm fold and the incoming reparent in one owner**, per column,
   with refuse-on-disagree — Package B's B1 residue, two instances (N5).
5. ~~**Reclassify the compound many-to-many refusal from a defect to a capability
   refusal.**~~ **CLOSED by deleting the limitation.** The query and migration
   refusal owners disappeared together, so there is no surviving public error to
   reclassify.

## §O3 — the five-question audit on every survivor

The five questions, verbatim from plan §6 O3:

1. The invalid state can first become known at this boundary.
2. No upstream validation or canonical representation already excludes it.
3. No sibling or downstream guard catches the exact same state.
4. Removing it makes its unique falsifier execute a wrong effect, lose
   atomicity, misattribute a failure, or accept an incoherent request.
5. Moving it earlier would not change untaken-arm validation timing.

A site failing question 4 is deleted by doctrine. Q5 reads "yes" when moving the
guard earlier would NOT disturb untaken-arm timing, so a "no" is itself a reason
the site must stay where it is.

| # | Site | Q1 | Q2 | Q3 | Q4 | Q5 | Verdict |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| 22 | `relation-key-legality.assertSingleTargetMembershipMoveAppliesToRecords` | yes — the root count exists only after the capture | yes — no schema can express an N-dependent rule | yes | yes — at N ≥ 2 the last root would silently take the child from the rest | yes — root and nested shells call it before member zero writes | **survives** |
| 2 | `RecordUpdateCompiler.postTransitionReference` | yes — pairs the located pre-value with the SET operand, and the located row exists only after planning | yes | yes — site 3's branch is never entered for a compound reference | yes — a fresh child would reference a value that does not exist | yes | **survives** |
| 3 | `RecordUpdateCompiler.resolveCreateParent` | yes | yes | yes — see disagreement 1: site 2 is not entered on the arity-1 non-PK branch, and it refuses a STRICTLY NARROWER operand set | yes — `sql-operand-boundary-behavior.ts:186` | yes | **survives** |
| 4 | `RecordUpdateCompiler.recordSharedKeyFold` | yes — Package E narrowed it from refusing a shape to refusing an arm that names no value | yes | yes — site 20 is the create root, a different trust boundary | yes — three arms in `parity-e-shared-pk` | yes | **survives** |
| 5 | `RecordUpdateCompiler.beforeTargetReferencedValue` | yes | yes | yes — site 15 is the create root; §O2 row 2 names both owners | yes — `parity-f-fresh-field.test.ts:858` | yes | **survives** |
| 6 | former `RecordUpdateCompiler.composeToOneEntries` unsupported arm | — | — | — | — | — | **retired → the shape executes as a supplier plus a one-member record-series continuation (residual Package E)** |
| 7 | `CreateManyRecordSeries` constructor | yes — the product contract, refused before the series shell is chosen | yes | yes | yes — the tracked corpus entry `J_SKIP_WITH_RELATIONS` is this site's whole reason to exist | yes | **survives** |
| 8 | `RelationJunctionPart.resolveCreatePk` | — | — | — | — | — | **retired → the shape executes as one target-subtree-plus-join series member; historical site 31 temporarily owned the batch-substrate half** |
| 31 | `junction-create-many-routing.assertSeriesSkipAttributable` | yes at the Package-F checkpoint | yes at that checkpoint | yes under the former lowering | yes under the former lowering | yes | **RETIRED by the batch-only series lift. Root isolation plus normalized row count makes the safe shape executable; a prior effect is refused by site 27.** |
| 11 | `RelationWritePart.assertOwnedFkAbsentFromUpdateData` | yes — on the divergent schema the parse boundary omits nothing, so the contradiction first exists here | **no**, in general — N1 owns it for every ordinary schema; the divergent spelling is the residue | yes | yes — `nested-update-owned-fk.test.ts:459/:596`, each falsifiable with a reparented row | yes | **survives**, with the retirement path recorded as future unit 1 |
| 12 | former `RelationUpsertPart.withoutAgreeingOwnedFk` | — | — | — | — | — | **retired → selected-record final-assignment owner** |
| 13 | `RelationUpsertPart.assertNoIncomingTargetMutationOverlap` | yes — exact target identity is known at this seam | yes | yes | yes — deleting the narrowed check lets a target mutation address the enclosing root | yes | **survives, narrowed to exact parent-held OwnWrite scope** |
| 15 | `CreateOperation.requireRecordReferenced` (the merged cluster-1 owner) | yes — `recordReferenced` is total over what an INSERT can publish | yes | yes — it IS the sibling the other three were | yes — six pinned sentences across four files | yes | **survives** |
| 19 | `CreateOperation.producedReference` | yes — adapter capability and database-assigned arity meet here | yes | yes — a different fact from "no row holds this value" | yes — **corrected by residual I / Phase 2:** the older `fresh-produced-field` citation exercised a sibling arm, not this plural non-returning sentence; `residual-refusal-falsifiers.test.ts` now pins it and the RETURNING twin | yes | **survives** |
| 20 | `CreateOperation.assertSelectedSharedPkValue` | yes — the selected value first exists in `compile(known)` after lookup and before the fresh root INSERT | yes | yes — site 4 is the update root | yes — **corrected by residual I / Phase 2:** the older parity/fresh citations did not pin this create-root sentence; `residual-refusal-falsifiers.test.ts` now pins the public null route and concrete twin | yes | **survives** |
| 21 | `UpsertOperation.createArmIdentity` | yes — and only when the create arm is TAKEN | yes | yes | yes — `produced-compound-identity.test.ts:111` | **no** — moving it earlier would analyse an untaken arm, which §4.4 forbids | **survives**, and Q5 is the reason it cannot move |
| 22 | `relation-key-legality.assertSelectedUpdateManyDataIsScalar` (the merged cluster-2 owner) | yes — the enclosing selected record's data, parsed once, before any Part is built | yes | yes — it IS the sibling sites 9, 10 and 23 were | yes — `junction-adopt-create-relations.test.ts:678` and two more | **no** — it is deliberately called by its callers so an untaken upsert arm stays inert | **survives**, and Q5 is why callers own its timing |
| 24 | former `builders/decimal-portability.assertExactDecimalOperation` | — | — | — | inverted into `decimal-exact-surface.test.ts` | — | **RETIRED — exact SQLite coefficient decimals removed the premise** |
| 25 | `drivers/shared/transaction-options.refuseTransactionOption` | yes — a driver capability | yes | yes | yes — `transaction-options-behavior.core.test.ts:263` and `:422` assert the `UnsupportedOperationError` by name (located at the Package O gate; the O1 row named no falsifier) | yes | **survives** (outside the query engine) |
| 26 | former `client/raw.rawOperationInBatchError` | — | — | — | `raw-sql.test.ts` now proves the raw operation joins the same atomic array batch | — | **RETIRED — raw SQL is lazy and batchable** |

Every survivor answers yes to question 4. The three "no" answers are all
question 2 or 5 and each is a positive reason, not a failure: site 11's upstream
owner covers every ordinary schema and the residue is a measured degenerate one;
sites 21 and 22 must NOT move earlier because untaken-arm inertness is a
contract (§4.4).

## Disagreements with O1's analysis, measured in O2/O3

1. **Site 3 is `keep`, not `move-to-owner`.** O1 proposed delegating its
   non-literal arm to `transitionedCreateParent`/`postTransitionReference`
   because the sentence is byte-identical. Measured: it is not the same decision.
   Site 3 refuses on `!isConstructionLiteral(literal)`, which is false for `null`,
   an `Sql` operand, an arithmetic envelope AND a batch-value `Ref`; site 2
   refuses only on `null || isSql` and hands everything else to
   `getUpdatedPrimaryKeyValue`. Delegating would therefore ACCEPT operands that
   are refused today, and `transitionedCreateParent` returns `afterRoot: true`
   where this branch's accepted arm returns `afterRoot: false` — a different
   statement order on a byte-pinned path. That is a semantics change wearing a
   compression's clothes, so it was not made.
2. **Site 17 did not reach the compound-M2M fact "one statement earlier".** It
   never reached it at all. MEASURED with a compound-primary-key model carrying a
   many-to-many relation, driven through the public client: the answer is
   `QueryEngineError` from `correlation-utils.ts:155
   getRequiredSinglePrimaryKeyField`, via `many-to-many-utils.getManyToManyJoinInfo`
   ← `RelationMembership.getRelationMembershipScope` ← `OwnWriteRelation.create` ←
   `OwnWriteAnalyzer.analyze`, i.e. at the record-program boundary, BEFORE
   `CreateOperation` interprets any relation. So the site failed §O3 clause 3 as
   well as clause 1, and the §N2 mandate that kept it does not cover clause 3:
   §7.4 requires the refusal to stand in the ENGINE rather than be restated as a
   validation rule, and it does — with a better message, since the live owner
   names the surrogate-key remedy. Converted to a `QueryEngineError` naming the
   structural invariant, with the behavioral witness this estate's conversion law
   requires. **Plan §7.4's coordinate (`CreateOperation.ts:1998`) should be
   re-pointed at `getRequiredSinglePrimaryKeyField` in the FINAL docs pass.**
3. **Site 14's falsifier gap cannot be closed, and now does not need to be.**
   MEASURED: a direct polymorphic edge's `referencedField` is ALWAYS the target's
   primary key (`schema/validation/rules/polymorphic.ts:621` sets it from
   `target.primaryKey.field`), so making it unresolvable requires the target's PK
   to be absent, `null`, or an `Sql` operand — and the parse boundary refuses all
   three before the engine sees them (probed through the public client on a
   direct polymorphic to-one, in both create and update roots, for `create` and
   `connectOrCreate`). The site is no longer a separate construction position, so
   the census no longer counts an unfalsifiable one; its POSITION is falsified
   through the ordinary caller by `parity-f-fresh-field.test.ts:842`. Its
   `QueryEngineError` twin keeps its class for the same reason: a conversion owes
   a behavioral witness and no payload can produce one.
4. **Site 10's "one unshadowed position" is not live.** MEASURED: the position is
   `nested-target-parts.foldJunctionChildHeldEntry` case `updateMany`, whose only
   producer is `RelationJunctionPart.freshTargetFold` — i.e. CREATE-context data,
   and `ToManyCreateSchema` admits exactly `create`, `createMany`, `connect`,
   `connectOrCreate` and `upsert`. There is no `updateMany` key to carry. The
   owner is now called at that seam anyway, because the seam builds bulk leaves
   without the enclosing record's legality pass and that is a coverage claim one
   can name.

## Falsifier gap list, after O2/O3

| Site | Gap | Status |
|---|---|---|
| 14 · polymorphic before-parent | NONE | **CLOSED BY DELETION.** The site is gone; the position it shared with site 15 is pinned by `parity-f-fresh-field.test.ts:842`. The polymorphic CALLER is unreachable — disagreement 3. |
| 17 · `edgeParentId` | NONE | **CLOSED.** Not by a falsifier for the site, but by a witness for the owner that actually answers: `operation-construction-witnesses.test.ts`, "a compound primary key carrying a many-to-many relation". |
| 10 · `parseScalarUpdateData` | NONE-DISTINGUISHING | **CLOSED BY DELETION** (disagreement 4). |
| 9 · `scalarOnly` | NONE-DISTINGUISHING | **CLOSED BY DELETION.** |
| 2 · the `"membership"` position (`RecordUpdateCompiler.ts:2621`) | The SITE has a falsifier; this POSITION did not | **CLOSED by residual Package G (2026-08-14).** The gap was a position with no witness, and G both witnessed it and removed the noun that named it: `sql-operand-boundary-behavior.ts`, "the same null reaches the same owner through an ADOPT arm, at compile" drives `update { token: null, tags: { connect } }` to the compile-time position and asserts the ONE message, with the create-leaf arm asserting the same message beside it. Site 2 itself is retired in the same change — the sentence is now `requireRewrittenReferenceValue`'s `NestedWriteError`, which names the field and the relation and no longer names a position at all, so there is no `update membership on relation …` left to assert. |
| N10 · `cacheKeyArgs` | Reached, not distinguishable | **STILL OPEN**, recorded as the one series guard with no distinguishing falsifier. |
| N14 · ARCH-7 | No inverse to-one upsert on a child-held edge under a shared-PK fold into the guarded regime | **STILL OPEN.** Raised by Package E, declined by Package K as a witness with no home; it needs `RelationUpsertPart` + `RecordUpdateCompiler` territory and belongs to whoever next owns it. |

## Final counts

Re-measured at the Package O gate with `rg -n "new UnsupportedOperationError"`,
and independently by the architecture review; all three raw counts agree to the
site.

| Scope | Raw sites (base → HEAD) | Distinct invariants (as `UnsupportedOperationError`) |
|---|---|---|
| write-engine | 21 → **15** | **10** (clusters 1, 3, 4×2, 5, 6, 7, 8, 10, 11 — cluster 2 lives in `relation-key-legality.ts` and cluster 12 in `builders/`) |
| query-engine | 24 → **17** | **12** (adds cluster 2 and cluster 12) |
| whole `src` | 26 → **19** | **14** (adds the driver transaction-option and client raw-in-batch boundaries) |

Engine-owned refusal invariants: **13** — the twelve above plus the compound
many-to-many topology, which cluster 9 no longer expresses as an
`UnsupportedOperationError` and `getRequiredSinglePrimaryKeyField` still refuses
before any I/O.

Cluster 4 counts as two throughout (see the correction under the census at the
top of this file). The base numbers on the same convention are 13 for the
query-engine scope and 11 for the write-engine scope, so the lift retired six
sites and **no invariant at all**: one changed class, twelve did not move.

15 is still above §O4's 8–12 band, so the architecture-review path the
coordinator invoked remains the operative one — and the §O3 table above plus the
adjudication record below are that review, site by site. No correctness guard was
deleted to approach the range; the two sites that could have been (3 and 11) were
kept on measurement, and the six that went took no invariant with them. Worth
stating plainly, because it is the reason the overshoot is defensible rather than
merely tolerated: 15 sites express 10 invariants, and a perfect
one-site-per-invariant estate would already sit at 10 — inside the band. The
entire overshoot is five extra sites belonging to three multi-boundary
invariants (the unresolvable-referenced-value family 2/3/5/15, the
relation-owned-FK family 11/12, the shared-primary-key family 4/20), and plan
§O2 row 2 itself names two owners for the first of them.

---

## §O4 — the architecture review: adjudication record

Plan §O4: *"A result above 12 blocks finalization until an architecture review
examines every survivor. The review may approve a higher count only when every
extra site has a distinct reachable trust boundary and unique falsifier."* The
review below was conducted independently of the O2/O3 lane, against HEAD, with
every named falsifier located and 22 coordinates spot-checked. It is reproduced
**verbatim**, including the corrections it returned.

### Verdict

> **APPROVED — the higher census count passes O4's architecture review. All 19
> classified survivors are approved; none rejected.**
>
> RAW COUNTS, re-measured independently at HEAD with `rg -n "new
> UnsupportedOperationError"` (base `0ccd6abf` in parentheses): write-engine 15
> (21), query-engine 17 (24), whole src 19 (26). All three are stated in the
> ledger, in two places, and match my measurement exactly — scope-report
> completeness is satisfied.
>
> DISTINCT INVARIANTS, independently derived by grouping survivors on "one
> sentence naming the invalid domain state": write-engine 10, query-engine 12,
> whole src 14. My grouping matches the ledger's on every cluster boundary EXCEPT
> cluster 4, which the ledger's own prose calls two invariants but its headline
> counts as one — so the ledger's 11/13 should read 12/14 (write-engine 10 is
> right, by a cancelling pair of errors). This is the number §O4 calls more
> important, and it is the one substantive correction I am returning.
>
> WHY THE COUNT IS APPROVED RATHER THAN MERELY TOLERATED. 15 write-engine sites
> express 10 invariants. Even a perfect one-site-per-invariant estate would sit at
> 10 — inside the 8–12 band — so the entire overshoot is five extra sites
> belonging to exactly three multi-boundary invariants, and each extra names a
> boundary I verified in code rather than in prose: the
> unresolvable-referenced-value family carries four sites (2, 3, 5, 15) across
> create root vs update root and, within the update root, the per-member compound
> closure vs the arity-1 non-primary-key branch, whose predicates I confirmed
> differ (`null||isSql` vs `!isConstructionLiteral`) and whose accepted arms order
> the INSERT differently (afterRoot false vs true); the relation-owned-FK family
> carries two (11, 12), one a parse residue on a schema where
> `getInverseRelationMap` and `bindRelation` demonstrably disagree, the other an
> absorb-or-refuse decision with its own accept witnesses; the shared-primary-key
> family carries two (4, 20), separated by the presence or absence of a located
> row. Plan §O2 itself names two owners for the first of these, so it is licensed
> rather than tolerated.
>
> FALSIFIERS. I located every named falsifier file and spot-checked 22
> coordinates: every one resolves to a real assertion pinning the exact sentence.
> No survivor rests on a hypothetical internal call. The executable census owner
> (`operation-construction-inventory.test.ts`) pins write-engine at 15,
> re-resolves all 19 throw coordinates and 18 owner declarations, and asserts the
> classified list stays length 19 so a site cannot be dropped to keep it green.
>
> NO SHARED HELPER HIDES A DECISION (plan §9). `requireRecordReferenced` takes no
> error, class or message from callers and has exactly one condition under it,
> with the position argument selecting a noun; `relationOwnsForeignKey` and
> `unresolvedFreshReferenceMessage` return strings, and each caller still
> constructs and throws its own error. The one residual smell — a sentence shared
> across `UnsupportedOperationError` and `QueryEngineError` at
> `CreateOperation.ts:1016` — is recorded with a measured reason (no reachable
> payload exists to witness a conversion) and is out of census either way.
>
> CONDITIONS ON APPROVAL (none blocking, all for the final report): fix the
> distinct-invariant arithmetic to 10/12/14 and correct cluster 4's
> justification; correct the now-false one-emitter comment at
> `parity-d-transition.test.ts:828`, which the ledger itself mandated; quote the
> executable companion's coordinates rather than the ledger's O1-era prose; add
> Package I's substrate-refusal asymmetry to the non-census table; re-point plan
> §7.4 from `CreateOperation.ts:1998` to `getRequiredSinglePrimaryKeyField`. Site
> 2's "membership" position, N10's `cacheKeyArgs` and N14's ARCH-7 remain the
> three honestly recorded falsifier gaps.

### The site-by-site table the review returned

Nineteen survivors, nineteen approvals, no rejections.

| Site | Approved | Reason returned by the review |
|---|:--:|---|
| 22 · `relation-key-legality.ts:110` · `assertSingleTargetMembershipMoveAppliesToRecords` | yes | The record count exists only after capture, so no schema or parse boundary can express this N-dependent rule. Root and nested series now consume this one relation-legality owner. |
| 2 · `RecordUpdateCompiler.ts:1800` · `postTransitionReference` | yes | Boundary is the per-member closure inside `transitionedParentId`, which pairs the located pre-value with the SET operand and therefore cannot run before planning; falsifier `parity-d-transition.test.ts:805`/`:833` verified, with the caveat that its "membership" position (`:2621`) is still unpinned. |
| 3 · `RecordUpdateCompiler.ts:2017` · `resolveCreateParent` | yes | Verified in code that the byte-identical sentence hides two different decisions: this branch refuses on `!isConstructionLiteral` (null, Sql, arithmetic envelope AND Ref) versus site 2's `null\|\|isSql`, returns `afterRoot:false` where the delegation candidate returns true, and is entered only when the referenced field is NOT a primary-key member — disjoint routes, unique falsifier `sql-operand-boundary-behavior.ts:186`. |
| 4 · `RecordUpdateCompiler.ts:3533` · `recordSharedKeyFold` | yes | The update root can only decide "no one final value" against a located row plus the root SET, and `parity-e-shared-pk.test.ts:645` pins a sentence ("does not resolve to one final value") that site 20 cannot emit. |
| 5 · `RecordUpdateCompiler.ts:3612` · `beforeTargetReferencedValue` | yes | Plan §O2 row 2 explicitly licenses one selected-transition owner beside the create-root owner, and `parity-f-fresh-field.test.ts:858` pins the "before-root target" update wording that site 15's create-root owner never produces. |
| 6 · `RecordUpdateCompiler.ts:4767` · `composeToOneEntries` | yes | The public to-one lattice deliberately admits the shape and only this dispatch separates connect+update (composes) from create/connectOrCreate+update; approved as a residue with the stated expiry (the produced-identity selector channel), falsifier `parity-h-to-one-lattice.test.ts:1268` verified. **The expiry has since been met by residual Package E, without that channel — see cluster 8.** |
| 7 · `CreateManyRecordSeries.ts:126` · former constructor refusal | retired | The relation-bearing bulk pass chose suppress-the-whole-subtree semantics and replaced the refusal with an exact root-conflict disposition plus member savepoint. |
| 8 · `RelationJunctionPart.ts:1374` · `resolveCreatePk` | yes | A genuinely different invariant from site 7 — identity, not product meaning — because whether a row was skipped is knowable only per row where the join value resolves; `junction-skip-adoption-behavior.ts:608`/`:652`/`:681` verified. |
| 11 · `RelationWritePart.ts:1250` · `assertOwnedFkAbsentFromUpdateData` | yes | Approved conditionally: question 2 fails for ordinary schemas (N1's parse omission owns them), but the residue route is real in code — `getInverseRelationMap` tests `state.fields` for truthiness at `schema/relation/types.ts:248` where `bindRelation` tests length — pinned by `nested-update-owned-fk.test.ts:459`/`:596`, and applying ONE construction site at all four dispatch positions is uniform application rather than duplication, with the retirement path recorded as a named future unit. |
| 12 · former `RelationUpsertPart.withoutAgreeingOwnedFk` | retired | Package C moved its accept/refuse decision into the selected-record final-assignment contribution owner. |
| 13 · `RelationUpsertPart.ts:1088` · `assertNoIncomingTargetMutationOverlap` | yes | Narrowed to target mutations on the exact incoming parent-held OwnWrite scope; membership writers and child-held self inverses are handled by the ledger/compiler. |
| 15 · `CreateOperation.ts:2772` · `requireRecordReferenced` | yes | The merged cluster-1 owner is one predicate, one class and one condition with the position argument selecting only a noun — not the "common unsupported function" §O2 forbids — and all six previously pinned sentences survive byte-identically (`parity-f-fresh-field.test.ts:813`/`:819`/`:830`/`:842` verified). |
| 19 · historical `CreateOperation.ts:2850` · `producedReference` | yes | A different fact from "no row holds this value". **Residual-I correction:** `fresh-produced-field.test.ts:464` exercised another arm and did not pin the surviving plural non-returning sentence. Phase 2 supplies the exact synthetic non-returning refusal and RETURNING control in `residual-refusal-falsifiers.test.ts`. |
| 20 · historical `CreateOperation.ts:3154` · now `assertSelectedSharedPkValue` | yes | A genuinely different trust boundary from site 4. **Residual-I correction:** the old parity/fresh citations pinned sibling decisions, not this create-root sentence. Phase 2 pins the public selected-null route at `compile(known)`, before root insertion, in `residual-refusal-falsifiers.test.ts`. |
| 21 · `UpsertOperation.ts:1147` · `createArmIdentity` | yes | It fires only when the create arm is TAKEN, so moving it earlier would analyse an untaken arm in violation of §4.4; `produced-compound-identity.test.ts:111` pins the surviving half now that the one-absent-increment case is accepted. |
| 22 · `relation-key-legality.ts:173` · `assertSelectedUpdateManyDataIsScalar` | yes | The merged cluster-2 owner reads `relationWriteKeys` (every entry of the parsed relation collection, ordinary AND polymorphic), so it is strictly stronger than the two Part-level copies it replaced; three falsifiers verified and its callers own its timing so an untaken upsert arm stays inert. |
| 24 · former `builders/decimal-portability.ts:56` · `assertExactDecimalOperation` | retired | The dialect capability it read is gone: SQLite stores the unscaled integer coefficient, so every operation it refused is exact there. Its accept/refuse witness pair became an accept/accept parity pair in `decimal-exact-surface.test.ts`. |
| 25 · `drivers/shared/transaction-options.ts:144` · `refuseTransactionOption` | yes | A driver-capability boundary outside the reviewed engine scope; it constructs-and-returns rather than throwing and is counted honestly in the `src`-wide census. |
| 26 · former `client/raw.ts:129` · `rawOperationInBatchError` | retired | Raw calls no longer execute eagerly; the lazy operation representation removes the invalid state. |

### What the gate did with the review's five conditions

| Condition | Disposition at the gate |
|---|---|
| Fix the distinct-invariant arithmetic to 10/12/14 and correct cluster 4's justification | **DONE** — here, in the census correction at the top of this file, in `operation-construction-inventory.test.ts`, and in `forbidden-shapes-reference.md` §12. The engine-owned total moves 12 → 13 with it. |
| Correct the now-false one-emitter comment at `parity-d-transition.test.ts:828` | **DONE** — the comment now names both emitters, states which one this payload reaches and why (`(area, slot)` is compound, so the arity-1 branch is never entered), and points at disagreement 1. |
| Quote the executable companion's coordinates rather than the ledger's O1-era prose | **DONE** — every stale coordinate in this file now carries its HEAD position beside N3's, and the inventory's own site table gained a HEAD column. |
| Add Package I's substrate-refusal asymmetry to the non-census table | **DONE** — row N17. |
| Re-point plan §7.4 from `CreateOperation.ts:1998` to `getRequiredSinglePrimaryKeyField` | **NOT DONE, deliberately** — `limitation-lift-plan.md` is the normative plan and the FINAL docs pass owns it. Recorded here and in disagreement 2 so it cannot be lost; the coordinate is false at HEAD in the plan's §7.4 text. |

---

## The Package O gate — what it changed, and the three adversarial findings it sustained

The gate re-measured the compress lane's claims rather than accepting them.
Three findings were sustained and fixed, one was sustained as a documentation
defect only, and two were measured and DECLINED with the reason recorded.

**Sustained and fixed.**

1. **The dead-PK-guard class was recorded as exhaustive and is not** — five
   members, not two. Corrected under the non-census table above; the three
   survivors stay, with the reason named (pinned members of the N7-U-A converted
   family) rather than asserted.
2. **`forbidden-shapes-reference.md` contradicted the code in the present tense**
   — it still carried the retired coordinates, "the 24 query-engine sites
   collapse to 12 distinct invariants", the pre-O bucket totals and the verdict
   "§O4's band is a SITE gate, and 24 does not meet it". It is one of §O4's own
   named focused-validation artifacts and the compress lane left it untouched.
   Re-anchored at the gate.
3. **The inventory's closing narrative had gone stale against its own executable
   table** — seven retired rows printed as live, four surviving rows at pre-O
   coordinates, "THE 3 QUERY-ENGINE SITES OUTSIDE THIS DIRECTORY" (now two).
   That is exactly the decay N3 built the `CLASSIFIED` re-resolution to prevent,
   reappearing in the prose the re-resolution does not execute. Fixed.

**Sustained as a documentation defect only.**

4. **The call added at `nested-target-parts.ts:101` was justified by a comment
   that stated the opposite of the lane's own measurement** ("this fold pushes
   its bulk parts unconditionally, so the owner runs here instead" — presented as
   a live route, while disagreement 4 says the position is not live). The GATE
   RE-MEASURED and confirms the position has no live route:
   `buildJunctionTargetRelationParts` is reached only through
   `RelationJunctionPart.freshTargetFold` (directly, or through the
   `deeperBuilder` it threads), whose data is a `create` payload parsed by
   `buildParsedRelationPrograms`, and `ToManyCreateSchema` has no `updateMany`
   key. **The call is KEPT and the comment is corrected**, for two reasons that
   are the same reason: it is a CALL POSITION of the one owner, not a second
   construction site — the pattern site 11 uses at four positions, which this
   review approved by name as "uniform application rather than duplication" — and
   the Package N gate's standing instruction is not to read "no measured live
   route" as licence on a bulk arm, because the arm N's own implementer note had
   called dead was the one silently reparenting rows. What Package O deleted at
   that seam was the RESTATEMENT (site 10's own construction site and its
   byte-identical sentence), which is what the one-guard rule is about.

**Measured and declined.**

5. **"Convert the `:1027` twin, or do not convert site 17"** — the review of the
   conversion law's symmetry. Declined: the two are not symmetric. Site 17's
   conversion has the behavioral witness the law demands
   (`operation-construction-witnesses.test.ts`, "a compound primary key carrying
   a many-to-many relation", which pins the answering owner, its stack, and the
   fact that the parse boundary does not answer). The twin's cannot be written at
   all — a direct polymorphic edge's referenced field is always the target's
   primary key, and the three spellings that would make it unresolvable are
   refused by the parse boundary first — so converting it would be a class change
   with no witness, which is the thing the law forbids. The cost the review named
   is real and is recorded rather than dismissed: `QueryEngineError` defaults to
   `V9001 INTERNAL_ERROR`, which `classifyFailure` reports as a defect rather
   than a failure. For site 17 that changes nothing a caller can observe, because
   the owner that actually answers the payload
   (`correlation-utils.ts:155 getRequiredSinglePrimaryKeyField`) was already a
   `QueryEngineError` before this package. **That the compound-M2M refusal reaches
   callers as an internal-error classification at all is a pre-existing
   truthfulness defect of that owner, not of this conversion** — it is plan §7.4
   material (a named future capability), so it should surface as a capability
   refusal. Recorded for the final report; fixing it means giving
   `getRequiredSinglePrimaryKeyField` an expected classification, which is a
   change to a live refusal's public class and needs its own witness.
6. **"Re-measure site 11's four call positions rather than inheriting Package N's
   measurement"** — declined as a change, accepted as a provenance fix. The
   disposition (keep all four) is the direction that needs no new measurement;
   what was wrong was presenting N's measurement in O's voice. Site 11's row now
   attributes it.

### The three plan §9 acceptance items Package O owns

| §9 item | Verdict | Evidence |
|---|---|---|
| *"Every `UnsupportedOperationError` construction site has one unique reachable falsifier and names a distinct first-knowable invariant."* | **MET, 19/19.** | Every survivor's falsifier is named in the cluster tables above and was located at the gate; the two `src` sites outside the query engine, which had no falsifier recorded in O1, were tracked down and are now named in the §O3 table. No survivor's Falsifier cell reads `NONE` — the only two `NONE` rows in this file are sites 14 and 17, both retired. The three honestly recorded gaps are NOT sites: a POSITION of site 2 (`"membership"`), the non-census `cacheKeyArgs`, and the non-census ARCH-7 coverage hole. |
| *"The expected raw refusal census is 8–12. A higher result has received the explicit architecture review required by Package O."* | **MET by review, not by count.** 15 write-engine / 17 query-engine / 19 `src`. | The review is recorded above, verbatim, with a site-by-site table: 19 approved, none rejected. |
| *"No shared error helper hides multiple independent guard decisions."* | **MET.** | Re-checked at the gate by reading all 19 construction sites: not one takes an error, a class, or a message from its caller. Three consume a message BUILDER that returns a string — `relationOwnsForeignKey` (sites 11, 12) and `unresolvedFreshReferenceMessage` (site 15 and the `QueryEngineError` twin) — and in every case the condition, the class and the `throw` stay at the site. `requireRecordReferenced`, the one construction site this package merged, has exactly one condition under it (`recordReferenced` returned `undefined`) and its `position` argument selects a noun, not a decision. The one coupling this creates is recorded as N18 rather than hidden. |

### Validation run at the gate

Sequential, single process, one file at a time for the focused set, on the tree
being committed.

| Run | Result |
|---|---|
| 37 focused files, one at a time, `--project=coverage-write-engine` | ALL GREEN. Every falsifier the compress lane touched or wrote (`junction-adopt-create-relations` 19, `upsert-untaken-arm-legality` 4, `inverse-to-one-update-depth` 33, `fresh-produced-field` 19, `compound-relation-adoption` 6, `nested-update-owned-fk` 22, `sql-operand-boundary` 6, `produced-compound-identity` 11, `junction-skip-adoption` 20, `create-many-relation-series` 41, `update-many-relation-series` 52, `nested-arm-dispatch` 74, `compiled-key-transition` 16, `parent-held-lookup` 54, `adopt-owned-fk-agreement` 31, `shared-pk-update-root` 48, `vacate-then-supply` 43, `target-projection.core` 10, `operation-construction-witnesses` 22), all NINE parity files (`parity-b` 18, `-c` 24, `-d` 26, `-e` 46, `-f` 22, `-h` 79, `-j` 18, `-k` 29, `-m` 12), `record-compiler-contract` 24, `record-series-contract` 8, `architecture-gates.core` 6, `parse-boundary-gate.core` 6, `dead-symbol-gate.core` 16, `fragment-validator.core` 10, `unsupported-operation-error` 4, and the census owner `operation-construction-inventory` 7 LAST. |
| `decimal-refusal-surface.test.ts` | 88 passed — re-run under `--project=extended-local` after the write-engine project reported "No test files found" for it (it lives under `tests/contracts/engine/query/` and is not `.core`). A file that silently matches nothing is a green that means nothing; recorded so the next lane does not repeat it. |
| `pnpm test:types` | clean, 23.6s. |
| `pnpm test:layer:query-engine` | 45 files / **796** tests passed, then `FATAL ERROR: Ineffective mark-compacts near heap limit` AFTER the last test. **Pre-existing**: Package N's own gate logs show the identical FATAL after an identical all-passed line on two different layers (`operation-schemas` 37/1037, `cache` 4/60). 796 = Package M's 797 minus the one `capturedTargetConstraint` unit test this package deleted with its dead owner. |
| `pnpm test:coverage:write-engine` | 151 files passed / 20 skipped, **3,098 passed / 354 skipped** — identical to Package N's gate and to the compress lane's run. NOTE: the packaged script's `--wall-limit-ms=300000` is now borderline on this machine (296.6s here; 234–267s at the D/M/N gates), and the first attempt was killed by that wall with every visible file green. Re-run at `--wall-limit-ms=600000` with the same config for the count above. Not a test failure; a harness budget worth raising. |
| `pnpm test` | 215 files / **5,046** tests passed. |
| `pnpm test:all` | Run ONCE, phase by phase, counts recorded rather than exit codes. `pnpm test` 215/**5,046** · `extended-local` 138 passed + 20 skipped files, **3,186 passed / 359 skipped** · `provider-pglite` **779 passed / 1 skipped** · `provider-sqlite3` + `provider-libsql` **2,296 passed / 2 skipped** · `provider-bun` **2 passed** · `provider-d1` **FAILED AT COLLECTION** (see below) · `test:package` was never reached, because the `&&` chain stops at d1 — run separately: tsdown build OK, **4 passed**. The one count that moved against Package N's gate log is `extended-local`: 3,186 against N's 3,185, and the difference is exactly the one witness this package added (the site-17 conversion witness). `.core` files are excluded from `extended-local`, which is why the deleted `capturedTargetConstraint` unit does not show up as a −1 there; it shows up in the layer run. |
| `provider-d1` — the one red phase | **PRE-EXISTING, PROVEN, NOT PACKAGE O's.** `tests/providers/workers/d1.test.ts` fails during COLLECTION with workerd's `Disallowed operation called within global scope … generating random values are not allowed within global scope`, thrown at `@paralleldrive/cuid2/src/index.js:134` — that package's own top-level `init()`, reached through `d1.test.ts → @src/drivers/d1 → @client/client → … → schema/scalars/string/scalar.ts → autogenerate.ts`. Measured both directions rather than argued: (1) Package O added **no** module to any import graph — its only new import is `assertSelectedUpdateManyDataIsScalar`, from a module three write-engine files already imported — and it REMOVED one (`TargetConstraint`); `src/schema/` is byte-identical to `0ccd6abf` and the sole importer of `autogenerate` is clean; (2) the identical failure REPRODUCES AT `0ccd6abf` in a throwaway `git worktree` with the same `node_modules` (same message, same three frames). The worktree was removed and the main tree was never touched. Flagged for the final report: no gate in this lift had run the `provider-d1` project before, which is why it surfaces here. |

## Addendum — distinct-truth Phase 5 (derive membership views from bound topology)

Two standing items and one ownership move, recorded against the arity-pairing
guards the phase touched.

**Plan §7.4's stale coordinate.** `CreateOperation.ts:1998` (§O2 disagreement 2
above) is re-pointed at `getRequiredSinglePrimaryKeyField`, now
`builders/relation-data-builder.ts:369` — it moved there in Phase 3 with the
junction binder that owns its only consumers. The refusal, its class and both
sentences are unchanged; only the file is.

**Guard #1 — mismatched foreign-key metadata.** The owner MOVED from
`RelationMembership.getRelationMembershipScope` into the binder's lazy `members`
getter (`relation-data-builder.ts`, `buildForeignKeyMembership`). Same class
(`NestedWriteError`), same message bytes, same `relationInfo.name` argument, same
first-access timing: the getter is lazy and memoized precisely so binding does not
pair, and the scope reader is still the first consumer to ask. The pinned order
(`bound-relation.core.test.ts` "relation-key legality still answers before mismatched FK
arity") is preserved by keeping `relation-key-legality.ts` off `.members`.

**Guard #2 — `assertEqualArity` — DELETED.** What is impossible now: a member
binding a missing source. The pairers iterate the BOUND members, and every source
list is built either by mapping the members themselves or over `referencedFields`
after `.members` has already answered — which proves `referencedFields` is at
least as long as the member list, so `sources[index]` is always populated.
RESIDUAL, recorded: `references` LONGER than `fields` is still constructible on
the client path (schema rule FK007 does not run there), was refused on write
paths by `assertEqualArity`'s internal error, and now binds the paired prefix
silently — the extras were never bound before either, and correlated READS still
refuse the shape via guard #3, but the write/read asymmetry is new and unpinned.
The refs-SHORTER direction is guard #1's at `.members`, unchanged.

**Guard #3 — `correlation-utils.ts` mismatched fields/references — KEPT.** Its
sentence is distinct (`has mismatched fields (n) and references (m)`), it is on the
READ path, and it is publicly reachable on the same schema shape. It is also what
proves the member pairing below it cannot refuse and displace it, so it now carries
a second, stated job rather than being a redundant restatement.

**Guards #4 and #5 — untouched.** `RelationUpsertPart`'s index-alignment refusal
keeps its class, message and documented-unreachable status (its arity read now goes
through the row-held `membershipReferencedFields` projection, because polymorphic
membership carries one referenced FIELD rather than a one-element list).
`CreateOperation.edgeParentId`'s compound-row-key refusal is unchanged in text,
class and reachability.

## Addendum — distinct-truth Phase 7 (centralize read-side physical traversal)

One deletion, one replacement, one guard re-verified in place.

**`buildCorrelation`'s junction refusal — DELETED (`correlation-utils.ts:56-61`,
`QueryEngineError`, "Many-to-many relation '<n>' cannot use buildCorrelation
directly. …").** What is impossible now: reaching that function with a junction
relation. `buildCorrelation` no longer takes a `RelationInfo` and binds it — it
takes the BOUND row-held relation (`ParentHeldRelation | ChildHeldRelation`), and
its single caller is `relation-traversal.ts`'s row-held arm, which exists only
under the one classification (`classifyRelation`). The junction answer constructs
the other arm and calls `buildManyToManyJoinParts`. So the gate is the union type
plus one classification, not a green run — which matters, because the refusal was
UNREACHABLE and UNCOVERED at Phase 0 and the baseline record said so explicitly:
"the honest gate is those four dispatch coordinates, not a green run"
(`distinct-truth-baseline-phase0.md:102-105`). Those four dispatch coordinates
(`include-builder.ts:86,151`, `relation-filter-builder.ts:339`,
`relation-count-builder.ts:45`) are themselves gone, replaced by the traversal's
one classification — the same predicate, in one place, now expressed in the type
of what it returns.

**`ManyToManyStatements.materialize`'s guard — REPLACED, not added
(`ManyToManyStatements.ts:53`).** Same class (`QueryEngineError`), byte-identical
sentence ("Relation statement references unknown many-to-many relation '<n>'."),
same position in time: it now asks `classifyRelation(...).kind !== "junction"`
instead of `relation.type !== "manyToMany"`. Classifying binds nothing, so the
guard still runs before any topology resolution — the compound-M2M refusal and the
junction-naming errors still fire when a side is READ, with the stack frames
Package O pinned. This is what let `bindJunctionRelation`'s second exported entry
point be absorbed: every caller now reaches the one construction through the one
classifier.

**Guard #3 — `correlation-utils.ts` mismatched fields/references — KEPT, VERBATIM.**
Class, sentence and position are unchanged, and its second stated job is unchanged
with it: it still runs BEFORE the first read of `membership.members`, so guard #1's
`NestedWriteError` cannot displace it. Phase 7 moved the bind out of the function
(the traversal binds and passes the bound value in) but not the order of these two
reads — the arity comparison reads `foreignFields`/`referencedFields`, which are
eager fields, and `.members` is still touched only below it. The code says so in a
comment, because neither message has a test witness and a silent displacement
would pass the whole suite.

## Addendum — distinct-truth Phase 8 stage 1 (project nested relation data once)

No guard was added, moved or deleted. What changed is what can REACH two engine
sentences, and one runtime/type divergence that is now a single expression.

**`resolvePolymorphicMutationIntent`'s invalid-payload sentence — KEPT, now
engine-fault-only (`builders/polymorphic-mutation.ts:106`, `:125`).** Both
constructions read `Polymorphic relation '<r>' produced an invalid mutation
payload.` and neither has ever had a test witness (the only occurrences are the two
source lines) because the parse boundary refused first — INCLUDING the presence
corner: a required direct polymorphic membership is required by PRESENCE
(`requiresOneOfKeySets`, `primitives/object.ts:511-528`), so `{ subject: {} }`
satisfied the requirement, but the old per-verb union still refused the empty
payload at parse in the union's voice (`Value did not match any union member`).
The hazard was COUNTERFACTUAL: a naive lattice migration whose empty arm parses
clean would have let that corner reach `:125` as an internal error. Unit 8.3
forecloses it — the direct surface takes the lattice owner in `exactlyOne` mode,
whose zero-active refusal (`Missing to-one operation: expected exactly one of …`)
answers the corner in the lattice's own voice; the witness is
`polymorphic.core.test.ts` "the required-membership corner refuses at parse, not in
the engine". The engine check STAYS: it is the fail-closed floor for a payload that
reaches the resolver without passing the schema, and it is now exactly that and
nothing else.

**`… produced an invalid <operation> mutation.` (`polymorphic-mutation.ts:131`) —
KEPT, and its one reachable route closed.** The route was the direct `update` arm,
whose payload schema required only `data` while the published TYPE required the
discriminator too; a validated `{ update: { data } }` therefore reached the engine
with no `type`. The migrated arm requires `type` and `data`
(`relations/polymorphic/update.ts`), which is the type surface unchanged and the
runtime narrowed to meet it — a pre-existing divergence fixed, with the witness in
`polymorphic.core.test.ts` "the update arm still requires the discriminator its
engine step addresses".

**Polymorphic-inverse to-one `delete` — one expression for both levels
(R10).** The deleted clone added `delete: v.boolean()` unconditionally while
`PolymorphicInverseToOneSchemas` gated the same key on `S["optional"] extends
true`. Unified through `toOneUpdateFactory`, whose optional gate is now the single
reading. Unreachable divergence: schema rule R008 (`rules/relation.ts:53-77`)
forces a fields-less `oneToOne` to be optional, and that branch was the only entry —
so no validated schema observes the change.

## Addendum — distinct-truth Phase 8 stage 2 (derive relation clearability once)

The two facts about emptying a relation now have ONE owner,
`src/schema/relation/clearability.ts`: `slotMayBeEmpty` (public optionality) and
`membershipCanBeCleared` (physical storage), each with its type twin beside it. The
operation-schema availability sites read them; the duplicate per-field nullability
scan that lived in the validation layer is deleted. **No engine guard moved, and no
validation-layer fact was threaded into the engine** — `relation-nullability.ts` still
answers from BOUND membership (Phase 5), which is the only reading available to it.

**`assertRelationCanDisconnect` / `requiredForeignKeyFields` — KEPT, byte-identical,
with unique coverage that the schema layer cannot take.** Both sentences are
unchanged, and so are the three call positions (`RecordUpdateCompiler.ts:1741`,
`:2888` — skipped when `rebound` — and `:4121`). What the schema owner does NOT cover,
and why:

1. **A parent-held optional to-one whose own foreign-key column is not nullable.**
   The operation schema exposes `disconnect` on that direction from the SLOT fact
   alone, and the membership fact cannot answer for it: the column sits on the SOURCE
   row, while `membershipCanBeCleared`'s ordinary reading is the TARGET's scalars.
   The canonical instance is a shared primary key — `accountId` is both identity and
   foreign key, so it is never nullable while the slot is optional. This is a PUBLIC
   route through the client, pinned at
   `parity-e-shared-pk.test.ts:803` (fixture comment at `:147`: "the only spelling `disconnect` reaches") and
   `shared-pk-update-root-behavior.ts:630`. Making the schema withhold `disconnect`
   there would be a capability change and would need the optionality/nullability
   agreement rule the plan forbids.
2. **`set` dropping members on a non-clearable membership.** The same
   `requiredForeignKeyFields` fact is consumed as a NON-refusal by
   `buildToManySetPart` (`RelationWritePart.ts:1350` → `RelationSetPart.requiredFk`),
   which refuses with its own sentence (`messages.ts:51`, "rows removed from the set
   cannot be disconnected. Delete them instead."). The schema deliberately still
   offers `set` on a non-clearable membership (`compatibility.mdx:144-146`), so this
   route exists by design; pinned at `nested-mutation-behavior.ts:332`,
   `m7-error-surface.test.ts:153`, `nested-write-behavior.ts:951`.
3. **Trusted internal programs that never pass the public schema** — e.g. the
   single-statement build API spelling `disconnect` on a REQUIRED relation whose
   schema owns no such key (`sql-generation.core.test.ts:1450`).

**The two facts stay two.** On a polymorphic edge they coincide by definition (the
private `(type, id)` pair is nullable exactly when the relation is optional); on an
ordinary edge they diverge, and an optional slot with a non-nullable child foreign key
is a legal schema whose to-one surface offers `delete` without `disconnect`. That
divergence is what item 1 above is made of, and the plan (§8.2) explicitly leaves any
rule forcing the two to agree as a separate, source-breaking product decision.

## Distinct-truth Phase 10 — prototype REJECTED at its own gate (falsifier record)

The compiled-selection prototype (plan Phase 10) was implemented in its only
byte-safe form and rejected at the 10.3 gate. The record, so it is not re-run
on the same evidence:

- Every threading route from the selection traversal to the operation object is
  closed at this estate's shape: hoisting the compile renumbers aliases (the
  find path spends up to three pagination aliases before the projection; every
  write builder compiles its WHERE first, and an extended-unique where spends a
  hide alias); the two find builders have 67 call sites of which ~63 never
  parse; a shape-only mode duplicates the branch structure it claims to unify;
  an out-parameter capture is a context bag.
- The one byte-safe variant — the parser-side shape delegating to the select
  traversal over a throwaway scope — was built whole and measured: SQL bytes
  exact, parsing exact, CTE eligibility unchanged, tsc within budget, but
  e2e overhead regressed 6–9% on findUnique/include/create (the discarded SQL
  build per parse), and physical production LOC rose (+101). Rejected; the
  five explicit owners stand, with the two pre-SQL predicates now carrying the
  structural reason they cannot consume a compiled fact.
- Permanent value kept: the five projection-interpretation pins (commit
  92c9397c), and `relationCardinality(state)` as the one owner of the
  type→cardinality derivation (four former inline spellings).
- Consequence: plan Phase 11 (conditional on a retained Phase 10) does not run.

## Addendum — distinct-truth Phase 12 (final deletion and doctrine)

Four code deletions, each adjudicated against HEAD before it was made, plus the
proof history the production comment sweep moved here rather than dropped.

**Three dead engine refusals — DELETED, because the compiler is the owner now.**
`RelationInfo["cardinality"]` is the two-value union `"one" | "many"`
(`query-engine/types.ts:228`, derived by `relationCardinality`), so a third state
is unconstructible and the three sentences that named one could not fire:

1. `relation-orderby-builder.ts:69` — `Unsupported relation orderBy '<n>'.`,
   after arms that test `=== "one"` and `=== "many"` and both return;
2. `relation-orderby-builder.ts:124` — the same sentence on a nested field path,
   behind `if (nestedRelationInfo.cardinality === "many") throw`, so `!== "one"`
   is the empty set;
3. `relation-filter-builder.ts:145` — `Unsupported relation filter '<n>'.`, in
   the same shape as (1).

None was message-pinned anywhere in `src/`, `tests/` or `docs/` (verified by
grep at HEAD before deletion), and none had a witness. The to-many/to-one arms
are now the total dispatch they always were: the last arm is unconditional.

**`OwnWriteSteps.buildToOneUpdateFootprint`'s junction refusal — DELETED, because
the TYPE SYSTEM is the owner.** The refusal read
`Relation '<n>' is many-to-many and has no FK direction. Many-to-many writes must
go through the junction table handlers.` and doubled as the narrowing that let
the body read `membership.foreignFields`. The parameter is now
`ParentHeldRelation | ChildHeldRelation`, which is the same narrowing stated once:
`JunctionBoundRelation.cardinality` is the literal `"many"`
(`relation-data-builder.ts:185-189`), and the only caller is inside
`processUpdate`'s `boundRelation.cardinality === "one"` arm — so a junction cannot
be passed, and passing one would now be a compile error rather than a runtime
sentence. Not message-pinned (the other occurrences (also in map-tx-create-connect.md and map-oracle-and-callers.md, all prose) in the repo is a prose
line in `engine-unification/map-shared-and-m2m.md`).

**Seven index-pairing walks — FOLDED onto `membership.members`.** Byte-neutral by
construction: `pairMembers` is `foreignFields.map((f, i) => ({ f, referencedFields[i] }))`,
so the folded loops read the same arrays in the same order with the same index
math, and the mismatched-foreign-key refusal keeps its single lazy owner. The
seven, re-resolved at HEAD: `CreateOperation.ts` `resolveSharedPkIdentity`,
`toOneFkAssign`, `beforeParentFkAssign`, `childFkAssign`; `RecordUpdateCompiler.ts`
`recordSharedKeyFold`, `beforeTargetFkAssign`, `toOneFkAssign`. No refusal moved,
and no site now spells `foreignFields[i]` beside `referencedFields[i]`.

**`interpretParentHeldToOne` → `interpretParentHeld`.** A tautological
cross-product name: parent-held is always to-one, which is what the union already
says. Renamed at its four `RecordUpdateCompiler` coordinates and in every live doc
and test comment naming the method. The historical rows above (cluster 13, and the
`<parentHeldToOne>` query spellings in clusters 1, 4 and 6) keep the old spelling
on purpose — they record what a site was called when it was measured.

**Proof history relocated out of production comments.** Two blocks stated a
deletion's argument at the site of the deleted thing; both are recorded here and
removed from `src/`:

- `relation-key-legality.ts` — `assertPinnedTransitionIsCompilable` lived there
  and is deleted. It refused a selected target that transitions a row-key member
  the locator does not pin while a deeper non-cascading edge references that
  member, because the engine could not name the member's pre-transition value
  ("…transitions the target primary key '<field>' while writing a deeper edge
  whose foreign key does not cascade on update; it must locate the target by that
  primary key."). `RecordUpdateCompiler.interpretReferencedKeyTransition` now
  names it — the located row supplies every member's OLD value and
  `postTransitionReference` derives every member's NEW value — so the refusal has
  a compiling answer, and its five eager arm-side call sites went with it. Its
  domain was also strictly NARROWER than the compiler's: row-key members only, and
  it matched a parent-held membership's `referencedFields`, which name the
  TARGET's columns rather than the selected model's, by name across two models.
- `target-projection.ts` — `capturedTargetConstraint` lived there with zero
  production consumers and is deleted. It was refused on SHAPE: an occupied-slot
  predicate is a `where` over the CHILD scope whose conjuncts pair the child's
  FOREIGN fields with the PARENT's pre-transition referenced values, and a
  `TargetConstraint` binds ONE model's own field names to values, so the
  cross-model pairing the relation topology owns had nowhere to live in it. It
  also asked the wrong question — "do these two static targets overlap", not "does
  any row exist here" — and there is no captured child row to normalize, since
  discovering whether one exists is that guard's whole purpose. The occupied
  guard's conjuncts come from the correlated membership binding through
  `planningMembershipCondition` / `finalMembershipCondition`; where a captured row
  key belongs beside a selector, `capturedTargetFilters` is the live shape.

**Sequence check.** The Phase 5, 7, 8-stage-1, 8-stage-2 and 10 addenda above were
re-read in order at this phase and still read coherently: 5 moves guard #1 into the
binder's lazy `members` getter and deletes `assertEqualArity`; 7 deletes
`buildCorrelation`'s junction refusal and replaces `ManyToManyStatements`'
guard with the classifier; 8 stage 1 keeps two polymorphic engine-fault sentences
and closes their one reachable route; 8 stage 2 gives clearability one owner and
records the three coverages the schema layer cannot take; 10 records a REJECTED
prototype. Phase 12 adds no guard, moves none, and deletes only refusals whose
owner is now a type.

Two counterfactual notes for the Phase 12 deletions, recorded so the reasoning is
not re-derived: (1) a FORGED third cardinality value (unconstructible from any
public input) would now land in the adjacent arm's own shape validation — loud but
differently worded at the orderBy-name and filter sites, and a silent to-one JOIN
at the nested-orderBy site, which is double-impossible (it must also survive the
"many" throw above it). (2) The seven pairing folds are byte-neutral on every
well-formed schema; on malformed-arity metadata in DEFERRED-legality flows (upsert
arms, nested fresh subtrees) they newly fire the pairing owner's NestedWriteError
at construction where the raw walks silently paired `undefined` — root flows were
already dominated by the analyzer's `.members` touch. A strict widening toward the
single owner, which is the fold's point.

One clarification on the updateMany wall (row 22), for the reader chasing "the
wall": DETECTION has one owner (`findRelationBearingUpdateManyData` over the one
parsed collection), and the REFUSAL has two boundary spellings by position — the
root update refuses as a `NestedWriteError` naming the nested-writes contract,
every selected/deeper position as the census's `UnsupportedOperationError`. Row
22's "only expression of this invariant" is a claim about the census class; the
root sentence is the same detector's other voice, not a second detector. The
polymorphic reach of the selected-position guard is exercised through the ROOT
twin's witness; the selected-position falsifiers are ordinary-relation shaped.

## Addendum — polymorphic cardinality Package D, fence A (bound `JunctionStatements`)

One deletion. No guard added, none moved.

**`ManyToManyStatements.materialize`'s guard — DELETED, its owner is now a type
(the module is `JunctionStatements.ts`).** The Phase 7 addendum above recorded
this same guard as REPLACED — `classifyRelation(...).kind !== "junction"` in place
of `relation.type !== "manyToMany"`, same class, byte-identical sentence
("Relation statement references unknown many-to-many relation '<n>'."). It is now
gone entirely, because `materialize` takes a `JunctionBoundRelation` rather than a
`RelationInfo`: the question the refusal asked is answered by the parameter's
type, and there is no longer a moment at which a caller could ask it wrongly.

Both call sites already held the bound value and passed it straight back in
(`RelationJunctionPart` holds `context.relation`; `NestedSelectedRecordSeries`
holds `membership.relation` and was unwrapping it to `.relationInfo` only to have
the callee re-bind it), so the emitted SQL is unchanged for every ordinary
junction — the byte pins in `junction-*`, `m2m-mutation`, `compound-junction` and
`read-traversal-byte-pins` are the executable statement of that.

This is not a coverage loss: the refusal was unreachable from any public payload
and uncovered, exactly as the Phase 7 note said of `buildCorrelation`'s. It was
also the last thing forcing a junction to be re-derivable FROM ITS NAME, which a
direct polymorphic collection's per-variant member carrier is not — the deletion
is what admits that binding, and the seam comment at the top of
`JunctionStatements.ts` records the two operations the singular-junction transfer
will add to the union.

## Addendum — polymorphic cardinality Package D, fence B (direct collection writes)

**One construction refusal added, one classifier guard added, two grammar
refusals added, one grammar refusal deleted, one re-pointed. No guard moved.**

**ADDED — `assertClearIsIndivisible` (`PolymorphicCollectionPart.ts`), census
site 33.** A collection `set` is one indivisible unit: clear every configured
member table, then refill. `generatedOutputSegments` is the only splitter of a
non-series atomic batch, and the eligibility checks around it gate PER-STEP
`expects` and `onUniqueConflict` — nothing marks a GROUP of steps indivisible. So
after the final guard/clear/write order exists, the coordinator shares the
executor's exact boundary analysis and refuses only when a non-transactional
batch would really split after the first clear. A boundary before the clear or
an insert-id dependency served by batch scratch is accepted. Unique coverage,
nameable: *the clear committed without its refill*.
The alternative — an executor-side indivisible-group marker — was declined: it
would be a second mechanism for a property §13.4 explicitly admits "refuses
before the clear" as satisfying.

**ADDED — the pre-bound carrier guard in `classifyRelation`.** A direct
collection binds one member junction per variant, owner-oriented, at parse time.
Those carriers live in no relation map, so the ONLY way one reaches a resolver is
by being passed to it — and if it were, `resolvePolymorphicCollectionMember` would
answer the VARIANT orientation (the reverse of what a direct entry needs) or, for
an unbound variant, the ordinary `manyToMany` arm would compile against a pair
table the serializer never emits. Unique coverage, nameable: *a pre-bound carrier
reached a resolver and would have silently bound the wrong topology*. The brand it
tests (`RelationInfo.polymorphicMemberCarrier`) exists for this guard and nothing
else.

**NARROWED, THEN DELETED (grammar) — `inverseCollectionWriteRefusal` →
`singularInverseCollectionWriteRefusal` → gone
(`validation/relations/index.ts`).** The refusal Package D had to ADD closed a
hole open on all three doors:
`getRelationSchemas` dispatched on cardinality alone, `classifyRelation` bound
both inverses as real junctions, and `membershipCanBeCleared` answered `true`
unconditionally — so a fields-less `manyToOne`/`manyToMany` bound to a `.toMany()`
group received the FULL ordinary write family, and a singular-inverse `connect`
emitted a bare junction insert with NO vacate.

Package E splits it by the ASKER's arity, which is where plan §9.4/§9.5 put the
boundary:

- the PLURAL inverse (`manyToMany`) is a fixed-variant ordinary junction VIEW. The
  binder already supplied the same topology in reverse orientation and
  `RelationJunctionPart` / `JunctionStatements` are written entirely against
  `membership.source` / `membership.target`, so every verb works unchanged. The
  refusal is LIFTED with no engine change, and eight dual-substrate rows in
  `polymorphic-collection-write-family.test.ts` assert §9.5's five observable
  consequences against DATABASE STATE plus the DIRECT collection read;
- the SINGULAR inverse (`manyToOne`) refused for one more round, with a sentence
  naming the SHAPE rather than a package, per plan §12's rule that a refusal must
  say which declaration reached it.

**DELETED (grammar) — `singularInverseCollectionWriteRefusal`, and its type half
with it.** §9.4's lattice now exists, so the sentence stopped being true. The
singular inverse is a to-one SLOT — one member-junction row under a UNIQUE over
the complete variant side — and takes the ordinary to-one create and update
families verbatim; `GetRelationSchemas` dispatches on cardinality alone again,
and `HasPolymorphicCollectionInverse` / `BindsPolymorphicMemberJunction` are
deleted from `nested-data-projection.ts` in the SAME commit, because that file's
own doc says both halves answer together and splitting them re-opens the B3
advertise/refuse skew in its unsafe direction. What made the sentence necessary
was never the FAMILIES — it was the LOWERING, and the lowering now has an owner.

**ADDED (engine, no census site) — `RelationJunctionToOnePart`
(`write-engine/RelationJunctionToOnePart.ts`).** A thin dispatcher and
orientation adapter over the bound member-table topology and `JunctionStatements`.
It owns exactly three things, and each replaces a MEASURED wrong answer rather
than filling a gap:

1. **the composition order.** `(vacate, supplier, modify)` is CONSUMED from
   `classifyToOneComposition` — the same owner `OwnWriteRelation` reads — never
   from the parsed entry order, which `RELATION_MUTATION_KEYS` lists as
   `update` (3rd) before `connect` (9th) and would therefore lower modify before
   supply.
2. **the four correlated spellings.** `disconnect: true` deletes THE junction row
   by the variant side alone (the plural fold raises
   `m2mDisconnectRequiresSelector`, a sentence written for a relation where
   "which membership" is a real question); `delete: true` deletes the SINGLE
   captured owner row addressed by its captured row key (the plural fold lowers it
   to `{kind: "deleteMany", filters: [{}]}`, whose `compileDeleteMany` sweeps the
   whole connected set through `membership.target.model` — the polymorphic OWNER
   in this reversed orientation); `update` and `upsert` correlate through the
   membership (the plural fold raises "requires a unique target", and an inverse
   to-one modify is correlated by construction because a to-one payload spells no
   `where`).
3. **the owner-orientation projection feeding the transfer.**
   `bindOwnerOrientedCollectionMember` resolves the OWNER's collection relation
   and delegates to `bindPolymorphicCollectionMember`, so
   `polymorphicMemberMembership(member, "owner")` keeps exactly one call site.
   The traversal's own bind is provably WRONG input there — `membershipOwners`
   selects `membership.source`'s columns filtered by `membership.target`, so a
   variant-oriented junction asks "which variant rows sit on this owner" — and the
   transfer's `cardinality !== "one"` gate does not catch it, because the inverse
   singular bind IS `"one"`.

Nothing else is its: statement materialization, chunking, target probes, race
pins and the transfer protocol stay where they are. Its internal invariants are
`QueryEngineError`s and `NestedWriteError`s, so the `UnsupportedOperationError`
census stays at **9**.

**ONE ELISION, stated because it is a behaviour and not an optimisation — the
composed vacate.** When a composition carries a vacate, the supplier does NOT go
through the slot-replacement protocol: `disconnect: true` deletes the member row
for this variant and `delete: true` deletes it and the owner row behind it, so the
slot is empty by construction before the supplier runs. Measured: keeping the
transfer there made the transaction leg report `the captured owner's membership
was already removed` and retry into the same state, because the capture is a
PLANNING read that ran before the composed delete; on the batch leg the transfer's
premises are evaluated before the composed delete for the same reason. The
compare-and-swap is then the composed DELETE plus the member table's target-side
UNIQUE in one atomic unit — which §9.4 already names as the batch leg's
enforcement. This is the junction twin of the parent-held direction's own elision,
where a vacate's FK-null is dropped when a sibling supplier rebinds the same
columns.

**ONE FORK, TWO MOUNTS, ONE WRITER — `isSingularCollectionInverse`.**
`RecordUpdateCompiler.interpretRelation` and `CreateOperation.interpretRelation`
both ask it on `position === "junction"` BEFORE `buildJunctionParts`.
`OwnWriteRelation` already asked the same question in the same words
(`cardinality === "one"` on a bound junction) when resolving the composed
continuation and the upsert decision; a compiler that only learned the shape
INSIDE the plural fold would be the ledger's N5 skew re-opened — one invariant,
two readers, agreeing by construction. The analyzer learns nothing new: the
lowering produces exactly the continuation `resolveComposedContinuation` already
reports.

**ADDED (definition validation) — P021, the singular-inverse optionality rule
(`schema/validation/rules/polymorphic.ts`).** §6.3 declares a `toMany` group's
inverse optional and clearable; nothing enforced it. A singular collection
inverse's removal verbs hang on `slotMayBeEmpty(state)` — i.e. on `.optional()` —
and on nothing else: `validation/relations/update.ts` reaches
`membershipCanBeCleared` only on the fields-less `oneToOne` branch, so the
`manyToMany` arm that would otherwise grant a junction-backed clear is DEAD for
this shape. `getFkRequirementKeySets` does not fill the gap either (it groups only
fields-BEARING to-ones and `toOne` polymorphic groups), so a non-optional
declaration was a slot you could fill and never empty, with no error anywhere.
Unique coverage, nameable: *a singular collection inverse was declared
non-optional and silently degraded*. Refusing at definition validation is what
keeps `slotMayBeEmpty` a pure one-owner state read; the rejected alternative was a
junction-aware override inside the clearability owner, which would have put a
second, shape-aware writer on that rule.

**KEPT, and PROMOTED to sole closer (engine) — the bulk-row collection narrowing
in `bulk-polymorphic-connect.ts`.** `PartitionedModelData` widened to carry both
storage arms, and this shortcut is the one consumer that cannot follow: it stores
PRIVATE OWNER COLUMNS, which a collection has no analogue of. It used to be
belt-and-braces behind a grammar refusal; since Package E the grammar ACCEPTS a
collection key in a bulk row, and `routing.ts` sends such a call to the record
series before this file is reached — so on the client path it is unreachable, and
it stays because a directly-built scope can reach `buildBulkPolymorphicConnects`
without passing routing. Plan §9.6 states the prohibition normatively ("Do not
extend the current direct-`toOne` connect-only grouped shortcut to junction
work").

**DELETED (grammar) — `collectionWriteRefusal`, then `collectionBulkRowRefusal`.**
The first died with Package D ("a collection is not writable" stopped being true).
Package E deletes the second: the ROOT-`createMany` ROW now mounts the SAME
collection `create` family, because `routing.ts`'s `relationBearingRow` is
cardinality-dispatched over the polymorphic set through the new
`isPolymorphicCollectionRelation` predicate, so a collection row is
relation-BEARING and the whole call routes to the record series. The silent-drop
hazard the sentence closed is now closed by the ROUTE. The direct polymorphic
TO-ONE row keeps its narrower connect-only union and its grouped INSERT, and
`parity-j-create-many.test.ts` pins both halves of that asymmetry in one file
(`isRecordSeries` false for the to-one payload, true for the collection payload,
false again for a scalar-only row on the same model) with its byte contract
unmoved.

**MEASURED, THEN CLOSED — the progressive preflight timing gap (§9.6, §10 (a)).**
`OperationExecutor.prepareProgressiveMember` returned early for any member whose
planning phase is non-empty, AHEAD of the three eligibility asserts, so such a
member got `assertProgressiveRootConflictEligibility` at member time rather than
"before member zero". MEASURED per verb and pinned in
`junction-progressive-preflight.test.ts`: a collection `connect` /
`connectOrCreate` contributes ONE planning step (its target probe); `create` /
`createMany` contribute none. So the gap IS reachable through a collection key —
but identically reachable WITHOUT one, since an ordinary junction `connect` alone
makes the member plan. The collection key adds a spelling to a pre-existing shape;
it does not create the shape. The measurement is kept as the before-picture; the
gap itself is now closed.

*How it is closed, and why this is a second READER and not a second GUARD.* One
invariant — "skipping a root must strand no prior effect" — keeps ONE sentence and
ONE construction: `strandedRootConflictPrefix` in `OperationExecutor.ts`. Two
readers now feed it, because the invariant is asked at two times about two
different things:

| reader | input | when | unique coverage |
|---|---|---|---|
| `assertProgressiveRootConflictEligibility` | the COMPILED fragment's step order | preflight for empty-planning members; member time for the rest | every arm actually chosen, including the probe-dependent ones no parsed shape can promise |
| `assertDeclaredRootConflictEligibility` | `CreateOperation.declaredPreRootWriteId`, read off the PARSED shape | preflight, for members the compiled reader structurally cannot reach | **TIMING** — the refusal arrives before member zero for a member whose fragment cannot exist yet |

The second reader is the one the plan's §9.6 sentence makes normative, and it can
refuse nothing the first would have passed: a parent-held `create` arm ALWAYS
writes before the root, and a record carrying one never folds (the fold requires
no parent-held arms and is refused outright under `skipDuplicates`). A parent-held
`connectOrCreate` is deliberately NOT declared — it writes before the root only on
the arm its probe picks, so declaring it would refuse the found-arm program that
runs correctly today; that shape stays with the compiled reader. Falsified by
restoring the bare early return: the refusal still arrives, but member zero's root
is durably committed first (`junction-progressive-preflight.test.ts` reddens on
database state, not on a message).

*The decided asymmetry beside it (§10 (b)), now pinned rather than remembered.*
The skip rule covers EFFECTS, not PREMISES. A collection `connect` reads its target
during the member's planning phase, which runs before the root INSERT is attempted
at all, so a row whose root would have been skipped still raises when its target is
missing. Accepted rather than fixed: the alternative reorders a premise read behind
a conditional write, which would make the probe answer a question about a row the
series has already decided not to write. The pin sits beside the row where the same
duplicate root with a PRESENT target skips silently — the difference is the
premise, never the duplicate.

A METHOD NOTE that cost a wrong answer once and is worth carrying: a QueryEngine
built over models whose polymorphic storage has not yet been resolved
(`validateClientSchemaOrThrow`) silently reads the collection arm as ABSENT — the
first measurement of the numbers above answered zero for every collection verb for
exactly that reason. Any direct-engine test over a polymorphic collection must
resolve storage first, as `parity-j-create-many.test.ts` already does.

**NOT ADDED, deliberately.** The singular-slot transfer's malformed multi-owner
state and its plural-junction misuse are `QueryEngineError`s — internal
invariants, not routes, and therefore not census sites. And the transfer adds no
BATCH postcondition mechanism: on a native batch its enforcement is the in-batch
exists/notExists premises plus the membership PK and the target-side UNIQUE, which
is why §1.7's conflict targeting had to land before it. Three falsifications were
run and each reddened only the rows that name it: removing the guarded vacate
fails the transfer on both substrates with a unique violation; treating a
target-side collision as a duplicate SWALLOWS the transfer on the transaction leg
and trips the captured-membership premise on the batch leg; moving the clear after
the refill loses the `set` reinsert and leaves the unmentioned variants filled.

**FOUR MORE FALSIFICATIONS, for the singular-inverse lattice.** Each was applied
to the shipped source, measured, and reverted with a `shasum` check.

| # | mutation | what reddened |
|---|---|---|
| H2 | the Part reads `program.entries` instead of `classifyToOneComposition`'s order | 3 pins × 2 projects: the plan-level order pin and the producing-supplier composition row on both substrates — the modify's membership capture runs before the supplier writes it and silently updates nothing |
| H5 | the owner delete sweeps the connected set (`buildDeleteMany` + `capturedTargetSetWhere`) instead of the single captured row key | 1 pin × 2 projects: `DELETE FROM "board" WHERE "board"."id" IN ($1)` where the pin demands `… = $1`. NO state assertion can separate these on a well-formed member table, which is why the pin is a plan pin |
| H1 | the transfer receives `context.relation` (the variant-oriented traversal bind) instead of `context.ownerJunction` | 18 rows × 2 projects, and the SOLE detector on the scalar-keyed fixture is the transfer's own `LIMIT 2` throw: *Member table 'siw\_crate\_slips' holds more than one owner for a singular polymorphic member of relation 'crate'* |
| H3 | both compiler forks removed, so the singular inverse falls back into `buildJunctionParts` | 18 rows × 2 projects, reporting exactly the four wrong answers the Part exists to replace: `requires a target selector`, `many-to-many update … requires a unique target`, `many-to-many upsert … requires a unique target`, the delete-scoping pin, and a bare-adoption `UniqueConstraintError` |

The H1 row needed a fixture the compound one could not provide. On
`shelf`/`book` the swapped orientation dies EARLIER, at the side-value seam
("Compound junction side requires one value for every referenced field"), because
`(tenantId, code)` and `(region, isbn)` cannot be mistaken for one another — a
control that would stay red for a plan with the orientation right and the arity
wrong. `scalarInverseSchema` (`crate`/`slip`, one `int` key each, with a slip id
that COLLIDES with a crate id) makes the two sides structurally
interchangeable, so the answer is the only thing left to separate them.

---

## Appendix — the two carrier guards, and why both are gone (2026-08-22)

This appendix used to record two guards minted by the 2026-08-19 polymorphic API
respell. The unified relation language deleted the concepts each of them
guarded, so both entries close here rather than in the addendum below.

**The forged-carrier ejection — DELETED, unconstructible.** Its unique coverage
was "a carrier reaching validation with no cardinality at all gets one owned
issue instead of a `TypeError` or silence". That shape needed a separate
polymorphic field category extracted by a `state.type` predicate: a value forged
past a terminal's constructor could enter the model's polymorphic map and reach a
rule that read its raw cardinality. There is no separate category any more. A
variant target is one arm of the ONE relation-state union, every arm carries a
literal `cardinality`, the model boundary recognizes a relation only by the
internal brand, and the two factories are the only producers of that brand. The
guarded input cannot be built rather than merely being unreached.

**The single-getter carrier refusal — DELETED, the shape it refused is now
legal.** Its unique coverage was "a bare `() => model` handed to a polymorphic
factory would silently build private `(type, id)` storage where the caller
expected a foreign key". That risk existed only while polymorphic factories were
separate: a getter passed to one of them had no other meaning. Under two
factories, `s.toOne(() => model)` IS the ordinary declaration — the same call the
refusal used to redirect callers toward — so the refusal has no shape left to
refuse. What survives in its place is not a guard but the map overload's own
constraint pair: `VariantMapGuard` owns "structurally a map, but not a legal
variant map" and `GetterOnly` owns "not a map at all and not a getter". Each has
its own nameable coverage; neither restates the other, because the map overload
is tried first and a `never` answer would otherwise be assignable to a model
shape and make the refusal vanish.

## Addendum — unified relation language, Package E (§8.4, ruling D27)

**`assertRelationCanDisconnect` — DELETED, unreachable.** Its unique coverage was
"the operation schema published a `disconnect` the storage cannot clear", and
every route that could reach it is closed:

1. **The shared-primary-key parent-held to-one** (ledger item 1 above) reached it
   because the schema exposed `disconnect` from a DECLARED `.optional()` while
   the foreign-key column — the row's own identity — was not nullable. A model
   target declares no `.optional()` any more: `slotMayBeEmpty` reads the stored
   tuple, `accountId` is non-nullable, and `ToOneUpdateSchema` publishes neither
   removal verb. The two facts cannot disagree because there is one fact.
2. **`set` dropping members on a non-clearable membership** (item 2) never
   reached this guard: it is `RelationSetPart`'s own refusal, and it SURVIVES —
   `requiredForeignKeyFields` is retained as the complement of the clearable
   subset, so `setRequiredOrphan` keeps naming exactly the members that block a
   departure. What narrowed is WHEN it fires: a mixed compound key is clearable
   now, so the refusal is reserved for a membership with no nullable member at
   all (§11.4.9).
3. **Trusted internal programs** (item 3) go through the same operation schema —
   `engine.build(model, "update", …)` parses before it compiles — so a
   `disconnect` on a required relation is refused there, by name, before any
   bind exists. Re-pinned at `sql-generation.core.test.ts` ("a required relation
   publishes no disconnect at all").

Keeping it would also have been WRONG, not merely redundant: §9.4 makes a mixed
compound foreign key disconnectable by clearing its nullable members, and this
guard refused exactly that shape.

**`relation-nullability.ts` inverts its former doctrine, deliberately.** Its
header used to state that the ENGINE does not read `clearability.ts` and answers
the same physical question from bound membership. It reads it now, and that is
the point of §8.4: the columns a disconnect clears and the columns the operation
schema published `disconnect` from must be ONE list, or a mixed tuple gets a verb
whose write nulls a required column. `clearableMembership(resolved)` is that one
owner; `requiredForeignKeyFields` is its complement, computed from it rather than
scanned again.

**`classifyRelation`'s carrier-brand refusal — DELETED with the brand (D9).** It
existed because a synthetic member carrier could be handed back to a resolver
that would bind the wrong orientation or a pair table nothing emits. There is no
synthetic relation: a member view IS the carrier's resolved slot narrowed to one
member, and re-classifying it reaches that member's own junction. The failure
mode it guarded is now unconstructible rather than refused.

## Addendum — unified relation language, Package F (ruling D27)

Two more guards lost their last reachable input at the estate gate, both to the
same construction-time refusal.

**`pairMembers`' mismatched-foreign-key-metadata refusal
(`query-engine/builders/relation-data-builder.ts`) — DELETED.** Its unique
coverage was "the engine holds a foreign-field list longer than its
referenced-field list", and the only schema that produced one was an unequal
chain — `.fields("a","b").references("id")`. `.references(...)` pairs
positionally and refuses that chain at CONSTRUCTION now (V4002,
`'references' declares 1 field(s) against 2 local field(s)`, witnessed at
`tests/unit/schema-validation/foreign-key-rules.core.test.ts`), so no such
declaration reaches a model, let alone a bind. The two flat lists are also gone
as INPUTS: `buildForeignKeyMembership` takes the resolver's own
`ResolvedStoredReference.members` pair list and projects `foreignFields` /
`referencedFields` from it, so the shape the guard tested for is
unconstructible rather than merely unreached. The lazy/memoised `members` getter
went with it — it existed to defer this refusal past the relation-key legality
error, and there is no refusal left to order.

**`buildOneUpsertPart`'s child-held-FK length re-assertion
(`query-engine/write-engine/RelationUpsertPart.ts`) — DELETED.** It compared
`membership.foreignFields.length` with `membershipReferencedFields(membership).length`
on a membership whose two lists are now projected from ONE pair list (foreign
key) or from one column and one referenced field (polymorphic). Both are equal
by construction, which is the third statement of the same invariant the factory
already owns.

The witness that used to order these two — `operation-construction-witnesses.test.ts`,
"RelationUpsertPart :814 — a mismatched-arity child FK is refused UPSTREAM" —
is deleted with its schema, and the file carries a ledger comment naming the
construction refusal that replaced it.

## Addendum — the identifier domain (Stage D, native identifiers)

Four refusals were added and one was narrowed. Each one's unique coverage is
stated below, because a guard whose coverage cannot be named is one this
codebase does not keep.

**`FK012` — two answers to "what does this column hold"
(`schema/validation/id-domains.ts`, in the GATE).** Unique coverage: a column
whose identifier domain is reached through more than one path and disagrees — a
foreign key whose own declaration contradicts its target, one column shared by
two references whose keys are different formats or prefixes, a compound member
whose target disagrees. Nothing downstream can repair it: the migration would
create one column while the engine bound values of another domain into it. It
lives in the gate rather than in the advisory rule list because
`skipValidation` may drop advice and must not be able to drop this. It is NOT a
second `FK003`: that one compares scalar TYPE, array shape, decimal domain and
SQLite datetime form; two `string` columns that pass it can still hold different
identifier domains.

A reference CYCLE is one path set, not one path per arm: the derivation settles
each strongly connected component of the reference graph as a unit, so every
declaration on a cycle and every key the cycle reaches outside itself must agree,
and the verdict is the same whatever order the schema lists its models in (the
earlier walk answered a field still being resolved with its own declaration,
which accepted `{ a, b }` and refused `{ b, a }`). No guard was added or removed:
this is the same clause, asked of the right unit. Pins:
`tests/unit/schema-validation/id-domain-derivation.core.test.ts`, "a reference
cycle derives one domain, whatever order registers it".

**`FK012` widened — two answers to how a foreign key column stores its key's
values (same file, same gate; added by the Raptor 3 port review).** Unique
coverage: a foreign key and the key it references that hold ONE domain but that
`idStorageOf`, asked of each column's OWN native type, stores in different
representations on a dialect one of the two overrides names — a key kept text by
`varchar(40)` beside a foreign key with no override, which is `uuid`/`bytea`/
`BINARY(n)`. Without it PostgreSQL (42804) and MySQL (3780) refuse the push and
SQLite creates a BLOB foreign key beside a TEXT key, where the engine then binds
the payload the key never holds. It compares REPRESENTATION only, the one fact
the engine binds by; `varchar(40)` beside `text` holds the same strings and is
accepted. It is not `F013` (an override the domain cannot live in: that one
answers `undefined` here and is skipped) and not `FK003` (declared scalar type,
never a derived domain). Pins: `tests/unit/schema-validation/id-domain-derivation.core.test.ts`,
"a foreign key stores its key's values the way the key does".

**`F013` — a native type the domain cannot live in (same file, same gate).**
Unique coverage: a declared or derived identifier field whose native type
override is, for its own dialect, neither a text-family column nor a binary one
of that format's exact width (nor `uuid` for the two uuid formats). It is
dialect-blind — the override names its own dialect — and it is not the
native-catalog spelling check (`J011`), which asks whether the type exists at
all rather than whether this domain fits in it.

PostgreSQL's `char(n)` is NOT in that text family, though it is an ordinary
string override: `character(n)` blank-pads to its full width, so a 36-character
uuid in a `char(40)` column reads back with four trailing spaces and no value of
the domain is ever returned — measured live, where both the write and every
later read answered "not in this column's declared identifier domain". MySQL's
`CHAR(n)` strips the padding on the way out and keeps its place in that
dialect's list. This narrows F013's accepted set; it adds no second check.

**`P002` widened — variants must agree on their identifier domain
(`schema/validation/id-domains.ts`).** Unique coverage: two variant targets
whose keys are both `string` but HOLD different formats or prefixes. The row
carrier stores every variant's key in ONE column, so a `uuid` beside a `ulid`
would be written through a codec that is not its own. It is the same statement
the storage rule already makes for scalar type and for the decimal descriptor,
in a third representation fact — not a new guard, one more clause of an existing
one, and it keeps that clause's code.

It is computed in the DERIVATION rather than beside the rule's other clauses
because the answer may be derived: a variant whose primary key is its parent
foreign key declares nothing and still holds uuids, and the storage rule runs
while the index it would have to ask is still being built. Compared as
declarations it both over-refused (two variants that hold one domain, one
declaring and one deriving it) and under-refused (two variants that derive
domains which differ — the shape that types the carrier column from one variant
and writes another's key through it).

**`J004` on `generate.implicit` (`schema/json/read.ts`).** Unique coverage: a
document that marks a generator implicit where `.id()` could not have installed
it — on another KIND, or without the `id` flag. `implicit` says "this ULID is
the one `.id()` installs", which is one kind beside one flag. On another kind it
would claim a generator that does not exist and silently drop that format's
domain, its admission and its compact column. Without `id` the interpreter
installs nothing at all — its `.id()` arm needs the flag and its `applyGenerate`
arm stands down for an implicit node — so the declared generator vanishes and
the field round-trips as a bare `{"type":"string"}`. Not reachable from
`serializeSchema`, which writes `implicit` only for an `.id()` field; reachable
from any hand-authored or externally produced document.

**The identifier domain's second crossing, after a custom schema
(`validation/primitives/helpers.ts` `buildValidator`, added by the PR #43
review).** Not a new predicate: the same `canonicalizeId` admission, with the
same `Expected <domain>` message, chained a second time only when the field
carries a `.schema()`. Unique coverage: the custom schema's OUTPUT. The first
crossing admits the caller's input and hands the custom schema the canonical
spelling; the schema is caller code and a Standard Schema may return any
string, and nothing after it asked the domain again — `"garbage"` was admitted
and died at the binding as `EngineInvariantError` (the encode invariant below),
and a returned alias was admitted unfolded, one identifier under two cache
keys. The first crossing is not made redundant by the second: it is what gives
the custom schema canonical input, and it refuses an input outside the domain
before caller code runs on it. No transform position is added: `idDomain` is
passed only by `validation/scalars/string.ts`, whose field state carries no
transform. Pins: `tests/unit/scalars/string-scalar-schemas.core.test.ts`, "a
custom schema's output crosses the domain again".

**The engine's text-predicate refusal
(`query-engine/builders/scalar-filter-operators.ts`).** *RETIRED by the Raptor 3
port (2026-09-23): admission (`validation/scalars/string.ts`,
`buildCompactIdFilterSchema`) is the one owner, raptor3 keeps no second
operator switch (`raptor3/AGENTS.md`), and the pins now state the refusal as
admission's `ValidationError` (`identifier-storage-sql.core.test.ts`). What
follows is the retired engine's reasoning.* Not a new guard: the
existing `assertSupportedScalarFilterOperator` gains a narrower operator set for
a compactly stored identifier, and a message that says why rather than
"unsupported". The validation schema already removed the four operators from the
type and from what it admits; this is the same fact restated at the boundary a
trusted internal program can reach without one, exactly as every other entry in
that function is.

**The encode-side refusals (`query-engine/builders/id-field.ts`
`encodeIdValue`).** *Became ONE INVARIANT in the Raptor 3 port (2026-09-23):
`raptor3/shared/identifier.ts` `encodeIdentifier`, an `assertInvariant`, not a
refusal (N4). Every path the two sentences below named is, in raptor3, a value
admission canonicalized, a custom schema's output included (a `{ set }` crosses the validated base schema; filter
operands, cursors, unique selectors and connect keys are validated) or a
captured row key the decoder returned as the canonical public string; a
relation-correlated key is a raw column sub-select that never reaches the
encoder, and `referenceSql`'s deferred `Ref` has no raptor3 counterpart. The
provider cell "a value outside the declared domain is refused, not stored" is
answered by admission. What follows is the retired engine's reasoning.* Two, and
each names a case the other cannot. `Identifier
field '…' received <typeof>`: a NON-STRING reached a binding for a column whose
values are strings — a value that never crossed the field's schema, which is the
only thing that could have typed it (a `set` inside an atomic update object, a
connect-derived foreign key, a relation-correlated key lowered by
`referenceSql`). `… received a value outside its declared <format> domain`: a
string that IS a string and is not one of this column's, on those same paths. It
is the closing move `decimalLiteral` already makes for the same reason and at
the same seam — a value with no bytes has no binding, and writing one would
store a row no read could return.

**The decode-side refusal (`query-engine/result/ResultParser.ts`
`createFieldChain`; since the Raptor 3 port, `raptor3/shared/query.ts`
`decodeScalar`'s identifier arm, `InvalidScalarResult("string", "the value is
not in this column's declared identifier domain")`).** Unique coverage: a PHYSICAL value the column's codec
cannot name — bytes of the wrong width, text outside the domain, a shape no
driver spelling normalizes. It is not the generic malformed-string arm beside
it, which asks only whether the driver returned a string at all; this one asks
whether what came back is a value of THIS column, and it is the one refusal that
catches an estate whose rows were written under a different reading (a migration
that re-encoded text into a binary column is exactly that).

**The binary-conversion refusal (`migrations/binary-conversion.ts`, reached
from the one `alterColumn` dispatch in `migrations/drivers/base.ts`).** Unique
coverage: an altered column whose TARGET type is this dialect's raw-bytes column
and whose source type is not. Every generated `ALTER COLUMN` is a blind
re-reading of the stored bytes, which is exact when the two types share a
reading and data loss the moment the target is binary: PostgreSQL's
`USING col::bytea` writes the ASCII of the old text, SQLite's rebuild copies the
value verbatim into the `BLOB`, MySQL truncates or pads to the declared width in
a non-strict `sql_mode`. All three were measured, and all three produced an
estate no read could return.

It is stated in COLUMN TYPES rather than in identifier domains on purpose: the
snapshot carries no logical marker saying "this BLOB decodes identifiers", and
it needs none — a verbatim copy into a binary column is unreadable whatever the
column holds. It is one refusal at the dispatch rather than three in the three
conversion routes, which is how those routes came to be wrong three different
ways. Both sides binary is a WIDTH change and passes: re-reading the same bytes
as the same bytes is the property the refusal requires. PostgreSQL's `uuid`
target passes too — `col::uuid` is a real per-value conversion that succeeds for
an estate of canonical uuids and aborts the transaction for one that is not,
leaving the column as it was.

**Deleted, not added.** `createFingerprint`'s
`globals.length > 0 ? globals + entropy : entropy`
(`schema/scalars/string/autogenerate.ts`) is gone. Its two arms are the same
string — concatenating an empty `globals` IS `entropy` — so the condition named
no case and its unique coverage could not be stated. It was carried over from
upstream CUID2 and was the one uncovered branch in the whole schema subsystem at
the stage baseline (`32af0e16`: branches 99.95%). The digest is unchanged, which
the differential test against the pinned upstream package proves.

So is the PostgreSQL migration driver's `scalarState.autoGenerate !== undefined`
conjunct in `getDefaultExpression`. `idDomainOfState` answers a domain only when
`state.autoGenerate` is defined, so the conjunct can never be the arm that
fails; `idDomain !== undefined` beside it already carries it, and the branch it
added was unreachable.

## Addendum — the existing database (Stage F, identifier conversion)

Three refusals were added. One of them changes no outcome at all, and says so
here so that a later reader neither deletes it as redundant nor promotes it to a
second gate.

**The PostgreSQL `text` → `uuid` guard (`migrations/identifier-conversion.ts`
`postgresTextToUuidGuard`, emitted into the generated alteration).** Unique
coverage: **the message, and nothing else.** `ALTER COLUMN … TYPE uuid USING
col::uuid` already fails on the first row that is not canonical uuid text — the
transaction aborts and the column is left as it was — so the outcome with this
`DO` block and without it is the same outcome. What the cast alone cannot say is
how many rows are in the way and what the author's two routes are, and a
PREFIXED domain is the case that needs saying most: `usr-a0ee…` is not uuid
text, no `USING substring(col from 5)::uuid` is ever generated for it (the
snapshot carries the column TYPE, never the domain), and PostgreSQL's own error
names one offending value and no route at all. It is deliberately NOT a second
refusal beside `binary-conversion.ts`: that one stops a conversion that would
otherwise SUCCEED and destroy the data, and this one stops nothing.

**`identifierConversionChecks` on a field with no compactly stored domain
(same file).** Unique coverage: a caller who named a field that has no text
conversion to check — a `nanoid`, a `cuid`, or a plain string — for whom the
honest return value is an empty list and the honest reading of an empty list is
"this estate is ready". Every other refusal in this program protects a value;
this one protects an ANSWER, and it is the only place that can: the list is
handed to `generate()` as `originChecks`, where zero checks pass vacuously and
the conversion proceeds. It is not `F013` (a native type the domain cannot live
in) and not `FK012` (two answers to what a column holds): both of those are
schema facts decided at resolution, and this one is a fact about the call.

Its first check — every row is a value of the domain — asks a KSUID payload one
more question than its grammar: `<= KSUID_MAX_TEXT`. It is not a new guard but
the same check made true to its promise. Unique coverage: a 27-character base62
text above 2^160 (`"z".repeat(27)`, or `aWgEPTl1tmebfsQzFP4bxwgy80W`), which the
regex and the GLOB admit and `ksuidToBytes` refuses; without the bound the check
certified an estate the conversion cannot carry. The bound is read from
`validation/primitives/id-formats.ts`, which owns it beside
`KSUID_EXCLUSIVE_MAX`, never spelled here. The comparison is byte order on every
dialect because base62's alphabet (`0-9A-Za-z`) is in ASCII order and a
case-folding collation is not: `CAST(… AS BINARY)` on MySQL, `CAST(… AS text)
COLLATE "C"` on PostgreSQL (the cast because `citext` lowercases before any
collation applies), SQLite's default `BINARY`. The pin's own coverage is
`…80a`, above the maximum yet below it under `en_US.utf8` and
`utf8mb4_0900_ai_ci`. A ULID needs no such bound: its leading `[0-7]` is one.

**`assertComparableIdStorage` (`query-engine/builders/where-builder.ts`,
reached from `fieldRefColumn`; since the Raptor 3 port,
`raptor3/shared/query.ts` `Queries.prepareOperand`, beside the decimal-domain
refusal it twins, with its sentence built by `raptor3/shared/identifier.ts`
`incomparableIdentifiers` — the same words).** Unique coverage: a FIELD REFERENCE operand
whose column does not spell one public value the way the filtered column does —
one side compact or `uuid`-typed and the other plain text, or two compact
columns of different domains, where equal payload bytes stand for different
public values. `checkRef` in `validation/primitives/operand.ts` compares
`ScalarType` and arity over interned, model-blind filter schemas, and
`'string' === 'string'` for an identifier field and an ordinary one; the where
builder is the first boundary that holds the model and can ask what each column
physically holds. It is the identifier twin of
`assertComparableDecimalDomains`, which sits on the same line for the same
reason, and it is NOT the `encodeIdValue` pair: those cover a VALUE arriving at
a binding, and a reference binds no value at all — it lowers a second column.

Measured before it existed, on in-process SQLite: `where: { id: { equals:
refs.plain } }` over a row whose `id` and `plain` hold the same public string
returned `[]`, because `id` holds sixteen bytes and `plain` holds the text. A
silent wrong answer, in both directions, on a seam the codebase already names.

TEXT against TEXT is left alone in both directions, deliberately: a `nanoid`
column stores exactly the string it shows, so comparing it with an ordinary
string column asks the question it appears to ask. A refusal there would have no
case to name.

## The exact decimal value type (2026-09-17, workstream 1 of the footprint program)

`src/validation/primitives/decimal-value.ts` is a NEW public value type, so it
brings two refusals of its own. Both are recorded here because they are the only
ones it has: everything else the old boundary refused is refused by construction
now, and this entry names what that means as much as what was added.

**`TypeError` in the constructor (`DECIMAL_CONSTRUCTOR_REFUSAL`).** Unique
coverage: a caller who hands `new Decimal(…)` something that names no exact
decimal — every JavaScript number (a double, including `NaN` and `Infinity`),
a string outside the accepted literal grammar (including the exponent form
`"1e3"`, which the grammar has always refused), or a value of any other type.
It is not `DECIMAL_ERROR` in `primitives/decimal.ts`: that one refuses a FIELD
INPUT and returns issues, and its caller is `v.decimal()`. This one refuses a
VALUE at the constructor, where there is no validation result to return and no
field in sight, and it is the reason the boundary above can stop inspecting
what a decimal looks like. The two families differ by one member — the
constructor also takes a whole `bigint` coefficient, which a field does not —
so there are two sentences, `DECIMAL_INPUT_REFUSAL` (the field's, which
`DECIMAL_ERROR` is built from) and `DECIMAL_CONSTRUCTOR_REFUSAL`, and they
share one spelling clause declared once in `decimal-value.ts`. The STRING
grammar has one owner, `admitDecimal` (the admission rule for every
value: a string through the grammar, anything else through the brand): the
constructor and the field both refuse exactly where it answers `undefined`,
and `decimal-value.core.test.ts` pins that they agree on every input. The
codec's `canonicalizeDecimalValue` and the string-only
`canonicalizeDecimalInput` were two more readers of the same two answers and
are gone; the custom-schema return position reads `canonicalDecimalText`
directly, and the codec's `canonicalizeDecimal` is `admitDecimal` itself under
the name the engine binders import.

**A JavaScript number at a decimal position (2026-09-23, decision D1).** No
guard of its own: the number arm of the admission rule and the
`String(n)` exponent expansion behind it are deleted, so a number reaches the
same `undefined` every other non-decimal value reaches and the field returns
`DECIMAL_INPUT_REFUSAL`, the constructor `DECIMAL_CONSTRUCTOR_REFUSAL`. The
invariant that retires the arm: a field admits only values that already name
an exact decimal, and a double does not. Witnesses:
`decimal.core.test.ts` (scalar, list member at `[1]`, empty list still
admitted), `number-scalar-schemas.core.test.ts` (base, create, list create),
`decimal-update-union.core.test.ts` (every arithmetic arm and the shorthand),
`decimal-cache-identity.core.test.ts` (a filter operand never reaches a cache
key) and `client-construction-boundaries.core.test.ts` (`create` refuses at
`data.total` before any statement).

**`RangeError("Division by zero")` in `div`.** Unique coverage: a quotient with
no value at all. Nothing else in the type can fail — `plus`, `minus`, `times`,
the comparisons, `abs`, `neg` and every rendering are total over the domain —
and the zero divisor cannot be caught earlier, because `"0"`, `"-0.000"`, `0n`
and a `Decimal` zero are four spellings that only the constructor resolves.

**No guard for `div`'s fraction-digit count, deliberately.** A count that is not
a non-negative integer is refused by `BigInt(fractionDigits)` (which throws for
a fractional number) and by `10n ** -1n` (which throws for a negative one), each
with its own sentence. A guard there would have no unique coverage to name.

**What construction replaced, rather than moved.** The old codec refused a
foreign value nine ways — a sign that was neither direction, a non-integer
exponent, an exponent or digit count outside a render ceiling, a missing or
non-array coefficient, a hostile `length`, a sparse index, a member that was not
a single digit, an accessor that threw. None of them has a successor. A private
field is installed by the constructor and by nothing else, so `#c in value` is
the whole admission and `Object.create(Decimal.prototype)` — which passes
`instanceof` — is refused by it. The render ceiling has no successor either, for
a narrower reason than "a rendering is as long as the digits allocated": it
bounded a FOREIGN value's exponent, and CONSTRUCTION bounds that now — the
accepted grammar admits no exponent and no number, so a value this module
built carries exactly the digits it was handed. The length of
`div(other, fractionDigits)` and `toFixed(dp)` output comes from the caller's
own small integer argument instead, and is deliberately unguarded:
`new Decimal("1").div("3", 20000)` renders 20,002 characters for the same reason
`"0".repeat(20000)` does, it is unreachable from VibORM (no call site in `src/`
divides or fixes a Decimal), and a ceiling there would be a guard on a caller's
own arithmetic with no VibORM coverage to name.

## Decimal descriptor and default (2026-09-23)

`src/schema/scalars/decimal/descriptor.ts` read `{ precision, scale }` as a
hostile object and its default as a hostile list. A `ScalarState` is built only
by VibORM's factories from the developer's own arguments, and the one untrusted
source that reaches the factory — a schema document — hands over two plain
numbers, so the reflection posture had no untrusted input to face. Two guards
survive, each with one owner and one message.

**The descriptor bound check (`readDecimalDescriptor`).** `precision` is an
integer from 1 to `Number.MAX_SAFE_INTEGER`; `scale` is an integer from 0 to
`precision` and is not `-0`. One sentence per key —
`'precision' must be an integer between 1 and the maximum safe integer`,
`'scale' must be an integer between 0 and precision` — as a `ValidationError`
from `s.decimal` at `descriptor.<key>`. Unique coverage: the schema document,
whose reader (`src/schema/json/read.ts`, `readRequiredDomainBound`) checks
presence and number type only and delegates integrality, range and
`scale <= precision` here — `10.5`, `1e300` and `-0` (which `JSON.parse` keeps
and `JSON.stringify` loses) reach this check and nothing earlier — and an
untyped JavaScript caller. The public type already refuses everything else.
Witnesses: `decimal-descriptor.core.test.ts` (the refusal table, with path and
sentence) and `hostile.core.test.ts` (`10.5`, `-0` and `scale > precision`
from JSON text, as `J010` at the field). Provider limits stay a separate
bind-time owner (`provider-limits.ts`).

**The default canonicalization (`normalizeDecimalDefault`).** A literal
`.default()` — re-run by `.array()` and `.schema()` — crosses the field's
complete base schema once, at the call that writes it, and `state.default`
keeps the canonical output. One sentence: `The decimal default did not satisfy
its field schema`, at `default`. Unique coverage: `state.default` is canonical
text, which three readers trust without re-validating — the DDL default
renderers in `src/migrations/drivers/base.ts` (`decimalDefaultText`,
`decimalListDefaultText`), the schema-document serializer, and the create
schema's `v.optional(state.base, state.default)`, which emits a literal
default unchecked. F004 (`rules/model.ts`) does not cover it: it skips
decimals, runs only at push, the CLI and document `validate`, and stores
nothing. Witnesses: `.default("1.005")` refused, `.default("+001.20")` stored as
`"1.2"`, sparse and revoked list defaults refused with the sentence.

**Removed, and the invariant that retires each.** `readOnce` (read-once
snapshot under a `try`), `ownKeys` and `nameUnknownKey` (every own key,
symbols and non-enumerable ones included, refused by name),
`isDescriptorObject` (a revoked-proxy descriptor owned as a refusal), the
five-message `readBound`, `snapshotDecimalDefaultList` (dense-array snapshot
with no shadow properties) and `validateDecimalDefault` (a hostile
Standard-Schema result read property by property). The invariant: the
descriptor and the default are the developer's own arguments, and the schema
the default crosses is VibORM's own base schema. An inherited descriptor or an
extra key is read as an ordinary argument (the public `ExactDomain` type still
refuses an extra key, fresh or held); a list default is copied by the field's
own list schema, which reads each index, owns a revoked proxy or a throwing
member read as an issue, and drops shadow properties; a custom schema is the
developer's code, so what it throws reaches the developer unchanged.

## Addendum — geographic values as ordinary records (decision D2, 2026-09-23)

Decision D2: the public input for a geographic value is exactly the value
VibORM returns, validated as an ordinary record. The record walker
(`createObjectValidator` in `src/validation/primitives/object.ts`) owns key
reading, unknown and missing keys, and issue paths for every object operand;
the geographic codecs keep only the facts no generic schema can state.

**Retired: the bespoke geographic record reader.** `snapshotGeoRecord` and
`readExactGeoRecord` refused a non-plain prototype, a symbol key, an inherited
key, and a key deleted between listing and reading, and caught every throwing
reflection trap. Successor: the walker. It reads enumerable string keys (own or
inherited) in schema order, refuses unknown keys before reading any value, and
reports a key removed mid-read as `Missing required field`. A throwing getter
or trap is contained by `parse` (`src/validation/index.ts`) and by the
operation boundary, which turn it into an issue with the thrown cause; a direct
call to `validateGeoPoint` now propagates it. Three callers sit outside
`parse` and the operation boundary, and none sees a caller-built object:
`parsePointValue` (`src/query-engine/result/scalar-structured-parser.ts`)
reads provider rows, plain values decoded from JSON; `pointCodec` snapshot and
materialize (`src/query-engine/result/cache-value-codecs.ts`) read values
VibORM itself produced; `normalizePointDefault`
(`src/schema/scalars/point/scalar.ts`, through `validateSchema`) reads the
developer's own `s.point().default(…)` declaration, trusted code, so a throwing
getter there now surfaces as that raw error at declaration time instead of a
`ValidationError`. Witnesses:
`tests/unit/validation/point.core.test.ts` ("reads the point as an ordinary
record", "names the offending key", "refuses a coordinate removed while the point
is read").

**Kept normalization: longitude `-180` becomes `180`** (`validateGeoPoint`).
Consumers: the SQLite CHECK in `src/migrations/drivers/sqlite/geo-point.ts`
(`longitude > -180`, so the physical `-180` spelling is refused by the
database) and the meridian arms of `src/adapters/shared/geo-point.ts`, which
assume the `+180` spelling.

**Kept normalization: `-0` becomes `0`** (`geoCoordinate`, the one coordinate
schema). Consumer: the returned-value contract. The same codec decodes provider
rows and cache snapshots, and the type VibORM returns has no `-0`.

**Retired: `finiteBound` and `readGeoVariantRecord`.** Successors: the bounds
record (the one coordinate schema per key, walker-owned keys) and the area
record (fully partial, strict), both in `geo-area-codec.ts`. A bounds
coordinate now reports the coordinate's range sentence (`Latitude must be …`)
at the bound's own path. Witnesses: `tests/unit/validation/geo-area.core.test.ts`
("reads bounds and areas as ordinary records") and
`tests/unit/operation-schemas/args/geopoint-known-negatives.core.test.ts`.

**Kept guard: `south <= north`** (`validateGeoBounds`). Unique coverage: an
inverted rectangle is no database error; the latitude arm of `withinBounds` in
`src/adapters/shared/geo-point.ts` would compile to a predicate that silently
matches nothing. Falsifier: removing it fails "refuses invalid bounds 0" and
"reads bounds and areas as ordinary records".

**Kept guard: exactly one of `bounds` or `polygon`** (`validateGeoArea`). Unique
coverage: `buildGeoPointWithin` (`src/query-engine/builders/geo-point-builder.ts`)
branches on `"bounds" in area`, so a second variant would be dropped silently,
and an area with neither would reach `geoPolygonJson(undefined)` and throw a
`TypeError` rather than a database error. One guard covers both cases, so the
area record carries no `requiresOneOf`. Falsifier: removing the `!polygon` arm
fails "discriminates GeoArea exactly".

**Retired, then restored: the polygon geometry pre-checks.** D2 retired every
geometry check on the premise that a malformed polygon becomes a database
error. **That premise is false on PostgreSQL** (corrected 2026-09-24, lane
`geo-checks`). Measured with VibORM's exact predicates on PGlite 0.5.8 +
PostGIS 3.6.2 and on MySQL 8 (docker, 3307), PostGIS raises only for an edge
between antipodal endpoints ("Antipodal (180 degrees long) edge detected!",
liblwgeom `edge_calculate_gbox`) and answers every other malformed polygon
silently:

| Polygon | PostGIS | MySQL 8 |
| --- | --- | --- |
| bowtie | both lobes and the crossing point | the same |
| retracing or collinear ring | its outline only | the same |
| antipodal endpoints, (0,0) to (180,0) | raises | answers |
| (0,10) to (180,10), over the pole | (0,80) in | (0,80) out |
| (0,10) to (179.999999,-10), 1e-6 short of antipodal (review round 3) | (90,30) in, as the sphere | (90,30) out |
| pole vertex (written at longitude 0) | the polar sector | the equator and the opposite pole |
| ring winding around a pole | the polar cap | the polar cap |
| 340-degree band (half globe or more) | the poles and the antimeridian | the band |
| tropics band, -170 to 170 at ±30 (11.18 sr on the sphere; the old trapezoid sum said under half) (review round 3) | the whole globe | the band |
| ring with vertices both sides of the equator, the 0/180 and the 90/-90 meridian planes, 27% of half the globe (review round 3) | inside out | as the sphere |
| hole outside the outer ring | adds the hole's area | ignores the hole |
| overlapping or nested holes | matches a point in two holes | excludes it |
| hole touching the outer ring or a hole at a shared vertex or along a meridian | inside the outer ring and in no hole | the same |
| hole touching a straight parallel edge (box (0,40)-(10,50), hole vertex (5,40)) | matches (5,40.05) and (5,40.08), in the hole | does not |
| hole B touching hole A's straight lat-44 edge at (5,44) | matches (5,44.01)-(5,44.03), in both holes | does not |
| ring past a whole turn over itself (0..400 degrees along a band) | (20,1) out | (20,1) in |
| repeated consecutive or closing vertex | as without the repeat | the same |
| box (0,40)-(10,50), no hole | (5,40.05) out, (5,50.05) in | the same |

The last row is the edge reading: PostGIS geography draws an edge as the
great-circle arc between its vertices (within 4e-12 degrees, measured by
bisection), which bows toward the nearer pole off the equator and the
meridians; MySQL draws the ellipsoid's path, close enough on this 10-degree box
to give the same answers (review round 3 corrected "both databases draw arcs";
the band is under "Remaining gap"). So the geometry is judged on the unit
sphere (`src/validation/primitives/geo-area-codec.ts`: vertices as unit
vectors, `crosses`/`onArc`/`meet` on arcs, `sweep` placing each ring by the arc
first north of it on a meridian). A first restoration judged straight
longitude/latitude lines in the unwrapped plane (the pre-D2 geometry) and
admitted touching holes; review round 1 measured PostGIS answering touching
holes wrongly (the second and third "touching" rows: in the plane they touch,
on the globe they cross) and a self-overlapping ring past a whole turn that the
plane could not see. Both are refused now, a touch included, as before D2.

**Owner rule (Arnaud, 2026-09-24).** Asked whether to keep refusing
continent-scale polygons PostGIS misreads: "it seems a postgis issue, not a us
issue". VibORM's polygon validation refuses input with NO SINGLE MEANING on
the great-circle reading (the polygon being the side of its outer ring away
from both poles): self-intersecting or retracing rings, zero area, holes not
strictly inside, touching, overlapping or nested holes, a hole equal to its
ring, walker shape errors; and input outside its stated DOMAIN CHOICES (next
paragraph): edges between near-antipodal endpoints, a vertex on a pole, a
ring with no side away from both poles (winding around one, or running over
both), all judged at the resolution `TOLERANCE`.
It does NOT refuse a valid polygon because a database computes it differently;
that difference is stated in `docs/content/docs/schema/scalars/point.mdx`
("How each database reads a polygon") and CHANGELOG "Geo". Of the table
above, the pole vertex, pole winding, bowtie, retracing, antipodal, hole and
self-overlap rows are refused; the 340-degree band, the tropics band and the
three-planes row are valid polygons PostGIS misreads, and the over-the-pole
row a valid polygon the databases part on only along the edge itself (second
pass below): all are admitted.

**Domain choices (second PR review, 2026-09-24).** "No single meaning" alone
overstated the contract: three rules are VibORM's choices, each with its
reason, stated as such in the codec's header, `point.mdx`, the CHANGELOG and
both AGENTS.md (Rule 10, and `src/validation/AGENTS.md`), so a future refusal
needs a reason of this kind, never an "invalid geometry" label:

- Resolution, `TOLERANCE` = 1e-9 degrees (about 0.1 mm). Reason: exact
  predicates on float64 unit vectors need a margin for rounding, and one
  fixed margin serves every ring size. Within it a point is on what it
  touches, so rings closer than it touch (refused) and an edge shorter than
  it is a repeated vertex (dropped). Measured exact above twice it (the ring
  size entry below).
- Near-antipodal edges, `NEAREST_ANTIPODE` = 0.01 degrees. Reason: float
  rounding of the great circle. Antipodal points lie on every great circle
  through them, and near the antipode one float64 step of a written
  coordinate turns the edge's circle by about 3e-12 / d degrees at d degrees
  from antipodal; from 0.01 degrees out that stays under a third of
  `TOLERANCE` (the near-antipodal entry below has the measurements).
- Poles. A vertex within `TOLERANCE` of a pole is on it and has no
  longitude, so no meridian for its edges (refused). A ring winding around a
  pole, or running over both, has no side away from both poles, the side
  VibORM reads as the polygon (refused). An edge whose longitudes differ by
  exactly 180 degrees between vertices that are not antipodal runs over the
  pole on its vertices' side (admitted). Reason: the reading chosen, not a
  database's.

The owner rule holds alongside them: none of the three is a database's
reading, and a valid polygon is not refused because a database computes it
differently.

The refused rows are refused in `validateGeoPolygon`, after the record walker
admitted the shape (so a shape error keeps the walker's message), with the
pre-D2 messages word for word and a path. Each guard, its unique coverage, and
the witness that goes red without it (`geo-area.core.test.ts` "refuses
…"/"admits …", and the matching `geopoint-sql.core.test.ts` cell), each
falsified one at a time on 2026-09-24 (the owner-rule pass re-ran every
falsifier on the final codec; the list is at the end of this addendum):

- Vertex on a pole (`distinctVertices`, `A GeoPolygon ring cannot contain a
  pole`, the pre-D2 sentence, at the vertex; owner-rule second pass,
  2026-09-24). A vertex on a pole has no longitude, so its edges have no
  meridian to leave it by: a domain choice (above). The guard refuses a vertex
  within `TOLERANCE` (1e-9 degrees) of a pole, VibORM's own resolution, at
  which a point is on what it touches; nothing about a database sets it.
  Unique coverage: nothing else looks at a vertex's latitude, and a pole
  vertex passes the wrap and antipode tests. Witness: "a north pole vertex",
  "a south pole vertex", "a hole vertex on a pole", "a vertex within 1e-9
  degrees of a pole" (5e-10 degrees; unit and SQL); admitted "a vertex 1.5e-9
  degrees from a pole". Falsifiers: guard off, 7 red; bound at `TOLERANCE /
  10`, 2 red (the 5e-10 cells); the retired 1e-4 bound, 7 red (the
  admissions below).
- Retired (owner rule, second pass, 2026-09-24): the pole clearance
  (`POLE_CLEARANCE`, `A GeoPolygon vertex must be at least 1e-4 degrees from
  a pole`, review round 4). Why it is not VibORM's to refuse: a vertex off
  the pole has a longitude, and its ring one meaning; the 1e-4 was the
  databases' measured clearance, MySQL answering points 70 degrees from
  rings with two consecutive vertices within about 3e-6 degrees of a pole
  wrongly, PostGIS from about 6e-7 (its answer changing with the query
  plan), none of about 1,500 rings from 5.6e-6 out. Stated in `point.mdx`
  and the CHANGELOG. VibORM's own geometry was measured there rather than
  assumed: against 60-digit gnomonic geometry taken from the pole (great
  circles as straight lines; this lane's geo-pole/oracle.mjs, probe.mjs),
  random rings with vertices 3e-9 to 3.5e-4 degrees from either pole (stars,
  shuffled rings, rings with holes, rings over the pole), every ring whose
  edges and clearances exceed twice `TOLERANCE` was judged exactly: verdict,
  message and winding (seeds and counts in the second-pass falsifier
  paragraph at the end). Removing the clearance exposed one precision loss,
  fixed with it: `signedArea` added each south-branch arc's lune (tens of
  degrees) into the same sum as its triangle, and a ring 1e-7 degrees from
  the south pole, about 1e-18 steradians, lost its sign to their rounding
  (wound inside out); the lunes' longitudes now telescope along each run of
  such arcs, so a ring near the south pole adds exactly none. Its witnesses
  flip to admissions asserting the value: "an edge between two vertices
  1e-7 degrees from the south pole", "edges between vertices 1e-6 degrees
  from the north pole" (unit and SQL), "… 1e-8 …", and "a counterclockwise
  triangle 1e-7 degrees from the south pole" (red with the lunes summed in
  the triangle sum, as before, and with them summed arc by arc apart from
  it).
- Retired (owner rule, second pass, 2026-09-24): the exact-180-degree edge
  (`A GeoPolygon edge cannot span exactly 180 degrees`). Why it is not
  VibORM's to refuse: an edge whose longitudes differ by exactly 180 degrees
  and whose endpoints are not antipodal lies on one great circle, the
  meridian plane, and runs over the pole on the side of its endpoints' mean
  latitude: one meaning. Its antipodal case, (0,0) to (180,0), is refused by
  `NEAREST_ANTIPODE` below, which covers every such edge within 0.01 degrees
  of antipodal. The databases read it the same off the edge: 8 named rings
  over a pole and 140 random ones (5 to 80 degrees from the pole, both
  poles, PGlite + PostGIS and MySQL 8, table and index scans, about 118,000
  points at least 0.01 degrees from every edge; geo-pole/dbpole.mjs, seeds
  4242 and 777) gave no wrong answer on PostGIS and one on MySQL, a point
  0.02 degrees from a long non-meridian edge, inside MySQL's ellipsoid band;
  on the edge itself they part (PostGIS matched (0,50), (180,60) and the
  pole on the edge from (0,10) to (180,20), MySQL did not; the table row
  above, (0,80), is such a point). Stated in `point.mdx` and the CHANGELOG.
  Its witnesses flip: "a 180-degree edge" becomes "a 180-degree edge between
  antipodal vertices" (`NEAREST_ANTIPODE`, unit and SQL); "a 180-degree
  closing edge" and "… edge over the pole" are admitted as "a closing edge
  over the north pole" (unit and SQL) and "an edge over the pole between two
  latitude-10 vertices"; "… hole edge" is "a hole with an edge over the
  pole", refused as outside its square. New admissions asserting the value:
  "an edge over the north pole" ((0,10) to (180,20)), "an edge over the
  south pole", "a hole by the pole inside a ring over it" (unit and SQL), "a
  ring over the pole across the antimeridian", "a hole 1e-4 degrees from the
  pole inside a ring over it", "a hole on the meridian where an edge over the
  south pole ends". Falsifier: the refusal restored, 21 red.
- An edge over a pole, the geometry (not guards; second pass): the arc keeps
  its great circle (`Arc.pole` names the pole), goes round whichever way
  leaves the ring no turn (`ringArcs`: `turn` counts the ring's wraps with
  the edge as written, and the edge takes the other way when that cancels
  them; red without it: "a ring over the pole across the antimeridian", "a
  hole over the pole its outer ring runs over"), and enters the sweep as a
  walk along each of its meridians from its vertex to the pole with a
  stretch at the pole between them, beyond every other arc crossing those
  longitudes (`polarEvents`). The stretch leaves before the stretches
  starting on its last meridian enter: left last, it sorted a south-pole
  edge below them and placed the hole starting there in the wrong ring
  ("a hole on the meridian where an edge over the south pole ends", red;
  also red with no polar events at all). `apart` excuses an arc from itself,
  which its walk finds as its own stretch (14 red without it).
- Ring over both poles (the second-pole test in `ringArcs`, `A GeoPolygon
  cannot contain a pole`, at the ring): neither side is away from both
  poles, and no way round leaves the ring no turn. Unique coverage: the
  ring may wind zero times and cross nothing (it is simple), so neither the
  wrap test nor the sweep refuses it. Witness: "a ring over both poles" (red
  without it). A ring over one pole twice needs no test of its own: its two
  edges cross at the pole, which the sweep finds ("a ring over one pole
  twice", refused as self-intersecting with the test off).
- Retired (owner rule, 2026-09-24): the edge of 150 degrees or more
  (`LONGEST_EDGE_COSINE`, `A GeoPolygon edge must be shorter than 150
  degrees`, review round 3). Why it is not VibORM's to refuse: an edge short
  of antipodal has exactly one great circle, so the polygon has one meaning;
  the divergence is MySQL's ellipsoid path, which left the arc (followed by
  PostGIS to 4e-12 degrees) by as much as 0.075 degrees at 90 degrees long,
  0.46 at 150, 1.6 at 170, 2.7 at 174, 8.4 at 178 and 16 at 179 (the largest
  observed over 30 random edges per length, up to five points along each),
  and random triangles with an
  edge 0.000001 to 2 degrees short of antipodal were answered unlike PostGIS
  and the sphere far from the edge in every one of 32 runs of 30. Stated in
  `point.mdx` (table to 179 degrees) and the CHANGELOG. Its witnesses flip:
  "a 151-degree edge" is admitted (unit, and the SQL cell asserts the emitted
  GeoJSON); "a 149-degree edge" is gone with the bound.
- Near-antipodal edge (`NEAREST_ANTIPODE`, `A GeoPolygon edge cannot join
  vertices within 0.01 degrees of antipodal`, at the vertex ending the edge;
  owner rule, 2026-09-24). Two antipodal points lie on every great circle
  through them, so near the antipode the edge's circle is fixed by the last
  digits of its coordinates: moving one written coordinate by one float64
  step turned VibORM's arc normal by up to about 3e-12 / d degrees at d
  degrees from antipodal (2,000 random edges per distance: 3.1e-9 at 0.001,
  9.8e-10 at 0.0032, 3.0e-10 at 0.01; this lane's antijitter.mjs). The bound
  is where that turn falls to a third of `TOLERANCE` (1e-9 degrees), so the
  tolerance is justified by the ambiguity of the great circle at VibORM's own
  resolution, not by any database: nearer, the written coordinates do not
  decide on which side of the edge a point lies. Unique coverage: the exact
  180-degree test sees only an exact 180 degrees of longitude, and an edge
  1e-6 short of antipodal passes every other check. Witness: "a nearly
  antipodal edge" (unit and SQL), "an edge 0.009 degrees short of
  antipodal"; admitted "an edge 0.011 degrees short of antipodal".
  Falsifiers: removing the test reds the three refusals; a bound of 0.001
  reds "0.009"; a bound of 0.02 reds "0.011".
- Ring winding around a pole (`wrap !== 0` in `ringArcs`): the ring encloses a
  pole, so it has no side away from both poles, the side VibORM reads as the
  polygon (`signedArea` and the sweep's placement read the area on the
  pole-free side). This is VibORM's own ambiguity, which side is inside, not
  a database's reading, so it stays under the owner rule. Witness: "a ring
  winding around a pole", "a ring over a pole winding around the other"
  (the turn left after the edge over the pole takes either way).
- Self-intersection (two non-neighbor arcs meet, found by `sweep`): an
  asymmetric bowtie has area and passes the rest. Witness: "a bowtie", "a
  bowtie hole", "a ring touching itself at a repeated vertex", "a ring past a
  whole turn over itself", "a vertex on a meridian edge" (an arc along a
  meridian is compared by position at its longitude, not by the order), "a
  bowtie whose crossing arcs a hole keeps apart in the sweep" (the
  comparison when an arc leaves the sweep; red without it, the polygon then
  refused for its hole).
- Self-intersection of neighbors (one arc doubles back along the one before
  it, in `ringArcs`): `sweep` excuses neighbors, which meet at their
  shared vertex, and cannot order two arcs that overlap, so it missed the
  non-neighbor meeting such a spike always makes (13 to 23 per 20,000 random
  degenerate rings against a comparison of every pair). Witness: "a ring
  doubling back along an edge".
- Retired (owner rule, 2026-09-24): the ring size bound (`SMALLEST_RING`,
  `A GeoPolygon ring must be at least 2e-5 degrees across`, review round 3).
  Why it is not VibORM's to refuse: a small simple ring has one meaning; the
  divergence is MySQL's precision, which answers points within about 1e-6
  degrees of any vertex unlike PostGIS and the sphere, so it misread points
  in rings a few 1e-6 degrees across (tiny squares, triangles, concave and
  thin rings at random places, points a tenth of the ring from every edge:
  0.4% wrong at 5e-6, 9% at 2e-6, 16-32% at 1e-6, 34-56% below; PostGIS
  none) and none of 16,000 at 1.4e-5. The VibORM-side question, whether
  VibORM's own geometry can judge a ring that small for self-intersection,
  zero area and winding, was measured rather than assumed: against 60-digit
  gnomonic geometry (great circles as straight lines) on 9,000 random rings
  1e-9 to 1e-4 degrees across (random-order, star, sliver and pinched rings,
  every latitude, near the poles, on the antimeridian; this lane's
  tinygen.mjs / tinyjudge.py, seeds 1-3), every ring whose edges and
  clearances exceed twice `TOLERANCE` was judged exactly: 4,048 simple rings
  admitted with the right winding, 2,135 crossing rings refused, 0 wrong.
  Nearer than that a feature reads as a touch (refused) or an edge shorter
  than `TOLERANCE` as a repeated vertex (19 crossing rings admitted, each
  only through such an edge). So VibORM's resolution is `TOLERANCE` itself,
  1e-9 degrees, and no smaller ring bound stays; a ring whose vertices all
  fall within it of one another has no arc and is refused by the zero-area
  guard below. Its witnesses flip: the three "a square 1e-5 degrees across
  …" cells and "a square 1e-8 degrees across" are admitted (the SQL cell
  asserts the emitted GeoJSON); "a ring of one distinct vertex" now reports
  `must have non-zero area`.
- Cross products from vertex differences (`cross`, (a − b) × (a + b) / 2):
  not a guard but the precision the geometry rests on; the plain a × b loses
  a 1e-7-degree arc's direction. Witness: "a 1e-7-degree bowtie in a larger
  ring" (at latitude 45; admitted with the plain product).
- Zero area (`!first || …` in `ringArcs`, `A GeoPolygon ring must have
  non-zero area`): a ring of at most three arcs on one great circle has only
  neighbor arcs, which the self-intersection test skips, and a ring of one
  distinct vertex (every edge under `TOLERANCE`) has no arc at all. Witness:
  "a collinear ring" (on the equator), "a ring of two distinct vertices";
  for the no-arc arm "a ring of one distinct vertex" and "a square 5e-10
  degrees across" (unit and SQL). Three
  vertices in a straight line of longitude and latitude off the equator are a
  thin spherical triangle, admitted, and both databases answered points inside
  and outside it correctly.
- Retired (owner rule, 2026-09-24): across all three planes (`across` in
  `validateGeoPolygon`, `A GeoPolygon cannot reach across the equator and the
  0/180 and 90/-90 meridians at once`, review round 3). Why it is not
  VibORM's to refuse: such a ring, pole-free, has one meaning, the side away
  from both poles; the divergence is PostGIS's. PostGIS tests a point
  against a reference point outside the polygon's geocentric box, and widens
  that box to the pole of every axis whose two other coordinates the rings
  take on both sides of zero (liblwgeom `gbox_check_poles`); with all three
  it is the whole globe, `gbox_pt_outside` fails, and PostGIS falls back to
  a guess (`lwpoly_pt_outside_hack`, `circ_tree_get_point_outside`, the
  latter decided by its incremental merge of the edges' circles). Measured:
  PostGIS misread 23 of 372 random outer rings reaching across all three
  planes, one of them 27% of half the globe, and none of 494 reaching across
  two or fewer; table scans went wrong on 42 of 44 rotations where either
  fallback point fell inside, none of 436 where both fell outside; MySQL
  none. Rerun on this lane for the admitted witnesses (400 random points,
  table and index scans, points within 0.5 degrees of an edge excluded):
  the tropics band 38 of 394 wrong on PostGIS, "a band with two long edges
  on each side" 398 of 398 (inside out), "a ring across all three planes"
  347 of 397, "a band from 180 to 0 through -90" and "the Pacific" none;
  MySQL none on any. Stated in `point.mdx` with the advice to split such an
  area into polygons joined with `OR`, each on one side of one plane. Its
  witnesses flip to admissions asserting the value ("the tropics band", "the
  Pacific" also as SQL cells asserting the emitted GeoJSON), and "a triangle
  touching the equator and the 0 meridian" stays admitted.
- Retired: the half-globe area guard (`sphericalArea`, `A GeoPolygon must
  cover less than half the globe`), subsumed by the three-planes rule in
  review round 3 and not restored with its retirement: a pole-free ring
  larger than half the globe has one meaning.
- Hole escaping its outer ring, meeting arm (`sweep`'s meeting, reported as
  a hole outside when the lower ring index of the two arcs is the outer
  ring's, `validateGeoPolygon`): any crossing or touch, including a hole
  written against a straight parallel edge. Witness:
  "a hole crossing the outer ring", "… bridging a notch …", "… whose edges
  cross an outer notch", the three "a hole touching …"/"along an outer edge"
  cells, "a hole equal to its outer ring", "a hole touching a parallel edge in
  the plane", "a hole inside the plane's edge but outside the great-circle
  arc".
- Hole escaping its outer ring, outside arm (`!inside`, placed by `sweep`):
  a hole wholly outside meets nothing. Witness: "a hole outside", "a hole
  north of a band that crosses its antimeridian".
- Holes touching or overlapping, meeting arm (`sweep`): "holes touching
  at one point", "holes sharing an edge", "holes overlapping through shared
  corners", "a hole touching another's parallel edge in the plane";
  a later hole inside an earlier one (`RingNode.firstAround`): "a hole
  nested in a hole"; an earlier hole inside a later one
  (`RingNode.firstWithin`): "a hole enclosing a hole". A hole is reported at the first index where it lies in
  or around an earlier hole, as when each hole was tested against every
  earlier one.
- Restored (owner rule, 2026-09-24): the antipode test in `crosses`. Review
  round 3 retired it because every ring then admitted lay on one side of one
  of the three planes, where two arcs straddling each other's circles share
  the circle through their antipodal points. Admitted rings may now reach
  across all three planes, and two of their arcs can straddle each other's
  circles and meet only at the far one of the two points the circles share.
  The test: the arcs cross when they hold the same one of the two, the one on
  the side of each arc's middle (start + end; an arc shorter than half a
  circle holds a point of its circle exactly when the point is on that side).
  Against an angle-sum oracle it agreed on 400,000 random arc pairs (49,954
  antipode-only straddles) and 400,000 pairs of 170 to 179.99-degree arcs
  (143,131); this lane's crosscheck.mjs / crosscheck-long.mjs. Unique
  coverage: without it the straddle test calls such arcs crossing, and the
  ring is refused as self-intersecting. Witness: "a band with two long edges
  on each side" and "the tropics band" (unit), "the tropics band" (SQL), red
  without it.
- Retired with `inside` (review round 4): its behind-the-pole skip and its
  one offset per shared vertex. The sweep places rings on half meridians
  from pole to pole and never counts crossings, so neither case arises; their
  witnesses ("a hole north of a band that crosses its antimeridian", "holes
  where one grazes the other's meridian at a vertex") keep their verdicts.

Kept output facts, not refusals: an edge shorter than the tolerance, a
repeated consecutive or closing vertex, is dropped from the geometry (witness
"admits 'a closed ring'", "admits 'a repeated consecutive vertex'"); the
emitted GeoJSON is unchanged.

Deleted as unreachable (coverage closure, 2026-09-24): the sweep's comparison
of the arcs along one meridian among themselves (the "column"). Where two
such arcs meet, one ends on the other, and the arc continuing its ring from
that end crosses the meridian there (a ring's consecutive arcs along one
meridian continue in one direction, since `ringArcs` refuses a ring doubling
back), so the walk along the other arc meets it first; the continuing arc
could be excused only as a ring neighbor of the arc it lies on, and a
neighbor sharing an end with it would itself run along the meridian. Over
160,000 random polygons (grid-snapped, antimeridian, tiny, star, band and
across-all-planes rings with holes) the column never found a meeting, and
verdicts matched a comparison of every pair of arcs on 280,000 (this lane's
diff.mjs, seeds 1-5 and 11-13). Hole placement now reads each ring's
`RingNode` (`around`, `inside`, `firstAround`, `firstWithin`) instead of
parallel arrays, which removes the `?? none` fallbacks every placement
already covered; `pnpm test:coverage:validation` is at 100% on statements,
branches, functions and lines.

Not a guard: `sweep` finds whether any
two arcs meet by a sweep in longitude that keeps the arcs it crosses in
south-to-north order in a skip list and compares only neighbors in it
(Shamos and Hoey), all rings in one pass; it agreed with a comparison of every
pair on 120,000 random rings built to touch, overlap, run along meridians and
cross the antimeridian. It replaced a sweep over arc boxes that compared every
pair whose boxes overlapped: on the review's star (spokes from radius 0.5 to
20 degrees) that took 7.2 s at 20,000 vertices, 33 s at 40,000 and 98 s at
20,000 with 50 small holes, now 27 ms, 65 ms and 53 ms; every input of the
review's perf script is under 0.1 s. Witness: "admits a 40,000-vertex star
with 50 holes in near-linear time" (under 2 s; red with every pair compared).

The skip list's heights are coin flips drawn from `Math.random()` for each
arc (review round 7). They were Park and Miller's generator at a fixed seed,
chosen so the same polygon built the same list, but an input can replay a
fixed sequence: strips that stay in the sweep exactly when both their arcs
drew height 1 leave the long-lived arcs at the lowest level, and every search
walks them one by one. Measured on this lane's bundle (review-geo7
skipadv.mjs, repeated in geo-repair7): 20,004 / 40,004 / 80,004 / 160,004
arcs took 442 / 1,985 / 7,942 / 56,767 ms against 48 / 50 / 98 / 193 ms for
the same strips chosen by an independent stream; with drawn heights both take
40 / 68 / 125 / 250 ms. Heights decide running time, not the verdict: two
arcs that meet are neighbors in the south-to-north order before their
westernmost meeting whatever the heights. Messages and paths did not vary
either: 24,000 random polygons (bands with holes, stars with holes, spirals
with crossings, stars with reversed spokes), 23,460 of them refused, each
validated 8 times, never gave two results (geo-repair7 determinism.mjs, seeds
5 and 6). The review's oracle fuzz (fuzz.mjs, 5,000 each of star, holes,
spiral, band, long: 0 false refusals, 0 false admissions), msgcheck.mjs
(19,853, 0 false) and gridneg.mjs (400 grids, all as expected) were rerun on
the drawn heights. Admission is now expected n log n for any input.
Witness: "admits strips chosen against predictable skip-list heights in
near-linear time" (under 2 s; 11.3 s, red, with the fixed seed restored).

Not a guard either: hole placement (review round 4). Testing each hole's
first vertex against the outer ring and every earlier hole was O(H x N) and
O(H^2 x hole size): 7.1 s for 10,000 four-vertex holes in a 64-vertex ring,
1.9 s for a 40,000-vertex star with 2,500 holes. No two rings meet once
`sweep` has found no meeting, so `sweep` also lists, for each ring, the arc
first north of the ring's northernmost point on the meridian where it first
met the ring (its own arcs through that point skipped). The ring lies inside
that arc's ring when the arc has its ring's interior to the south (the
exact `signedArea` sign gives each ring's orientation), else in the same
ring as that ring; rings first met on one meridian are listed north to
south, so the ring an answer depends on is always placed first. North is
latitude, atan2(z, hypot(x, y)), not z (second PR review, 2026-09-24): z
rounds to ±1 within about 6e-7 degrees of a pole, and there an outer ring
reaching the antimeridian with an edge and with its edge over the pole
tied, kept the edge as its northernmost, and was placed inside a hole
north of it (637 of 3,000 unambiguous polygons with a hole's longitudes
jittered were refused as holes touching; 0 by latitude; witness "places
rings meeting the antimeridian together near a pole by latitude", red with
z). Admission
is O((N + H) log N): the review's perf script now takes 59 ms for the
10,000 holes, 61 ms for the star with 2,500. Verdicts, messages, paths and
values were identical to the pairwise placement on 95,000 random polygons
(80,000 small outer rings with up to 40 nested, overlapping, touching,
grid-snapped and antimeridian holes; 15,000 bands up to 340 degrees wide
with up to 30 holes). Witnesses, each red under its mutation: "admits
10,000 holes in near-linear time" (under 2 s; the pairwise placement took
7 s), "holes side by side on one meridian" (red when the rings met on one
meridian are not placed north first), "a hole in another hole's notch, both
reaching west to one meridian" (red when a ring is placed from its first
point on the meridian rather than its northernmost), "holes where one grazes
the other's meridian at a vertex" and "a hole beyond the plane's north edge,
inside its great-circle arc" (red without skipping the ring's own arcs), and
every hole cell (red with the orientation rule inverted).

Evidence beyond the witnesses: a differential run of 4,800 random cases
(holes jittered around a slanted outer edge, judged by PostGIS `ST_Intersects`
between the rings as geography lines plus a vertex-in-polygon test; random
quadrilaterals, judged by their non-neighbor edges as geography lines) agreed
with `validateGeoPolygon` on every verdict; the straight-line restoration
disagreed on 100 to 200 of every 800. Every admitted probe polygon (69 points,
table scans on PostGIS and MySQL) answered correctly on both databases.
`tests/providers/docker/mysql2.test.ts` geo cells stay green.

Remaining gap (measured in review round 3): MySQL draws edges on the ellipsoid,
PostGIS geography on the sphere. The largest departure of MySQL's edge from
the great-circle arc observed over 30 random edges per length (up to five
points each; rerun on 2026-09-24 for 10, 30, 60, 178 and 179 degrees, which
the lane had sampled on 10 edges) is 0.0007 degrees (about 79 m) on a
10-degree edge, 0.007 at 30, 0.029 at 60, 0.075 at 90, 0.17 at 120 and 0.46
at 150, none along the equator or a meridian; at 120 degrees of
longitude on latitude 40 (an 83-degree edge) the review measured 0.054 at the
middle. A point, or a hole, inside that band beside an edge can be answered
differently by the two databases; VibORM refuses touches but admits a hole 1e-9
degrees clear. Decision (owner rule, 2026-09-24): the band is stated, not
refused, at every edge length, including from 150 degrees on where MySQL's
path swings non-locally near the antipode (the retired `LONGEST_EDGE_COSINE`
entry above has the figures); only the near-antipodal edge VibORM itself
cannot fix is refused. Below 150 degrees the band is a fraction of the edge
(0.08% at 90 degrees, 0.3% at 150) that shrinks with the square of the length
when an edge is split. Separately (review round 4, which corrected
"edges of 1e-5 degrees or shorter sit up to 2e-7 off": that was measured at
edge midpoints), MySQL answers points within about 1e-6 degrees of any
vertex unlike PostGIS and the sphere, whatever the edge length: about 13%
of such points in random pentagons with edges of 0.001, 0.1, 1 and 5
degrees (1,240 to 1,332 of about 9,600 per size, the review's
vertexband.mjs, rerun on this lane), none from 1.8e-6 out, PostGIS none;
MySQL's SPATIAL index and table scans also disagreed on 152 such points,
all within 7e-7 of a vertex (idxcheck.mjs). Witness of the effect: the
admitted 0.001-degree square from (10, 40), where MySQL matched
(10.0009994, 39.9999994), 6e-7 outside, and missed (10.0000006,
40.0009994), inside. Decision: stated, not refused; it is a fixed 11 cm
neighbourhood of the vertices, and in rings a few 1e-6 degrees across it
covers the whole ring (the retired ring size entry above has the figures),
which `point.mdx` states with the advice not to rely on MySQL there.

Falsifiers of the owner-rule pass (2026-09-24, final codec, each mutation
alone, `geo-area.core.test.ts` + `geopoint-sql.core.test.ts`, this lane's
falsify.py / muts.json): pole clearance off, 8 red; exact 180 off, 5;
near-antipode off, 3; its bound at 0.001, 1 ("0.009 degrees short"); at
0.02, 1 ("0.011 degrees short" admitted); pole winding off, 2; zero area
no-arc arm off, 3; collinear arm off, 3; neighbor doubling back off, 1;
every sweep meeting off, 27; hole/outer and hole/hole meetings off, 19;
the meridian walk off, 8; the comparison on leaving off, 1; the antipode
test in `crosses` off, 3; the outside arm off, 3; `firstAround` off, 2;
`firstWithin` off, 2; the orientation rule inverted, 17; the plain cross
product, 1; winding off, 2; repeated vertices kept, 6.

Second pass (owner rule applied to the pole clearance and the exact-180
edge, 2026-09-24; the file copied aside, mutated, the two geo files run,
restored from the copy; this lane's geo-pole/falsify.py): pole-vertex guard
off, 7 red; its bound at `TOLERANCE / 10`, 2; the 1e-4 clearance restored,
7; the exact-180 refusal restored, 21; no turn choice over a pole, 2; the
both-poles test off, 1; no polar events, 1; the polar stretch leaving last,
1; lunes in the triangle sum, 1; lunes summed arc by arc, 1; an arc not
excused from itself, 14. Oracle runs on the final codec
(geo-pole/probe.mjs against 60-digit gnomonic geometry from the pole, seeds
301-306, 150 per kind): 6,190 polygons judged, 3,193 admitted and 2,997
refused, 0 wrong in verdict, message or winding; 1,664 with a clearance
within twice `TOLERANCE` left out. Kinds: stars, shuffled rings and rings
with holes 3.5e-9 to 3.6e-4 degrees from either pole; rings over a pole
(small, shuffled, with holes by the pole) 3.5e-9 to 1.1e-4 degrees from it
and 0.02 to 81.6 degrees from it.

Moved from the codec's comments (second PR review, 2026-09-24): the
measurement history the comments on `TOLERANCE`, `NEAREST_ANTIPODE`,
`cross`, the hole rules and the self-meeting refusal carried now lives only
here, and the comments point here: the ring size entry and the second-pass
paragraph above (9,000 tiny rings, 6,190 polygons by the poles), the
near-antipodal entry (2,000 edges per distance), the cross-product entry
(the bowtie at latitude 45), and the table at the top of this addendum
(holes outside or overlapping; the bowtie, both lobes and its crossing point
matched on both databases, a parity reading the docs do not state; the ring
past a whole turn over itself, which split them). The code keeps each
algorithm and each reason.

Reproduction: `scripts/geo-verification/README.md` keeps the oracles, seeded
fuzz, performance cases, MySQL departure runs and a verdict corpus behind these
figures, with seeds, commands and observed output, and lists the lane's scratch
scripts named above that it does not keep.

**Kept guard: at least `GEO_POLYGON_MIN_RING_POINTS` vertices per ring**
(`validateRing`). Unique coverage: `closedRing` in
`src/adapters/shared/geo-point.ts` reads the first vertex of every ring, so an
empty ring would throw a `TypeError` there rather than reach the database, and
the JSON Schema projection states the same minimum as `minItems`. Falsifier:
removing it fails "still refuses a ring shorter than three vertices before any
SQL" (`geopoint-sql.core.test.ts`).

**Kept output normalization: winding (outer counterclockwise, holes
clockwise)** (`wound` in `validateGeoPolygon`, reading the sign of
`signedArea`, the ring's exact spherical area from the pole side, since
review round 3; the planar shoelace sum it replaces could disagree with the
sphere for a ring simple on the globe but not in the plane). It is not a refusal and judges
nothing, so decision D2 does not retire it. Consumer: the GeoJSON bound by
`withinPolygon` in `src/adapters/databases/postgres/postgres-adapter.ts` and
`src/adapters/databases/mysql/mysql-adapter.ts`; that PostGIS `geography` and
MySQL SRID 4326 read the interior the same way for either orientation is
unproven (`docs/architecture/v1-public-api-geopoint-plan.md`), so VibORM keeps
sending one orientation. Retiring it needs the Docker falsifiers
(`tests/contracts/drivers/behaviors/geopoint-behavior.ts` reversed rings on
pg, postgres and mysql2; `tests/providers/docker/mysql2.test.ts`) green
against un-rewound rings and an owner decision. Witnesses: "normalizes winding
and keeps open rings" (`geo-area.core.test.ts`) and "binds canonical polygons
and never concatenates caller geometry" (`geopoint-sql.core.test.ts`).

**Kept output normalization: `holes: []` is omitted** (`validateGeoPolygon`).
An empty and an absent hole list emit the same GeoJSON; one spelling keeps them
one validated argument and so one cache key. Falsifier: "spells an empty and
an absent hole list as one validated polygon" (`geo-area.core.test.ts`, strict
equality, so a `holes: []` or `holes: undefined` key left in the value fails
it). "emits an empty hole list as no hole and a hole list in input order"
(`geopoint-sql.core.test.ts`) pins the emitted GeoJSON only; `closedRing`
emits the same text either way, so it cannot falsify this normalization.

**Moved, not added: the coordinate domain constants.** `GEO_POINT_KEYS`, the
longitude and latitude limits, `GEO_BOUNDS_KEYS` and
`GEO_POLYGON_MIN_RING_POINTS` now live in the import-free
`src/validation/primitives/geo-values.ts`. The codecs now build records with
`object()` at module load; while the JSON Schema converter imported its
constants from the codecs, loading `object.ts` first re-entered it through
`json-schema/factory` → `converters` → codec and threw a temporal-dead-zone
`ReferenceError`. Reading the constants from the leaf removes that edge.
Falsifier: `tests/unit/validation/point.core.test.ts` ("loads when object is
the first module of a fresh graph", one case per entry module: object,
helpers, json-schema factory, json-schema converters); importing
`GEO_POINT_KEYS` in the converters from `geo-point-codec` again fails the
object case with that `ReferenceError`, while every other geo suite stays
green.

---

## Addendum — the G3P-04 suppression refusal becomes a warning (2026-09-24)

**Owner decision (Arnaud, 2026-09-24): "Warn, drop skipDuplicates".** The Raptor 3
sentence `Raptor 3 borrowed createMany skipDuplicates requires an operation-owned
member rollback region.` (`TransactionError`, `V5001`) is **RETIRED**. It was a
candidate (unmatched) refusal in `scripts/raptor3-refusal-census.mjs` at two
throw sites — `OperationContext.executeSkippableMember` and `requireSuppression`,
the latter reached from the command analysis pass and from the MySQL
`recoverableUniqueError` scalar `createMany` — and the census now reads 36
candidate sentences at 45 sites (37 at 47 before).

| Site | Invariant | First knowable boundary | Disposition |
|---|---|---|---|
| `commands.ts` analysis pass · `if (command.suppression) requireSuppression()` | A skippable member needs a member rollback region the operation owns. | The analysis pass, before the enclosing root writes. | **DELETED.** A refusal had to fire before any effect; a dropped skip does not, so the question moved to where the skip is spent and an arm that never runs never warns. |
| `OperationContext.executeSkippableMember` | same | the member boundary | **CONVERTED** to `admitsSuppression("rows involving nested writes")`: without a region the member runs through the ordinary `executeMember`. |
| `OperationContext.createMany` MySQL `recoverableUniqueError` path | same | the scalar per-row loop | **CONVERTED** to `admitsSuppression("duplicate rows")`: without a region each row is a plain insert. Reachable only through a borrowed binding without `memberRollback` (an array `$transaction([...])` member on mysql2/planetscale); batch preparation still answers the dynamic-planning sentinel first. |

`OperationContext.admitsSuppression` is the ONE rule (borrowed without
`memberRollback`, or `usesBatch` — which batch preparation implies) and the one
sentence (`droppedSkipMessage`). It warns once per client lineage (the engine's
`EngineSchema`) and model: through the caller's logger when it routes warnings
(`meta.notice`, a new ORM-authored key in the log-metadata allowlist beside
`deprecation`), `console.warn` otherwise. No site still needs to refuse: running
the member plainly is the same operation the caller would get without the flag —
a duplicate fails with `UniqueConstraintError`, and a segmented transport keeps
what an earlier segment committed, reported through `recordSeriesProgress`.

Falsifiers (restoring the refusal in `executeSkippableMember` and at the MySQL
path turns every one red): `tests/providers/workers/d1.test.ts` (three "drops
skipDuplicates …" cells), `tests/raptor3/prep/{suppression-replay,
g3p04-review-regressions,native-suppression-replay}.test.ts`,
`tests/contracts/engine/write/{compound-junction,polymorphic-collection-write-family,
combined-depth-stress,nested-create-context-grandchild,create-many-skip-depth}.test.ts`,
`junction-produced-identity-behavior.ts`, and the `atomicBatch` arm of
`tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior.ts`.
The logger route and the `notice` key are pinned by "routes the dropped-skip
warning through the client's logger once …" (`suppression-replay.test.ts`).
