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

`OperationFragment.ts` defines four runtime step kinds:

- `ReadStep`;
- `WriteStep`, the only kind that can carry `racePin` or
  `onUniqueConflict`;
- `GuardStep`;
- `RecordSeriesStep`, the one nested placement of an existing
  `RecordSeriesOperation` inside a final fragment.

`PlanningFragment` contains statement steps and outputs, never guards or record
series. Planning is not read-only: skip-duplicate capture performs preparation
writes. Nested `Part.planning()` currently contributes reads. Keep the
executor's non-read planning fallback.

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

Every record-bearing entry carries `RecordMutationData`: the transformed record
beside the exact source record that produced it. This provenance is recursive and
stays one value, never an index-aligned companion array. It lets a record series
run the established validation boundary once per selected member without applying
that boundary to its own transformed output. A source is `undefined` only in
compile-level witnesses and analytical callers that start from an already parsed
tree; such a value may be inspected but cannot be replayed as user input.

Validation transforms are not assumed to be idempotent. Parse untrusted input
once at its trust boundary and pass transformed meaning downstream.

### Relation topology

ONE STORED TOPOLOGY, SEVERAL DERIVED VIEWS. `bindRelation` classifies an edge on
THREE ORTHOGONAL AXES: `position` (`parentHeld` | `childHeld` | `junction`),
`cardinality` (`one` | `many`), and `membership.kind` (`foreignKey` |
`polymorphic` | `junction`), with impossible combinations unrepresentable
(parent-held is always to-one). A junction is to-many for every ordinary pair —
`bindJunctionRelation` writes `"many"` unconditionally — but the axis is NOT
collapsed to it: `bindPolymorphicMemberJunction` is the one producer of a
singular junction, for a fields-less `manyToOne` bound to a member whose
`inverseCardinality` is `"one"`, backed by that member table's UNIQUE over the
complete target side. Cardinality,
clearability and physical membership are DERIVED from that one stored
declaration, each by one named owner (`@schema/relation/cardinality`,
`@schema/relation/clearability`, the bound membership itself) — never
re-derived inline and never stored twice.
`BoundRelation` carries ordered topology only — including which model HOLDS the
membership and which it references, and the foreign/referenced fields paired
member for member. That pairing (`membership.members`) is the ONE pairing;
consumers do not re-pair the two field lists by index. It does not carry scopes, runtime identities, value sources,
transition state, SQL, or branch policy. Bind at the first topology decision so
error order and untaken arm behavior do not move; the field pairing is lazy for
the same reason, because it owns the mismatched-metadata refusal.
The OwnWrite membership scope is a READER of that bound membership, not a second
constructor of it.

A polymorphic child-held relation is a fixed inverse topology — the inverse of a
ROW-HELD group. Both cardinality
variants carry the private type/id storage, the inverse's stored discriminator,
and the one parent field the private identity references. Their physical
membership is exactly `child.id = parent.referenced AND child.type = storedType`.
The `ToOne` variant changes public arity and operation shape; it does not create
another storage or execution owner.

An inverse of a JUNCTION-HELD group is not one of those: its membership lives in
a member junction, so it binds as `position: "junction"` with a `junction`
membership, in reverse orientation, carrying `membership.polymorphicMember`. The
plural inverse (`manyToMany`) is then an ordinary to-many junction edge and needs
no polymorphic-specific engine code at all; the singular inverse (fields-less
`manyToOne`) is the junction-`"one"` combination above. Direct collection leaf,
plural view and singular slot all read the same `ResolvedJunctionTopology`, so
they cannot disagree about a member table.

Direct polymorphic payloads remain a distinct FACT, carried in the one parsed
relation collection rather than a companion map. After schema transformation the
payload resolves to one concrete direct target or a targetless disconnect, and
becomes a `polymorphicTarget` or `polymorphicDisconnect` entry of
`ParsedRelationMutation`. `ResolvedPolymorphicEdge` reuses ordinary target
lookup/create semantics, while `PolymorphicStorageValue` owns the atomic private
`(type, id)` assignment. A payload-selected direct edge and a schema-fixed
inverse topology are different facts and must not be coerced into one carrier.

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

Selected-row continuity is one `RecordUpdateCompiler` fact, not a relation-name
or ID special case. Planning always addresses the complete row key captured by
the target projection. Execution asks `selectedRowKeyAt` for that captured key
before the root transition or the complete final key after it; each relation
owner supplies the phase from its actual root/child placement. An exact
correlated incoming-parent `update` or found `upsert` may transport this fact
back to the matching parent-held edge. `delete`, global-adopt target mutation,
and a loopback that itself changes the incoming parent's row key remain focused
refusals because they do not publish a usable final tuple to enclosing siblings.

Fresh and selected compilers recurse through a type-only `RecordCompilerSeam`
with two functions: `createFresh` and `updateSelected`. It is a dependency
boundary, not a strategy framework. Runtime imports inside `write-engine` must
remain acyclic.

Direct top-level scalar folds remain specialized, and so does every bulk
operation **over the payloads its bulk path expresses** — scalar `createMany`
rows (plus a direct polymorphic `connect`), scalar `updateMany` data,
`deleteMany`, relation `set`, skip-duplicate capture, and the many-and-return
folds. A root bulk write whose payload carries a general relation program is not
specialized: it routes to a record series. Nested scalar-only `createMany` and
`updateMany` keep their grouped paths; relation-bearing forms place the same
record-series execution at their exact position in the enclosing tree.

### Bind-budget partitioning

The driver owns `maxBindParametersPerStatement`; `QueryEngine` exposes its
normalized positive-integer value to semantic builders. `QueryScope` stays an
adapter/model concern and never reaches through to driver state.

`bind-budget.ts` partitions a contiguous semantic item range by compiling SQL
and measuring `Sql.values.length`. Never estimate binds as rows × columns:
casts, private relation storage, SQL-valued cells, predicates, and adapter
lowering can add values. Unknown capacity preserves the old statement shape. A
single over-budget item remains indivisible for the executor's final pre-I/O
capacity refusal.

The currently splittable write owners are:

- `buildCreateManyPlan`: contiguous same-shape scalar rows, including nested,
  polymorphic, skip, and returning forms. Chunks preserve input ordinals and
  their counts/results concatenate in order.
- junction `connect`/`set`: the duplicate-skipping join INSERT over an already
  captured exact target-key list. The clear step of `set`, every target guard,
  and every insert chunk stay in the existing atomic operation.

The other bulk forms remain one statement for semantic reasons:

- scalar `updateMany`/`deleteMany` own one arbitrary predicate (and optional
  limit/RETURNING contract). Repeating that predicate can rematch changed rows,
  double-count, or choose a different limited set;
- child-held grouped `connect`/`disconnect` own one all-target existence
  decision across their probe and write. They have no statement-plan seam that
  can partition both halves from compiled bind counts yet;
- junction `deleteMany` owns whole-set added/removed guards. Partitioning the
  captured set makes the other chunks look like membership differences;
- per-selector junction disconnect/delete and record-series update paths are
  already separate semantic statements or members, so there is no bulk leaf to
  split.

Chunking changes statement-level trigger cardinality only for payloads that did
not fit previously: one firing per chunk. Row-level triggers still fire once per
row, and an under-budget run stays one statement.

### Record series

`write-engine/record-series.ts` owns one atom: `RecordSeriesOperation`, the
left-to-right sequencing of ordinary record operations. It is deliberately
thin.

- **What it is.** A capture (optional), then N ordinary member operations run
  left to right, then the public bulk result. Members reuse `CreateOperation`
  and `RecordUpdateCompiler`. `RecordSeriesStep` is the one authorized nested
  placement of this existing form; it adds no mutation Part, transaction AST,
  callback protocol, or second planning model.
- **Why sequencing and not pre-planning.** Member N may observe what member N−1
  wrote in the same execution scope. That is what makes duplicate
  `connectOrCreate` targets converge on one row, and it is a semantic
  requirement, not an implementation preference.
- **Interactive substrate.** A root series opens one transaction. A nested
  `RecordSeriesStep` runs in the transaction already owned by the enclosing
  operation; it never opens another one. The complete series retry, capture
  included, is outer-owned.
- **Batch-only substrate.** Any no-transaction driver with native atomic batch
  can execute a dynamic series as committed segments after normalized awaited
  success. The successful meaning and order are unchanged. A later failure
  preserves acknowledged prior segments and carries `meta.recordSeriesProgress`;
  no retry replays that prefix. `supportsOrderedCommittedSegments` strengthens
  callback-before-decode attribution. Without it, a dispatched segment whose
  result cannot be decoded is reported as possibly committed. A nested
  `RecordSeriesStep` uses the same runner only when its compiler supplies the
  exact complete-parent and, where needed, membership guard that every later
  write batch reasserts. An unguardable placement refuses before its containing
  member writes, although prior root members may already be committed. A dynamic
  series inside explicit `$transaction([...])` remains indivisible and refuses
  before the first user write.
- **Skip ownership.** On an interactive driver, `skipDuplicates` on a
  relation-bearing create series treats one member as a savepoint-scoped
  subtree. On a batch-only driver, the executor isolates the skippable root as
  one atomic segment and observes normalized row count before it dispatches any
  descendant. A root conflict skips the complete subtree; descendant and
  non-unique failures remain fatal. This is safe only when no write or nested
  series precedes the root. `assertProgressiveRootConflictEligibility` refuses
  that prior-effect case before segment dispatch because the effect would survive
  a root skip. A junction `createMany` whose skipped-on row NO unique selector
  can name uses the same member — target subtree plus its join row. Where one
  complete unique DOES name it, adopt-and-link remains unchanged. Vacuous flags
  still drop at routing.
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

`FreshRecordSeriesPart` places relation-bearing nested `createMany` rows.
`NestedSelectedRecordSeries` owns every captured selected-record series: the
correlated target set of a nested relation-bearing `updateMany`, and the
exactly-one membership capture a composed producing to-one supplier hands it.
Scalar-only nested bulk never enters either series path. Series returning reads use
`series-result-read.ts`: it groups complete row keys into K bounded set reads,
normally one, reorders results to source order, replays duplicate keys, strips
injected key fields, and preserves exact missing-row failures.

`RecordUpdateCompiler` is the one comparison owner for every final assignment
to a selected record's physical columns. Scalar SET data, parent-held folds,
shared-primary-key demands, and demanded global-adopt membership enter the same
ledger contribution rule across construction and compile timing boundaries.
Correlated incoming membership is only a locate/guard premise and does not emit
a redundant SET. Equal proven sources collapse; conflicting or unprovable
sources fail closed before silent last-writer overwrite.

Every nested `RecordSeriesStep` carries a progressive proof: either one exact
guard or one fail-closed reason. The guard is compiler-owned because only the
relation placement knows which existing parent or membership fact crosses the
commit boundary. The executor materializes boundary values and repeats that
guard in each later write batch; it never invents relation identity.

When the selected parent moves, the same placement phase chooses which complete
key that progressive guard re-pins: captured before-root, final after-root. A
row-key transition is therefore not itself a progressive refusal.

That proof is TWO facts with one relation-membership source owner, and neither
substitutes for the other.
LIVENESS is the parent's complete `ModelKeyCatalog.rowKey`, resolved by
`resolveFinalReferenceRowKey` — a reference value is not row identity, so a
non-PK reference never stands in for it. MEMBERSHIP is the exact referenced
value each later write will store. Every ordinary child-held progressive entrance
asks `relation-membership.ts` for the complete correlated premise when the
reference key differs from the row key. Existing-member series use the READ-side
row key and referenced tuple; supplier continuations use the WRITE-side pair the
supplier stored. Junction sides and polymorphic inverses reference the complete
primary key by construction, so their membership premise is empty and their guard
is the complete row key alone. A premise that cannot be stated exactly declines
the placement rather than guarding half of it.

D1 publishes one statement's official `meta.last_row_id` through the existing
`QueryResult.insertId` channel. Progressive segments can materialize that one
generated integer identity after commit. It is per-statement provenance, never
permission to infer an ID range or assign identities arithmetically.

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
polymorphic-column or junction-column mappings. A bound `JunctionSide` owns the
complete ordered mapping from junction columns to one endpoint's row-key fields;
junction SQL consumes that group without projecting it to a scalar.

### Bind-parameter budgets

The active driver owns `maxBindParametersPerStatement`. Semantic bulk builders
receive that number from `QueryEngine` and partition only shapes whose count,
order, conflict, and guard meaning survive partitioning. `buildCreateManyPlan`
chunks compiled same-shape rows from actual `Sql.values.length`; junction
`connect` and `set` chunk complete captured key tuples. The executor enforces the
final compiled limit but never parses or rewrites arbitrary SQL. Predicate
updates/deletes, complete-set guards, and one indivisible over-limit statement
remain one unit and refuse before I/O when the provider limit is known.

### Fresh-record field publication

A fresh record can publish a demanded field once that field becomes knowable,
and demand is what drives the work: nothing publishes a value no consumer asked
for.

- The model key catalog owns row-key member order. `CreateOperation` classifies
  omitted database-assigned members once and publishes the complete row key on
  demand. Exactly one such member keeps the historical `id` output; plural
  members each use the existing field-keyed `produced:<field>` channel. Never
  infer one generated member from another or privilege the first member.
- Any referenced scalar field can be demanded, not only a generated primary key.
- On a RETURNING provider the demanded fields join the INSERT's `RETURNING`
  select, keeping the destination casts.
- A selected shared-key arm may publish an exact pre-cast value that its own
  successful INSERT consumed. The statement both writes and publishes one source;
  descendants and the terminal never reselect the branch. Returning remains the
  stored-row authority when available.
- A compound selected relation publishes its complete stored tuple once any
  member overlaps the row key. Only the overlap is row identity; non-key tuple
  members remain field publications for downstream memberships. Relations with
  no row-key overlap keep the ordinary parent-held fast path.
- On a non-returning transaction provider one focused SELECT by the created-row
  selector answers it, inside the transaction. One generated key uses the exact
  statement-local `insertId`. A plural generated row key may instead use another
  complete addressable unique only when every member is an explicit create-source
  literal. Omitted/defaulted, null, `Sql`, incomplete, and raw-index-only candidates
  do not qualify. If no selector exists, the operation refuses BEFORE the INSERT
  rather than writing a row it cannot name. A locator identifies the row; it is not
  the demanded value.
- SQLite and MySQL batch adapters can publish one generated identity through
  their exact statement-local insert-ID channels. PostgreSQL never uses
  session-global, trigger-sensitive `lastval()`: a default operation either keeps
  the producer's `RETURNING` in one exact fold or materializes it before a guarded
  dependent segment. The latter can commit a prefix and reports that progress.
- An explicit `$transaction([...])` remains one indivisible shared batch. A scalar
  RETURNING result folds into one statement. On an adapter with data-modifying CTEs,
  a bounded mutation DAG may also fold when its result projection reads no table a
  sibling CTE mutates. Otherwise it refuses before provider effects when an internal
  statement needs generated output and no exact one-batch lowering exists. A
  non-returning adapter also refuses a plural database-assigned row key when no
  complete explicit stable locator can name the inserted row. Every generated output
  that crosses a segment must carry the compiler's exact continuation premise.

For selected updates, connect and connectOrCreate use the exact referenced tuple
captured by their probe. Target update and found upsert publish their compiler's
post-update tuple; a database cascade owns the physical shared-key move. Current
membership writes precede that transition and post-transition writes follow it.

### To-one composition

A to-one payload under an update surface is `(vacate?, supplier, modify?)` — the
create root owns neither `update` nor a vacate key, so it stays at one intent.
The relation owner states that order; `RELATION_MUTATION_KEYS` ordering decides
nothing. `builders/to-one-composition.ts` is the ONE reading of that shape, and
both the compiler and OwnWrite consume it rather than re-deriving it.

A composed modify is never located by planning-time membership correlation,
because that correlation addresses the OUTGOING member — the wrong row. HOW it
is located depends on the supplier, and that is the composition's one branch:

- a `connect` names a unique selector that already exists at construction, so
  its modify is an ordinary selected-record update in the same fragment
  (`suppliedSelector`); that path is unchanged;
- a `create`, or `connectOrCreate`'s missing arm, PRODUCES the row, so nothing
  names it until that write lands. Its modify is a record-series continuation
  (`membershipCapture`): the supplier runs, the singular member is then selected
  through the same exact physical-membership predicate every other arm on the
  edge uses, and the ordinary `RecordUpdateCompiler` runs against the captured
  complete row key. MEMBERSHIP AFTER SUPPLY IS THE SELECTOR, so the supplier is
  never asked to predict or publish its own row key, and no produced-identity
  channel is required.

The continuation is an ordinary nested `RecordSeriesStep` of exactly one member,
placed after its supplier's Parts. It therefore inherits the series substrate
contract unchanged: one interactive transaction, or native atomic-batch segments
whose complete-parent and membership guard is repeated in every later write
batch, or a refusal before the containing member writes. Ordered commit callbacks
strengthen attribution; they are not eligibility.

A parent-held vacate plus supplier is a final-slot fold: compute the final FK
value and write it once in the root statement; never emit a transient null
assignment.

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

A singular ROW-HELD inverse reuses the ordinary child-held-to-one Parts and
record compilers. The composite storage index supplies portable occupied-slot
uniqueness. A slot collision is a genuine unique conflict, not a retryable
missing-target race.

### Polymorphic collections

A `s.polymorphicToMany` slot stores each variant's memberships in one
fixed-target member junction, so the junction owners serve it whole. The rule is
that the collection adds COORDINATION only: no second junction DML owner, no new
relation-kind cross-product, no polymorphic scheduler, no provider-name branch.

Reads compose one branch per member junction in `storage.members` declaration
order. Filters lower `some`/`none` to correlated existence over the named
variant's member table and `every` to an explicit TWO-conjunct `NOT EXISTS` — no
member of the selected arm violates the predicate (read membership-first through
a LEFT JOIN, so an orphan counts as a violation), and no member of any other
configured arm exists. This is deliberately not `negateInner`, which would
compute "every post satisfies P while other variants are allowed" — a silently
wrong truth table whose correct public spelling is `none: { type, isNot: P }`.
`_count` sums one correlated count per member table in declaration order, and
`orderBy: { rel: { _count } }` sorts on that same expression.

`PolymorphicCollectionPart` returns ONE `Part`, not a list, because sibling Parts
are concatenated in list order and N variant Parts could not express a
clear-once barrier. It owns exactly four relation-wide facts — the `set`
clear-all barrier, cross-verb/cross-variant ordering, the single owner-row
publication every leaf correlates on, and a cache footprint that is empty by
measurement (invalidation lives above the engine in `client.ts`). Its compile
order IS the contract: every leaf's guards, then the barrier, then every leaf's
writes. `set` is LOWERED — the parser keeps emitting `set`, the coordinator
rewrites each entry into its insert half and owns the clear half, so ordinary
junction `set` stays byte-identical. The one shape a batch could split between
clear and refill (no transaction, `clearsAll`, owner row key arriving as a
produced output reference) is refused at construction, before any effect.

A membership add on a member whose `inverseCardinality` is `"one"` is a SLOT
REPLACEMENT, owned by `junction-singular-transfer.ts` for both directions: one
capture read, then one write sequence identical on both substrates —
`forUpdate` with the row lock as the premise inside a transaction, an in-batch
CAS with no `expects` in a native atomic batch. A freshly created target is
proven empty structurally, so its capture is elided rather than paid for.

Root `createMany` dispatches on cardinality in `routing.ts`, reading raw rows
before any parse: a ROW-HELD `connect` stays out of the relation-bearing set and
keeps the pinned grouped INSERT; a COLLECTION key is in it, because member
junction rows cannot exist before the owner row does, so the whole call routes to
the ordered record series. A skipped root contributes neither a key nor nested
effects.

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
| `pending-operation.ts` | lazy public model-operation routing entry |
| `pending-execution.ts` | one-shot default/driver-bound execution lifecycle shared by model and raw operations |
| `transaction-operation.ts` | the internal protocol consumed by `$transaction([...])` |
| `write-engine/routing.ts` | route-wide operation gates, shared-envelope parsing, and shell construction |
| `operations/*.ts` | operation-specific SQL, plan, identity, and ordering helpers; not shells |
| `write-engine/CreateOperation.ts` | fresh record compilation and create result |
| `write-engine/UpdateOperation.ts` | public update shell and direct folds |
| `write-engine/RecordUpdateCompiler.ts` | one selected record mutation |
| `write-engine/UpsertOperation.ts` | top-level arm selection and terminal result |
| `write-engine/record-series.ts` | the record-series contract and its routed-operation discrimination |
| `write-engine/CreateManyRecordSeries.ts` | root relation-bearing `createMany` shell |
| `write-engine/UpdateManyRecordSeries.ts` | root relation-bearing `updateMany` shell |
| `write-engine/FreshRecordSeriesPart.ts` | nested relation-bearing `createMany` placement |
| `write-engine/NestedSelectedRecordSeries.ts` | member compilation for a relation owner's captured selected records — the correlated set of a nested relation-bearing `updateMany`, and the singular member a to-one supplier just produced |
| `write-engine/series-result-read.ts` | bounded final set reads and source-order reconstruction |
| `write-engine/target-projection.ts` | complete captured row keys and selected-target projections |
| relation Parts | child-held/junction selection, membership, guards, pins, and edge effects |
| `write-engine/OperationExecutor.ts` | generic fragment execution, including series execution and retry routing |
| `write-engine/OperationFragment.ts` | step and fragment vocabulary |
| `builders/relation-mutation-parser.ts` | parsed mutation programs |
| `builders/relation-data-builder.ts` | bound relation topology, and the classifier every entry point goes through |
| `builders/relation-traversal.ts` | the one read-side physical traversal of a relation occurrence |
| `builders/polymorphic-relation.ts` | row-held member resolution |
| `builders/polymorphic-read-builder.ts` | row-held CASE projection and correlated filters |
| `builders/polymorphic-collection-read-builder.ts` | collection read: one correlated JSON document, one branch per variant in declaration order, reading `only` and `variants` and nothing else |
| `builders/polymorphic-member-join-parts.ts` | the shared member-table join legs both collection reads and filters traverse |
| `builders/polymorphic-mutation.ts` | resolved row-held intent and atomic private storage value |
| `builders/polymorphic-collection-mutation.ts` | binds one collection member for a write leaf |
| `builders/polymorphic-collection-filter-builder.ts` | `some`/`every`/`none` lowering over member tables (`every` as an explicit two-conjunct `NOT EXISTS`, never `negateInner`) |
| `write-engine/PolymorphicCollectionPart.ts` | the ONE direct-collection coordinator: `set` clear-all barrier, cross-verb/cross-variant order, one owner-row publication, empty cache footprint |
| `write-engine/RelationJunctionToOnePart.ts` | singular collection inverse: composition order, the four correlated spellings, owner-oriented membership projection |
| `write-engine/junction-singular-transfer.ts` | the singular member slot-replacement protocol, both substrates |
| `write-engine/relation-membership.ts` | child-held membership and value provenance |
| `JunctionStatements.ts` | junction SQL materialization — one owner, every orientation and arity |
| `result/ResultParser.ts` | result-boundary middleware chains and nested row-parser reuse |
| `result/polymorphic-result-parser.ts` | strict discriminator dispatch and orphan semantics |

Keep the type-only `QueryMetadata` compatibility export, adapter `batchRefs`,
and `JunctionStatements`. `QueryMetadata` is not a runtime boundary. Do not
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
