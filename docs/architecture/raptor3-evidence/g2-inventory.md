# Raptor 3 — G2 transition inventory

Date: 2026-09-08. Status: **G2 complete**. The [closure report](g2-closure.md)
owns final receipts and acceptance. The [execution record](g2.md) preserves
intermediate failures and repairs; earlier handoff counts below are historical.

## Outcome

This is the G2-03 handoff for C05–C07, not G2 closure or a change to shipped
contracts. [G1 closure](g1-closure.md) remains frozen at 2,799 charged production
lines; the public route still uses the shipped engine. The
[central plan](../raptor3-implementation-plan.md#G2--prove-the-hard-derivations)
owns scope and advancement. No G3 bulk, recursion, general retry-scope expansion,
or G4 full read/lifecycle work is included here.

The initial implementation proposal below had **18 scenario IDs**, each for
real SQLite interactive and restricted atomic-batch execution: **36 legacy
cells, then 36 commands comparisons**. That proposal was split and extended
into independently classified packs. Additional mandatory G2 cells and provider races follow; the
first pack alone cannot complete G2.

### Coverage audit after the216-cell checkpoint

The audit groups missing semantic contrasts, not every Cartesian combination.
The execution record remains authoritative for runtime status.

| Family | Required distinction | Status |
|---|---|---|
| Occupied nested keys | Real non-cascade move versus `set:current` / `increment:0`; actual occupied CASCADE | Four scenarios/eight cells now pass both engines, including three candidate replays each |
| Mixed transition edges | Old membership reads versus final-key child/junction writes; found/missing adoption and row-carrier counterpart | Four scenarios/eight baseline and candidate cells pass, including old-membership capture before the atomic mixed UPDATE |
| Variant removals | Retain/adopt/depart clears both columns; own/wrong-discriminator delete; required carrier; inverse junction owner deletion and all-variant empty set | All14 row-carrier cells pass. Separate all-variant empty-set, inverse-owner-delete and standalone inverse-disconnect cells pass |
| Conditional skip staleness | Captured `targetWhere`/`setWhere` upsert cannot switch to a replacement; nullable UNKNOWN remains a no-match; matching filters update and absent targets create | All eleven baseline/candidate cells pass; conditional skip-to-match retry remains explicitly G3 scope |
| Supplier identity / shared key | Found/missing COC modifies exactly its supplied row; shared-PK rebind with/without non-cascade dependent | All ten supplier and four shared-PK cells pass; envelope/member admission scopes retain their separate exact ledgers |
| Active verb lattice | All21 pairs, six triples, inactive false and empty payload; child-held delete+connect differs from parent-held | All58 baseline/candidate cells pass, including three exact candidate replays |
| Junction ownership races | Held/empty competing adopters and captured-owner replacement, preserving the actual provider's retry/locking law | Three PostgreSQL and two MySQL baseline/candidate cells pass; captured full-pair transfer and MySQL exact-pair handling are exercised natively |
| Supplier failure / untaken work | Unique modifier failure, wrapper-filter miss, untaken arm; exact committed prefix versus transaction rollback | All ten supplier cells and18 OwnWrite cells pass. Interactive disconnect/connect/modify is repaired and green |
| Captured junction identity | Own-key rebase retains the opposite owner; a different owner still requires transfer; found COC retains its selected row | Key reconnect/transfer and found/missing COC cells pass with complete raw-state and retained-error oracles |
| Shared membership analysis | Direct/inverse views name one physical membership; logical earlier writes differ from a valid later connection; distinct compound relations may share a column | All eight baseline/candidate cells pass. Shared-column success required replacing partial field intersection with existing resolved edge/member identity |

The adversarial implementation review also requires collection `set` before
`create`, pure child-held supplier lookups versus decision reads, and selected
collection-update footprints even when the selector field itself is unchanged.
Those are existing C07 contracts to express with actual constructed commands;
they do not authorize another input walker or copied legacy OwnWrite ledger.

The integrator first authorized the six C05 cases alone. Their independent
legacy baseline passed 12/12 cells (receipt `tZq9F5`); the unchanged candidate
passed 6/12 (`kiMOnc`), with arithmetic, final-NULL and occupied-setNull failing
on both profiles. A seventh fixed case, `g2-key-arithmetic-rollback`, now extends
that bounded pack to 14 cells per engine: keep the same root10→15 input, seed
the requested child key tk1 under decoy10000, require the actual stored root15
cut, then `UniqueConstraintError` / `V3001` and complete initial raw state after
rollback. This rejects an early committed root flush. This paragraph records the
initial handoff; the integrator subsequently reported the full local32-case G2
legacy baseline green, including the seventh key case. The original six inputs
and expected outcomes are unchanged.

The next authorized ordinary to-one pack is saved in `transitions/singular.ts`:
`g2-child-disconnect-connect`, `g2-parent-delete-create`,
`g2-parent-disconnect-connect`, `g2-parent-connect-modify`,
`g2-child-create-modify`, `g2-child-occupied-supply-modify`,
`g2-parent-delete-connect-refused`, `g2-parent-create-modify-refused`.
It has16 cells per engine, included in that32-case legacy baseline. Child-held storage uses a real
nullable UNIQUE FK; parent-held replacement has a trigger rejecting a transient
NULL. Producing supply/modify additionally requires the inserted rank to be2,
then the final rank to be5, so merging the modifier into the insert cannot pass
only through its final state. Existing schemas/default phases are not reused to
manufacture expected answers. Variant/junction transitions are not in this pack.

Two restricted-batch-only capture witnesses are now saved in
`transitions/staleness.ts`, export `capturedKeyScenarios` (two cells per engine).
Both publicly update selected counter10 by increment5 with a nested tk1 create.
After observing the actual typed capture row outside any transaction, fixture SQL
moves A10→77. `g2-key-captured-missing-decoy` leaves old10 empty and seeds an
unrelated row15; `g2-key-captured-replaced` instead inserts B10 with a different
tag and has no row15. Both must fail NotFound before ORM effects, preserving A77,
B or row15, and every untouched counter/tick. The recorded cut plus explicit
external mutation in publicInput and full raw final state describe the fixture's
committed effect. This is a controlled between-batch mutation, not simultaneous
live-server transactions. The integrator reports both legacy cells green and the
candidate initially red for decoy attachment and replacement rewriting; final
candidate qualification belongs to the source-bound integration report.

The next authorized six-case pack is saved in `transitions/junctions.ts`, export
`junctionTransitionScenarios`: `g2-junction-singular-transfer`,
`g2-junction-supply-modify`, `g2-junction-set-owned-refill`,
`g2-variant-junction-set-all`, `g2-junction-disconnect-shared`,
`g2-junction-delete-shared`. It has12 cells per engine, not yet executed. One
four-model family has a genuinely singular compound book inverse, plural clips,
inverse-less notes, compound owners, exact target-side UNIQUE and cascading
member FKs. Seeded left/right shared note11 distinguishes disconnect (only left
link disappears) from delete (note11 and both links disappear). Crossed owner,
region and ISBN rows and their memberships must stay intact. Commands tests
save lossless baseline/candidate records in `g2-junction-corpus.json` when the
established evidence directory is supplied, and replay each candidate three
times through the existing API. Root owns registration and execution. Required
reference retain/depart and empty-set cells remain separate mandatory work.

### Evidence and provider vocabulary

- **B-I / B-B:** current connection-owned SQLite interactive / restricted atomic
  batch profiles. Every proposed public input must pass the independent legacy
  oracle first. Existing PostgreSQL tests do not establish SQLite execution.
- **C-P / C-PB:** real PGlite interactive / forced atomic-batch behavior, using the
  existing isolated schema-family owner. These are real PostgreSQL statements,
  not concurrent PostgreSQL-server transactions or hosted-provider evidence.
- **C-PG / C-MY:** real PostgreSQL / MySQL servers. Required storage and concurrent
  transaction claims must execute here. Availability is not checked in this task.
- **V:** public validation refusal, before provider statements.
- **L:** admitted scalar/relation shape, semantic/dependency refusal before
  effects; planning reads may be legal. Do not assert zero statements for L.
- **D:** provider constraint refusal with the specified rollback. A database
  refusal is neither V nor an excuse to manufacture a successful result.

Existing `compiled-key-transition.test.ts` and
`vacate-then-supply-substrates.test.ts` register C-P/C-PB; their `*-docker.test.ts`
siblings register C-PG/C-MY. The Docker entries currently conditionally skip and
use destructive table setup: reuse the public cases and provider fixtures, **not
those skip/setup conventions**. G2's required provider lane cannot silently skip,
and new fixtures must use isolated authorized storage. No setup is executed here.

### Source owners

Paths below are relative to the repository root. Line references identify public
inputs and state assertions, not SQL snapshots to copy into the new oracle.

| Ref | Existing contract owner |
|---|---|
| K | [compiled-key-transition-behavior.ts](../../../tests/contracts/engine/write/compiled-key-transition-behavior.ts), 138–352 |
| A | [post-transition-adopt-behavior.ts](../../../tests/contracts/engine/write/post-transition-adopt-behavior.ts), 240–396 |
| J | [pk-transition-junction-mixed-edge.test.ts](../../../tests/contracts/engine/write/pk-transition-junction-mixed-edge.test.ts), 178–409, 453–552 |
| O | [relation-key-update-legality-occupied-to-one.test.ts](../../../tests/contracts/engine/query/relation-key-update-legality-occupied-to-one.test.ts), 42–195; [to-many sibling](../../../tests/contracts/engine/query/relation-key-update-legality-occupied-to-many.test.ts), 31–181 |
| S | [staleness-injection-upsert-capture.test.ts](../../../tests/contracts/engine/write/staleness-injection-upsert-capture.test.ts), public `targetWhere` cases 95–216; later cases include private routed-operation entry |
| H | [vacate-then-supply-behavior.ts](../../../tests/contracts/engine/write/vacate-then-supply-behavior.ts), 76–414; [pair lattice](../../../tests/contracts/engine/write/vacate-then-supply-pair-lattice.test.ts), 55–203 |
| P | [parent-held compositions](../../../tests/contracts/engine/write/vacate-then-supply-parent-held-composed.test.ts), 29–146; [parent-held refusals](../../../tests/contracts/engine/write/vacate-then-supply-parent-held-refused.test.ts), 23–73 |
| VJ | [polymorphic-collection-write-behavior.ts](../../../tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior.ts), schema 37–87, transfer 252–280/615–635, set 338–406, disconnect 408–425, delete 570–586/637–675, supply/modify 677–707 |
| VR | [polymorphic-write-family.test.ts](../../../tests/contracts/engine/write/polymorphic-write-family.test.ts), inverse disconnect 2120–2163, required membership 2165–2208, targeted delete 2336–2374, set 2376–2460, own effects 3171–3200 |
| W | [own-write-linearization-behavior.ts](../../../tests/contracts/engine/write/own-write-linearization-behavior.ts), 196–445, 537–640, 741–818 |
| SP | [shared-pk-supply-modify.test.ts](../../../tests/contracts/engine/write/shared-pk-supply-modify.test.ts), 96–192 |
| R | [nested-write-concurrency-behavior.ts](../../../tests/contracts/drivers/behaviors/nested-write-concurrency-behavior.ts), unique recovery 143–279, singular ownership 467–665 |
| RC | [race-retry-classification.core.test.ts](../../../tests/contracts/engine/write/race-retry-classification.core.test.ts), 26–90; this is classification evidence, not a public provider oracle |
| DOC | [nested-writes.mdx](../../content/docs/client/nested-writes.mdx), connection management and to-one composition; [clean-sheet language](../raptor3-clean-sheet-language.md), intended versus successful values and opaque expressions |

### First pack: C05 key/value distinctions — six cells

Use separate small schemas, not K's eight-model aggregate. Full raw snapshots
include source/target rows, complete reference tuples, unrelated occupied parents
and independently advanced sequences when a key is generated. Select explicit
public fields so the returned final identity is also checked.

| Proposed ID | Public input and independent world/result | Classification/source |
|---|---|---|
| `g2-key-alt-locator` | org(o1, slug s1), no own seats; unrelated org/seat remain. `org.update({where:{slug:'s1'},data:{id:'o2',seats:{create:{id:'st1',name:'n'}}}})`. Only o1 moves; st1.orgId=o2. | Admitted; K138. B-I/B-B first; C-P/C-PB/C-PG/C-MY storage counterparts. |
| `g2-key-compound-final` | zone(eu,west)→(eu,east), `spots.create(sp1)`. Preserve eu, bind east; crossed rows (eu,decoy) and (us,west), and their children, unchanged. | Admitted; K163. Same profiles. |
| `g2-key-arithmetic-final` | counter id10/tag t, decoy10000. `where:{tag:'t'}, data:{id:{increment:5},ticks:{create:{id:'tk1'}}}`. Stored source15 and tk1.counterId15, never10/10000. | Admitted portable arithmetic; K205. C-MY is mandatory actual arithmetic/FK evidence. |
| `g2-key-null-final-refused` | bay b1 has reference(eu,west). `slot:null,pads:{create:{id:'p1'}}`. No source/child change. | L; K230: `Cannot update relation key field 'slot' to null while mutating relation 'pads'. A null reference names no row for that relation to point at.` |
| `g2-key-setnull-occupied-refused` | Same input as unpinned-create, but st0 already references o1 under `onUpdate('setNull')`. No root move, nulling or st1 creation. | L; K278: `Cannot update relation 'seats' with onUpdate('setNull') while the current relation is occupied.` |
| `g2-key-null-old-empty` | bay b1(eu,NULL); pad p0(eu,NULL) names no row. `slot:'west',pads.create(p1)`. p0 stays NULL; p1 gets(eu,west). | Admitted MATCH SIMPLE; K316. Must distinguish old-null from forbidden new-null on both B profiles. |

K's header says its decoys take the pre-transition key. Its actual static seeds
are `o-old`, `(eu,decoy)` and `10000`; none takes the vacated key. These tests
prove final-key placement, **not capture→move→key-reuse**. That separate required
cell remains below; do not repeat the stronger header claim in new evidence.

### First pack: C06 membership transitions — six cells

| Proposed ID | Public input and independent world/result | Classification/source |
|---|---|---|
| `g2-child-disconnect-connect` | station s1 has badge b1, nullable UNIQUE badge.stationId; b-alt is free, unrelated station/badge are occupied. `badge:{disconnect:true,connect:{id:'b-alt'}}`. b1 survives with NULL; b-alt→s1. | Admitted; H76. Real UNIQUE proves vacate-before-supply. |
| `g2-parent-delete-create` | station s1.depotId=d1, unrelated d-alt. `depot:{delete:true,create:{id:'d-new',note:'fresh'}}`. d1 removed, d-new exists, FK=d-new. | Admitted; P29. Fixture-owned trigger must reject any transient NULL on the old non-NULL FK; final-state-only is insufficient. |
| `g2-parent-disconnect-connect` | Same parent-held world. `depot:{disconnect:true,connect:{id:'d-alt'}}`. d1 survives; final FK=d-alt, no transient NULL. | Admitted; P45. Reuse the no-NULL causal invariant, not an exact UPDATE count. |
| `g2-junction-singular-transfer` | Variant book has singular `shelf:toOne`, so complete compound target tuple is UNIQUE in member table. Book(eu,111) starts at shelf(t1,left). Right's `items.connect(book eu/111)` leaves exactly right/eu/111; book and tuple decoys survive. | Admitted; VJ252. **Not** the G1 plural-inverse book schema; its topology lacks this uniqueness. |
| `g2-junction-set-owned-refill` | Same singular book already owned by left. Left `items.set([book eu/111])`. Final membership still present exactly once. | Admitted; VJ373. Pre-clear ownership is not a post-clear duplicate proof. Preserve unrelated owner/target tuple decoys. |
| `g2-variant-junction-set-all` | Left owns book, clip, note; right shares plural note and has unrelated members. Left `items.set([note n1])`. Unmentioned book/clip arms empty for left, own note retained, right unaffected, no target deleted. | Admitted; VJ338. All configured variants are cleared once semantically, not only those named by the refill. |

H has real C-P/C-PB and C-PG/C-MY registrations. VJ is an existing public
provider-behavior owner; the new B-I/B-B and selected C provider registrations
must be executed, not inferred from one another. A producing supplier followed
by modify can require ordered committed segments on B-B; do not assume a global
rollback across those segments.

### First pack: C07 supply and refusal ownership — six cells

| Proposed ID | Public input and independent world/result | Classification/source |
|---|---|---|
| `g2-parent-connect-modify` | Parent FK initially d1; `depot:{connect:{id:'d-alt'},update:{note:'moved'}}`. Modify d-alt only; d1 unchanged, final FK=d-alt. | Admitted; P127. |
| `g2-child-create-modify` | Occupied child-held slot; `badge:{disconnect:true,create:{id:'b-new',tag:'fresh',rank:2},update:{rank:{increment:3}}}`. b1 orphaned; new badge rank5 at s1; decoy rank untouched. | Admitted; H pair/triple lattice and DOC rank example. rank is the minimal scalar extension to H's schema, independently defined, not a new feature family. |
| `g2-child-occupied-supply-modify` | Keep incumbent; omit disconnect and supply free b-alt beside update. Incoming adoption hits UNIQUE stationId. No old/new modifications survive the failed atomic operation. | D, not automatic transfer; H281. Distinguishes reference storage from singular junction transfer. |
| `g2-parent-delete-connect-refused` | s1→d1, alternate d-alt exists; `depot:{delete:true,connect:{id:'d-alt'}}`. Full state unchanged. | L; P23: connect depends on earlier delete target write; keep exact relation/verb attribution and split-query sentence. |
| `g2-parent-create-modify-refused` | `depot:{create:{id:'d-new',note:'fresh'},update:{note:'moved'}}`. No statements/effects. | V; P47: `Unsupported to-one operation combination: create, update`. Parent-held COC+modify is likewise unadmitted. |
| `g2-child-delete-connect-modify-refused` | Occupied badge slot; `delete:true,connect:b-alt,update:{tag:'moved'}`. No effects. | L; H triples: update depends on earlier delete target write. Do not replace this with the successful disconnect triple. |

Spell at least the producing-modify and vacate/connect payloads supplier-first
or modify-first in a separate generated input choice: caller key order must not
change admission, state, defaults or the selected target. The frozen input is
still one public call, not a manually ordered program.

## Remaining mandatory G2 pack, not a Cartesian product

Each row below names an independent distinction not discharged by the first 18
or by G1. IDs are concrete proposals; expand a stated pair into two registered
cells, never one conditional skip. No row is waived because its fixture is not
implemented yet.

| Proposed IDs / family | Minimum independent property and reusable owner |
|---|---|
| `g2-key-cascade-members`, `g2-key-restrict-occupied` | Existing children follow a cascade; non-cascading occupied reference refuses before effects even beside nested delete/update. O and `nested-update-pk-transition-cascade-{ordering,occupied,located}.test.ts` own the causal contrast. Include one nested selected source, not only root updates. |
| `g2-key-junction-disconnect`, `g2-key-junction-set` | Root key changes while an ordinary junction and non-cascade edge coexist: reads use old membership, removals reach the row carried by cascade, writes use final identity. J226/267/346; no global deletion of decoy memberships. |
| `g2-key-adopt-coc-mixed`, `g2-key-required-set` | Transition1→5 with found target20 and missing30 COC: both finish FK5. Required-FK set from empty source adopts box100 from9 without clearing any nondeparting row. A299/362. No bulk spelling needed. |
| `g2-variant-key-transition` | Inverse row-carrier parent key moves; old variant member retains vacated key (no physical polymorphic FK cascade), adopted/new members take final key; same-ID other discriminator is untouched. Public variant transition family and J's ordinary contrast own the semantics; use actual stored tags, not public variant names as SQL values. |
| `g2-capture-key-reused`, `g2-capture-deleted`, `g2-capture-null-skip` | S95/143/182: public upsert captures A by email; before write batch, A moves and B takes old email (or A is deleted). Return non-raceable NotFound, never update/adopt B; keep external mutations and original A values. NULL targetWhere stays a successful stable no-match. B-B/C-PB can admit the committed barrier; B-I cannot inject unrelated SQL inside its live transaction. |
| `g2-variant-junction-inverse-transfer`, `g2-variant-junction-inverse-disconnect`, `g2-variant-junction-inverse-delete` | VJ615/637: inverse book.shelf moves membership to right; disconnect deletes only junction; delete removes the selected shelf and cascades its other memberships but preserves every target row. Different direction and deletion subject from direct collection delete. |
| `g2-variant-junction-empty-set`, `g2-junction-disconnect-shared`, `g2-junction-delete-shared` | VJ393/408/570: empty set clears every configured arm; disconnect removes only this owner's shared membership; targeted delete removes the target row and its FK-cascaded memberships. Preserve unrelated targets/owners. Ordinary junction witnesses reuse the association schema with raw cascading DDL. |
| `g2-variant-reference-set`, `g2-variant-reference-delete-foreign`, `g2-variant-reference-disconnect` | VR2120/2336/2376: optional carrier set retains/adopts/departs, clears BOTH stored columns, ignores same-ID wrong-type rows. Foreign targeted delete fails exact membership; own targeted delete succeeds in its paired cell. Direct optional carrier disconnect is a distinct storage write from inverse clearing. |
| `g2-required-set-retain`, `g2-required-set-depart`, `g2-required-disconnect-refused` | Nonnullable ordinary child FK and required inverse variant: retaining set succeeds; departing set cannot orphan rows; disconnect unavailable or refused at its actual public owner. VR2165 currently calls a private operation helper and only asserts rejection, so measure exact public validation/error before freezing that envelope. A required direct shared-PK to-one has no disconnect at all (SP159). |
| `g2-child-coc-modify-found`, `g2-child-coc-modify-missing`, `g2-junction-supply-modify` | H and VJ677: modify uses adopted row or newly produced row AFTER supply, including rank arithmetic. A produced record's declared rank is not proof its write succeeded. Same whole-operation callback and ordered-batch progress distinctions as existing G1, not a new interpreter. |
| `g2-shared-key-supply-modify`, `g2-shared-key-dependent-refused` | SP96/124: card.accountId is PK+FK, supplier moves a1→a2 and modifies a2; adding a noncascade dependent note blocks the move exactly as supplier alone. Neither modifier nor note can leak on failure. |
| `g2-own-coc-set-distinct`, `g2-own-coc-set-same` | W374/414: COC creates905, later set[801] detaches905; set[905] instead is an earlier-target-write dependency refusal, full state unchanged. Public baseline must confirm route admission because W uses a private operation runner. Existing G1 nested series refusal is not this root contrast. |
| `g2-own-delete-create`, `g2-own-delete-update-refused`, `g2-own-filter-write-refused` | W595/196 and H pair-lattice172: delete then create same identity leaves fresh row; delete then update same target refuses; earlier write to wrapper-filter field invalidates deeper modify proof even with another unique locator. Pin effects and error precedence, not legacy ledger structure. |
| `g2-to-one-lattice` | Keep all existing21 child-held pairs and six triples classified by V/L/D/success (H lattice), without multiplying by every storage/provider. First pack covers distinct owners; remaining admitted five replacement pairs, inactive false and empty payload remain explicit regressions. Required/unavailable verbs are validation cells, not arbitrary absent combinations. |

### Resolved public boundary: opaque assignment expressions

The plan and DOC require that identical expression text not prove equal stored
values. The concrete `Sql` contribution in
`tests/contracts/engine/write/final-root-assignment.core.test.ts:57` enters a
private assignment owner directly. It is not evidence of a public Sql assignment
API, and does not authorize adding one during G2.

Current public key-update admission is decisive: `validation/model/core/update.ts`
composes each scalar's update schema; `validation/scalars/int.ts:132–144` accepts
the base integer shorthand, `set` of that base, or integer arithmetic operands.
`primitives/shorthand.ts:18–19` uses the validating coercion in
`primitives/transform.ts:57–62`; `primitives/number.ts` requires an actual integer.
String/bigint update schemas follow the same scalar-versus-filter separation.
Thus `data:{id:sqlFragment}`, `data:{id:{set:sqlFragment}}` and an SQL arithmetic
operand are public validation refusals, not missing successful C05 recipes.
Their exact validation envelope can be pinned through the real public client;
no malformed internal program or new downstream guard is needed.

`schema/scalars/int/scalar.ts:84` constrains a custom schema's output to number;
`validation/primitives/helpers.ts:213–218` runs base admission before it. A custom
schema lying about that output is outside the trusted scalar contract. Defaults
are evaluated and then validated (`helpers.ts:127–139`): a nondeterministic
default returning a number becomes a concrete admitted value, not a database SQL
expression. Generated database identities remain successful-output C04 evidence.

Sql/FieldRef/callback operands **are** admitted by `primitives/operand.ts` for
filter comparisons, including nested update wrapper filters. That separate C07
dependency surface must not be relabeled SQL key derivation. Existing local-FK
arithmetic refusal versus literal rebind plus independent arithmetic remains a
valid narrower public pair, not general opaque-expression equality proof.

### Provider races and wrong recovery: required G2, not G3 postponement

1. `g2-race-singular-held` / `g2-race-singular-empty`: R467/507. Two real server
   connections adopt a singular target. Final zero/one membership matches actual
   successes; no failed loser owns the surviving row and no loser deletes a winner.
2. `g2-race-singular-captured-owner` / `g2-race-singular-captured-empty`: R587/627.
   Both actors reach the SAME declared capture barrier before writes. Exactly one
   success and its one membership. These stronger outcomes apply only when those
   observations were actually forced, not to arbitrary concurrent transactions.
3. `g2-race-singular-replaced`: R541. A captures s0; B commits transfer to s1;
   A resumes. A fails its stale requirement and leaves s1's membership intact;
   no retry reinterprets old ownership as current intent.
4. `g2-race-exact-unique` / `g2-race-wrong-unique`: R219, plus RC attribution rule.
   After a missing-target probe, a conflicting insert on the exact selected
   unique may retry/adopt. A failure on an unrelated unique must remain loud and
   must not retry or publish an unrelated row. The latter currently has a private
   classifier witness, not enough live public evidence: create two independent
   unique fields, select one and conflict only the other, raw-pin all rows.
   Use actual provider constraint evidence; do not label every unique failure a
   target race. PostgreSQL and MySQL must each execute the applicable distinction.

The existing server-race owner provides real independent connections and arrival
latches. PGlite and SQLite cannot replace its simultaneous live transactions.
Provider failures with no exact attribution are not normalized into a successful
retry. G1's private no-targeted-conflict capability boundary on MySQL must be
resolved for the admitted G2 provider cases, not accepted as blanket refusal.

### Harness seams and falsifiers

Reuse the one RunObservation/recorder/replay vocabulary, schema-family provider
setup and raw inspection. Public inputs/default tapes remain fixture-owned.
Baseline is an additional oracle, never the producer of expected rows.

- Raw-state and fixture-trigger invariants name no-transient-NULL,
  vacate-before-supply, exact final membership and supply-before-modify. A trigger
  rejects forbidden intermediate state; it does not require a private step count.
- Staleness requires a hook outside a committed transaction, after semantic
  capture and before later use. Recognize captured complete keys/actual physical
  types, not SQL regexes or nth statements. Root owns any missing seam.
- A removed fault cut needs concrete atomic trace evidence plus surrounding
  fault assertions under §5.4; missing capture is not silently accepted.
- Add specimen falsifiers that publish to old/reused key, collapse a compound
  occupancy predicate, treat pre-clear owned as a duplicate after clear, modify
  outgoing instead of supplied row, leak a rolled-back vacate/refill, or recover
  from the wrong constraint. Save original failures and three exact replays.
- For producing supply/modify on B-B, fault after acknowledged supply must retain
  exactly its committed prefix; no replay duplicates the supplier. Add the
  acknowledged-prefix/commit-ack and stale-publication falsifiers before claiming
  this composed guarantee. This uses current progress ownership, not G3 bulk.
- Extend the same A/B generators/shrinker with these legal transition choices,
  faults and actors. G2 exit still requires 5,000 **new** seeds/profile, 20% two
  actors, 20% legal faults and explicit multifault/healthy suffixes. Initial fixed
  witnesses and C provider races do not substitute for that campaign.

## Validation

Integrator checkpoint: the first 47 local/profile cells have executed against
the public legacy route. Their exact candidate classification and receipts live
in [g2.md](g2.md), which supersedes historical handoff counts in this inventory.
An additional series-filter observation control, four required-membership
recipes and five public OwnWrite recipes are now written but await baseline
classification. No inventory row is discharged merely by registering a fixture.

Source inventory against current public docs, existing test payloads and G1
closure, followed by the expressly assigned fixture packs above. This witness
owner ran no test, build, typecheck, benchmark, credential lookup or database
operation. Baseline counts above are reported by the integrator, who owns the
serial execution receipts and closed registry/manifest. Junction fixtures remain
unrun at this handoff.

## Risks

Public-route gaps in private-operation source tests and the exact required-membership
error envelopes remain unverified. Required live server results belong to the
integrator; service availability alone is not conformance evidence. These gaps block their respective G2 claims; none is
a reason to weaken an oracle or reclassify an admitted capability as unsupported.
Provider assertion/rollback wording must be frozen from the independently
successful legacy fixture before commands expansion. G1 completion is unchanged.
