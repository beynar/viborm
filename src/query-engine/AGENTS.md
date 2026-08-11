# Query Engine — Database-Agnostic Query Planning

**Location:** `src/query-engine/`  
**Layer:** L6 — query structure and semantics

## Purpose

The query engine validates operation inputs, decides query structure, compiles
ordered SQL fragments, and parses results. It never owns database syntax.
Adapters express SQL. Drivers execute it.

## Golden rule

Every dialect-dependent SQL choice goes through the adapter. Provider error
recognition belongs to driver error mapping. Do not inspect SQL text in the
query engine to infer a dialect semantic that the compiler already knows.

## Result parsing

`result/ResultParser.ts` owns middleware chains and compiled row parsers for one
result boundary. Strict nested rows compile from the first validated provider
row and reuse that parser only when expected shape, model, and operation match.
The strict shape guard still runs for every returned row; parser reuse must not
turn validation into a first-row-only check. Row normalization validates the
provider array without copying or mutating it, and row mapping uses a pre-sized
output array so transient allocation does not buy slower iteration.

## Write architecture

```text
validated input
        ↓
RelationMutationProgram map
        ↓
root operation + relation Parts
        ↓
guard-free PlanningFragment
        ↓
selected OperationFragment
        ↓
OperationExecutor
```

See [write-engine/ATOM.md](write-engine/ATOM.md) for the normative doctrine and
[write-engine/README.md](write-engine/README.md) for the short guide.

### Execution atom

`OperationFragment.ts` defines three runtime step kinds:

- `ReadStep`;
- `WriteStep`, the only kind that can carry `racePin` or
  `onUniqueConflict`;
- `GuardStep`.

`PlanningFragment` contains statement steps and outputs, never guards. Planning
is not read-only: skip-duplicate capture performs preparation writes.
Nested `Part.planning()` currently contributes reads. Keep the executor's
non-read planning fallback.

### Local terminology

An **operation shell** is the concrete public-operation-family owner that
exposes `mode`, `planning`, `compile`, and `parse`. `write-engine/routing.ts`
owns route-wide gates and shared-envelope parsing. The routed root shell owns
the remaining family- and arm-specific parsing, target, result, and direct
folds. `CreateOperation` can also be reused as a delegated fresh-record compiler
inside another shell. Files in `write-engine/*Operation.ts` contain these
owners. Files in `operations/*.ts` contain operation-specific SQL, plan,
identity, and ordering helpers; their historical directory name does not make
them operation shells.

Within relation compilation, **parent** means the current source record at that
edge and **child** means its relation target. `position: "parentHeld"` says
that the source record stores the FK. It does not claim a global model
hierarchy.

### Payload meaning

`builders/relation-mutation-parser.ts` constructs one lossless
`RelationMutationProgram` for each schema-transformed relation payload. Entries
preserve mutation order, array order, duplicates, `set: []`, and normalized
targets. Emitters consume `program.entries`; they do not reparse or recreate an
optional per-kind bag.

Validation transforms are not assumed to be idempotent. Parse untrusted input
once at its trust boundary and pass transformed meaning downstream.

### Relation topology

`bindRelation` classifies an edge on THREE ORTHOGONAL AXES (distinct-truth
Phase 4): `position` (`parentHeld` | `childHeld` | `junction`), `cardinality`
(`one` | `many`), and `membership.kind` (`foreignKey` | `polymorphic` |
`junction`), with impossible combinations unrepresentable (parent-held is
always to-one; a junction is always to-many).
`BoundRelation` carries ordered topology only. It does not carry scopes,
runtime identities, value sources, transition state, SQL, or branch policy.
Bind at the first topology decision so error order and untaken arm behavior do
not move.

A polymorphic child-held relation is a fixed inverse topology. Both cardinality
variants carry the private type/id storage, the inverse's stored discriminator,
and the one parent field the private identity references. Their physical
membership is exactly `child.id = parent.referenced AND child.type = storedType`.
The `ToOne` variant changes public arity and operation shape; it does not create
another storage or execution owner.

Direct polymorphic payloads remain separate. After schema transformation,
`ResolvedPolymorphicMutation` selects one concrete direct target or a targetless
disconnect. `ResolvedPolymorphicEdge` reuses ordinary target lookup/create
semantics, while `PolymorphicStorageValue` owns the atomic private `(type, id)`
assignment. A payload-selected direct edge and a schema-fixed inverse topology
are different facts and must not be coerced into one carrier.

### Record compilers

`CreateOperation` compiles each fresh record subtree except the explicit
inline junction-target insert. `RecordUpdateCompiler` compiles each
already-selected record update except the top-level scalar upsert fold,
which stays in its shell to preserve the one-statement path. "Each record" now
includes the members of a root bulk write: a relation-bearing `createMany` row
and a relation-bearing `updateMany` root are ordinary record operations inside a
record series, not a second compiler (see *Record series* below).

The update compiler owns scalar SET data, an optional incoming membership,
nested relations, the target projection, primary-key transitions, the root
UPDATE, and descendant ordering. `TargetProjection` groups the public fields
and private physical columns consumed from the located row. For a
parent-held edge, the record
compiler also owns the inline FK fold and the branch needed to construct its
root statement.
For child-held and junction edges, relation owners keep the target read,
correlation, membership, found/missing decision, guards, race pins, not-found
failure, and standalone edge effects. A true no-op allocates no step ID.

Fresh and selected compilers recurse through a type-only `RecordCompilerSeam`
with two functions: `createFresh` and `updateSelected`. It is a dependency
boundary, not a strategy framework. Runtime imports inside `write-engine` must
remain acyclic.

Direct top-level scalar folds remain specialized, and so does every bulk
operation **over the payloads its bulk path expresses** — scalar `createMany`
rows (plus a direct polymorphic `connect`), scalar `updateMany` data,
`deleteMany`, relation `set`, skip-duplicate capture, and the many-and-return
folds. A root bulk write whose payload carries a general relation program is not
specialized: it routes to a record series. Nested relation-level `createMany`
and `updateMany` stay scalar-only and refuse relation-bearing data before SQL.

### Record series

`write-engine/record-series.ts` owns one atom: `RecordSeriesOperation`, the
transactional sequencing of ordinary record operations. It is the only new
execution form in the write engine, and it is deliberately thin.

- **What it is.** A capture (optional), then N ordinary member operations run
  left to right in one interactive transaction, then the public bulk result.
  Members are `CreateOperation` / `UpdateOperation` instances built the ordinary
  way. The series adds no runtime step kind, no Part, no transaction AST, no
  callback protocol and no second planning model.
- **Why sequencing and not pre-planning.** Member N may observe what member N−1
  committed inside the transaction. That is what makes duplicate
  `connectOrCreate` targets converge on one row, and it is a semantic
  requirement, not an implementation preference.
- **Substrate.** A series always opens its own scope — a transaction on a
  top-level driver, a SAVEPOINT on a nested one — so a retry cannot re-run
  members over surviving predecessor rows. A batch-only driver has no
  interactive transaction and the operation refuses. Decide the substrate at
  CONSTRUCTION, before choosing the series shell, so a typed refusal is not
  degraded into the transaction wrapper's generic wording.
- **Retry ownership.** The COMPLETE series retries once as one unit, capture
  included; members never retry locally. Guards are the only producer of
  `meta.raceable`, and members always run in transaction mode, so inside a
  series only identity marking applies.
- **Routing is a predicate, not a mode flag.** One predicate per family decides
  series-or-not, and the scalar owners stay byte-identical on the other side of
  it. Those predicates are single owners whose violation is silent data loss —
  the value-group builders drop relation keys rather than refusing them — so a
  new relation kind must be added to the predicate in the same change.

The two concrete shells are `CreateManyRecordSeries.ts` and
`UpdateManyRecordSeries.ts`. They parse the bulk envelope, construct ordinary
record operations and shape the public result; they contain no relation-kind
switches and they are not record compilers. `write-engine/ATOM.md` §17 is
normative for what each one promises: capture-then-per-root ordering, the
count contracts, the N>1 membership refusal, and the postcondition on the
returning arms.

### Row keys and target projections

Three key kinds are different facts and keep different owners. Do not introduce a
universal `Identity`, tuple, or value-bag abstraction that erases them.

- A **row key** addresses one row: ALL of that model's primary-key members, in
  schema order. It is never one scalar. `TargetProjection`
  (`write-engine/target-projection.ts`) is its owner for a selected target —
  `{ identityFields, fields, columns }`, built model-first — and the declared
  list IS the read list, so a member cannot be declared and then silently
  dropped at extraction.
- A **reference key** names the ordered TARGET fields a relation points at. It
  may differ from that target's row key: a foreign key may reference a non-PK
  unique. Never assume the two coincide.
- A **membership key** composes stored references with fixed qualifiers (a
  polymorphic discriminator, a junction side) WITHOUT erasing their topology. A
  discriminator is a qualifier of the membership key, never a member of the
  target's row key.

`TargetProjection` publishes selected target values. It does not own FK,
polymorphic-column or junction-column mappings, and no configuration may carry a
`TargetProjection` and a single scalar child key at the same time. Junction SQL
keeps its own single-primary-key carve-out at its own owners, documented there,
because a junction table keys on one column per side.

### Fresh-record field publication

A fresh record can publish a demanded field once that field becomes knowable,
and demand is what drives the work: nothing publishes a value no consumer asked
for.

- Any referenced scalar field can be demanded, not only a generated primary key.
- On a RETURNING provider the demanded fields join the INSERT's `RETURNING`
  select, keeping the destination casts.
- On a non-returning transaction provider one focused SELECT by the created-row
  selector answers it, inside the transaction. If no such selector exists, the
  operation refuses BEFORE the INSERT rather than writing a row it cannot name.
  An `insertId` identifies the row; it is not the value.
- On a batch substrate publication is refused: batch statement rows are not
  addressable, and widening the scratch carrier would widen the
  `$transaction`-merge exclusion. That was measured, not assumed.

### To-one composition

A to-one payload under an update surface is `(vacate?, supplier, modify?)` — the
create root owns neither `update` nor a vacate key, so it stays at one intent.
The relation owner states that order; `RELATION_MUTATION_KEYS` ordering decides
nothing. A composed modify
is located by the SUPPLIER'S IDENTITY, never by membership correlation, because
correlation at planning time addresses the OUTGOING member — the wrong row. It
follows that only a supplier whose identity exists before the fragment's first
write can carry a modify: a `connect`'s unique selector can, and a `create` or
`connectOrCreate` cannot, because it produces the identity by inserting it. That
refusal names the missing produced-identity channel rather than an arity, so it
stays truthful the day the channel lands. A parent-held vacate plus supplier is
a final-slot fold: compute the final FK value and write it once in the root
statement; never emit a transient null assignment.

### Polymorphic relations

Direct polymorphic projection is compiled by
`builders/polymorphic-read-builder.ts` as one correlated CASE expression with
one branch per configured member. Each branch compares the stored discriminator
with adapter-owned exact-text equality and reuses the normal nested target
selection builder. It emits one SQL statement and no client-side per-row query.
Ordinary relations retain their existing LATERAL/correlated capability path.

Direct filters are type-correlated: `type`, `type + is`, or `type + isNot`.
Optional fields also accept bare `null`, `{ is: null }`, and `{ isNot: null }`;
those presence forms compare the private pair directly. Both inverse
cardinalities use the central correlation owner to add
`child.<private id> = parent.<referenced field>` and
`child.<private type> = <fixed stored discriminator>`. The ordinary to-one or
to-many relation builder then owns result arity, filters, and count behavior.

`CreateOperation` owns direct connect/create/connect-or-create storage on a
fresh owner and fresh inverse targets. `RecordUpdateCompiler` owns direct
connect/create/connect-or-create/update/upsert storage on a selected owner;
optional storage also permits disconnect and typed target delete. It projects
the private pair only when current membership affects the selected mutation.
Existing child-held
relation Parts own inverse probes, exact membership, found/missing branches,
guards, pins, link/set/delete effects, and bulk statements. Nested inverse
`createMany` remains grouped. Root `createMany` keeps the grouped bulk plan for
a row whose only relation work is a DIRECT POLYMORPHIC `connect`: one shared
bulk owner groups target probes by relation and variant, then feeds private row
values to the normal grouped INSERT plan. That route is what "connect-only
membership" names, and it is the direct polymorphic surface's whole bulk
vocabulary — any other polymorphic verb in a bulk row is not admitted there.
A row carrying a GENERAL relation program routes the whole operation to the
create record series instead, where each row is an ordinary `CreateOperation`;
the grouped path and the series never mix within one call. The implementation
adds no runtime step kind, adapter method, per-row target query, or generic
polymorphic strategy. On a non-returning driver, `select` plus `skipDuplicates`
is refused when those memberships are present because target resolution and
skip-capture cannot both own the same preparation phase.

Polymorphic to-many `set` uses the existing relation owner. It compares exact
`(type, identity)` membership. Optional storage clears departing pairs;
required storage guards that the departing set is empty.

OwnWrite maps direct payload-selected polymorphic edges and inverse relations
to the same exact `polymorphicForeignKey` scope. The synthetic parent-held edge
used by record compilation does not change that physical fact. Direct
disconnect contributes one exact scope per configured variant; never replace
this with a discriminator-free wildcard.

For inverse writes, connect and connect-or-create adopt globally. A fresh-parent
upsert also adopts globally. A selected-parent upsert requires the found row to
already have the exact fixed membership; a same-id row with another
discriminator is foreign and fails V7001. During a parent referenced-value
transition, membership reads use the old value and create/adopt writes use the
new value. Existing members are not rewritten because the database has no
polymorphic foreign key or automatic referential action.

A singular inverse reuses the ordinary child-held-to-one Parts and record
compilers. The composite storage index supplies portable occupied-slot
uniqueness. A slot collision is a genuine unique conflict, not a retryable
missing-target race.

Strict results keep a separate polymorphic expected-shape map and parser. The
existing adapter/driver relation decode chain receives result kind
`"polymorphic"`, then `polymorphic-result-parser.ts` validates the internal
carrier, chooses the exact target shape, and delegates target rows to the normal
strict row parser. Empty storage returns `null` only when the relation is
optional. A non-empty membership whose known target is missing always throws
`QueryEngineError`; unknown or half-null storage is malformed provider data.

### Source-bound relation membership

`write-engine/relation-membership.ts` binds child-held topology to its value
provenance once. Ordinary membership carries ordered field-bound FK members;
polymorphic membership carries the same parent source beside its fixed storage
and discriminator. The owner alone lowers membership into assignments,
planning/final predicates, probe projections, empty assignments, and decoded-row
tests — including the occupied-slot predicate a referenced-key transition emits,
whose conjuncts are the binding's members in schema order. Transitioned keys use
distinct old-read and new-write sources, and the old-read source is a required
input rather than a fallback to the write one. A transitioned source is
field-agnostic: it transforms the value of whichever member it is bound to, so
binding one source across a compound reference stays exact and applies the
transformation once per member. Final operation references cannot enter planning
SQL, a planning reference cannot enter an atomic unit's own SQL, and lookup SQL
cannot decide a branch.

### Branch pins

- Captured-target batch found arm: guard the captured row, `raceable: false`.
- Scalar probe-first upsert batch found arm: reassert the original unique and
  conditional selector together with the captured primary key.
- Scalar conditional-skip batch arm: first reassert selector plus captured key
  with a non-raceable presence guard; then assert that the same row still does
  not match the conditional with a raceable absence guard. Keep that order.
- Transaction found arm: use the locked read; do not duplicate the guard.
- Missing same-target insert arm: use the constraint and root-write `racePin`.
- Same-operation duplicate: add neither guard nor race pin.
- Keep explicit absence guards only when no same-target constraint enforces the
  premise.

`RecordUpdateCompiler` and relation owners that pass it a selected target write
by the captured primary key. A scalar probe-first upsert does the same in batch
mode after guarding that the complete selector still names that captured row.
Transaction mode keeps the original selector because its locate locks the row.
The eligible `ON CONFLICT` fold has no planning read, while a relation-bearing
found arm uses `RecordUpdateCompiler` and its captured identity.

When compilation reads private physical columns to select a mutation branch,
the batch guard reasserts those captured values before any write. This extends
the existing guard; it does not add a statement or round trip.

## Main owners

| Owner | Responsibility |
| --- | --- |
| `query-engine.ts` | client-scoped driver, registry, and engine composition |
| `pending-operation.ts` | lazy public operation lifecycle and routing entry |
| `write-engine/routing.ts` | route-wide operation gates, shared-envelope parsing, and shell construction |
| `operations/*.ts` | operation-specific SQL, plan, identity, and ordering helpers; not shells |
| `write-engine/CreateOperation.ts` | fresh record compilation and create result |
| `write-engine/UpdateOperation.ts` | public update shell and direct folds |
| `write-engine/RecordUpdateCompiler.ts` | one selected record mutation |
| `write-engine/UpsertOperation.ts` | top-level arm selection and terminal result |
| `write-engine/record-series.ts` | the record-series contract and its routed-operation discrimination |
| `write-engine/CreateManyRecordSeries.ts` | root relation-bearing `createMany` shell |
| `write-engine/UpdateManyRecordSeries.ts` | root relation-bearing `updateMany` shell |
| `write-engine/target-projection.ts` | complete captured row keys and selected-target projections |
| relation Parts | child-held/junction selection, membership, guards, pins, and edge effects |
| `write-engine/OperationExecutor.ts` | generic fragment execution, including series execution and retry routing |
| `write-engine/OperationFragment.ts` | step and fragment vocabulary |
| `builders/relation-mutation-parser.ts` | parsed mutation programs |
| `builders/relation-data-builder.ts` | bound relation topology |
| `builders/polymorphic-relation.ts` | direct member resolution |
| `builders/polymorphic-read-builder.ts` | direct CASE projection and correlated filters |
| `builders/polymorphic-mutation.ts` | resolved direct intent and atomic private storage value |
| `write-engine/relation-membership.ts` | child-held membership and value provenance |
| `ManyToManyStatements.ts` | junction SQL materialization |
| `result/ResultParser.ts` | result-boundary middleware chains and nested row-parser reuse |
| `result/polymorphic-result-parser.ts` | strict discriminator dispatch and orphan semantics |

Keep the type-only `QueryMetadata` compatibility export, adapter `batchRefs`,
and `ManyToManyStatements`. `QueryMetadata` is not a runtime boundary. Do not
add a generic mutation DSL, payload walker, branch-step IR, locator, strategy,
lifecycle hook, or shared utility landfill.

## Core rules

1. Adapter owns dialect SQL; driver mapping owns provider error recognition.
2. Parse once at each trust boundary.
3. Preserve SQL, parameter order, step IDs, guards, race pins, and exact errors.
4. Planning contains no guards, but can contain skip-duplicate preparation writes.
5. Atomic-batch guards precede writes with stable order inside both groups.
6. Old-read and new-write key-transition values stay distinct.
7. First-create-wins remains local to connect-or-create, and across the rows of
   one bulk series it is EXECUTION that answers it: row N observes row N−1.
8. One invariant has one guard. Every `UnsupportedOperationError` construction
   site must name a distinct first-knowable invariant and have one unique
   reachable falsifier. Before adding, moving or deleting one, read
   `docs/architecture/guard-ownership-ledger.md` — it owns the reasoning for
   every surviving site — and `tests/contracts/engine/write/operation-construction-inventory.test.ts`,
   which owns the count and re-resolves every coordinate. A guard whose unique
   coverage cannot be named does not go in.
9. Use direct owner imports; do not recreate a query-engine barrel.
10. Keep polymorphic private storage outside public scalars. Direct payloads
    write both columns through one storage value; fixed inverse topology binds
    the same pair with its schema-owned discriminator.
11. Every inverse polymorphic predicate includes both id correlation and exact
    discriminator equality.
12. Keep ordinary read and write fast paths unchanged when no polymorphic field
    is selected or mutated.

## Validation

Run focused behavior tests for the changed operation, then:

```bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
pnpm test
```

Use PGlite transaction and forced atomic-batch witnesses for changed nested
writes. Run PostgreSQL and MySQL parity suites when Docker is available.

Ordinary PGlite behavior uses `usePGliteSchemaFamily`: one database and one
schema push per compatible schema and substrate, with table truncation between
tests. Reset explicitly between parity arms in one test. The fixture owns the
disconnect. Keep a fresh database only for DDL, lifecycle, destructive-schema,
independently committed concurrency, staleness/race, or rollback-isolation
contracts. Structural fragment proofs do not boot PGlite.

`pnpm test:coverage:write-engine` is the authoritative credential-free write
estate. It includes core query/architecture sentinels and every local write
behavior; `pnpm test:layer:query-engine` remains the representative fast gate.
