# Residual Write-Limitation Lift Plan

**Date:** 2026-08-13

**Status:** Implemented; retained as the residual-lift implementation record

**Starting branch:** `by-relation-bearing-bulk`

**Starting commit:** `2b1cb0d0`

**Checkpoint implementation overlay (2026-08-14):** The live refusal census was
**8 write-engine / 10 query-engine / 12 whole `src`**. The batch-only
RecordSeries lift supersedes Package F's savepoint-only provider boundary and
Package H's ordered-capability eligibility premise. Any no-transaction driver
with native atomic batch can run a safe progressive series after normalized
awaited success. `supportsOrderedCommittedSegments` only strengthens
callback-before-decode attribution. A skippable root is isolated; a write or
nested series before it remains a typed pre-effect refusal. Explicit
`$transaction([...])` remains indivisible. Historical package notes below are
kept as implementation history.

**Current overlay (2026-08-17):** The later five-capability lift retires only
the client raw-in-array constructor, so the live census is **8 write-engine / 10
query-engine / 11 whole `src`**. It also narrows four retained write boundaries:
selected-row continuity admits stable same-incoming update/found-upsert;
splittable create-many and junction inserts chunk to the verified driver bind
budget; scalar RETURNING and snapshot-safe PostgreSQL-family mutation DAGs fold
inside an indivisible array member; and a complete explicit addressable alternate
unique locates plural generated row-key members for a non-returning focused read.
The dated package and provider records below remain historical evidence.

**Measured baseline:**
[residual-write-limitation-lift-baseline.md](residual-write-limitation-lift-baseline.md)

**Depends on:** the retained output of
[relation-bearing-bulk-round-trip-plan.md](relation-bearing-bulk-round-trip-plan.md)
and the earlier query-engine limitation lift. In particular, this plan assumes
the live `ModelKeyCatalog`, `TargetProjection`, `FinalReferenceSource`,
`CreateOperation`, `RecordUpdateCompiler`, `RecordSeriesOperation`, and
proof-carrying progressive-series boundaries. It does not revive any rejected
`CompiledSelection`, `OperationResultContract`, native-libSQL-batch, or
whole-series-CTE proposal.

## 1. Outcome

Lift the remaining write restrictions that have coherent user semantics and
can be expressed by extending an existing semantic owner.

The pass has four primary product outcomes:

1. A probe-first scalar upsert can create a row whose complete compound row key
   contains more than one database-assigned member, when the provider can
   publish every member exactly. This is the first delivered unit, not deferred
   future work.
2. Parent-held relation writes inside selected upsert arms and shared-primary-
   key writes use one per-column final-assignment reconciliation instead of
   broad topology refusals.
3. `create + update` and `connectOrCreate + update` on a singular child-held
   relation execute as supply followed by an ordinary selected-record update.
4. A junction `createMany` row whose skipped target cannot be named suppresses
   that complete target-and-join member on interactive and native atomic-batch
   drivers instead of refusing the whole operation.

The implementation also narrows progressive-series refusals when a complete
parent row key can already be published, and prototypes Neon HTTP ordered
committed segments behind provider proof.

This is not a campaign to delete throws. The starting write-engine census was
13 construction sites representing approximately ten invariants. Package A
retired the upsert-local site, leaving 12. The expected
end state is **five to seven sites**, but the numerical result is only a review
signal. Every remaining site must identify one invalid state that no earlier
trusted owner excludes.

## 2. Method and architectural conclusion

### 2.1 Method

For each live `UnsupportedOperationError` construction site:

1. Drive the shortest public or trusted-internal payload that reaches it.
2. Name the exact value or decision the engine lacks at that point.
3. Ask whether that value already exists earlier as a literal, planning field,
   target-projection field, operation output, or final reference.
4. If not, ask which current compiler is responsible for producing it.
5. Lift the shape only by extending that owner or composing an ordinary record
   operation through `RecordSeriesOperation`.
6. Keep the refusal when the request is contradictory, the record is genuinely
   unnameable, or the provider cannot preserve the required failure/commit
   contract.

The audit deliberately distinguishes a missing value from missing machinery.
Several refusals say “identity,” but the actual missing fact is often one field
value produced by an INSERT or UPDATE. Calling all of these facts identity
would merge row addressing, relation references, and physical membership into
one false abstraction.

### 2.2 Architectural conclusion

No new general identity system is required. The live engine already has the
needed concepts:

~~~text
ModelKeyCatalog.rowKey.fields
  owns the ordered complete row key

TargetProjection
  owns fields captured from a selected record

FinalReferenceSource
  owns the provenance of one value used by later mutation work

OperationValueReference + StatementOutputSource
  carry one produced value between statements

CreateOperation
  owns publication from one fresh record

RecordUpdateCompiler
  owns final values and assignments for one selected record

RecordSeriesOperation / RecordSeriesStep
  own a data-dependent continuation after an earlier record effect
~~~

The one domain phrase added by this plan is **record field publication**: making
one exact field value produced by an INSERT or UPDATE available to later
mutation work. It is vocabulary, not a new public API or universal carrier.

The main compression is therefore:

- generalize fresh row-key planning from one generated member to an ordered
  set of database-assigned members;
- make one selected-record owner reconcile all final assignments to a column;
- use the existing record series when a selected continuation genuinely needs
  to plan after a supplier writes;
- make provider capability depend on proof, never a driver-name branch.

## 3. Starting refusal census and disposition

Coordinates are pinned at `2b1cb0d0`; function names are the durable locator.

| # | Current owner | Current invariant | Disposition |
|---:|---|---|---|
| 1 | `UpsertOperation.createArmIdentity` | Scalar upsert cannot name a create arm with an unpublished complete row key | Lift in Package A; delete this local refusal |
| 2 | `RelationUpsertPart.withoutAgreeingOwnedFk` | Nested data may contradict the relation-owned FK | Narrow and consolidate in Package C |
| 3 | `RelationUpsertPart.assertArmEdgeIsChildHeld` | A parent-held arm fold can be overwritten by incoming membership | Lift the broad topology refusal in Package C |
| 4 | `CreateOperation.requireRecordReferenced` | A fresh record cannot publish a demanded field | Keep one focused residual for genuinely unpublishable values |
| 5 | `CreateOperation.producedReference` batch branch | Batch execution cannot publish a database-produced field other than the one singular generated-identity channel | Lift proven field classes in Package B; retain only unpublishable residue |
| 6 | `CreateOperation.assertSharedPkResolved` | A shared-PK create target has no resolved final key | Lift in Package D |
| 7 | `RelationJunctionPart.resolveCreatePk` | A skipped generated-key target cannot be named for the join | Lift in Package F on interactive transactions |
| 8 | `RecordUpdateCompiler.postTransitionReference` | A rewritten reference field is null or cannot be represented | Consolidate truthful contradiction in Package G |
| 9 | `RecordUpdateCompiler.nestedTargetWriteId` | A nested create cannot consume an unpublishable rewritten reference | Consolidate with site 8 in Package G |
| 10 | `RecordUpdateCompiler.recordSharedKeyFold` | A selected shared-PK relation has no single final value or conflicts with scalar SET | Lift missing-value cases and retain one assignment-conflict owner in Packages C/D |
| 11 | `RecordUpdateCompiler.requireBeforeTargetReferenced` | A before-root fresh target cannot publish a demanded field | Delegate to the fresh publication owner in Package G |
| 12 | `RecordUpdateCompiler.composeToOneEntries` | A supplied fresh target cannot be selected for the following update during the same planning phase | Lift completely in Package E |
| 13 | `OperationExecutor.progressiveSeriesRefusal` | A segment-committed series lacks a required provider or proof fact | Keep as the single provider/progressive refusal factory; narrow its reachable reasons in Packages B/H |

The census must be refreshed before implementation because line numbers and
test comments are historical evidence, not architectural identifiers.

## 4. Fixed public contracts

### 4.1 Compound database-assigned row keys

This currently refused shape becomes supported when the database and execution
substrate can publish every row-key member exactly:

~~~ts
const twin = s
  .model({
    a: s.int().increment(),
    b: s.int().increment(),
    label: s.string(),
  })
  .id(["a", "b"]);

await client.twin.upsert({
  where: { a_b: { a: 10, b: 20 } },
  create: { label: "created" },
  update: { label: "updated" },
});
~~~

On an interactive PostgreSQL path the create arm uses `INSERT ... RETURNING
a, b`, constructs the terminal selector from both returned values, and returns
the created row. It does not infer sequence adjacency or depend on RETURNING
row order.

Providers whose schema rules do not permit this generated-key shape do not
need artificial parity. A provider that permits the schema but cannot publish
all members keeps one provider-specific refusal at the publication owner.

This matrix is a database fact, not an ORM policy. PostgreSQL explicitly allows
[more than one identity column](https://www.postgresql.org/docs/current/sql-createtable.html),
MySQL permits [only one `AUTO_INCREMENT` column](https://dev.mysql.com/doc/refman/8.4/en/create-table.html),
and SQLite permits `AUTOINCREMENT` only on its
[`INTEGER PRIMARY KEY`](https://www.sqlite.org/autoinc.html). The positive
two-generated-member witness therefore belongs to PostgreSQL; the other
providers prove their truthful DDL boundary instead of simulating adjacent
generated values.

### 4.2 Selected upsert relation assignments

A selected upsert update arm may contain an unrelated parent-held relation.
The compiler accepts it when its final column assignments are disjoint or
agree exactly.

For the relation through which the selected arm was located:

- correlated found-arm membership is a selection premise, not an unconditional
  instruction to restore the same membership after the update;
- an explicit reparent or disconnect has the same meaning as in an ordinary
  selected update;
- a global-adopt arm still demands the enclosing membership as a final
  assignment;
- two different final values for one physical FK member remain a contradiction.

### 4.3 Singular supply followed by update

The already-public lattice gains its missing execution:

~~~ts
relation: {
  create: { /* fresh target */ },
  update: { /* ordinary update data, including relations */ },
}
~~~

and:

~~~ts
relation: {
  connectOrCreate: { where, create },
  update: { /* ordinary update data */ },
}
~~~

The semantic order is supplier, then selected update. Relative scalar updates
therefore observe the supplied record. The update is not merged into create
data. Wrong-row replacement, recursive relation writes, defaults, race pins,
and result parsing remain those of `RecordUpdateCompiler`.

### 4.4 Junction skipping

The junction contract distinguishes two cases:

- When one exact unique selector names a skipped target, preserve the existing
  adopt-and-link behavior.
- When a skipped generated-key target cannot be named, suppress that complete
  target-and-join series member on an interactive transaction substrate.

The second case never links an arbitrary pre-existing row. A unique conflict
inside the target subtree, rather than on the annotated target root INSERT,
still fails the complete operation.

Batch-only providers keep a pre-effect refusal until they can attribute the
root conflict separately from every descendant conflict.

## 5. Fixed internal architecture

### 5.1 Fresh row-key plan

Generalize the existing nested-create identity planning owner. Do not add a
generic `Identity`, tuple, generated-value bag, or new reference-source kind.

The semantic result is:

~~~ts
interface FreshRowKeyPlan<Value> {
  readonly fields: readonly string[];
  readonly known: Readonly<Record<string, Value>>;
  readonly databaseAssigned: readonly string[];
}
~~~

The concrete type may use the repository's existing field/source types instead
of this illustrative shape. Required invariants:

- `fields` comes from `ModelKeyCatalog.rowKey.fields` in schema order.
- Every field is classified exactly once as known or database-assigned.
- Known values retain their existing literal/final-reference provenance.
- Database-assigned members are demanded from the existing fresh publication
  owner.
- A complete row selector is constructed only after every member is resolved.
- Existing single-generated-key output names, IDs, SQL, and parameter order
  remain unchanged.

`CreateOperation` remains the fresh-record compiler. `UpsertOperation` must not
grow a second plural publication protocol. Preserve the current scalar
`ON CONFLICT` and probe-first plans for already accepted shapes. When the
specialized scalar create arm cannot name its row through its existing
capture-free or singular-generated fast path, compose the already parsed/source
pair through `FreshRecordPart`; that is the existing internal seam into
`CreateOperation`. Append the upsert terminal by the complete published row key.
Do not parse or materialize the create payload twice.

### 5.2 One final assignment per physical column

`RecordUpdateCompiler` becomes the sole reconciler of final root assignments
for a selected record:

~~~text
scalar SET
  + parent-held relation fold
  + shared-primary-key fold
  + demanded final membership
  -> one final assignment per physical column
~~~

This is a module-local compilation fact, not a new exported capability type.

Rules:

- one contribution: accept;
- multiple contributions with provably equal values: keep one;
- disjoint contributions: accept all;
- different values: raise the one relation-assignment contradiction;
- unknown equality: fail closed at this owner;
- correlated membership used only to locate the arm is not added as a final
  contribution;
- global-adopt membership is a final contribution.

No later `Object.assign` may overwrite a value already folded by the compiler.

### 5.3 Branch-selected field sources

Shared-PK `connect`, `connectOrCreate`, and upsert already produce enough
information in their selected arm:

- connect: captured field from its target probe;
- connectOrCreate found: captured field from its probe;
- connectOrCreate missing: `FreshRecordPart.rootReferenced(field)`;
- correlated upsert found: located/captured field;
- upsert missing: fresh subtree publication.

Record the resolver beside the existing relation member while constructing the
program. Resolve it only after the arm is selected. Feed the result into the
same final-assignment owner. Do not add a branch-aware universal identity
object.

### 5.4 Selected continuation

Supply-then-update uses `RecordSeriesOperation` or `RecordSeriesStep` as the
existing operation-level sequencing owner:

~~~text
vacate when requested
  -> ordinary supplier operation
  -> capture the singular target through exact physical membership
  -> publish its complete TargetProjection
  -> ordinary selected RecordUpdateCompiler
~~~

The membership capture is exact for the relation topology: ordinary child FK,
polymorphic discriminator plus referenced value, or junction membership where
that topology is publicly singular. It removes any requirement for the
supplier arm itself to predict or publish its row key.

No mutation Part may execute its own transaction or call the public client.
No callback executor, nested operation shell, or new runtime step kind is
introduced.

On an interactive transaction, the continuation may add the round trips that
the formerly refused shape requires. On any native atomic-batch provider, it
runs when the existing progressive boundary can re-pin the complete parent and
supplied target before every later write. Ordered commit callbacks strengthen
attribution but are not eligibility. Otherwise the existing progressive
placement refusal remains.

## 6. Work packages

Each package is independently reviewable and has an explicit keep gate. Run
packages sequentially; do not mix a capability lift with a provider prototype.

### Package 0 — Refresh the residual baseline

#### Unit 0.1 — Repository and performance preflight

Record:

- branch, commit, and dirty files;
- physical and token-bearing LOC for `src/query-engine/write-engine`;
- runtime import-cycle count;
- three warm `pnpm test:types` timings;
- current statement/driver-call witnesses for every affected accepted path.

Preserve every pre-existing file. Stop only this unit if the stacked base is not
the expected bulk-lift result; continue with non-overlapping audit work.

#### Unit 0.2 — Executable refusal ledger

Update `operation-construction-inventory.test.ts` so every site records:

- function owner rather than only a line number;
- invariant;
- public/trusted route;
- unique falsifier;
- intended package;
- keep/delete/consolidate disposition.

Add the positive witness before changing each refusal. The witness must fail at
that exact refusal in the starting tree and must assert zero effects.

#### Unit 0.3 — Fast-path parity witnesses

Pin planning/final IDs, SQL, parameters, outputs, guards, expectations, race
pins, statements, and round trips for:

- scalar upsert with a known PK;
- scalar upsert with one generated increment PK;
- existing shared-PK connect/update paths;
- accepted child-held `connect + update`;
- existing nameable junction skip/adopt;
- one eligible PostgreSQL per-record create CTE fold.

No subsequent package may alter these witnesses unless the new shape itself is
the subject of the test.

### Package A — Publish plural fresh row keys, including the first refusal

#### Unit A1 — Generalize row-key planning

In the existing mutation-identity owner:

1. Replace the zero-or-one generated-field assumption with the ordered
   `known + databaseAssigned` classification.
2. Derive order only from `ModelKeyCatalog.rowKey.fields`.
3. Keep alternate addressable-key selection separate from the row key.
4. Preserve the existing one-generated-member representation at its public
   operation boundary where required for exact plan parity.
5. Delete every local arity assertion made impossible by the plan.

In `CreateOperation.RecordPlan` and `RecordIdentity`, replace singular
`generatedField` as the internal source of truth with the ordered database-
assigned field fact. Keep the historical `id` statement output only as the
compatibility fast path when there is exactly one generated field. Additional
generated fields use the existing `producedKey(field)` output naming, and
`createdRowWhere` combines known values with all published row-key members.
When the set is plural, no member is privileged as “the generated field” or
chosen by array position; every member uses its field-keyed produced channel.

Tests:

- all-known compound row key;
- one known plus one database-assigned member;
- two database-assigned members;
- mapped columns and destination casts;
- incomplete non-generated row key remains the existing nested-write error;
- field order is schema order, never object-key or RETURNING-row order.

#### Unit A2 — Publish every demanded INSERT field

Extend the existing `publishedFields`/`rootReferenced(field)` flow:

- RETURNING-capable interactive paths request every demanded field in one root
  RETURNING projection;
- all consumers receive existing final references by field name;
- one terminal selector consumes the complete resolved row key;
- no nth-row output or plural output-source type is added.

The newly plural scalar upsert arm delegates to `FreshRecordPart`; it does not
consume the row-key plan and re-emit its own plural RETURNING statement. This
keeps one publication owner while leaving Upsert's known and singular-generated
inline fast paths byte-identical.

If a post-insert focused read is needed on a non-returning interactive driver,
use one read for all demanded fields and only when a stable selector exists.
Never derive one generated value from another.

#### Unit A3 — Lift probe-first scalar upsert

Keep `UpsertOperation.createArmIdentity` only as the current fast-path
classifier for already accepted capture-free and singular-generated cases. Its
fall-through no longer throws locally: it constructs one `FreshRecordPart`
without incoming membership from the existing `RecordMutationData` pair, asks
that part to publish every row-key member, and appends the upsert terminal. At
the original scalar-create parse boundary, retain `{ parsed: createData,
source: rawCreate }` once; the inline fast paths consume `parsed` and the plural
fallback passes the pair to the fresh compiler. Never reconstruct source from
parsed data.
`CreateOperation` then owns both successful plural publication and the one
genuinely unpublishable fresh-row refusal.

Requirements:

- found arm remains byte-identical;
- untaken create arm does not validate provider publication capability;
- missing plural arm INSERT publishes every row-key member through
  `FreshRecordPart.rootReferenced(field)`;
- the terminal addresses the row by the complete final row key;
- the root INSERT retains the current upsert race pin through the existing
  fresh-part root race-pin input, rather than post-hoc statement guessing, only
  when create data exactly reproduces the probed unique discriminator;
- a root unique violation retries only when both the constraint and its values
  represent the probed missing premise. `racePinMatches` alone compares
  constraint identity, so `UpsertOperation` must withhold the pin when create
  data intentionally writes a different or generated key;
- no client default is parsed or materialized twice.

Primary acceptance witness: the compound two-increment PostgreSQL upsert shown
in §4.1 succeeds and returns the created row. Also cover an update-arm hit to
prove that the impossible create publication is inert when the row is found.

Add a bounded correctness witness for the pre-existing pin defect: the probe is
missing at one primary/unique value, the create arm targets another value, and
the INSERT loses a genuine same-constraint conflict at that other value. The
engine must surface the genuine unique conflict; it must not retry into or
adopt the row named by `where`. This is an intentional failure-correctness
deviation from the baseline, not fast-path SQL drift.

#### Package A keep gate

Keep only if:

- existing scalar upsert SQL and statements are byte-identical;
- one generated member does not gain another output/read;
- every new field is published through an existing output/reference channel;
- no provider-assigned range or sequence order is inferred;
- write-engine runtime import cycles remain zero.

Suggested commit:

~~~text
feat: publish compound generated row keys
~~~

### Package B — Carry demanded fields across atomic-batch execution

**Outcome: B1 retained; B2 and B3 rejected at their keep gates.** Package A's
interactive PostgreSQL publication remains the supported plural path. Package
B adds no batch publication protocol, CTE compiler, output descriptor, or SQL
statement. It closes an older wrong-data path instead: PostgreSQL no longer
lowers a consumed atomic-batch `insertId` through session-global `lastval()`.

#### Unit B1 — Classify the exact field classes

The reachability audit found only omitted `int.increment()` and
`bigInt().increment()` values. MySQL permits one auto-increment column and has
no built-in batch-only driver. SQLite/libSQL/D1 can generate only the singular
INTEGER PRIMARY KEY shape. PostgreSQL is the only built-in dialect that can
host plural generated members, but its batch scratch is TEXT and bigint reads
currently use the logical `integer` destination cast. More importantly,
`lastval()` is session-global: another generated column or a trigger can change
it, including a trigger that advances the same owned sequence after assignment.

Therefore PostgreSQL's existing `batchRefs` object does not expose
`storeLastInsertId`. The optional lowering itself is the capability fact;
`OperationExecutor` refuses a locally consumed `insertId` before `_executeBatch`
when it is absent. MySQL and SQLite keep their exact existing lowerings. The
ordered row-key database-assignment classifier from Package A remains the
identity owner; no second all-scalar classifier or duplicate guard was retained.

#### Unit B2 — Exact-selector publication — rejected

The only plausible retained subset was PostgreSQL plus an application-known
row key plus a demanded non-PK `int.increment()`. It still required a new
`firstRowField` batch-materialization descriptor, a second focused SELECT, and
an SQL premise to prevent a zero-row scalar store from persisting NULL before
the consumer. That is a new publication protocol for one provider shape, not a
small extension of the existing `insertId` channel. The prototype was not kept.

#### Unit B3 — PostgreSQL producer-local CTE capture — rejected

The existing mutation fold is owned by `CreateOperation`, while atomic scratch
identity is allocated later by `OperationExecutor`. Preserving the original
INSERT as the attributed root mutation, its race pin, concrete
`firstRowField` outputs, and scratch stores would require an executor-visible
mutation descriptor or rendered-SQL reconstruction. The first is new durable
lowering vocabulary; the second violates the adapter boundary. No prototype
survived the gate. Existing transaction CTE SQL is unchanged.

The decisive falsifier is failure semantics, not descriptor aesthetics. A
PostgreSQL INSERT may produce zero RETURNING rows (for example through a BEFORE
trigger or row policy). A scalar scratch store then persists NULL unless a SQL
premise aborts before every consumer. Neon/native batch errors do not provide a
stable failing-statement index, and rollback removes the scratch row whose
premise a later attribution probe would need to inspect. Exact attribution
therefore needs a new provider error protocol, not merely a CTE spelling. The
prototype was deleted rather than claim weaker errors or silently consume NULL.

#### Unit B4 — Preserved failure boundary

Focused witnesses prove that PostgreSQL's lowering is absent and that a
single-sequence generated parent feeding a nested child refuses before the
provider batch method is called. A separate two-sequence interactive
PostgreSQL witness remains positive through Package A's producer-local
RETURNING/CTE path. Because B2/B3 were deleted, there is no new zero-row store,
scratch cleanup path, statement attribution case, or stale-value state.

#### Package B keep gate

Met by rejection: no new provider lowering was retained. PostgreSQL keeps one
first-knowable executor refusal for missing exact generated-identity transport.
It is distinct from `CreateOperation.producedReference`, which refuses a
demanded non-identity field before any `insertId` output exists.

Suggested commit:

~~~text
fix: refuse ambiguous PostgreSQL batch identities
~~~

### Package C — Reconcile selected-record assignments once

#### Unit C1 — Introduce the module-local assignment ledger

Inside `RecordUpdateCompiler`, collect physical root-column contributions from:

- scalar update data;
- parent-held relation folds;
- shared-primary-key folds;
- demanded final membership.

The ledger stores existing value sources and provenance labels only. It is not
exported and does not become a query AST.

Define one equality procedure using existing source/value equality:

- literal equality is exact after scalar normalization;
- identical final/planning sources agree;
- correlated values captured from the same projection member agree;
- values that cannot be proved equal are conflicting when they target the same
  column.

#### Unit C2 — Fix selected upsert incoming membership

For a correlated found arm, pass incoming membership as a locate/guard premise,
not a final assignment. For a global-adopt arm, retain it as a demanded final
assignment.

Delete `assertArmEdgeIsChildHeld`. Let the compiler accept:

- unrelated parent-held relation writes;
- explicit reparent on the incoming edge;
- explicit disconnect where membership is clearable;
- exact agreement with the global-adopt membership.

Keep one conflict when an explicit fold and a demanded global-adopt membership
demand different values for the same column.

The assignment ledger does not make every operation on the incoming edge safe.
Before compilation, use the existing OwnWrite membership-scope equality to
separate:

- membership writers (`connect`, `create`, `connectOrCreate`, `disconnect`),
  which the final-assignment owner can reconcile;
- target mutations (`update`, `delete`, `upsert`) whose selected target is the
  enclosing root itself, which must retain a narrowed overlap refusal unless
  existing OwnWrite already rejects the exact same physical target.

This preserves the historical falsifier in which deleting the enclosing root
degraded into a terminal `TransactionError`, while unrelated parent-held edges
become legal.

#### Unit C3 — Absorb relation-owned FK agreement

Move `withoutAgreeingOwnedFk`'s semantic decision into the same assignment
owner where the data is trusted. This input is publicly reachable on the
upsert update arm; the create projection already omits relation-owned FK fields
and must be trusted rather than checked again.

- every spelled FK member that agrees with its corresponding literal parent
  source is removed from nested update data and accepted;
- an agreeing subset of a compound FK is valid; unspelled members remain
  engine-owned and are injected normally;
- null, arithmetic, or disagreement remains invalid;
- planned/final sources remain fail-closed until equality can be proved by the
  same source comparator;
- no second relation-specific agreement helper survives.

Preserve `relationOwnsForeignKey` as the topology fact that distinguishes a
real scalar-versus-membership contradiction. This package removes duplicate
agreement decisions; it does not erase physical FK ownership.

#### Package C keep gate

Replay the historical falsifier that caused the broad guard to be restored:
connect must not be probed and discarded, create must not leave an unreferenced
row, disconnect must not be overwritten, and delete must not degrade into a
terminal `TransactionError`.

#### Package C outcome (implemented)

The keep gate passed. `RecordUpdateCompiler` now has one module-local
contribution/comparison owner across its construction and compile timing
boundaries. Construction-known scalar and demanded-membership contributions
seed the owner; each `compile(known)` continues a fresh copy with the selected
branch's folds. This preserves early failure without duplicating the equality
rule or leaking branch-dependent assignments between compiles.

The broad direction guard and `withoutAgreeingOwnedFk` are deleted. Correlated
incoming membership is a locate/guard premise only. Global-adopt membership is
a demanded final assignment. The narrowed survivor refuses only a parent-held
target mutation whose existing OwnWrite membership scope is the exact incoming
scope; a child-held self-relation inverse remains legal.

Agreeing partial or complete compound FK spellings are absorbed member by
member. Null, arithmetic, disagreement, and opaque equality remain fail-closed.
The assignment identity is keyed by the mapped physical column, so public field
aliases cannot create a second writer. Duplicate public scalars mapped to one
column remain definition-invalid under the existing F003 rule and therefore do
not require a runtime witness.

The raw write-engine refusal census falls from 13 to 12: two obsolete sites and
one duplicate before-target publication check are removed; the ledger conflict
owner and exact incoming-target overlap owner are added.

Suggested commit:

~~~text
refactor: reconcile selected record assignments once
~~~

### Package D — Resolve shared-primary-key values from the selected arm

This package is a medium-risk compiler lift, not one of the mechanical easy
deletions. The fresh create and selected-update roots consume the same semantic
value at different times and must not be forced through one positional
shortcut.

#### Unit D1 — Fresh-create shared-key publication

`CreateOperation.assertSharedPkResolved` protects a fresh root whose identity is
consumed during construction by descendants, terminal selection, and
`rootReferenced`. The selected target arm may nevertheless decide that value
only later.

At construction:

1. Reserve the existing final reference for the fresh root INSERT's shared-PK
   field.
2. Register the target arm that will provide that field.
3. Let descendants and terminal selection consume the reserved field reference
   without choosing an arm early.

At compile:

1. Select the target arm once.
2. Resolve its exact field source.
3. Fold that value into the root INSERT assignment.
4. Publish the same field from the root INSERT under the reserved reference.

Package B owns carrying that publication on batch substrates. Do not add a
second create-identity carrier or let separate consumers choose the arm twice.

#### Unit D2 — Selected-update resolver registration

When compiling a shared-PK relation, register one field resolver per shared-key
member from the already-selected topology:

- literal or parent final source;
- connect probe field;
- connectOrCreate found probe field;
- connectOrCreate missing fresh publication;
- correlated upsert located field;
- upsert missing fresh publication.

The resolver is attached to the existing relation compilation record. Do not
add a shared-PK Part or exported branch-value protocol. This unit applies to
the selected `RecordUpdateCompiler`; Unit D1 remains the fresh-root owner.

#### Unit D3 — Resolve after arm selection

At the beginning of selected-record compilation, resolve the taken arm's value
and contribute it to Package C's final-assignment ledger.

Accept alternate-unique connect when its probe published the referenced field.
For connectOrCreate and upsert, the found and missing arms may contribute
different sources because only one arm is taken.

Delete `assertSharedPkResolved` and the missing-value half of
`recordSharedKeyFold`. Retain only:

- null final shared key;
- no selected arm can publish the key;
- contradictory scalar/fold assignment.

For shared-PK upsert, include the missing arm in `sharedKeyMembers`. A missing
arm can itself move the selected record's key. Reconcile its before/after-root
ordering with the normal transition compiler, suppress occupied-transition
guards only when the selected found arm is a proved no-op, and ensure every
child consumes the post-transition value. Do not retain the dedicated missing-
upsert parent SET as a second ordering owner.

#### Unit D4 — Identity and race proofs

Cover:

- application-known and generated shared PK;
- alternate unique selector whose value differs from the referenced PK;
- connectOrCreate found/missing/concurrent-winner arms;
- upsert found/missing/untaken illegal arm;
- compound shared PK members;
- selected root PK transition;
- wrong-row replacement between probe and write;
- exact destination casts.

#### Package D keep gate

Keep this package only if fresh create and selected update retain their own
timing owners while sharing Package C's final assignment truth. If the
implementation needs a new branch-identity DSL, a second shared-PK compiler, or
multiple arm-decision evaluations, stop Package D and continue Package E. Do
not make this medium-risk prototype a prerequisite for the easier lifts.

Suggested commit:

~~~text
feat: resolve selected shared primary keys
~~~

#### Package D outcome (implemented)

The lift is retained. Fresh create and selected update keep their existing
timing owners and share the Package C physical-column assignment truth. The
single new semantic fact is `consumedValue`: after a write succeeds, it may
publish an exact pre-cast scalar or prior output reference that the same
statement consumed. Returning providers still publish the stored row through
`firstRowField`; `consumedValue` is the exact non-returning counterpart, not a
generated-identity inference or a branch protocol.

Create reserves and declares the root field output before its INSERT is frozen.
The selected connect/connectOrCreate arm supplies the same source used by the
INSERT. Incoming membership, scalar data, and every parent-held assignment are
reconciled by mapped physical column before lowering. Race pins now compare the
probe selector against the complete effective create assignment, so a conflict
on different values is never misclassified as a concurrent winner.

Selected update resolves alternate-unique connect tuples from the captured row,
pins the selector plus every captured referenced member in batch mode, and
defers missing-arm publication until that arm wins. Direct target update and
found upsert publish their target compiler's post-update referenced tuple. When
a database cascade owns a shared-key transition, current-membership writes run
first, the selected target transition runs second, and post-transition writes
run last. Empty updates publish the captured tuple without inventing a write.

For a compound relation whose stored tuple only partly overlaps the row key,
the complete tuple is the transition/publication fact and the overlap alone is
the terminal identity fact. This lets a downstream relation consume a selected
non-key companion column without widening the record identity. Non-shared
parent-held relations remain on their historical fast path. Fresh create uses
the same split: selected relation values remain separate from raw scalar input,
so descendants can read the complete tuple while contradictory explicit scalar
and relation assignments still fail at the physical-column truth owner.

At this Package-D checkpoint, the retained residues were semantic: null selected keys, contradictory final
assignments, unavailable database-produced values on non-returning/batch
substrates, and values that would cross a committed execution boundary before
becoming concrete. PostgreSQL batch generated-ID crossings remain refused under
Package B. Track A later retired that PostgreSQL default-operation boundary through
exact RETURNING folds or guarded output segments; explicit atomic arrays and truly
unnamed non-RETURNING rows remain fail-closed. No Part, arm DSL, source-reference kind, provider capability flag, or
second branch decision was added. `consumedValue` is a statement-output arm; it
does not add an `OperationValueReference` or branch-identity kind.

### Package E — Continue a singular supplier with an ordinary update

#### Unit E1 — Reuse the existing composed lattice

Do not change the public type/runtime schema except to remove stale rejection
witnesses. The lattice already identifies supplier plus modify as one coherent
composition. Literal `false` remains inactive and ambiguous supplier pairs
remain rejected.

Keep the existing child-held `connect + update` direct selected path byte-
identical. Only `create + update`, `connectOrCreate + update`, and their admitted
vacate-prefixed forms need the membership-capture continuation.

#### Unit E2 — Build the supplier operation

Reuse the current fresh/adopt builders for `create` and `connectOrCreate`.
Preserve an optional preceding vacate. The supplier does not need to publish
its row key for this composition; membership after supply is the selector.

#### Unit E3 — Execute the selected continuation

Represent the sequence with the existing record-series form:

1. perform optional vacate;
2. execute supplier;
3. select the singular target through the central exact physical-membership
   predicate and publish its complete `TargetProjection`;
4. parse the original update source for this selected continuation exactly once;
5. compile it through `RecordUpdateCompiler`;
6. resume the enclosing suffix.

OwnWrite must analyze the complete supplier and update programs at their
respective trusted boundaries. The update may recursively contain relations,
nested createMany/updateMany, or another valid to-one composition.

Reuse the captured selected-record series machinery already used by nested
relation-bearing `updateMany`, specialized to an exactly-one membership
capture. Do not instantiate the public `UpdateOperation` shell and do not add a
supplier-specific target selector. The shared to-one composition
classification must be consumed by both OwnWrite and the compiler so the
analyzer does not re-derive connect-only semantics or reject the continuation
before its supplier is selected.

#### Unit E4 — Progressive provider guard

For ordered committed segments, carry the existing complete parent and supplied
target guard into every later write. If either row cannot be named and re-pinned
exactly, decline through `progressiveSeriesRefusal` before that containing
member writes. Do not weaken the interactive implementation to fit D1.

#### Package E keep gate

The new path must preserve supplier race pins, captured-target addressing,
whole-transaction rollback on interactive drivers, committed-progress truth on
D1, and exact found/missing behavior. Delete `composeToOneEntries`'s
unsupported site completely.

Suggested commit:

~~~text
feat: continue singular suppliers with updates
~~~

### Package F — Historical savepoint-only suppression implementation

#### Unit F1 — Reuse subtree skip disposition

When `skipDuplicates` is requested and the target has no exact selector that
can support existing adopt-and-link semantics, route that row through the
existing per-record fresh subtree plus join series:

~~~text
target subtree
  -> target root INSERT annotated as the skippable root
  -> join INSERT only when target root inserted
~~~

Run the member inside the existing savepoint. A root conflict produces the
existing private skipped outcome and rolls back all earlier work in that
member. A descendant conflict remains fatal.

#### Unit F2 — Preserve nameable adopt behavior

Do not route a target with one exact addressable unique through suppression.
Keep the established behavior that finds/adopts the skipped target and creates
the requested junction membership.

For multiple possible unique conflicts, do not guess which row to adopt. The
unnameable route suppresses the member rather than selecting an arbitrary row.

#### Unit F3 — Provider boundary

> **HISTORICAL F3 CHECKPOINT — SUPERSEDED.** The later batch-only RecordSeries
> lift isolated a skippable root as its own atomic segment and used normalized
> row count before dispatching descendants. Any native atomic-batch driver now
> executes the root-first shape. Only a write or nested series before that root
> retains the pre-effect refusal because the earlier effect would survive a skip.
> The construction design below records the former implementation.

Transaction-capable PostgreSQL, MySQL, SQLite, and libSQL use the member
savepoint path. D1 and other batch-only providers retain the generic pre-effect
refusal until exact root-versus-descendant conflict attribution exists.

At construction, if any nested junction-series member carries
`seriesRootConflict`, mark the enclosing `RecordSeriesStep.progressive` as
unsupported. The committed-segment executor must therefore refuse before the
containing fragment submits its prefix; it must not commit a parent/prefix and
discover conflict-attribution impossibility only when entering the nested
member.

Delete `RelationJunctionPart.resolveCreatePk`'s generated-key refusal after all
interactive routes use the series owner.

Suggested commit:

~~~text
feat: suppress skipped junction record subtrees
~~~

#### Package F outcome at that checkpoint (later widened for batch-only drivers)

The lift is retained. `routeJunctionCreateManyRow` classifies EACH row rather
than assigning one disposition to the complete entry. `suppress` names an
omitted generated target whose conflict no `whereUnique` can identify: two
complete addressable uniques, any remaining unique INDEX (including a partial
index whose predicate is opaque provider SQL), or a compound unique with a NULL
member. Those rows take the same per-record series a relation-bearing junction
row already took: the target subtree is a delegated `CreateOperation` whose root
INSERT carries the existing skip disposition, its join row is the next step of
the same member, and `runRecordSeriesMember`'s existing savepoint rolls the
complete member back when that root write returns no row.

Rows retain input order as maximal contiguous route runs. Homogeneous scalar
leaf and adopt paths retain their grouped fast path. Relation-bearing adopters
are isolated because descendant planning is dynamic. If an adopter must observe
a preceding suppress/leaf run or a relation-bearing adopter, the existing
`RecordSeriesOperation` is the planning barrier: earlier effects land before the
later probe. One shared adopt map preserves first-row-wins dedup across runs. A
spelled-key leaf, a nameable adopt, and a structurally vacuous generated row keep
their original meanings; the vacuous row drops the flag even when its ordinary
relation series must still run.

`resolveCreatePk` no longer receives `skipDuplicates` at all; the leaf never sees
a skippable generated key, so the identity it could not resolve is not asked for.
Its refusal is deleted rather than moved.

The provider boundary was implemented at that checkpoint as a CONSTRUCTION refusal at the series
builder rather than as an `unsupported` progressive marking, and the deviation is
deliberate. A marking answers only where a `RecordSeriesStep` is reached by the
progressive runner, so a plain batch-only substrate would have fallen through to
the executor's `QueryEngineError` ("requires ordered series execution") — an
engine-fault class for a capability fact. One typed refusal at the shared
attribution owner covers a directly constructed series on D1 and every other
batch-only provider. For suppression nested inside another replayed record,
`recordMutationNeedsInteractiveSkipAttribution` projects the same schema-level
MAY-suppress fact to both progressive entrances — ordinary child-held and
junction updateMany — before either can commit an enclosing prefix. The scanner
is conservative across replayed defaults and custom schemas: an omitted
increment key plus any declared non-PK conflict key may suppress. It does not
freeze or reparse defaults. The executor's own root-series refusal keeps its
distinct coverage: a ROOT `CreateManyRecordSeries` has no `RecordSeriesStep` and
never passes through the new site.

Census: 13 → 13. Site 8 (MSI, "a skipped row produces no identity for its join
row") is retired; site 31 (PSI, "suppression needs a savepoint and a batch
contract cannot attribute a root conflict apart from a descendant one") takes its
place. The later batch-only RecordSeries lift deleted site 31: root isolation and
normalized row count now execute the safe shape on every native atomic-batch
driver. Only a write or nested series before the skippable root remains refused,
through the executor's shared progressive owner.

Witnessed in `junction-skip-adoption-behavior.ts`: the suppressed member absent
with its join absent and its siblings landed, a pre-existing unnameable row
neither rewritten nor linked, a NULL-membered compound unique writing because
nothing can conflict, and both sides of the member boundary (a ROOT conflict
suppresses its complete subtree; a conflict INSIDE the subtree aborts the whole
operation). `junction-create-many-routing.test.ts` pins row-local mixed routes,
raw-index suppression, adopt dedup, and left-to-right dynamic visibility.
`junction-progressive-preflight.test.ts` pins both progressive entrances, replay-
varying selectors, direct batch refusal, and the vacuous positive case.
`record-series-contract.test.ts` proves that a suppressed member does not poison
its enclosing scope: a later member still writes, and a later pinned race still
retries the COMPLETE series.

### Package G — Consolidate unpublishable transition failures

This package is refusal compression, not a promise to invent a value that does
not exist.

#### Unit G1 — Separate three value states

At the selected-transition owner distinguish:

1. exact final value: publish and continue;
2. exact null: the request contradicts a nested membership that needs a
   non-null reference;
3. unknown/unrepresentable value: a genuine internal/provider publication
   limitation.

Public relative scalar operations already use transitioned planning sources.
Do not add UPDATE RETURNING or a generic SQL-expression carrier unless a public
payload can actually reach a missing exact-value case.

#### Unit G2 — Give null contradiction one owner

Move the null case to relation-key legality or the selected-transition boundary
as a `NestedWriteError`, with one exact message and one falsifier. Delete the
duplicated unsupported sites in `postTransitionReference` and
`nestedTargetWriteId` when they no longer have unique coverage.

#### Unit G3 — Delegate fresh target publication

`requireBeforeTargetReferenced` consumes the target subtree's existing
`rootReferenced(field)` result. If the subtree cannot publish it, use the one
fresh-publication refusal owner instead of constructing a second limitation
with the same invariant.

Keep separate sites only if direct internal construction can bypass one owner
and its witness proves a different failure.

Suggested commit:

~~~text
refactor: centralize unpublishable relation values
~~~

#### Package G outcome (implemented)

The consolidation is retained and it deleted three sites without adding one:
write-engine **13 → 10**, query-engine 15 → 12, whole `src` 17 → 14. Nothing
became legal and nothing became less refused; what changed is who says so, and in
two cases which class says it.

**G1/G2.** The census named two owners for one sentence — `postTransitionReference`
(compile, per member) and `resolveCreateParent`'s arity-1 non-primary-key arm
(construction) — and Package O had measured that their ACCEPTANCE predicates
genuinely differ, which is why it kept both. That measurement was right and is
preserved: the compile position has the located pre-value and can therefore derive
a portable arithmetic operand, the construction position cannot, and their accepted
arms order the fresh INSERT on opposite sides of the root UPDATE. What was
duplicated is the VERDICT. `RecordUpdateCompiler.requireRewrittenReferenceValue`
now owns it, answering in the three states §G1 names, with the ONE axis being
whether the located value is in hand:

- a value — returned; each position uses it its own way;
- an exact `null` — a CONTRADICTION, `NestedWriteError`, one message naming the
  field and the relation rather than the position. No substrate, no round trip and
  no later package produces a row for a foreign key equal to NULL, so claiming an
  unsupported capability was the wrong sentence;
- anything unrepresentable — `QueryEngineError`. Measured unreachable from the
  public surface: `Sql` and arrays die at the parse boundary, arithmetic at
  relation-key legality's CLASS IV guard, and an explicit `undefined` is stripped
  before the operand arrives. TWO of those boundaries carry pinned witnesses in
  `sql-operand-boundary-behavior.ts` — the `Sql` operand at the parse boundary and
  arithmetic at CLASS IV. The array operand and the explicit `undefined` are
  answered by those same two boundaries and have no witness of their own: two
  pinned arms, not four. That is what makes the conversion honest rather than a way
  to retire an unfalsifiable refusal, and the count is stated here so no reader
  takes the state's unreachability for four measured facts (residual Package H
  corrected this sentence; the owner's docblock and
  `forbidden-shapes-reference.md` §2.5 state the same two).

The three formerly-refused payloads still refuse, at the same phase, with zero
effects, and the previously UNPINNED `"membership"` position gained its own
witness: the same `null` reaching the same owner through an adopt arm at compile.

`relation-key-legality` was considered as the earlier owner and REJECTED on a
measurement: it does not know the referential action, so refusing there would also
refuse a cascading edge whose `null` rewrite compiles today. Duplicating the
cascade exemption at that boundary would have created the second owner this
package exists to remove.

**G3.** `beforeTargetReferenceSource` asked the fresh subtree
`rootReferenced(field)` and, on `undefined`, constructed the limitation site 15
already owns for the create root. It now calls `FreshRecordPart.requireRootReferenced`,
so the subtree refuses for its own INSERT and the update root only names the
position. The sentence is byte-identical: `beforeRootTarget` is the fourth
`FreshReferencePosition`, added exactly as `childEdge` and `parentId` were.

NOT taken, deliberately: the three `QueryEngineError` twins on the update root's
polymorphic paths (ledger item N2) read the same predicate and state the same
fact. Folding them CONVERTS an error class on paths with no behavioral witness,
and item N18 records that such a conversion owes one first. That debt is not this
package's.

### Package H — Narrow progressive-series provider refusals

#### Unit H1 — Complete parent row-key publication

At every `RecordSeriesStep` construction site, derive the complete parent row
key from existing facts:

- fresh root identity and generated outputs;
- selected target projection;
- post-transition row-key sources;
- junction parent side.

Use the existing complete-target presence guard. Do not accept a non-PK
reference value as proof of complete row identity. Lookup/opaque SQL sources
remain unsupported.

An exact polymorphic discriminator plus referenced value proves membership,
not parent row identity. Keep that pair in a distinct exact-membership guard
when the progressive boundary needs it; the parent liveness guard still uses
every `ModelKeyCatalog.rowKey` member.

#### Unit H2 — Neon HTTP ordered committed-segment prototype

Enable no capability until live provider tests prove:

- one submitted batch is atomic and ordered;
- later statements observe earlier statements in that batch;
- a later request observes the committed batch;
- a failed batch leaves no effects;
- `NeonHTTPDriver.executeBatch` invokes the existing committed callback
  immediately after `await client.transaction(...)` resolves and before result
  cardinality checks, normalization, or output assembly; a later normalization
  error must still report the already committed segment;
- RETURNING rows and generated fields normalize exactly;
- a stable failing statement index is preserved, or every segment with more
  than one plausible failing guard/insert is refused before effects;
- root-versus-descendant same-table/same-constraint failures, multiple guards,
  and race-pin classification remain exact;
- cache invalidation and progress diagnostics run at the acknowledged commit.

If the proof passes, set the existing
`supportsOrderedCommittedSegments` capability for Neon HTTP. Do not branch on
driver name in the query engine.

Only concrete normalized `StatementOutputSource` results merged by
`assembleOutputs` may cross a committed segment. No `Sql` scratch reference,
temporary table, or session state crosses requests. Package B qualifies only
when the producer also returns the exact field as a concrete output. Never use
PostgreSQL `lastval()` where multiple sequences or trigger-side sequences could
make it ambiguous.

Live witnesses must include malformed result data after commit, a later request
observing the commit, root and descendant failures on the same constraint,
multiple guards, current-member retry classification, and no prefix replay. If
hosted credentials are unavailable, leave the capability flag false; a local
mock is not sufficient proof.

#### Unit H3 — Keep the executor factory

`progressiveSeriesRefusal` remains the sole owner of:

- no verified ordered atomic batch;
- no positive bind limit;
- statement/guard over capacity;
- capture or planning writes that must precede dynamic member construction;
- skipDuplicates without exact root-conflict attribution;
- unguardable nested boundary;
- unexpected write/series in a final result read.

The last two final-read branches are trusted-compiler invariant failures. They
may be translated to `QueryEngineError` in this package if that improves error
taxonomy, but this is cleanup and must not be counted as a capability lift.

Suggested commit if the Neon proof passes:

~~~text
feat: run record series on neon http
~~~

#### Package H outcome (implemented)

No construction site moved: write-engine 10, query-engine 12, whole `src` 14,
unchanged. H is a reach narrowing plus two recorded refusals to change something.

**H1.** The complete parent row key is now derived at every `RecordSeriesStep`
construction site. Ordinary child-held entrances also carry the exact referenced
membership tuple when it differs from that row key.
`RecordUpdateCompiler.progressiveParentRowKey` is the selected-record counterpart of
the fresh-record owner `CreateOperation` already had: it publishes the located row's
complete `ModelKeyCatalog.rowKey` as final reference sources, so a parent located by
a NON-primary-key unique whose child edge references that same column is guarded
rather than declined. MEASURED before the change on that exact payload: *"…nested
relation-bearing createMany on relation 'spokes' cannot re-pin the complete parent
row key"*, zero batches submitted, while the row key sat in the locate one statement
earlier (`TargetProjection.identityFields` IS that key and leads the probe's fields).
The guard names `id` and never `code`.

The refusal is narrowed, not deleted, and its surviving arm is REACHABLE and
witnessed on a public payload: an update that moves its OWN row key abstains,
because which value names the parent in a later segment then depends on whether the
placement is ordered before or after the root UPDATE — the placement's fact
(`afterRoot`), not the record's. Answering it in the record would be a second
ordering owner, so §H1's "post-transition row-key sources" is served the way it
already was: an edge that REFERENCES the moving key carries the post-transition
value in its membership source and resolves from it.

Every ordinary child-held progressive entrance now consumes one exact correlated
premise from `relation-membership.ts` when the reference key differs from the row
key. The temporal correlation kind selects both facts together: an existing-member
`updateMany` resolves row identity and the referenced tuple from READ sources; a
supplier continuation resolves both from WRITE sources. This prevents a moved and
reused non-PK reference value from redirecting either series after a committed
segment. The fresh child-held create series uses the same referenced-premise owner
beside its selected parent row key.

`RelationJunctionPart` still needs no non-PK premise: its source side references
the parent's primary key. The inverse polymorphic placement likewise references
the target's one scalar primary key (schema rule P009). Their guard SQL remains
row-key-only. `progressive-parent-rowkey.test.ts` and
`supplier-continuation.test.ts` pin the read-side and write-side races separately;
the junction tests pin the unchanged row-key-only boundary.

**H2 — the stronger attribution capability is NOT enabled.** `supportsOrderedCommittedSegments` stays false
for `neon-http`. The local prerequisite is now implemented and pinned:
`NeonHTTPDriver.executeBatch` awaits the committed notification immediately after the
native transaction promise resolves and before cardinality checks or statement-result
parsing. A credential-free fake proves only that driver-code order, including malformed
post-commit results and no notification on provider rejection. It does not prove hosted
durability, atomic order, later-request visibility, result normalization, or exact
failure attribution.

The later batch-only series lift changed eligibility without enabling that flag.
A safe root or nested series reaches Neon's awaited native batch route. The absent
hosted proof means only that a dispatched, undecodable segment can be reported as
possibly committed instead of callback-acknowledged. Enabling the stronger flag still
needs live atomicity, order, visibility, normalization, and error-attribution evidence.
No query-engine path branches on the driver name.

**H3 — the factory stands, and two permitted conversions were declined.** All seven
reasons §H3 lists construct through `progressiveSeriesRefusal`; re-measured, none has
a second owner. The two final-result-read branches were NOT translated to
`QueryEngineError`: they are trusted-compiler invariants no payload reaches, and this
estate's conversion law (ledger item N18) requires a behavioral witness before a class
changes. Cleanup that cannot be falsified is not cleanup.

#### Package H finding — Package B's estate debt (historical checkpoint)

The following counts describe the Package-H/I checkpoint. Phase 3 completed the
reconciliation; its literal 19-file table and zero-red write/provider results below are
the current record.

Running the write estate for H's gate surfaced a pre-existing failure set that is
neither H's nor small, and it is recorded here so Package I plans it rather than
discovers it.

**The number, re-measured by Package I on the tree H left, is 131 failing tests
across 22 files** in `tests/contracts/engine/write` — one whole `coverage-write-engine`
run, `131 failed | 3166 passed | 392 skipped (3689)`. H's paragraph printed
**132 across 23**, which was H's own PRE-repair reading: H then repaired
`junction-skip-adoption` and did not re-measure the total, so the figure it left
describes a tree state that no longer existed by the time it was written. The
correction is one file and one test, and it is stated rather than edited away
because a debt figure a later package inherits has to be a figure that package can
reproduce.

**102 of them are exactly one sentence** — *"atomic batch cannot publish insertId
output '<step>.id': the active adapter has no exact statement-local
generated-identity lowering"* — and that half of H's paragraph was measured
correctly: the count is 102 on the nose, over 18 distinct `<step>` names. Of the
**29** remaining (H said "~30"), **6 name the same refusal in their failure text**,
arriving where a suite expected another error class or another message (`M4`'s
duplicate-row parity, three `linear operation fragments` class assertions, one
`'returned 0 results'`, one `guard provider failure`); the other **23** are the
same refusal arriving where a value was expected, and they read as structural or
oracle mismatches (`deeply equal undefined`, `to have a length of 1 but got +0`,
two `parity C` step comparisons) rather than naming it.

The cause is Package B, and it is deliberate at the source: PostgreSQL's `batchRefs`
no longer exposes `storeLastInsertId` because `lastval()` is session-global.
`CreateOperation` selects the identity channel with `capturesByReturning = txMode &&
returning`, so a BATCH substrate publishes a generated key through `insertId` even on
a RETURNING-capable adapter — and PostgreSQL now has no such lowering. The
user-visible consequence, measured on the PostgreSQL batch stand-in: `client.M.create({
data: … })` on a model with `s.int().id().increment()` REFUSES on a batch-only
PostgreSQL driver, which is the substrate `neon-http` runs in production.

Package B updated six suites to assert the new refusal and missed the rest. Two
choices remain, and they are a design decision rather than a test chore: update the
remaining witnesses to assert the refusal (what B did elsewhere), or give batch
PostgreSQL an exact identity transport that is not `lastval()` — B3 rejected the
producer-local CTE on error-attribution grounds, and that rejection would have to be
revisited on its own falsifier, not waved through. H repaired exactly one file,
`junction-skip-adoption`, because it is on H's own gate list; its batch leg now
registers the two refusals that substrate can express (including the identity one,
measured on the adopt payload with rows seeded outside the engine, so the refusal is
the operation's and not the fixture's) and the behavior stays on the interactive legs.
Everything else was left standing and unmasked.

### Package I — Final ownership and documentation pass

The I1/I2 prose below records the pre-Phase-3 handoff. It is retained as provenance,
not as current debt. Phase 3's reconciliation table and final coverage/provider results
supersede every open-count or "remaining" statement in this checkpoint.

#### Unit I1 — Recount and prove every survivor

Run the executable census and update the guard ledger. Expected survivors:

- one genuinely unpublishable fresh-record field;
- one provider/substrate publication refusal, if Package B cannot cover every
  real field/provider pair;
- one contradictory final-assignment refusal;
- one null/unnameable selected-transition refusal;
- at most one independently reachable before-target publication boundary;
- the progressive-series refusal factory;
- any provider-specific junction skip refusal that cannot use the factory.

Expected raw count: five to seven. A higher count requires a written unique
failure for every excess site. A lower count is welcome if all falsifiers stay
green.

#### Unit I2 — Update public documentation

Document only user-visible behavior:

- compound database-assigned row-key support by provider capability;
- parent-held selected-upsert updates and contradiction behavior;
- supply-then-update semantics and possible extra round trips;
- junction nameable-adopt versus unnameable-suppress behavior;
- D1/Neon committed-segment atomicity boundaries;
- remaining provider-specific refusals.

Do not narrate packages, deleted guards, or implementation history in public
docs. Keep that history in this architecture plan and the guard ledger.

#### Unit I3 — Update internal doctrine

Update `CONTEXT.md`, query-engine doctrine, ATOM, and the limitation/capability
matrix so they agree on:

- record field publication;
- one final assignment per physical column;
- selected continuation through record series;
- per-record PostgreSQL CTE folds versus rejected whole-series folding;
- native libSQL batching as a rejected performance prototype, not a missing API
  capability.

Suggested commit:

~~~text
docs: describe residual write capabilities
~~~

#### Package I outcome (implemented)

**I1 — census unchanged, ownership re-measured, three gaps found.** Write-engine
**10**, query-engine **12**, whole `src` **14**; every one of the fourteen had its
throw line and its owner declaration re-resolved by hand and its named falsifier RUN.
`guard-ownership-ledger.md` gained "Residual Package I — the live site table", which
supersedes the O-era cluster coordinates rather than editing them: six of the fourteen
carry a name or a position those tables never had, because residual B/D/F/H introduced
or renamed them. `forbidden-shapes-reference.md` and this plan now point at that table
instead of restating a snapshot, and the executable pin caught the one coordinate this
pass moved (site 31 slid a line when its file gained an import).

Two reds were found in the falsifier set and both were closed. One was the stale-batch
class (`compound-relation-adoption`'s batch leg). The other was NOT, and is the more
useful finding: `parity-f-fresh-field`'s "a nested create leaf" expected position
`childEdge` and got `parentId`, because a child-held nested `create` now carries an
`incomingMembership` like the adopt kinds and that binding resolves the whole-value
parent source before `childFkAssign` runs. Same site, same class, same phase, zero
effects; the witness was retargeted to the noun that is now true and the row's claim
that the two payload paths share a position was retired with it.

**At the Package-I checkpoint, three sites had no falsifier**: the
plural-without-RETURNING arm of `producedReference` (reachable only through a synthetic
non-returning adapter, since no migration driver in this estate can emit two
database-assigned members), `assertSelectedSharedPkValue` (its create-root sentence is
unpinned; only site 4's update-root twin is witnessed), and the `consumedValue`
execution-boundary crossing (Package D pinned the transport, not the refusal). Phase 2
closed all three in `residual-refusal-falsifiers.test.ts`: each exact typed refusal now
has an accepted control and a guard-disabled red proof; site 20 is pinned at its true
`compile(known)` boundary after lookup and before the root INSERT.

**The H1 carry-item was BUILT, not recorded.** §H1's second sentence — keep the exact
membership pair in a distinct guard, and let the liveness guard keep the row key — is
what every ordinary child-held progressive entrance needs when those keys differ.
`completeTargetPresenceGuard` carries the optional membership premise;
`resolveCorrelatedMembershipProgressivePremise` selects one temporal pair rather than
mixing sources: READ row key plus READ referenced tuple for existing members, WRITE row
key plus WRITE referenced tuple for supplier continuation. MEASURED without it, with a
concurrent writer between segments: both operations RESOLVED under a replacement owner.
Junction and polymorphic guards remain row-key-only. No census site moved.

**The stale-batch estate debt was COUNTED and only partly retargeted, and the number is
the deliverable.** 131 failing tests across 22 files at the tree H left; 102 are the
`insertId` sentence verbatim, 6 more name it in a failure text that expected another
class, and 23 are that same refusal arriving where a value was expected. **The debt is also wider than the write-engine project**: the provider runs found the
same class in `tests/providers/local/pglite.test.ts` (4) and
`tests/providers/docker/pg.test.ts` (37), so the true estate figure is **172 failing
tests across 24 files**.

Package I retargeted **four** files to the transaction-success + batch-pre-effect-
refusal shape E and H used — `compound-relation-adoption` (its mixed-component block
needs the parent's generated key), `type-depth-ceiling` (each level mints a tag whose
key the database assigns), `mutation-dependency-fold` (both batch legs, including the
duplicate-row parity half whose refusal now arrives one phase earlier), and the shared
`many-to-many-behavior` contract, which took an `includeGeneratedCreateCases` option
exactly as `batch-primary-key-dataflow-behavior` already had — and separately fixed one
NON-residue red, `parity-f-fresh-field`'s position noun. The Phase-3 baseline corrected
the remaining count from the actual runner output: **19 write-engine files (126 tests)**,
plus `tests/providers/docker/pg.test.ts` (37 tests), for **20 files and 163 tests**.
Of the 126 write-engine reds, 121 reached site 28 and five were independent stale
contracts. The literal family table below is the audit source; the prior 18-file claim
was not a measured end-state count.

One of those 22 was NOT the residue class and is now retargeted separately:
`upsert-family.test.ts`'s depth-2 to-one grandchild block asserted
`assertArmEdgeIsChildHeld`, the broad parent-held refusal residual Package C deleted,
and had been red since C. Measured before rewriting: the shape whose silent overwrite
the FIRST lift restored a guard for now writes its explicit value on both the agreeing
and the disagreeing spelling, because C's assignment reconciliation makes the arm's
incoming membership locate/guard-only. Both halves are pinned in that file.

One thing the retarget MEASURED that the debt note did not say, and it widens the
user-visible statement rather than the test one: the refusal does not need a nested
write at all. A BARE `client.M.create({ data })` on a model whose primary key the
database assigns refuses on a batch-only PostgreSQL driver, because the operation's own
terminal read must name the row it just wrote. That is why the many-to-many refusal leg
cannot seed its own fixture, and it is now pinned there.

The leverage for whoever finishes it was measured and is worth stating: the docker-pg
failures and several write-engine ones come through the SAME shared contract behavior
files (`update-family-behavior`, `upsert-family-behavior`, the nested-mutation and
operation-fragment contracts), each registered on both a write-engine oracle leg and a
provider leg. One option per behavior file — the shape `many-to-many-behavior` just
took — closes both at once. The rest is per-file work. None of it is a design question:
B3 already answered the design question, and its answer is what makes the refusal
correct.

##### Phase 3 — PostgreSQL atomic-batch debt reconciliation

The baseline was one full `pnpm test:coverage:write-engine` run on the Phase-2 tree:
**19 failed files, 126 failed tests, 142 passed files, 3,192 passed tests, 20 skipped
files, and 392 skipped tests**. “Site 28” below means the exact PostgreSQL atomic-batch
generated-identity refusal; it includes cases where an incidental generated fixture
prevented the contract under test from running. “Non-B” names the five reds that were
not that refusal.

| Baseline file | Raw reds | Site 28 | Non-B | Final disposition |
|---|---:|---:|---:|---|
| `batch-mode-fold.test.ts` | 4 | 4 | 0 | Give the batch-only UPDATE fixture an explicit key; keep all four fold contracts executable. |
| `batch-round-trip-baseline.test.ts` | 11 | 11 | 0 | Give seed/action rows explicit keys; keep transport and SQL census coverage executable. |
| `create-family.test.ts` | 10 | 10 | 0 | Keep transaction success; assert the same generated-root payload's exact batch refusal and empty state. |
| `create-junction-upsert.test.ts` | 10 | 10 | 0 | Make decoy setup explicit; execute FOUND controls and exact-refuse only generated article/topic arms. |
| `create-many-relation-series.test.ts` | 1 | 0 | 1 | Restore the child-held series remedy: dropping `skipDuplicates` does not make a plain batch relation series expressible. |
| `create-nested-upsert.test.ts` | 7 | 7 | 0 | Exact-refuse the two generated-root successes; give five guard/error/rollback contracts explicit roots. |
| `depth-seam.test.ts` | 3 | 1 | 2 | Exact-refuse `slot.create.id`; correct the two stale race-pin controls so their matching unique values remain real. |
| `junction-create-many.test.ts` | 6 | 6 | 0 | Exact-refuse three generated missing/create arms; use explicit fixtures for adopt/found/disjointness controls. |
| `junction-produced-identity.test.ts` | 6 | 6 | 0 | Exact-refuse five generated producer paths; keep connect-or-create FOUND executable with explicit rows. |
| `junction-upsert-arm-probe.test.ts` | 5 | 5 | 0 | Keep four FOUND/nonmember probes executable; exact-refuse only the missing generated target half. |
| `located-target-depth.test.ts` | 3 | 3 | 0 | Exact-refuse the two generated badge payloads; give the concurrent-delete guard an explicit badge key. |
| `parity-c-selected-identity.test.ts` | 2 | 0 | 2 | Retarget stale SQL: a correlated found row already belongs to the owner, so the UPDATE sets only the requested scalar. |
| `polymorphic-write-family.test.ts` | 25 | 25 | 0 | Isolate seven generated relation-demand groups; give all other membership, guard, and recursion contracts explicit IDs. |
| `produced-identity-depth.test.ts` | 4 | 4 | 0 | Exact-refuse the two generated-key crossings; keep the two non-PK referenced-field paths executable with explicit roots. |
| `to-one-create-family.test.ts` | 3 | 3 | 0 | Keep transaction success and exact-refuse the three generated-target batch payloads with both tables unchanged. |
| `to-one-update-family.test.ts` | 3 | 3 | 0 | Exact-refuse generated create/missing/scalar-plus-create payloads; keep FOUND controls executable. |
| `update-family.test.ts` | 10 | 10 | 0 | Give setup rows deterministic keys; preserve all UPDATE/DELETE guard and result contracts. |
| `update-nested-upsert.test.ts` | 4 | 4 | 0 | Give setup rows deterministic keys; preserve all nested UPDATE-arm contracts. |
| `upsert-family.test.ts` | 9 | 9 | 0 | Exact-refuse the generated nested create arm; use explicit setup keys for the other found/update/race contracts. |
| **Total** | **126** | **121** | **5** | **All 19 files retargeted without skipped semantic coverage.** |

The corrected 19-file checkpoint is **19 files and 557 tests passed**. The two shared
provider behavior registrations that previously skipped generated cases are also
executable: the focused PGlite batch-only many-to-many plus primary-key-dataflow run is
**43 passed, 725 unrelated tests skipped**. The final write-engine coverage run is
**161 files passed, 20 provider-gated files skipped; 3,318 tests passed, 392 skipped**
in 248.92 seconds, with no failed test. This closes the credential-free
`coverage-write-engine` debt from 126 to zero.

The real Docker PostgreSQL confirmation is closed too. The Package-I baseline was 37
failed, 833 passed, and 13 skipped. The first Phase-3 live run reduced that to two exact
site-28 residues: the atomic-batch depth-seam generated upsert grandchild
(`slot.create.id`) and the extended-whereUnique upsert-created row
(`note.create.id`). Their forced-batch registrations now take the same typed,
pre-effect refusal contract as PGlite while their transaction registrations retain the
success payload. The final live run passed **876 tests, skipped 7, and failed 0 (883
total)**: 35.41 seconds in Vitest and 35.69 seconds at the safe launcher.

**I2 — public docs carried the capabilities landed at that checkpoint.** `compatibility.mdx` and
`nested-writes.mdx` gained the supplier-plus-update semantics (Package E), the
compound database-assigned row key (A), the junction nameable-adopt versus
unnameable-suppress split (F), and the substrate boundaries a caller can hit —
including the then-current batch-only PostgreSQL generated-identity refusal. Track A
later superseded that default-operation boundary and updated both public pages; the
Phase-3 evidence below remains historical. No package numbers, no deleted guards, no
implementation history entered the public pages.

Internal doctrine took three durable facts and nothing else. `CONTEXT.md` gained
**progressive boundary premise** — two facts, liveness and exact membership, neither
substitutable for the other. `src/query-engine/AGENTS.md` and
`write-engine/ATOM.md` §17 say the same thing at their own altitudes, naming the two
resolvers and the placements whose premise is empty by construction. The
capability matrix gained **A18a**, the statement-local generated-identity transport
per driver family, which is the fact behind the estate debt below. The repository-root
`AGENTS.md` was NOT touched: it is clean in this worktree and every fact this pass
established is query-engine-local.

**Co-mingling, recorded.** `src/query-engine/AGENTS.md`, `write-engine/ATOM.md`,
`CONTEXT.md` and `capability-matrix-2026-07.md` were already uncommitted when Package I
opened, carrying residual Packages A–H. Package I edited ON TOP of those versions and
preserved every hunk, so each file's single uncommitted diff now mixes A–H with I. A
reader splitting this branch into per-package commits has to split those four files by
hunk; nothing else in the tree has that property.

**I3 — the provider matrix is measured, and §9.2's Neon column still stands.** Every
credential-free provider project was run once at this pass and its COUNTS recorded in
§9.2. Neon and PlanetScale are recorded as skipped for want of credentials, which is
also why `supportsOrderedCommittedSegments` stays false for `neon-http`.

**I4 — the sequential matrix, one process at a time.**

| Run | Result |
|---|---|
| §9.3 focused write families, 22 files in one invocation | **12 failed · 589 passed (601)**. Both red files (`junction-create-many` 6, `junction-produced-identity` 6) are the stale-batch residue, and they are the finding worth naming: the plan's OWN focused list contains two files the debt still holds. |
| `pnpm test:layer:query-engine` | **48 files · 864 passed**, green, no FATAL this time. |
| `operation-construction-inventory` alone | **7 passed** — write-engine pinned at 10, all 14 coordinates re-resolved. |
| `pnpm test:types` ×3 warm | 17.62 · 17.28 · 17.97 s → **median 17.62 s**, against Package 0's 17.84 s median and 18.73 s five-percent ceiling. Load at the third run: 2.43 / 2.85 / 2.65. |
| Biome over every A–I touched file (82 tracked + untracked) | 3 errors + 1 info on the first pass, ALL pre-existing Package F debt in files this package had not touched — an `UnsupportedOperationError` import left behind in `RelationJunctionPart.ts` when F moved that refusal to the shared owner, a dead `parsedRows`, one format drift, and an empty `dispose` block. Fixed, re-run **clean over all 82**. The stale import is a small confirmation of the census: that file now holds no construction site. |
| `git diff --check` | clean. |
| `pnpm test:coverage:write-engine` | **Package-I historical run: BEFORE 131 failed · 3166 passed · 392 skipped (3689) over 22 red files; AFTER 126 failed · 3172 passed · 392 skipped (3690), reported then as 18 red files.** Phase 3 re-measured that unchanged 126-test residue across 19 files and records the corrected baseline plus the zero-red result above. |
| `pnpm test` | **223 files · 5141 passed**, green. |

## 7. PostgreSQL CTE and native libSQL decisions

### 7.1 PostgreSQL CTEs remain in use

This plan does not remove or distrust PostgreSQL CTE execution. The engine
already folds one eligible fresh-record tree into one PostgreSQL statement:

~~~text
root INSERT ... RETURNING
  -> nested INSERT consuming returned fields
  -> optional scalar projection
~~~

That fold remains valid because dependencies are explicit through RETURNING and
the compiler proves the arms are guard-free and order-insensitive. Each
eligible member inside a record series may use this per-record fold.

The rejected prototype was different: combining several record-series members
as sibling data-modifying CTE arms. PostgreSQL gives those siblings one
snapshot and no reliable execution order. Member N could not observe member
N-1 by rereading the table, and two independently failing members could change
the first surfaced error. No public capability in this plan depends on that
optimization.

Retain exact SQL/parameter/statement witnesses for the current per-record fold.
A future strict whole-series pure-insert fold is a performance RFC, not part of
this limitation lift.

Package B's producer-local scratch prototype does not combine record-series
members. Its CTE must keep the INSERT as the attributed root mutation, communicate
only through explicit RETURNING dependencies, and expose demanded fields as
concrete statement outputs as well as any same-batch scratch values.

### 7.2 Native libSQL batch remains a performance rejection

libSQL already executes these capabilities through an interactive transaction.
Native `Client.batch()` would reduce provider requests; it would not unlock a
new public write shape.

The installed `@libsql/client` 0.14.0 SDK returns ordered results on success but
does not preserve the exact failing statement index. Switching to it would
weaken error attribution and first-failure diagnostics. A future stable index
is necessary but not sufficient: local and remote contracts must also prove
atomic rollback, order, exact result normalization, and commit timing. Keep the
current transaction path until all of those facts hold or the public failure
contract is deliberately changed in a separate decision.

## 8. Restrictions intentionally retained

These are not targets for this pass:

- two different final values claimed for the same physical FK member;
- partial compound relation-owned FK data;
- null final value where a nested membership requires a non-null reference;
- a record with no stable complete selector after a provider-generated write;
- a provider-produced value that its execution substrate cannot publish
  exactly;
- two competing suppliers for one singular slot;
- upsert beside an independent supplier intent;
- vacate plus update without a replacement target;
- moving one child-held target to more than one `updateMany` parent;
- dynamic record series inside explicit `$transaction([...])`, whose contract
  is one atomic prepared batch;
- a relation-bearing `skipDuplicates` member with a write or nested series before
  its skippable root, because that prior effect would survive the skip;
- discriminator-specific polymorphic cardinality;
- native libSQL batching and whole-series PostgreSQL CTE folding.

Compound many-to-many junction sides were on this retained list at the planning
checkpoint. The 2026-08-14 compound-junction pass lifted them with complete
ordered side groups while preserving scalar `.A()` / `.B()` tokens as exact
column names and interpreting those tokens as positional prefixes only for a
compound endpoint.

## 9. Test matrix

### 9.1 Every newly accepted behavior

Run in transaction and atomic-batch modes where the provider contract can
represent it. For progressive providers also run the committed-segment route.

Cover:

- found, missing, and untaken upsert arms;
- application-known, one generated, and compound generated row keys;
- alternate unique selectors and compound target projections;
- relation-bearing selected updates;
- parent-held, child-held, polymorphic, junction, and self-relation topologies;
- parent PK and referenced-key transitions;
- client defaults materialized once per actual record operation;
- same-ID wrong-discriminator decoys;
- root/descendant unique conflicts;
- wrong-row replacement after every planning/capture boundary;
- current-member race retry and whole-operation retry ownership;
- zero partial effects on interactive failure;
- exact committed progress on segment-atomic failure.

### 9.2 Provider matrix

The generated-output rule is producer-local and capability-driven. Exact
single-statement and insert-id-scratch lowerings remain unchanged. Otherwise a default
operation on a batch driver materializes `RETURNING` output between guarded atomic
segments. This fallback can report partial committed progress; it is never used to
weaken an explicit `$transaction([...])` array. A custom driver with neither callback
transactions nor atomic batches remains outside the safe lowering.

The five-capability follow-up adds exact indivisible lowerings without changing
that rule: scalar RETURNING arms fold on supporting adapters, and bounded
PostgreSQL-family mutation DAGs fold only when their projection does not read a
table written by a sibling CTE. A non-returning plural generated row key can use
one focused read when the source explicitly writes a complete addressable
alternate unique; otherwise site 19 remains.

| Capability | PostgreSQL/PGlite | MySQL | SQLite/libSQL | D1 | Neon HTTP |
|---|---|---|---|---|---|
| singular generated-ID transport | Interactive RETURNING; exact one-statement fold where available; otherwise guarded RETURNING segments | Transaction path; exact `LAST_INSERT_ID()` lowering remains available | Exact `last_insert_rowid()` lowering remains available | Exact static SQLite lowering where the operation stays one atomic batch | Guarded RETURNING segments; no cross-segment atomicity |
| plural generated row-key publication | Interactive RETURNING, exact scalar/eligible mutation-DAG array folds, and default-operation guarded RETURNING segments | N/A: DDL rejects more than one `AUTO_INCREMENT`; a generic non-returning adapter can use an explicit alternate-unique locator | N/A: DDL cannot generate this compound key | N/A for the plural shape | Producer-local RETURNING segments; exact eligible array folds, no cross-segment atomicity |
| selected assignment reconciliation | Required | Required | Required | Static atomic batch; exact guard when nested in a progressive series | Static atomic batch; exact guard when nested in a progressive series |
| supplier then update | Transaction path; per-member CTE still eligible where applicable | Transaction path | Transaction path | Exact guarded progressive subset | Exact guarded progressive subset |
| unnameable skipped junction member | Savepoint suppression | Savepoint suppression | Savepoint suppression | Isolated root segment; prior-effect member refuses | Isolated root segment; prior-effect member refuses |

Use live provider tests for hosted Neon and D1 claims. PGlite proves PostgreSQL
SQL semantics, not remote request count or hosted error normalization.

#### Historical measured provider runs (residual Package I, 2026-08-14)

These counts record the Phase-3 checkpoint before Track A changed generated-output
execution. They remain audit evidence, not the current capability matrix. Each project
ran once, one process at a time, with counts recorded rather than exit codes.
The Docker containers were probed first (`viborm-pg-test-2` on 5434 and
`viborm-mysql-test` on 3307 both answered) and their env vars were passed inline to the
one command that needs them, never exported into a shell that also runs the local
estate.

| Leg | Files | Tests | Note |
|---|---|---|---|
| `provider-pglite` | 1 failed / 1 passed | **4 failed · 764 passed · 7 skipped (775)**, then **GREEN after the retarget**: `pglite.test.ts` alone re-run at **758 passed · 11 skipped (769)**, 0 failed | All four failures were the same stale-batch residue: the batch-only PGlite many-to-many leg asks for a target key the database generates. Retargeted to assert the pre-effect refusal. The retarget also MEASURED the sharper fact and pins it — a BARE `article.create` refuses on this substrate too, because the terminal read has to name the row it just wrote, so the four junction payloads cannot even be seeded there. |
| `provider-sqlite3` + `provider-libsql` | 2 passed | **2290 passed · 2 skipped (2292)** | Exact `last_insert_rowid()` on both, batch included. |
| `provider-bun` | 2 passed | **2 passed** | |
| `provider-d1` (real `workerd`) | 1 passed | **16 passed** | The ordered committed-segment contracts, on the only substrate that declares the capability. |
| Docker `provider-mysql2` (3307) | 1 passed | **1067 passed · 1 skipped (1068)** | Exact `LAST_INSERT_ID()`, batch included. |
| Docker `provider-pg` (Package-I port 5434; Phase-3 port 2222, serial) | Package-I baseline: 1 failed; Phase 3: 1 passed | **37 failed · 833 passed · 13 skipped (883)** at Package I; final Phase-3 run: **876 passed · 7 skipped · 0 failed (883)** | The first live Phase-3 run left only `slot.create.id` and `note.create.id`; after their exact typed pre-effect retargets, the real PostgreSQL run was green in 35.41 seconds (35.69 seconds launcher wall). |
| Docker `provider-postgres` (5434, serial) | 2 passed | **294 passed · 7 skipped (301)** | |
| `provider-neon-http` + `provider-planetscale` | 2 skipped | **2 skipped** | No credentials in this environment. `NEON_TEST_DATABASE_URL` and the PlanetScale variables are unset, so both suites `describe.skip`. |

The Package-I red legs measured the boundary that existed at that checkpoint. Track A
retargets those default-operation refusal witnesses to exact success. The retained
site-28 witness is now the explicit indivisible `$transaction([...])` seam, where
segmenting would violate requested atomicity.

**Neon HTTP column, measured at Package H: every "after proof" cell stands, and the
hosted proof is still absent.** The credential-free fake now proves one local
prerequisite only: after the native transaction promise resolves, `executeBatch`
awaits the committed callback before cardinality/result parsing, including malformed
post-commit results, and provider rejection never notifies. It does not prove Neon
durability, atomic order, later-request visibility, normalization, or exact failure
attribution. This environment has no Neon credentials — `NEON_TEST_DATABASE_URL` is
unset and `tests/providers/hosted/neon-http.test.ts` skips — so
`supportsOrderedCommittedSegments` stays false. The flag strengthens attribution only;
the credential-free contract now pins a safe root series reaching and awaiting Neon's
native batch route. No query-engine path branches on the driver name.

### 9.3 Focused suites

At minimum update and run the existing families:

- `produced-compound-identity`
- `fresh-produced-field`
- `produced-identity-provenance`
- `produced-identity-race-pin`
- `shared-pk-connect-or-create`
- `shared-pk-update-root`
- `parity-e-shared-pk`
- `nested-arm-dispatch`
- `upsert-arm-referenced-edge`
- `parity-b-upsert-arm`
- `parity-h-to-one-lattice`
- `vacate-then-supply`
- `junction-produced-identity`
- `junction-create-many`
- `post-transition-adopt`
- `operation-construction-inventory`
- `operation-construction-witnesses`
- D1 provider record-series contracts
- Neon HTTP provider contracts when credentials are available.

### 9.4 Sequential repository validation

Run through the memory-capped repository launchers, one process at a time:

~~~bash
pnpm test:layer:relations
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm test:layer:client
pnpm test:types
pnpm package:build
pnpm test
pnpm test:all
pnpm test:coverage:write-engine
~~~

Run `pnpm test:providers` when services are available and report each exact
skip. Run three warm final type checks. Median regression must remain below
five percent from Package 0.

## 10. Acceptance

The pass is complete when:

- the compound two-database-assigned-key probe-first upsert works on an exact
  RETURNING-capable PostgreSQL path;
- no accepted existing operation changes SQL, parameters, IDs, guards, race
  pins, error attribution, statement count, or round trips, except the former
  PostgreSQL atomic-batch generated-output path: Track A keeps an exact fold when
  possible and otherwise uses the producer's own `RETURNING` across guarded
  committed segments. It never restores session-global `lastval()`;
- fresh publication has one row-key plan and no generated-ID range inference;
- selected-record root columns have one final-assignment owner;
- the broad parent-held selected-upsert refusal is gone without restoring the
  historical silent overwrite;
- shared-PK found/missing arms resolve their exact selected value;
- singular supplier-plus-update uses ordinary record compilation;
- unnameable skipped junction targets suppress the complete target-and-join
  member on interactive drivers;
- progressive provider support is enabled only by an existing capability flag
  after live proof;
- the existing per-record PostgreSQL CTE fold remains byte-identical;
- native libSQL batching and whole-series PostgreSQL CTE folding remain outside
  the capability acceptance gate;
- write-engine runtime import cycles remain zero;
- no new mutation Part, runtime step kind, reference-source kind, relation
  strategy, lifecycle hook, callback protocol, or second record compiler is
  added;
- every remaining refusal site has one unique falsifier and one first-knowable
  owner — **MET.** The live-site table records each owner. Phase 2 added witnesses
  for plural non-returning publication (site 19), a public selected-null create root
  (site 20), and the then-live `consumedValue` crossing. Track A converted that last
  boundary into an acceptance contract: an output-only alias materializes from the
  ordered provider result, while a later SQL consumer drives segmentation. The
  remaining generated-output refusals are the indivisible explicit-array boundary
  (site 28) and a crossed output with no compiler continuation premise (site 32);
- the final report states raw refusal sites, distinct invariants, deleted and
  consolidated guards, production/test/docs LOC separately, type-check medians,
  exact validation results, and provider skips.

## 11. Recommended implementation order

Use one coherent commit per validated package:

~~~text
test: refresh residual write limitation witnesses
feat: publish compound generated row keys
fix: refuse ambiguous PostgreSQL batch identities
refactor: reconcile selected record assignments once
feat: resolve selected shared primary keys
feat: continue singular suppliers with updates
feat: suppress skipped junction record subtrees
refactor: centralize unpublishable relation values
feat: run record series on neon http
docs: describe residual write capabilities
~~~

If a provider prototype fails its keep gate, remove only that provider lowering,
record the measured reason, and continue with the next independent package. Do
not roll back already proved capability packages, and do not weaken the public
failure contract to make a performance optimization pass.
