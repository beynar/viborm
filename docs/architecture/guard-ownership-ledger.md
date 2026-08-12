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
> unchanged — site 12 still owns cluster 3's adopt-seam half — so the estate is
> now **14 write-engine sites / 10 invariants** (query-engine 16/12, src 18/14),
> and `operation-construction-inventory.test.ts` pins the new counts.
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

| Scope | Command | O1 (at `0ccd6abf`) | After O2/O3 |
|---|---|---|---|
| write-engine | `rg -c "new UnsupportedOperationError" src/query-engine/write-engine` | 21 | **15** |
| query-engine | `rg -c "new UnsupportedOperationError" src/query-engine` | 24 | **17** |
| whole `src` | `rg -c "new UnsupportedOperationError" src` | 26 | **19** |

The executable census owner is
`tests/contracts/engine/write/operation-construction-inventory.test.ts` (it now
pins 15 for the write-engine directory and re-resolves all 19 classified
coordinates). §O4's 8–12 band is adjudicated against the **write-engine** scope
— the set every count-evolution entry in that file governs — so 15 > 12 and the
architecture-review path still applies to every survivor. It is a review the
survivors now pass site by site: see the §O3 audit below.

**Distinct invariants: 12 as `UnsupportedOperationError`, 13 engine-owned**
(query-engine scope; write-engine 10 / 15 sites, whole `src` 14 / 19 sites).
The honest split, because §O4 calls this the more important measure and a
rounded-up number would be the easy lie. Six sites went as pure duplication and
took NO invariant with them (12 of the 13 are untouched). The thirteenth — the
compound many-to-many topology, cluster 9 — is still refused by the engine, and
still before any I/O, but by `getRequiredSinglePrimaryKeyField` as a
`QueryEngineError`, so it no longer appears in an `UnsupportedOperationError`
census. Nothing became legal. Site numbering is N3's throughout and is NOT
renumbered — the retired numbers (9, 10, 14, 16, 17, 18, 23) are the record of
what folded into what.

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
| 2 | `RecordUpdateCompiler.ts:1800` · `postTransitionReference` · `client.M.update({ where, data: { <member of a COMPOUND non-cascade referenced key>: null, <childRel>: { create } } })` | A member of the reference the root SET rewrites has no post-transition value the fresh child can name (`null` names no row; an `Sql` value exists only after the database evaluates it). | Compile, inside the compiler — the per-member derivation pairs the located pre-value with the SET operand, and the located row exists only after planning. | `bay.update({ where: {id}, data: { slot: null, pads: { create } } })` on a `(area, slot)` compound reference: the arity-1 branch (site 3) is not entered, so only this site answers. | `parity-d-transition.test.ts:805` ("a rewritten column with no construction value") and `compiled-key-transition-behavior.ts:234` (+ `.test.ts` / `-docker.test.ts`). **The `"membership"` position (`:2621`) is UNPINNED.** | MSI | **keep** (owner of the per-member derivation, established by Package D) |
| 3 | `RecordUpdateCompiler.ts:2017` · `resolveCreateParent` · `client.M.update({ where, data: { <arity-1 NON-PK referenced unique>: null \| Sql, <childRel>: { create } } })` | Same invariant as site 2, on the single-member non-primary-key branch. | Same. | `counter.update({ data: { token: null, tags: { create } } })` — arity 1, `token` not a PK member, so site 2's per-member path is never built. | `sql-operand-boundary-behavior.ts:186` ("null on a nullable referenced column is the ONE arm that reaches the engine") via `sql-operand-boundary.test.ts` / `-docker.test.ts`. | MSI | **KEPT — disposition reversed on measurement** (disagreement 1). It refuses a strictly WIDER operand set than site 2 and its accepted arm orders the INSERT differently; delegating would accept operands refused today. |
| 5 | `RecordUpdateCompiler.ts:3612` · `beforeTargetReferencedValue` · `client.M.update({ where, data: { <parentHeldToOne>: { create: {…} } } })` | A before-root create target's referenced column is neither that record's primary key nor a knowable value in its own create data. | Construction — the subtree's `rootReferenced` is total over what an INSERT can publish. | An update root whose parent-held `create` target references a column the target's create data does not spell and the INSERT does not produce. | `parity-f-fresh-field.test.ts:858`; `parent-held-lookup-behavior.ts:619` via `parent-held-lookup.test.ts`. | MSI | **keep** — this is the plan's "one selected-transition owner when the value comes from UPDATE". |
| 14 | `CreateOperation.ts:991` · `interpretPolymorphicRelation` · `client.M.create({ data: { <direct polymorphic>: { create: {…} } } })` | A before-parent polymorphic create target's referenced column is unknowable. | Construction, in `CreateOperation`. | Nothing measured. Its own `connectOrCreate` twin — at `:1016` when this row was written, `:1027` at HEAD — states the SAME SENTENCE BYTE-IDENTICALLY as a `QueryEngineError`, one branch away. | **NONE** | MSI | **DONE — folded into site 15**, `requireRecordReferenced("beforeParentTarget")`. Its `query-engine` prefix was normalised to `query-engine-v2`, matching its three siblings; nothing pinned the difference. Its `connectOrCreate` twin keeps its `QueryEngineError` class and now shares the owner's message builder — disagreement 3. |
| 15 | `CreateOperation.ts:2772` (declared `:2764`; N3 read the pre-fold position at `:1789`/`:1781`) · `requireRecordReferenced`, formerly `targetReferencedValue` · `client.M.create({ data: { <parentHeldToOne>: { create: {…} } } })` | A before-parent create target's referenced column is neither its primary key nor knowable in its create data. | Construction, in `CreateOperation`. | The create-root twin of site 5: a before-parent target referencing an absent nullable unique. | `parity-f-fresh-field.test.ts:842`. | MSI | **DONE — this IS the owner now.** `requireRecordReferenced(record, referencedField, relationName, position)`; the position selects the noun, the decision is made once. |
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
| 12 | `RelationUpsertPart.ts:754` · `withoutAgreeingOwnedFk` · `client.M.create({ data: { <toMany>: { upsert: { create/update: { <ownedFk>: … } } } } })` | The same second provenance, in the one context that can ABSORB it: a create root whose own key is a literal the spelled FK can be compared against. | This boundary — the comparison needs the parent's construction-time value, which exists only here. | A create-context to-many `upsert` whose arm spells a DISAGREEING literal, `null`, an arithmetic envelope, a compound edge, or a `ref`/`planned` parent source. (`create.ts`'s upsert arm deliberately keeps the omission off, because absorbing the agreeing spelling is a capability.) | `adopt-owned-fk-agreement-behavior.ts:212`, `:429`, `:452`, `:460` via `adopt-owned-fk-agreement.test.ts` / `-docker.test.ts`. | SC | **keep** — this is not a pure guard; it is the absorb/refuse decision, and its accept half has its own witnesses. |

---

## Cluster 4 — `skipDuplicates` without an identity (2 sites, TWO contracts)

N3 flags this as one PHRASE over two invariants. Confirmed: nothing about the
substrate changes site 7's answer, and nothing about the product contract
changes site 8's.

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 7 | `CreateManyRecordSeries.ts:126` · the constructor · `client.M.createMany({ data: [<rows with relations>], skipDuplicates: true })` | The public meaning of a skipped root's nested effects is unchosen (suppress, or adopt-and-apply) and the engine will not pick one silently. | The product contract; §5.1 says not to guess. Refused typed at construction, before the series shell is chosen. | The exact shape plan §5.1 names — a relation-bearing bulk row beside `skipDuplicates`, on a transaction-capable substrate. | `create-many-relation-series.test.ts:349`; `create-many-relation-series-behavior.ts:545`; and the tracked corpus entry `J_SKIP_WITH_RELATIONS` in `operation-construction-inventory.test.ts:279`. | DPC | **keep** — the one refusal the lift adds, deliberately tracked. |
| 8 | `RelationJunctionPart.ts:1374` · `resolveCreatePk` · `client.M.update({ where, data: { <m2m>: { createMany: { data, skipDuplicates: true } } } })` with a database-generated target primary key | A skipped row produces no identity, so its join row has nothing to reference. | This boundary — whether the target key is database-generated is a schema fact, but whether a row was skipped is only knowable per row at execution, so the refusal must stand where the join value is resolved. | Junction `createMany` + `skipDuplicates` where `targetPkField` is `increment` (and the compound-unique variant where the constraint is incomplete). | `junction-skip-adoption-behavior.ts:608`, `:652`, `:681` via `junction-skip-adoption.test.ts` / `-docker.test.ts`. | MSI | **keep** |

---

## Cluster 5 — an upsert create arm with no readable-back row (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 21 | `UpsertOperation.ts:1147` · `createArmIdentity` · `client.M.upsert({ where, create: {…}, update })` | The create data names no row this operation can read back: no complete primary key, no complete unique constraint, and the absent primary-key members are not a single database-generated identity the INSERT can capture. | Compile, and only when the create arm is TAKEN — an upsert that updates is unaffected, which is why it cannot move earlier. | Two absent compound primary-key members (§7.2's third row); the one-absent-`increment` case is now ACCEPTED, so the site is genuinely narrower than the shape it once refused. | `produced-compound-identity.test.ts:111` (`NO_COMPLETE_UNIQUE`). | MSI | **keep** |

---

## Cluster 6 — a shared primary key with no one final value (2 sites, two roots)

§O2 row 7 territory ("stable mutation identity"). **Disagreement with N3**: site
20 is listed there under cluster 1; it is the create-root twin of site 4 and
belongs here. This does not change the invariant count — cluster 1 loses a site,
cluster 6 gains one.

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 4 | `RecordUpdateCompiler.ts:3533` · `recordSharedKeyFold` · `client.M.update({ where, data: { <parentHeldToOne whose FK is M's own row key>: { create \| connectOrCreate \| upsert \| connect } } })` | The arm that folds a member of this record's own row key names no one final value for it (absent, `null`, or a root SET that DISAGREES with the fold). | Construction — Package E narrowed the site from refusing a SHAPE to refusing an ARM THAT NAMES NO VALUE, which is exactly what is knowable here. | A shared-PK `connect` resolved by a correlated lookup subquery (no construction value), and a shared-PK `create` beside a root SET spelling the same column with a different value. | `parity-e-shared-pk.test.ts:645`, `:670`, `:690`; `shared-pk-update-root-behavior.ts:399` via `shared-pk-update-root.test.ts` / `-docker.test.ts`. | MSI (+ one SC arm) | **keep**. N3's `(*)` flag stands: the "root SET disagrees" arm is SC while "no value"/`NULL` are MSI. Recommend NOT splitting the sentence — a disagreeing SET is the same "no ONE final value" fact from the other side, and a second site would be a second owner. |
| 20 | `CreateOperation.ts:3154` (declared `:3140`; N3 read it at `:3091`) · `assertSharedPkResolved` · `client.M.create({ data: { <parentHeldToOne whose FK is M's primary key>: { create \| connect \| connectOrCreate } } })` | Same invariant at the create root: the shared key is not a compile-time literal. | Construction, in `CreateOperation` — a fresh record has no located row, so the update-root derivation cannot apply. This is a genuinely different trust boundary, which is why two sites survive one invariant. | A `connect` by a NON-referenced unique (a lookup subquery) and a `connectOrCreate` whose arm is chosen at compile while the identity is consumed at construction — E6.3's two surviving causes. | `parity-e-shared-pk.test.ts:749`; `fresh-produced-field.test.ts:538`. | MSI | **keep** |

---

## Cluster 7 — a single-target membership move across N>1 roots (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 1 | `UpdateManyRecordSeries.ts:348` · `assertMembershipAppliesToEveryRoot` · `client.M.updateMany({ where: <matches ≥2 rows>, data: { <childHeld rel>: { connect \| connectOrCreate \| set: <naming ≥1 existing target> } } })` | A membership stored on the target row cannot be applied to more than one source row: the last root updated would take the child from the others. | **Nothing earlier can know it** — the count is only known after the capture. No schema can own an N-dependent rule; it fires inside `compileMembers`, before any member is constructed and therefore before the first write. | The same payload at N = 1 builds its member and runs; at N = 2 it refuses. Empty spellings (`set: []`, `connect: []`) are deliberately NOT refused. | `parity-k-update-many.test.ts:850`; `update-many-relation-series.test.ts` ("K4 — the refusal covers the ROOT's relation keys, and says so"). | SC | **keep** — the textbook survivor: no upstream boundary can express it. |

---

## Cluster 8 — a composed producing supplier + modify (1 site, residue with expiry)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 6 | `RecordUpdateCompiler.ts:4767` · `composeToOneEntries` · `client.M.update({ where, data: { <toOne>: { create \| connectOrCreate: …, update: … } } })` | The shape is coherent and the lattice admits it, but the engine has no channel carrying a row's identity from an INSERT into the selected-record compiler that must then modify it (planning precedes every write). | This dispatch — the public to-one lattice deliberately ADMITS the shape (§O2 row 3: "at most one canonical-program guard"), and the obstacle is a compiler-channel fact, not a schema fact. | `connect` + `update` composes; `create` + `update` and `connectOrCreate` + `update` do not, and only this site tells them apart. | `parity-h-to-one-lattice.test.ts:1268`, `:1274`, `:1714`; `vacate-then-supply-behavior.ts:344`, `:360` via `vacate-then-supply.test.ts` / `-docker.test.ts`. | UFF | **keep** — residue with a STATED EXPIRY: it goes when the produced-identity selector channel for `RecordUpdateCompiler` lands (a final reference into an earlier INSERT's outputs, consumed by `writeWhere`, the captured-key guards and the terminal read). |

---

## Cluster 9 — a compound child edge into a junction (1 site in O1 → 0 after O3)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 17 | `CreateOperation.ts:2168` (declared `:2162`; N3 read the throw at `:2139`) · `edgeParentId` · `client.M.create({ data: { <manyToMany rel>: {…} } })` where `M` has a COMPOUND primary key | A junction side is one column today, so a compound parent row key has no junction representation. | **The schema** — a compound-PK model with an m2m relation is knowable at schema build. Plan §N2 forbids sealing it there ("do not add a validation seal that makes the future topology unreachable"; "do not restate it as a validation rule merely to move the error earlier"), so the site is retained AGAINST O3 clause 1 by explicit plan mandate. This is the one survivor that fails the letter of the one-guard rule and is kept by ruling. | **O1 CLAIMED** it reached the compound-M2M fact one statement EARLIER than `builders/correlation-utils.ts:155 getRequiredSinglePrimaryKeyField` (a `QueryEngineError`), the only other engine owner and invisible to the census grep. **MEASURED FALSE — it never reached the fact at all** (disagreement 2); that function answers every public payload first, at the record-program boundary. | **NONE, and unwritable** | UFF | **CONVERTED to a `QueryEngineError`** naming a structural invariant (disagreement 2). The falsifier could not be written because the claim was false: `OwnWriteAnalyzer` answers this payload first. §7.4 is intact — the fact is still refused in the ENGINE, by `getRequiredSinglePrimaryKeyField`, and has NOT been restated as a validation rule. |

---

## Cluster 10 — depth on an upsert's update arm (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 13 | `RelationUpsertPart.ts:1211` · `assertArmEdgeIsChildHeld` · `<toMany>: { upsert: { update: { <parentHeldToOne>: {…} } } }` one level deeper on the update arm | A parent-held to-one write belongs in the arm's own UPDATE SET, which already carries this relation's reparent. | This seam. The delegate owns the MECHANISM (`interpretParentHeldToOne` folds `connect`/`create`/`connectOrCreate`/`disconnect` into the one UPDATE) but not the whole INVARIANT: this seam ALSO hands the compiler an `incomingMembership` applied with `Object.assign` AFTER the fold, over the same column. | Package B DELETED this guard and MEASURED the result: on the relation the arm arrived through, `connect` resolved with membership unchanged, `create` committed an unreferenced row, `disconnect` was ignored, the two arms resolved to opposite memberships, and `delete` removed the enclosing operation's own root row. Restored. | `nested-arm-dispatch.test.ts:447`, `:482`; `operation-construction-witnesses.test.ts:75` (`ARM_EDGE_IS_PARENT_HELD`). | SC | **keep** — falsified, restored, and the only site in the estate with a recorded accept-and-discard measurement behind it. Package B carried a follow-up: reconcile the fold and the incoming reparent in one owner with a refuse-on-disagree per column (see non-census item N5/B1-residue). |

---

## Cluster 11 — publication on a batch substrate (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 19 | `CreateOperation.ts:2850` (declared `:2839`; N3 read it at `:2788`) · `producedReference` · a demanded database-produced field on a batch-only driver | An atomic batch addresses no statement's rows and its reference storage carries the generated identity alone, so a demanded produced column cannot be published. | This boundary. §4.3 rule 4 offered the adapter's `batchRefs` as a carrier and Package F measured it cannot be one: only `storeLastInsertId` is wired, and widening scratch use widens the `$transaction([…])` merge exclusion. | A DIFFERENT fact from "no row holds this value" (the K1 family), which is why it has its own sentence: a returning/transaction driver answers the same payload. | `fresh-produced-field.test.ts:464`. | PSI | **keep** |

---

## Cluster 12 — decimal portability (1 site)

| # | Site | Invariant | First knowable boundary | Unique reachable failure | Falsifier | Bucket | Disposition |
|---|---|---|---|---|---|---|---|
| 24 | `builders/decimal-portability.ts:56` · `assertExactDecimalOperation` · `orderBy` / aggregate / arithmetic over a `decimal` field on SQLite | SQLite has no exact decimal type, so ordering, aggregating or doing arithmetic on a decimal would round-trip a 64-bit float and could answer wrongly past ~15 significant digits. | This boundary — it is a dialect capability, resolved when the adapter is known. | Reads, writes, and equality filters stay exact on the same dialect; only the ordered/derived operations refuse. | `decimal-refusal-surface.test.ts:528` ("<op> — REFUSED where they are not"), paired with `:522` proving the same spelling ANSWERS where decimals are exact. | PSI | **keep** — the only site outside the write engine that has both a refusal and an accept witness on the same spelling. |

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
| N5 · one invariant, two writers | `RecordUpdateCompiler.ts:4728 composeToOneEntries` + `OwnWriteRelation.ts:366 resolveComposedSupplierSelector` | `composeToOneEntries` decides which payloads compose; `resolveComposedSupplierSelector` re-derives the same rule so the analyzer's decision read matches the compiled locator. They agree by construction and NOTHING enforces it; widening one without the other makes the analyzer report a dependency the plan does not have. | Record in the final report. A one-owner fix (export the composition decision and consume it) is the honest repair; both docblocks already say so. |
| N6 · single owner whose violation is silent data loss | `routing.ts:311 relationBearingRow` | If the predicate ever answers "no" for a row that carries relations, `CreateManyOperation.buildValueGroups` DROPS the relation keys silently. Unreachable today, test-caught only. | Keep; record the class. |
| N7 · the nested twin of N6 | `builders/values-builder.ts:81 buildValueGroups` | Package L measured the same hazard on the nested insert path: `buildValueGroups` iterates `scalarFieldNames` with no unknown-key guard, so validation-widening alone would be silent data loss. ONE ledger row, TWO instances. | Keep; record the class. Any future nested-bulk widening must add the unknown-key answer FIRST. |
| N8 · dead abstraction | `target-projection.ts:200 capturedTargetConstraint` | ZERO production consumers (`rg` finds only `target-projection.core.test.ts`). Package C kept it under the plan mandate with the explicit rule "if Package D lands without consuming it, Package O deletes it"; Package D refused it on SHAPE (the occupied predicate is a where over the CHILD scope pairing FOREIGN fields, not a target-side row-key constraint) and recorded that at its owner. | **DONE — deleted**, with its unit test (its only caller in the repository). The refusal-on-shape reasoning moved to a grave comment at the owner. |
| N9 · junction transition-blindness | `RecordUpdateCompiler.ts:~1187` (junction early-return, before `interpretReferencedKeyTransition`) | A junction edge is classified before the transition is, so a pair that opts out of the implicit `ON UPDATE CASCADE` has no engine owner — and the update ROOT has none either. Both fail closed at the constraint with identical statements and no partial effect, so the CONSTRAINT is the owner and an arm-side refusal would be an asymmetric duplicate. | Keep as measured-not-guarded; pinned three ways in `nested-arm-dispatch.test.ts`'s "B1 RESIDUE" block. |
| N10 · type-forced series guards | `record-series.ts` `parseResult` / `cacheKeyArgs` | `parseResult` is now falsified for BOTH series names (J did `createMany`, K added `updateMany`). `cacheKeyArgs` remains "reached, NOT distinguishable" — the same sentence arrives by the same absence for scalar bulk. | Keep; record `cacheKeyArgs` as the one series guard with no distinguishing falsifier. |
| N11 · compound-M2M twins across layers | `builders/correlation-utils.ts:155` (`QueryEngineError`) + `migrations/serializer.ts:661` (raw `Error`) | Near-identical sentences that are NOT byte-identical ("uses a compound primary key" vs "uses compound primary key"). Neither is a census site; site 17 reaches the same fact earlier. | Record. Unify the wording when `JunctionSide` lands, not before. |
| N12 · unasserted race pin | `UpsertOperation.ts:701 annotateCreateRacePin` | Never asserts that a step matched; any future owner rewriting a create arm's steps by id reintroduces Package M's hazard and only the new pin catches it. | Record for the final report. |
| N13 · the root-level owner that shadows cluster 2 | `relation-key-legality.ts:66 assertUpdateManyRelationsAreCompilable` | Throws `NestedWriteError`, never an `UnsupportedOperationError`. Package L's brief listed it among "4 census sites unchanged"; it has never been one. It answers FIRST at the update root (`UpdateOperation.ts:202`, `UpsertOperation.ts:447`), which is why cluster 2's sites are only reachable one level deeper. | Record; it is why sites 22/23 are nested-only. |
| N14 · ARCH-7 coverage gap | — | No test drives an inverse to-one upsert on a child-held edge under a shared-PK fold into the guarded regime (every current entrance is a scalar key move). Package E raised it, Package K declined it as a witness with no home. | **Still open.** A coverage gap, not a guard; it belongs to whoever next owns `RelationUpsertPart` + `RecordUpdateCompiler` territory. |
| N15 · determinism boundary | `target-projection.ts sortCapturedRowKeys` | Orders `updateMany` series members deterministically PER DEPLOYMENT but not identically ACROSS providers (node-postgres decodes an int8 row key as `"9"`, PGlite as `9`, better-sqlite3 as `9n` — different ranks). Visible in the `select` arm's row order. | Documented, not a refusal. Coordinator ruling still outstanding (Package K unresolved #1). |
| N16 · the fourth blind reader | `RelationJunctionPart.ts:2349` inside site 9 | Reads `relations` alone, the map-only question Package K proved is a measured silent wrong answer for a direct polymorphic key. K routed three readers through `relationWriteKeys`; this is the fourth. | **DONE — died with site 9.** |
| N17 · substrate-refusal asymmetry inside `execute` | `record-series.ts` / the executor's series branch | On a driver with NEITHER substrate, a non-series operation gets `noAtomicSubstrateError` and a series gets `withTransaction`'s wording — two sentences for one substrate fact. Package I measured it and called it an untested corner; nothing has tested it since. | Record. Not a census site and not a guard decision — one fact, two messages, on a corner no test drives. Added at the Package O gate because the architecture review asked for it by name. |
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
2. **A produced-identity selector channel for `RecordUpdateCompiler`** — site 6's
   stated expiry, inherited from Package H unchanged.
3. **`JunctionSide` compound many-to-many topology** — plan §6 N2. It now has one
   fewer engine site to update: the fact's live owner is
   `correlation-utils.ts:155 getRequiredSinglePrimaryKeyField`, reached through
   `getManyToManyJoinInfo`.
4. **Reconcile the arm fold and the incoming reparent in one owner**, per column,
   with refuse-on-disagree — Package B's B1 residue, two instances (N5).
5. **Reclassify the compound many-to-many refusal from a defect to a capability
   refusal.** `builders/correlation-utils.ts:149
   getRequiredSinglePrimaryKeyField` raises a bare `QueryEngineError`, which
   defaults to `V9001 INTERNAL_ERROR`, which `classifyFailure` reports as a
   DEFECT — "the engine broke its own invariant", the code the error docs tell
   callers to file a bug against. What the caller actually hit is plan §7.4's
   named future CAPABILITY, refused honestly and before any I/O. The
   truthfulness gap is PRE-EXISTING and belongs to that owner, not to Package
   O's site-17 conversion, which merely made a second site point at it. NOT DONE
   here: fixing it means giving that owner an expected classification, i.e.
   changing a live refusal's public error class, which owes its own behavioral
   witness — and the same fact has a second owner in
   `src/migrations/serializer.ts:661` (a raw `Error`), so whoever takes it
   should decide both at once. Surfaced in the final report.

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
| 1 | `UpdateManyRecordSeries.assertMembershipAppliesToEveryRoot` | yes — the root count exists only after the capture | yes — no schema can express an N-dependent rule | yes | yes — at N ≥ 2 the last root would silently take the child from the rest | yes — it already fires before member zero is constructed | **survives** |
| 2 | `RecordUpdateCompiler.postTransitionReference` | yes — pairs the located pre-value with the SET operand, and the located row exists only after planning | yes | yes — site 3's branch is never entered for a compound reference | yes — a fresh child would reference a value that does not exist | yes | **survives** |
| 3 | `RecordUpdateCompiler.resolveCreateParent` | yes | yes | yes — see disagreement 1: site 2 is not entered on the arity-1 non-PK branch, and it refuses a STRICTLY NARROWER operand set | yes — `sql-operand-boundary-behavior.ts:186` | yes | **survives** |
| 4 | `RecordUpdateCompiler.recordSharedKeyFold` | yes — Package E narrowed it from refusing a shape to refusing an arm that names no value | yes | yes — site 20 is the create root, a different trust boundary | yes — three arms in `parity-e-shared-pk` | yes | **survives** |
| 5 | `RecordUpdateCompiler.beforeTargetReferencedValue` | yes | yes | yes — site 15 is the create root; §O2 row 2 names both owners | yes — `parity-f-fresh-field.test.ts:858` | yes | **survives** |
| 6 | `RecordUpdateCompiler.composeToOneEntries` | yes — the obstacle is a compiler-channel fact, not a schema fact | yes — the public lattice deliberately ADMITS the shape | yes | yes — `parity-h-to-one-lattice` :1268/:1274/:1714 | yes | **survives**, residue with a stated expiry |
| 7 | `CreateManyRecordSeries` constructor | yes — the product contract, refused before the series shell is chosen | yes | yes | yes — the tracked corpus entry `J_SKIP_WITH_RELATIONS` is this site's whole reason to exist | yes | **survives** |
| 8 | `RelationJunctionPart.resolveCreatePk` | yes — whether a row was SKIPPED is knowable only per row, where the join value resolves | yes | yes | yes — `junction-skip-adoption-behavior.ts` :608/:652/:681 | yes | **survives** |
| 11 | `RelationWritePart.assertOwnedFkAbsentFromUpdateData` | yes — on the divergent schema the parse boundary omits nothing, so the contradiction first exists here | **no**, in general — N1 owns it for every ordinary schema; the divergent spelling is the residue | yes | yes — `nested-update-owned-fk.test.ts:459/:596`, each falsifiable with a reparented row | yes | **survives**, with the retirement path recorded as future unit 1 |
| 12 | `RelationUpsertPart.withoutAgreeingOwnedFk` | yes — the comparison needs the parent's construction-time value | yes | yes | yes — and its ACCEPT half has its own witnesses; this is a decision, not a guard | yes | **survives** |
| 13 | `RelationUpsertPart.assertArmEdgeIsChildHeld` | yes — this seam also hands the compiler an `incomingMembership` applied AFTER the delegate's fold | yes | yes | yes — Package B deleted it and MEASURED accept-and-discard: an unreferenced row committed, a `disconnect` ignored, and `delete` removing the enclosing root | yes | **survives**, the estate's only site with a recorded accept-and-discard measurement |
| 15 | `CreateOperation.requireRecordReferenced` (the merged cluster-1 owner) | yes — `recordReferenced` is total over what an INSERT can publish | yes | yes — it IS the sibling the other three were | yes — six pinned sentences across four files | yes | **survives** |
| 19 | `CreateOperation.producedReference` | yes — the substrate is known here, and §4.3 rule 4's `batchRefs` carrier was measured impossible | yes | yes — a different fact from "no row holds this value" | yes — `fresh-produced-field.test.ts:464`; a transaction driver answers the same payload | yes | **survives** |
| 20 | `CreateOperation.assertSharedPkResolved` | yes — a fresh record has no located row, so the update-root derivation cannot apply | yes | yes — site 4 is the update root | yes — `parity-e-shared-pk.test.ts:749`, `fresh-produced-field.test.ts:538` | yes | **survives** |
| 21 | `UpsertOperation.createArmIdentity` | yes — and only when the create arm is TAKEN | yes | yes | yes — `produced-compound-identity.test.ts:111` | **no** — moving it earlier would analyse an untaken arm, which §4.4 forbids | **survives**, and Q5 is the reason it cannot move |
| 22 | `relation-key-legality.assertSelectedUpdateManyDataIsScalar` (the merged cluster-2 owner) | yes — the enclosing selected record's data, parsed once, before any Part is built | yes | yes — it IS the sibling sites 9, 10 and 23 were | yes — `junction-adopt-create-relations.test.ts:678` and two more | **no** — it is deliberately called by its callers so an untaken upsert arm stays inert | **survives**, and Q5 is why callers own its timing |
| 24 | `builders/decimal-portability.assertExactDecimalOperation` | yes — a dialect capability, resolved when the adapter is known | yes | yes | yes — `decimal-refusal-surface.test.ts:528`, paired with `:522` proving the same spelling ANSWERS where decimals are exact | yes | **survives** |
| 25 | `drivers/shared/transaction-options.refuseTransactionOption` | yes — a driver capability | yes | yes | yes — `transaction-options-behavior.core.test.ts:263` and `:422` assert the `UnsupportedOperationError` by name (located at the Package O gate; the O1 row named no falsifier) | yes | **survives** (outside the query engine) |
| 26 | `client/raw.rawOperationInBatchError` | yes — the batch shell is known at the client boundary | yes | yes | yes — `raw-sql.test.ts:377` rejects with `UnsupportedOperationError` for a raw statement inside `$transaction([…])` (located at the Package O gate; the O1 row named no falsifier) | yes | **survives** (outside the query engine) |

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
| 2 · the `"membership"` position (`RecordUpdateCompiler.ts:2621`) | The SITE has a falsifier; this POSITION does not | **STILL OPEN.** Unchanged by O2/O3: no test asserts `update membership on relation …`. It is a position of a surviving site, not a site. |
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
| 1 · `UpdateManyRecordSeries.ts:348` · `assertMembershipAppliesToEveryRoot` | yes | The root count exists only after the capture, so no schema or parse boundary can express this N-dependent rule; `parity-k-update-many.test.ts:850` pins the exact sentence and its N=1 twin proves the site is narrow rather than shape-refusing. |
| 2 · `RecordUpdateCompiler.ts:1800` · `postTransitionReference` | yes | Boundary is the per-member closure inside `transitionedParentId`, which pairs the located pre-value with the SET operand and therefore cannot run before planning; falsifier `parity-d-transition.test.ts:805`/`:833` verified, with the caveat that its "membership" position (`:2621`) is still unpinned. |
| 3 · `RecordUpdateCompiler.ts:2017` · `resolveCreateParent` | yes | Verified in code that the byte-identical sentence hides two different decisions: this branch refuses on `!isConstructionLiteral` (null, Sql, arithmetic envelope AND Ref) versus site 2's `null\|\|isSql`, returns `afterRoot:false` where the delegation candidate returns true, and is entered only when the referenced field is NOT a primary-key member — disjoint routes, unique falsifier `sql-operand-boundary-behavior.ts:186`. |
| 4 · `RecordUpdateCompiler.ts:3533` · `recordSharedKeyFold` | yes | The update root can only decide "no one final value" against a located row plus the root SET, and `parity-e-shared-pk.test.ts:645` pins a sentence ("does not resolve to one final value") that site 20 cannot emit. |
| 5 · `RecordUpdateCompiler.ts:3612` · `beforeTargetReferencedValue` | yes | Plan §O2 row 2 explicitly licenses one selected-transition owner beside the create-root owner, and `parity-f-fresh-field.test.ts:858` pins the "before-root target" update wording that site 15's create-root owner never produces. |
| 6 · `RecordUpdateCompiler.ts:4767` · `composeToOneEntries` | yes | The public to-one lattice deliberately admits the shape and only this dispatch separates connect+update (composes) from create/connectOrCreate+update; approved as a residue with the stated expiry (the produced-identity selector channel), falsifier `parity-h-to-one-lattice.test.ts:1268` verified. |
| 7 · `CreateManyRecordSeries.ts:126` · the constructor | yes | A deferred product contract (§5.1 says not to guess between suppress-effects and adopt-and-apply), refused typed before the series shell is chosen; falsifier `create-many-relation-series.test.ts:349` plus the tracked corpus entry `J_SKIP_WITH_RELATIONS`. |
| 8 · `RelationJunctionPart.ts:1374` · `resolveCreatePk` | yes | A genuinely different invariant from site 7 — identity, not product meaning — because whether a row was skipped is knowable only per row where the join value resolves; `junction-skip-adoption-behavior.ts:608`/`:652`/`:681` verified. |
| 11 · `RelationWritePart.ts:1250` · `assertOwnedFkAbsentFromUpdateData` | yes | Approved conditionally: question 2 fails for ordinary schemas (N1's parse omission owns them), but the residue route is real in code — `getInverseRelationMap` tests `state.fields` for truthiness at `schema/relation/types.ts:248` where `bindRelation` tests length — pinned by `nested-update-owned-fk.test.ts:459`/`:596`, and applying ONE construction site at all four dispatch positions is uniform application rather than duplication, with the retirement path recorded as a named future unit. |
| 12 · `RelationUpsertPart.ts:754` · `withoutAgreeingOwnedFk` | yes | Not a pure guard but the absorb-or-refuse decision, which needs the parent's construction-time literal and therefore cannot exist earlier; its accept half carries its own witnesses in `adopt-owned-fk-agreement-behavior.ts`. |
| 13 · `RelationUpsertPart.ts:1211` · `assertArmEdgeIsChildHeld` | yes | The strongest survivor in the estate: Package B deleted it and measured accept-and-discard (an unreferenced row committed, a disconnect ignored, delete removing the enclosing root), and it is pinned twice at `nested-arm-dispatch.test.ts:447` and `operation-construction-witnesses.test.ts`. |
| 15 · `CreateOperation.ts:2772` · `requireRecordReferenced` | yes | The merged cluster-1 owner is one predicate, one class and one condition with the position argument selecting only a noun — not the "common unsupported function" §O2 forbids — and all six previously pinned sentences survive byte-identically (`parity-f-fresh-field.test.ts:813`/`:819`/`:830`/`:842` verified). |
| 19 · `CreateOperation.ts:2850` · `producedReference` | yes | The substrate is first known here and §4.3 rule 4's `batchRefs` carrier was measured impossible, so this is a different fact from "no row holds this value"; `fresh-produced-field.test.ts:464` pins it and a transaction driver answers the same payload. |
| 20 · `CreateOperation.ts:3154` · `assertSharedPkResolved` | yes | A genuinely different trust boundary from site 4 — a fresh record has no located row, so the update-root derivation cannot apply — with its own sentence pinned at `parity-e-shared-pk.test.ts:749` and `fresh-produced-field.test.ts:538`. |
| 21 · `UpsertOperation.ts:1147` · `createArmIdentity` | yes | It fires only when the create arm is TAKEN, so moving it earlier would analyse an untaken arm in violation of §4.4; `produced-compound-identity.test.ts:111` pins the surviving half now that the one-absent-increment case is accepted. |
| 22 · `relation-key-legality.ts:173` · `assertSelectedUpdateManyDataIsScalar` | yes | The merged cluster-2 owner reads `relationWriteKeys` (every entry of the parsed relation collection, ordinary AND polymorphic), so it is strictly stronger than the two Part-level copies it replaced; three falsifiers verified and its callers own its timing so an untaken upsert arm stays inert. |
| 24 · `builders/decimal-portability.ts:56` · `assertExactDecimalOperation` | yes | A dialect capability resolvable only once the adapter is known, and the rare survivor with a paired accept witness (`decimal-refusal-surface.test.ts:522` answers the same spelling where `:528` refuses). |
| 25 · `drivers/shared/transaction-options.ts:144` · `refuseTransactionOption` | yes | A driver-capability boundary outside the reviewed engine scope; it constructs-and-returns rather than throwing and is counted honestly in the `src`-wide census. |
| 26 · `client/raw.ts:129` · `rawOperationInBatchError` | yes | The batch shell is first known at the client boundary, outside the engine scope; also construct-and-return and counted honestly. |

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
(`bound-relation.test.ts` "relation-key legality still answers before mismatched FK
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
