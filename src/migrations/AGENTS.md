# L12 Migrations — Migration V1

**Location:** `src/migrations/`
**Canonical design:** [`docs/architecture/migration-v1-plan.md`](../../docs/architecture/migration-v1-plan.md)

## 30-second summary

Migration V1 is one authenticated state graph plus one separate, history-free
live synchronization path.

```text
immutable estate descriptor
  + content-addressed schema snapshots
  + content-addressed plain-SQL blobs
  + immutable state manifests and parent transitions
  + database current-state marker
  + append-only database ledger
```

A state is a graph node, not a numbered file. Each state authenticates its
target snapshot and one complete transition from every parent. Branches can
diverge and converge without renaming files or inventing lexical order. Human
names are metadata only.

Production never evaluates migration TypeScript and never reparses display SQL.
It executes only authenticated UTF-8 slices from an authenticated SQL blob,
with the exact closed typed-parameter tuples authenticated by each dispatch ID.

`push` is not history. It plans from the live schema, replans under the target
lock, executes the accepted in-memory program, and proves the destination. It
never reads or writes estate storage and never changes the marker or ledger.

## Domain model

Use these terms exactly:

| Term | Meaning |
| --- | --- |
| **Estate** | One storage root containing an immutable target descriptor, snapshots, SQL blobs, and committed state manifests. |
| **Schema snapshot** | One strict canonical description of the VibORM-managed logical and physical schema. |
| **SQL blob** | Plain review SQL containing every referenced check, forward dispatch, postcheck, and rollback dispatch. |
| **State** | One exact point in history, identified by its canonical manifest rather than its name or position. |
| **Transition** | One parent-specific forward program and rollback policy leading into a state. |
| **State manifest** | The one committed record for a target state, its snapshot, metadata, destination checks, and all incoming transitions. |
| **Marker** | The database's last confirmed state, authenticated arrival path, snapshot, estate, path hash, and revision. |
| **Ledger** | Append-only database evidence for attempts, confirmed steps, outcomes, baselines, recovery, and reset progress. |
| **Push plan** | An ephemeral baseline-specific live transition. It is never inserted into the estate. |

Schema identity and state identity are intentionally distinct. A data-only
transition can produce a new state while retaining the same schema snapshot.
Equal snapshots therefore never prove equal migration state.

The marker and ledger answer different questions:

- the marker says which state and arrival path are last confirmed;
- the ledger says what was attempted and what happened;
- an unfinished ledger attempt means the live database may be between states
  and blocks ordinary work;
- neither representation is reconstructed from the other.

## Estate format

```text
migrations/
├── estate.json
├── snapshots/
│   └── <snapshot-hash>.json
├── sql/
│   └── <sql-hash>.sql
└── states/
    └── <state-id>.json
```

`estate.json` is created once and is immutable. It contains format `"1"`, hash
algorithm `"sha256"`, and the exact `MigrationTarget`. PostgreSQL estates are
schema-bound; MySQL artifacts remain database-relative; SQLite retains its
dialect target. There is no mutable head or state list.

Snapshots, SQL blobs, and state manifests are immutable content-addressed
objects. Snapshot and manifest JSON is canonical RFC 8785 UTF-8 without a BOM.
A state becomes visible only when its manifest is conditionally created after
all referenced snapshot and SQL bytes are durable.

The virtual `null` origin maps to the canonical empty managed snapshot. It is
not a stored state and cannot be redefined.

## Identity and trust boundaries

### Hash rule

`identity.ts` is the one hash owner. Every digest is:

```text
frozen ASCII domain label + 0x00 + exact authenticated bytes
```

The result is lowercase 64-hex SHA-256. Estate, snapshot, SQL, dispatch,
transition, state, path, push-plan, reset-plan, and ledger-event identities
use distinct frozen domains. No locale, insertion order, display formatter, line-ending
conversion, or self-referential checksum participates.

The authenticated chain is:

1. estate hash over exact canonical `estate.json` bytes;
2. snapshot hash over exact canonical snapshot bytes;
3. SQL hash over exact SQL blob bytes;
4. dispatch ID over SQL hash, UTF-8 byte offset, byte length, and canonical
   typed parameters;
5. transition hash over the complete parent transition without its own hash;
6. state ID over the complete state manifest without its own ID.

Every read revalidates the chain. A filename is not proof merely because it
looks like a digest.

Stored snapshot identity (`encodeSnapshot` / `hashSnapshot`) is those exact
canonical bytes. Live physical comparison uses `fingerprintLive` in
`push-fingerprint.ts`. That path is the dialect canonicalization owner: it
projects partial-index predicates through the live database, drops constraint
names when `introspectionReadsConstraintNames` is false, keeps PostgreSQL
primary-key names (an omitted name is `{table}_pkey`, the catalog default),
normalizes types and
defaults, and excludes logical-only history such as `polymorphicStorage`.
Apply, baseline, verify, down, resolve, reset, and push compare live schema
through that function. Do not compare an introspected snapshot with
`encodeSnapshot`. A SQL `DEFAULT NULL` and an omitted default are the same
physical fact. Catalog aliases (`int4[]` / `integer[]`, `NOW()` / `now()`)
are the same physical fact; `normalizeType` and `normalizeDefault` in
`push-fingerprint.ts` are the one owner, including the differ. SQLite
primary-key columns are not nullable even when `PRAGMA table_info` reports
`notnull = 0`. SQLite `autoIncrement` is the `AUTOINCREMENT` keyword, not
every `INTEGER PRIMARY KEY`. SQLite enum types keep the `CHECK (... IN ...)`
suffix the driver writes; introspection reconstructs it from table SQL because
`PRAGMA table_info` returns only `TEXT`. Transactional wrap uses the live producer's
`supportsTransactions`; a dialect that can be transactional still executes
sequentially when that producer cannot open a callback transaction. Catalog
probes bind the resolved namespace and never fall back to `'public'` or
`DATABASE()`. A generated statement with no bound namespace emits no probe
(offline MySQL generate); it does not invent a default. PostgreSQL
introspection reads foreign keys from `pg_constraint`
and keeps a unique index that an FK targets as an index — `information_schema`
drops that pair (`unique_constraint_name` is null; `conindid` also names the
referenced unique index).

### Closed parsing

Hostile estate and control bytes become trusted V1 values only through the
parse modules: `v1-parse-snapshot.ts`, `v1-parse-dispatch.ts`,
`v1-parse-control.ts`, and `v1-parse.ts` for estate, state, and transition
records. `v1-parse.ts` re-exports the sibling owners so callers keep one
import path. The boundary rejects unknown versions, unknown keys, malformed
nested values, non-canonical JSON, invalid order, duplicate parents, and
identity mismatches. Do not cast `JSON.parse()` output to a snapshot,
manifest, marker, or ledger event.

`canonical-json.ts` alone produces and checks canonical JSON bytes.
`v1-types.ts` defines the closed persisted and public shapes; it does not admit
open `unknown` payload bags.

### Exact SQL framing

`sql-blob.ts` owns SQL framing. A dispatch references one SQL blob by hash plus
a UTF-8 byte offset and length. Before the first effect, the complete range
table is checked for matching blob hashes, valid bounds, order, non-overlap,
and exact `\n\n` display gaps. The complete blob is fatal-decoded as UTF-8
before any slice is executed, so a later check cannot fail after stepwise
effects. Execution slices those exact bytes.

Generated DDL already has provider statement boundaries. One manual `Sql` value
is one opaque provider dispatch, even if its text contains internal semicolons.
PostgreSQL dollar-quoted bodies, MySQL routines, and SQLite triggers therefore
do not create fake progress boundaries. MySQL `DELIMITER` is refused because it
is a client command.

Typed parameters are canonical tagged values. `compile.ts` encodes them once;
application decodes those tags through the same SQL boundary. Production does
not derive values from display text.

## One graph

`graph.ts` loads one immutable `MigrationGraph` from committed state manifests.
For one command, every graph-aware operation consumes that same instance. No
consumer rescans storage, orders by filename, or discovers parents independently.

The graph owner validates:

- the estate target and every referenced artifact and hash;
- one manifest per state ID and one transition per parent;
- present parents, snapshots, and SQL blobs;
- roots only from the virtual `null` origin;
- no dangling edge, duplicate edge, cycle, or unreachable history;
- valid leaves, selectors, and real adjacent edges;
- SQL ranges before any dispatch can become executable.

A normal state has one parent. A convergence state has one complete transition
from each parent:

```text
      B
     / \
A ──    ──> D
     \ /
      C
```

A database at B executes only B-to-D; a database at C executes only C-to-D.
The system never guesses that every missing branch should run.

The default target is the unique leaf. Multiple leaves require an explicit
target. State selectors use a full ID, unambiguous prefix, or unambiguous name.
Multiple routes require an explicit `via`; no timestamp, filename, equal
snapshot, or destructive-cost heuristic breaks the tie. `down` follows the
marker's actual arrival path and cannot cross a baseline boundary.

## Storage

`storage/contract.ts` owns the semantic storage contract:

- readers expose estate, state, snapshot, and SQL inventories and raw-byte
  reads;
- writers conditionally publish immutable estate, snapshot, SQL, and state
  bytes;
- reads and inventories are strongly consistent;
- identical bytes at an existing identity are idempotent;
- different bytes at an existing identity are corruption.

Parsers, not storage drivers, turn bytes into trusted domain values. An
unreferenced blob can be reported by `check`, but can never become executable
merely because an inventory listed it.

`storage/fs-estate.ts` owns filesystem publication:

```text
unique sibling temp
  → write and fsync
  → fresh-read verification
  → hard-link no-replace publication
  → exact-byte verification on EEXIST
  → temp unlink
  → parent-directory fsync
```

Check-then-rename is not an atomic no-replace publication. A filesystem that
cannot provide the required primitive is not a writable V1 estate.
`storage/memory.ts` is the in-memory implementation.
`storage/conformance.ts` is the reusable contract proof for writable drivers.

Eventually consistent, last-writer-wins storage is not directly writable under
this contract. It requires an external single-writer/conditional-publication
owner; the migration layer does not weaken its guarantees.

## Compilation and generation

There is one schema serializer (`serializer.ts`), one structural differ
(`differ.ts`), and one ambiguity/destructive resolver (`resolver.ts`). Migration
V1 reuses them. It does not fork schema comparison for estates or for `push`.

`compile.ts` is the one transition compiler. It turns resolved
`DiffOperation` values or complete manual `Sql` fragments into ordered
operations, checks, exact dispatches, rollback policy, typed parameters, and one
authenticated SQL blob. Dialect SQL, probes, and transactional classification
remain the bound `MigrationDriver`'s responsibility.

`generate-v1.ts` owns candidate construction and publication:

1. hydrate and validate the schema, retaining the exact resolved relation index;
2. load and validate one graph;
3. serialize the desired snapshot;
4. resolve the selected parent or all leaves to converge branches;
5. use the existing differ and resolver for each parent, then
   `prepareSchemaProgram` so generate and push compile the same operation order;
6. compile every parent-specific transition completely;
7. compute all hashes and return the complete candidate for `dryRun`;
8. otherwise publish snapshot and SQL bytes first, then publish the state
   manifest as the sole visibility boundary.

Manual work enters only through `GenerateOptions.manualMigration`. It supplies
complete parent transitions and destination checks before generation. The
estate stores final SQL and closed manifests, not a durable TypeScript migration
language. A state is wholly generated or wholly manual; custom text is not
spliced into generated operations.

## Live control and execution

`control.ts` owns the two target-qualified control tables:

```text
_viborm_migration_state  — one current marker row
_viborm_migration_log    — append-only ledger events
```

It also owns their validated naming, qualification, marker compare-and-swap,
and ledger append boundary; every row is delegated to `v1-parse.ts` for the
sole strict admission. An attempt is unfinished only when a start event has
no terminal event for the same attempt id — membership, not row or
timestamp order. Started and applied often share one millisecond, so a
sort by `startedAt` then `eventId` can put the closer first. Read-only
commands never bootstrap missing control tables or translate arbitrary
provider failures into an empty history. Bootstrap creates the state table
before the log table. An empty state-only table is therefore the one recognized
interrupted-bootstrap shape only after the dialect introspector and the native
CHECK catalog prove its exact definition and the attachment probe proves that
no trigger, rule, policy, or row-security behavior can alter recovery. This
state remains distinct from total absence. Only the bootstrap owner may drop
and recreate it; push and every other command refuse it. A colliding or
malformed empty table, a state table with a marker, or a log-only shape remains
corrupt partial history. `readControlState` is the one reader: it authenticates
a present pair once before returning marker and ledger truth. Transactional
apply, baseline, and reset perform a required bootstrap inside their first real
effect/publication transaction, so a failed first migration cannot leave new
control tables behind. Stepwise providers retain the recoverable bootstrap
protocol.

`apply-v1.ts` owns forward application. Before effects it authenticates the
complete selected graph, path, state manifests, snapshots, SQL blobs, ranges,
dispatches, and parameters. Under one pinned target lock it then:

1. admits the concrete provider and proves the exact target;
2. reads marker and unfinished ledger state;
3. selects from the actual marker;
4. proves the live schema matches the marker's authenticated snapshot;
5. executes only authenticated SQL slices with typed parameters;
6. proves operation postconditions and the final target fingerprint;
7. compare-and-swaps the marker and appends ledger evidence;
8. releases the lock on the same physical producer.

Transactional providers keep effects, final proof, marker, and success evidence
inside the real transaction when the complete transition permits it. Stepwise
providers record durable progress and honest `partial` or
`may-have-committed` outcomes. An ambiguous opaque dispatch blocks later work;
the system never claims rollback merely because code opened a nominal
transaction.

`operators.ts` owns the operator workflows. `status`, `verify`, and `log` are
read-only. `baseline` requires exact live equality and a provable structural
root path; it publishes the marker and `baselined` event in one transaction
when the producer can. `down` preflights every reverse program, appends
`started` before the first rollback dispatch, records step progress, and uses
the same transaction wrap as apply. An unfinished rollback can only be resumed
by `down()`. `resolve` accepts only outcomes established by origin/destination
proof; generated structural opacity may complete from a fingerprint, while
manual opaque work still needs state checks. `reset` preloads and authenticates
the complete clear-and-replay program before the first drop, classifies every
replay transition before clearing, and executes contiguous transactional replay
groups in real transactions without letting one stepwise edge flatten the whole
path. Resume accepts only an exact contiguous confirmed-dispatch prefix. It
never replays a committed opaque dispatch, and an announced stepwise opaque
dispatch without committed evidence is an ambiguous outcome. If the marker
already names the target after a crashed CAS, reset closes the exact sole reset
attempt only when the marker revision and arrival path prove that reset's CAS
advanced. An unchanged same-target source marker is not success and still runs
clear-and-replay.

## Shared live infrastructure — no second engine

Migration V1 extends the established migration infrastructure:

| Invariant | Existing owner reused by every V1 path |
| --- | --- |
| Exact durable estate target and namespace binding | `target.ts` |
| Command-local namespace spelling | `resolveCommandDriver` in `pinned-session.ts` |
| Artifact-relative versus live-qualified SQL | the dialect `MigrationDriver`, selected by required `DDLContext.destination` |
| Concrete-provider capability admission | `admission.ts` |
| One pinned producer, target selection, lock, and unlock proof | `pinned-session.ts` |
| Dependency-safe contained namespace clear | `live-reset.ts` |
| Model graph to snapshot | `serializer.ts` with the exact resolved relation index |
| Structural difference | `differ.ts` |
| Rename/destructive resolution | `resolver.ts` |
| Dialect DDL, probes, and atomicity facts | the bound `MigrationDriver` |

Do not wrap these owners in a V1-specific namespace engine, qualifier, lock,
resetter, admission registry, differ, resolver, or executor. Lock, marker CAS,
and artifact authentication protect different failure modes; none replaces
another.

## `push` is history-free

`push-v1.ts` owns V1 push identity, inert consent, marker interlock, and final
result shape. `push/index.ts` remains the dialect-aware live planning/execution
path. It is deliberately history-free and **must never receive or read estate
storage**.

The push flow is:

1. validate and serialize the desired schema;
2. introspect the exact live target and use the one differ/resolver;
3. compile one immutable internal baseline-specific program and hash every fact
   that can affect execution;
4. return an effect-free `dryRun` result and inert consent when requested;
5. reacquire the target lock, re-introspect, and reproduce the program;
6. require exact consent for destructive or force-reset work;
7. execute only that locked in-memory program;
8. re-introspect and prove live equals `fingerprintLive` of the desired
   snapshot after effects. Plan-time `desiredFingerprint` is a consent
   digest; it is not the attest target, because partial-index predicates
   cannot be canonicalized against tables that do not exist yet.

Consent is not authority and the preview is not an executable public plan. A
forged or stale value can only cause refusal. Resolution callbacks run outside
the lock; their normalized decisions are closed into consent and checked
against the locked replan.

Push may inspect the database control plane only to prevent history from being
made false. A non-empty push against a valid migration marker is refused. A
no-op is allowed only after the marker, unfinished-attempt state, desired
snapshot, live fingerprint, and empty authoritative diff all agree. This does
not verify estate storage; `verify` owns that operation.

Force-reset is a plan kind, not generic authorization. `dryRun` has zero
database and storage effects. The complete empty-to-target program and
dependency-safe clear are compiled before anything is dropped.

## Single owners

| Invariant or action | One owner |
| --- | --- |
| Domain-separated SHA-256 identity | `identity.ts` |
| Live physical fingerprint | `push-fingerprint.ts` `fingerprintLive` |
| Operation execution order | `utils.ts` `sortOperations` |
| Generated schema compile order | `utils.ts` `prepareSchemaProgram` |
| RFC 8785 canonical JSON bytes | `canonical-json.ts` |
| Closed V1 persisted/public shapes | `v1-types.ts` |
| Hostile artifact, marker, and ledger admission; derived hashes | `v1-parse.ts` |
| SQL blob framing, range validation, and exact slicing | `sql-blob.ts` |
| Semantic estate storage promises | `storage/contract.ts` |
| Atomic filesystem publication | `storage/fs-estate.ts` |
| In-memory estate behavior | `storage/memory.ts` |
| Writable-storage acceptance proof | `storage/conformance.ts` |
| Graph construction, selector resolution, and route selection | `graph.ts` |
| Structured operation, dispatch, rollback, and parameter compilation | `compile.ts` |
| Candidate generation and manifest-last publication | `generate-v1.ts` |
| Marker, ledger, control naming, qualification, and CAS | `control.ts` |
| Live transaction wrap predicate | `pinned-session.ts` `mayWrapTransaction` |
| Authenticated forward execution | `apply-v1.ts` |
| Offline estate integrity findings | `check.ts` |
| Status, verification, history display, rollback, baseline, recovery, and history-aware reset | `operators.ts` |
| Push consent identity and history interlock | `push-v1.ts` |
| History-free dialect-aware live planning/execution | `push/index.ts` |
| Migration client composition | `client.ts` |
| Package export boundary | `index.ts` |

If a new check cannot be assigned to exactly one row, fix the ownership before
adding it. Consumers use trusted projections; they do not re-derive the fact.

## Public operation surface

The migration client exposes only these operation nouns:

```text
generate
check
list
show
graph
status
verify
log
apply
down
baseline
resolve
reset
push
```

`client.ts` is the one composition root. `index.ts` is the intentional package
surface. `apply` targets a full state ID, unambiguous prefix, or unambiguous
name; numeric positions have no meaning. `dryRun` is an option on the relevant
operation, not a second execution API.

## Forbidden architecture

The following concepts are removed and must not return under aliases:

- a **journal**, mutable global manifest, mutable head, or timestamp order;
- **squash** or inferred history compaction;
- a public or internal orchestration class named **`MigrationContext`**;
- path-level storage **`get` / `put` / `delete`**;
- **`parseStatements`**, breakpoint/comment parsing, or any SQL parser service;
- **`split(";\n")` as execution framing** or any delimiter-derived boundary;
- one **latest snapshot** used as history;
- **numeric apply indexes** or filename order;
- a **migration manager**;
- an **event bus**;
- a **second differ** or resolver;
- a **public execution plan** or caller-executable operation program;
- a second migration executor, provider wrapper, generic storage transaction,
  or control-plane registry.

In particular, do not “temporarily” read legacy files to ease a transition.
VibORM is unreleased: V1 has no compatibility reader, alias, repair path, or
journal migrator.

## Navigation

| I want to… | Start here | Also inspect |
| --- | --- | --- |
| Change a hash domain or identity rule | `identity.ts` | `v1-parse.ts`, golden identity vectors |
| Change canonical JSON behavior | `canonical-json.ts` | `v1-parse.ts` |
| Change a V1 persisted shape | `v1-types.ts` | `v1-parse.ts`, `identity.ts` |
| Change strict artifact/control parsing | `v1-parse.ts` | `v1-types.ts`, `canonical-json.ts` |
| Change SQL range framing or slicing | `sql-blob.ts` | `compile.ts`, `apply-v1.ts` |
| Add a storage implementation | `storage/contract.ts` | `storage/conformance.ts`; copy neither parser nor graph logic |
| Change filesystem durability | `storage/fs-estate.ts` | `storage/contract.ts`, `storage/conformance.ts` |
| Change graph validity, selectors, or route ambiguity | `graph.ts` | `v1-parse.ts` |
| Change snapshot serialization | `serializer.ts` | schema relation resolution and bound migration drivers |
| Change structural diff behavior | `differ.ts` | `resolver.ts`; do not add an estate-specific differ |
| Change dialect statements, probes, or atomicity | the dialect `MigrationDriver` | `compile.ts`, `DDLContext.destination` |
| Change generated/manual transition compilation | `compile.ts` | `sql-blob.ts`, `v1-types.ts` |
| Change state generation or publication order | `generate-v1.ts` | `graph.ts`, storage contract |
| Change marker, ledger, control tables, or CAS | `control.ts` | `v1-parse.ts`, `pinned-session.ts` |
| Change forward application | `apply-v1.ts` | `graph.ts`, `control.ts`, `compile.ts` |
| Change offline integrity reporting | `check.ts` | `graph.ts`, storage inventories |
| Change rollback, baseline, recovery, or reset workflow | `operators.ts` | `control.ts`, `live-reset.ts`, `apply-v1.ts` |
| Change push consent or migration-marker coexistence | `push-v1.ts` | `control.ts`, `identity.ts` |
| Change live push planning | `push/index.ts` | `push/planner.ts`, `differ.ts`; never estate storage |
| Change target admission, qualification, locking, or clear behavior | `admission.ts`, `target.ts`, `pinned-session.ts`, or `live-reset.ts` respectively | bound migration drivers |
| Change the programmatic operation surface | `client.ts` | `index.ts`; keep the noun list exact |

## Non-negotiable review questions

Before accepting an L12 change, answer all of these:

1. Which single owner now answers the changed invariant?
2. Are the exact bytes and typed parameters production executes authenticated?
3. Can every artifact and the full selected path fail before the first effect?
4. Does branch convergence use one explicit transition per parent?
5. Are marker truth and ledger evidence still separate?
6. Does the command use the existing target, qualification, admission, lock,
   reset, serializer, differ, resolver, compiler, and driver owners?
7. Is a stepwise failure reported without pretending it rolled back?
8. Does `push` remain fully independent of estate storage and history mutation?
9. Did any forbidden concept or unofficial public noun reappear?

The design goal is not the largest migration framework. It is the smallest one
whose estate bytes, graph, database state, execution, and operator claims cannot
contradict each other.
