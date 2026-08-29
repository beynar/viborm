# Migrations - Schema Sync & Migration Files

**Location:** `src/migrations/`
**Layer:** L12 - Migrations (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Provides two approaches for syncing TypeScript schema to the database:

1. **Push** - Direct sync for development (no migration files)
2. **Migrate** - File-based migrations for production (versioned SQL files)

---

## Entry Points

| File | Purpose |
|------|---------|
| `push/` | Direct push workflow (serialize → diff → execute) |
| `client.ts` | `createMigrationClient()` programmatic API |
| `generate/index.ts` | Generate migration files |
| `apply/index.ts` | Apply migrations, status, pending |
| `apply/down.ts` | The ONLY rollback verb (executes down artifacts under the lock) |
| `context.ts` | Shared context (locking, tracking, execution) |
| `serializer.ts` | Model → SchemaSnapshot |
| `differ.ts` | Compare snapshots, detect changes |
| `resolver.ts` | Ambiguous/destructive change resolution |
| `types.ts` | SchemaSnapshot, DiffOperation, MigrationEntry types |
| `generate/polymorphic-history.ts` | Non-SQL history for stable polymorphic members |
| `generate/manual-artifact.ts` | Validates `GenerateOptions.manualMigration` (all five refusals) |
| `statement-safety.ts` | The ONE artifact classifier — refuses DIRECT boundary controls, and is not a sandbox (Rule 6c) |

### Subdirectories

| Directory | Purpose |
|-----------|---------|
| `drivers/` | Migration-specific drivers (DDL generation, introspection) |
| `storage/` | Storage drivers for migration files (filesystem, etc.) |
| `generate/` | Migration file generation and formatting |
| `apply/` | Apply, status, pending, down operations |
| `push/` | Push workflow internals (planner, executor, format, enum-removals) |

---

## Two Workflows

### Push (Development)

Direct sync - no migration files:

```
Models → serialize() → SchemaSnapshot
                              ↓
Database → introspect() → SchemaSnapshot
                              ↓
                          differ()
                              ↓
                      DiffOperations
                              ↓
                    User resolves ambiguities
                              ↓
                    migrationDriver.generateDDL()
                              ↓
                    driver.execute()
```

### Migrate (Production)

File-based migrations with journal:

```
Models → serialize() → SchemaSnapshot
                              ↓
Previous snapshot → diff() → DiffOperations
                              ↓
                    migrationDriver.generateDDL()
                              ↓
                    Write to SQL file + Update journal
                              ↓
Later: apply() reads files → execute in transaction
```

---

## Core Concepts

### SchemaSnapshot (Database-Agnostic)

```typescript
interface SchemaSnapshot {
  tables: TableDef[];
  enums?: EnumDef[];  // PostgreSQL only
  polymorphicStorage?: PolymorphicSnapshotStorage[]; // generated-file metadata
}

interface TableDef {
  name: string;
  columns: ColumnDef[];
  primaryKey?: PrimaryKeyDef;
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  uniqueConstraints: UniqueConstraintDef[];
}
```

`polymorphicStorage` is descriptive generated-file history. It is not a table
or DDL operation, and the structural differ ignores it.

It is a `kind`-tagged union, one arm per slot cardinality, and both arms are
LOGICAL ONLY — no physical fact is duplicated into either:

```typescript
type PolymorphicSnapshotStorage =
  | PolymorphicToOneSnapshot   // kind: "toOne"
  | PolymorphicToManySnapshot; // kind: "toMany"
```

A `toOne` arm carries `{ ownerTable, relation, storageRef, members }`, each
member `{ publicType, storedType, targetTable }`. `storageRef` is the join key
into the owner table's `relationStorage` registry — the physical type-column name
at serialization time, opaque to every reader and normalized through accepted
rename operations before history joins.

A `toMany` arm carries `{ ownerTable, relation, members }`, each member
`{ publicType, storedType, targetTable, memberJunctionTable, inverseCardinality }`.
It needs no `storageRef`: each member names its junction table directly, and the
structural differ owns that table's shape — columns, primary key, reverse index,
both foreign keys, and the singular member's unique constraint — entirely.

### Migration Estate Target

One discriminated value names the estate a history was generated for:

```typescript
type MigrationTarget =
  | { readonly dialect: "postgresql"; readonly namespace: string }
  | { readonly dialect: "mysql" }
  | { readonly dialect: "sqlite" };
```

PostgreSQL carries its schema because generated artifacts are schema-qualified.
MySQL is dialect-only ON PURPOSE — artifacts are database-relative, so one
estate deploys to `app_dev`, `app_test` and `app_prod` — and the LIVE MySQL
destination comes from the adapter's namespace at the live boundary, never from
the journal and never from `DATABASE()`.

`resolveMigrationEstate(driver)` is the only producer of BOTH facts — the
durable target and the live namespace — from ONE read of `adapter.namespace`.
It is reached through `getMigrationDriver(driver)`, which returns a frozen
adapter-bound view of the registered stateless singleton and must never read
that fact a second time: an accessor-backed custom adapter could answer
differently, and the view would then name one estate and render another. A
PostgreSQL adapter that declares no namespace is refused there: it must not
silently acquire `"public"`.

One internal `MigrationContext.readEstateJournal()` is the SINGLE
exact-estate-target gate. A dialect difference is `MIGRATION_DIALECT_MISMATCH`;
a PostgreSQL schema difference is `MIGRATION_INVALID_STATE`. Every high-level
verb and every named migration-client accessor passes through it BEFORE it
reads a snapshot or artifact, creates or queries tracking, writes storage, or
executes SQL. `migrations.storage` stays the deliberately unbound low-level
escape.

PostgreSQL qualifies in BOTH destinations — a PG estate is schema-bound in the
artifact and live alike, so `destination` is legitimately unread by its renderers
and artifact ≡ live is witnessed. MySQL qualifies only at `destination === "live"`;
its artifacts stay database-relative, and an UNBOUND MySQL driver renders bare for
both destinations (which is what keeps §12.21 true) while its catalog reads refuse
rather than falling back to `DATABASE()`. Managed PostgreSQL enum types are derived
from what this estate manages, replacing the old `_enum`-suffix guess, and the
enum-cast strip is keyed on the column's catalog-proven `udt_schema`/`udt_name`.

### Migration Journal

Tracks migration history in `meta/_journal.json`:

```typescript
interface MigrationJournal {
  readonly version: "3";   // "2" → "3" when the top-level dialect became the target
  readonly target: MigrationTarget;
  readonly entries: readonly MigrationEntry[];
}

interface MigrationEntry {
  idx: number;                 // Sequential index
  version: string;             // Timestamp version
  name: string;                // kebab-case name
  when: number;                // Unix timestamp
  checksum: string;            // SHA256 of SQL content
  mode: "generated" | "manual";        // How the up artifact was produced
  rollback:                            // The policy this entry commits to
    | { kind: "automatic" }
    | { kind: "manual" }
    | { kind: "irreversible"; reason: string };
}
```

`mode` and `rollback` are REQUIRED. An entry with no policy would have to be
given a default, and the only available default (`automatic`) is exactly the
bypass the policy exists to close.

`readJournal()` is the SINGLE STRUCTURAL journal parser — `apply`, `down`,
`squash`, `reset`, `status` and the client accessors all reach the journal
through the context gate, which reaches it through here — so the format is
validated once: a journal whose `version` is not `"3"`, whose `target` is
missing, malformed, unknown, or carrying fields its arm does not define, one
that still carries a top-level `dialect` beside the target, or any entry missing
`mode`, missing `rollback`, carrying an unknown rollback kind, or declaring
`irreversible` with a blank `reason`, is refused with `V11009`. There is no
legacy reader and no journal migrator; regenerate the estate instead. After that
guard `entry.rollback` is total and no downstream verb re-checks it. Whether a
readable journal is THIS client's estate is a different question with a
different owner — the context gate.

### Applied State Is Read-Only

`MigrationContext.readAppliedMigrations()` is the one applied-state reader and
it NEVER creates the tracking table. It obtains this command's driver view
first — which is where the configured namespace is proven, and where MySQL's
server spelling is answered — and renders through it, then establishes an absent
tracking table either positively — SQLite's one exact `sqlite_schema` lookup on
the configured name — or through the dialect's exact missing-table translation.
That view has ONE owner, `resolveCommandDriver` in `pinned-session.ts`: a locked
command gets it when its producer is reserved, and a read-only command
(`status()`, `pending()`, dry push) asks the same owner without taking a lock. Every other failure surfaces: there is no
catch-all that reports permissions or transport failures as an empty estate.
`ensureTrackingTable()` is a WRITE and lives only inside an admitted effectful
owner.

**What checksum verification proves.** Only that the journal entry and the
tracking row agree (`apply/index.ts`, `apply/down.ts`). The written file embeds
the checksum it would have to hash to, so artifact bytes are never re-verified
against the journal. Do not describe checksums as artifact integrity.

### Storage Drivers

Abstract storage for migration files. Concrete implementations:

- `FsStorageDriver` - Filesystem (default)
- Custom drivers possible (S3, database, etc.)

```typescript
abstract class MigrationStorageDriver {
  abstract get(path: string): Promise<string | null>;
  abstract put(path: string, content: string): Promise<void>;
  abstract delete(path: string): Promise<void>;

  // High-level operations (implemented by base class)
  readJournal(): Promise<MigrationJournal | null>;
  writeJournal(journal: MigrationJournal): Promise<void>;
  readSnapshot(): Promise<SchemaSnapshot | null>;
  writeSnapshot(snapshot: SchemaSnapshot): Promise<void>;
  readMigration(entry: MigrationEntry): Promise<string | null>;
  writeMigration(entry: MigrationEntry, content: string): Promise<void>;
}
```

### Migration Drivers

Separate from database drivers. Handle DDL generation and introspection:

```typescript
abstract class MigrationDriver {
  // `ctx.destination` is REQUIRED ("artifact" | "live") and reaches EVERY
  // renderer arm through the one dispatcher. There is no default and no mode.
  abstract generateDDL(operation: DiffOperation, ctx: DDLContext): string;
  // The namespace travels as an argument, so no ambient connection state can
  // pick the estate.
  abstract introspect(
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<SchemaSnapshot>;
  abstract generateCreateTrackingTable(tableName: string): string;
  // ... more methods
}
```

---

## Programmatic API

```typescript
import { createMigrationClient } from "viborm/migrations";
import { createFsStorageDriver } from "viborm/migrations/storage/fs";

const migrations = createMigrationClient(client, {
  storageDriver: createFsStorageDriver("./migrations"),
  tableName: "_viborm_migrations",
});

// Generate a migration
await migrations.generate({ name: "add-users" });

// Apply pending migrations
await migrations.apply();

// Get status
const statuses = await migrations.status();

// Push (no files) - works without storageDriver
await migrations.push();
```

---

## CLI Commands

```bash
# Push (direct sync, no files)
viborm push
viborm push --dry-run
viborm push --accept-data-loss

# Migrate (file-based)
viborm migrate generate --name add-users
viborm migrate apply
viborm migrate down --steps 1
viborm migrate status
```

Four subcommands, and `down` is the only rollback. There is deliberately no
`drop`: untracking an applied migration while its schema changes stay live is
the bypass a persisted rollback policy exists to close.

---

## Core Rules

### Rule 1: Separation of Concerns

- **Serializer** - Pure function: models → snapshot
- **Differ** - Pure function: snapshots → operations
- **MigrationDriver** - DDL generation (dialect-specific)
- **StorageDriver** - File I/O (filesystem, S3, etc.)

### Rule 2: Explicit Ambiguity Resolution

When column/table dropped AND added, always ask user. Never assume rename.

### Rule 3: Checksum Verification

Migrations are checksummed. Modifying an applied migration is an error.

### Rule 4: Atomicity Is The Dialect's

Each migration is applied in a transaction on every dialect that has one to
open, and a failure rolls that migration back. MySQL commits DDL implicitly, so
no transaction is opened there and none is faked: the entry runs as one
SEQUENTIAL PROGRAM on the pinned producer, and a failure reports the last
statement that completed, states that nothing was rolled back, and makes no
claim about the statement that failed. One owner answers for every such program
— apply, ordinary push, the force-reset rebuild, down and the reset replay —
and it is `runSequentialProgram` in `pinned-session.ts`.

SQLite table recreation reads the introspected pre-batch snapshot through one
schema-level replay owner. That replay first evolves the effective table set
through same-batch creates, drops, and renames, then applies local table changes
and the schema-wide inbound-FK effects of native table or column renames. Both
`SQLite3MigrationDriver.getCurrentTable` and the D1 relation census consume that
same effective set. A later recreation must rebuild the definition SQLite holds
at that point in the batch, not restore a stale reference from the snapshot or
miss a relation created earlier in the program.

`native-rename.ts` is the ONE snapshot owner for the schema-wide effect of a
native table or column rename: table/column identity, primary-key/index/unique
columns, partial-index predicate column references, local and self foreign-key
columns, and inbound foreign-key targets. Its predicate rewrite is lexical: it
preserves quoted values, escape strings, dollar-quoted bodies, comments,
function names, casts, and collations. SQLite replay, iterative ambiguity
resolution, and generated-down inversion all consume it. An accepted rename
updates a working source snapshot and reruns the ordinary differ with its
original options until no ambiguity remains; never add a renamed-table inner
differ or append post-rename operations to a pre-rename diff.

A resolve callback authorizes only the kind of change the planner supplied.
The planner passes that caller-known kind to the one result validator; callback
mutations of the public change object's discriminant never select another
authorization language. Enum mappings and use-null decisions are authoritative
only when made through that exact change object's methods. Their private state,
not the callback-visible `_mappings` or `_useNullDefault` presentation fields,
is what validation, planning, and the CLI dry-run recorder consume.

### Rule 5: Journal is Source of Truth

The journal tracks which migrations exist. The database tracks which are applied.

### Rule 6: Polymorphic Storage Is Relation-Owned, And Its History Is Refused Or Owned

A to-one polymorphic field serializes two private columns and one composite
index from its validated storage descriptor:

```text
<relation>_type
<relation>_id
<mappedOwnerTable>_<relation>_poly_idx  ON (type, id)
```

Required relations make both columns non-null; optional relations make both
nullable. The composite index is non-unique for a plural inverse (`s.toMany`)
and unique for a singular one (`s.toOne`).

A collection polymorphic field instead serializes ONE MEMBER JUNCTION TABLE PER
VARIANT, emitted by `serializeMemberJunction` from the same
`PolymorphicJunctionMember.junction` topology the engine binds — never
reconstructed from naming conventions. Each member table carries a composite
primary key over both complete sides in canonical order, one non-unique index
over the complete SECOND side (emitted unconditionally so every member table
shares one template shape), two `cascade`/`cascade` foreign keys, and — when that
member's `inverseCardinality` is `"one"` — a `UNIQUE` over the complete TARGET
side. The unique side is the target group itself, never the reverse index
flipped and never a primary-key prefix, because when the target sorts
canonical-first neither of those makes the target columns unique. Referential
actions on a member junction are fixed, so member junctions never consult the
ordinary pair's actions and no synthetic ordinary relation state exists
anywhere.

Changing inverse cardinality is therefore an ordinary structural diff — an index
or unique-constraint flip on a to-one slot, an added or dropped unique
constraint on the one affected member table for a collection. Existing duplicate
rows make the restricting direction fail
transactionally at the database; VibORM does not synthesize deduplication DML.
The private columns never enter public scalar state, and no cross-target FK or
CHECK constraint is emitted for row-held storage. A variant-bound plural inverse
is a member VIEW and is excluded from the serializer's ordinary junction walk;
the half-pair such a view could otherwise leave behind is now unconstructible
rather than refused, because one resolved slot carries exactly one edge — a slot
bound to a carrier member is not also an ordinary junction endpoint.

`generate/polymorphic-history.ts` is the SOLE comparator after accepted
structural renames, and classification is total. A public rename with stable
storage and target metadata is metadata-only. A stored-value change, member
removal, retarget, unexplained junction move, or cardinality flip is
**data-bearing**, and generation refuses it outright (`V11010`) — there is no
acknowledgement API and no resolver escape.

The one input that lifts that refusal is a complete caller-owned artifact:

```typescript
await migrations.generate({
  name: "subject-to-many",
  manualMigration: {
    up: [/* create destination, copy membership, remove source */],
    rollback: { kind: "manual", sql: [/* ... */] },
    // or: { kind: "irreversible", reason: "…" }
  },
});
```

Supplying it puts the WHOLE migration in manual mode — caller-elected and
unconditional, whether or not a data-bearing transition exists. Generation emits
only those statements and never appends generated DDL around them, while still
computing the complete diff and snapshot for reporting and history. It is a
suppression INPUT to classification, never an output of it, and it does not
suppress snapshot-coherence or stale-format refusals: those mean the snapshot
itself is wrong, not that a transition needs executing.

`generate/manual-artifact.ts` owns every artifact refusal (all `V11010`): an
`up` that parses empty, a `manual` rollback whose `sql` parses empty, a blank
`irreversible` reason, and a missing `name`. "Parses empty" is
`parseStatements(addStatementBreakpoints(...))` — the same parser `apply()` and
`down()` read artifacts back with, so comment-only and whitespace-only artifacts
are empty everywhere, by one definition.

An irreversible migration still gets a comment-only down artifact written, which
is safe only because `down()` dispatches on the persisted policy strictly BEFORE
it opens any artifact — while the same comment-only bytes under an `automatic`
or `manual` policy are fatal.

`push()` compares live structure only: introspected text columns cannot recover
discriminator history, so push cannot detect a stored-value rename, removal, or
retarget. Push users must migrate data before changing those mappings.

### Rule 6b: Rollback Reads Everything Under The Lock — On One Pinned Session

`down()` and `squash()` do all of it inside `ctx.withLockedSession`: read the
journal, read applied state, recompute the group, verify checksums, refuse on
policy, validate every artifact, and only then execute. The dry-run return comes
AFTER the whole preflight, because the CLI confirms against the dry run and a
preview that cannot report a refusal is not a preview.

State that honestly: the in-lock recomputation closes the window between the
caller's request and lock acquisition by recomputing, not by trusting the lock.
The lock is now CONNECTION-PINNED — `withLockedSession` reserves ONE physical
session, and the acquisition, every authoritative read, every statement and the
release all run on it — and both the acquisition and the release are PROVEN from
the provider's own answer, an unproven one destroying that session rather than
returning it to a pool holding a lock nobody owns. `apply()` takes the same lock
and commits once per entry inside it, rereading the authoritative journal and
tracking state before each entry. What stays weak is SQLite and libSQL: they
reserve nothing, take no lock, and report success, so on those substrates the
in-lock recomputation is still the ONLY defence.

### Rule 6c: The Artifact Classifier Refuses Direct Controls, And Is Not A Sandbox

`statement-safety.ts` is the ONE lexical classifier, and it runs before any
artifact effect. It refuses DIRECT boundary control at the head of a statement,
read in each dialect's own comment and string grammar: PostgreSQL transaction
control and every `pg_advisory_*` call, quoted or schema-qualified; MySQL
transaction/XA control, `SET autocommit`, table lock/unlock, and every named-lock
function. `PREPARE TRANSACTION` is refused as a two-word PHRASE, because
`PREPARE plan AS ...` leads with the same word and controls nothing.

It is **not a sandbox**, and no source comment, doc, or error message may say
otherwise. A dollar-quoted body is DATA to the scan — it has to be, or every
ordinary `CREATE FUNCTION` is refused — and the same bytes are a statement to the
server, so `DO $$ BEGIN PERFORM pg_advisory_unlock_all(); END $$` frees the
migration lock mid-command, and a safe-named function or dynamic SQL is the same
escape by another route.
`tests/unit/migrations/pinned-migration-session.core.test.ts` runs that exact
artifact through `apply()` on a real PostgreSQL and pins the lock gone.

Manual migration SQL is therefore trusted last-mile authority. Do NOT answer a
procedural escape with another spelling in the scanner: the enumeration does not
close, and each addition costs valid author SQL. The deliberate case is answered
after the fact by the release PROOF on the pinned session (Rule 6b), which fails
the command and discards the session when the lock it acquired is no longer
held. Add a spelling only for a DIRECT statement the scanner already reads and
misclassifies.

### Rule 7: Junction Sides Are Complete Stored References

The relation layer resolves each many-to-many side into one ordered group of
junction columns paired with the endpoint row-key fields. The serializer uses
those groups unchanged for columns, the combined junction primary key, the
reverse-side index, and both foreign keys. Never project a compound side to its
first member or rederive positional names in migration code.

The serializer consumes those resolved physical names unchanged. Ordinary
defaults use schema object keys, not JavaScript variable names or mapped table
names; a complete `.through().source().target()` declaration pins the table and
both tokens. Variant-member defaults use the mapped owner table as the table
prefix and the owner schema key as the owner token; an exact `.through(...)`
entry pins `table`, `source`, and `target`.

---

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Do This Instead |
|--------------|--------------|-----------------|
| Assuming rename | Data loss if actually drop+add | Ask user via resolver |
| Modifying applied migrations | Checksum mismatch error | Create new migration |
| Skipping storage driver | Can't use file-based operations | Use `createFsStorageDriver()` |
| Hardcoded dialect SQL | Breaks other databases | Use `migrationDriver.generateDDL()` |
| Silent destructive ops | Unexpected data loss | Require confirmation |
| Treating polymorphic metadata as DDL | Duplicates structural ownership | Keep history in `generate/polymorphic-history.ts` |
| Expecting push to infer discriminator history | Live text columns contain no public-member history | Use generated snapshots and explicit data migration |
| Untracking an applied migration to "undo" it | Leaves the schema live and bypasses manual/irreversible policy | `migrations.down()` — it executes the artifact and untracks together |
| Writing an empty or comment-only down artifact | Rollback would advance tracking past SQL that never ran | Declare `{ kind: "irreversible", reason }` |
| A second journal reader or SQL parser | Two definitions of "current format" or "non-empty" cannot agree | `storage.readJournal()` and `parseStatements()` are the only ones |
| Adding a classifier spelling to stop procedural SQL | The scanner reads a dollar-quoted body as data and the server runs it, so the enumeration never closes while valid author SQL starts failing | Keep the honest contract (Rule 6c); the release proof answers the deliberate case |

---

## Fixed-decimal migration contract

Schema snapshots carry the one decimal descriptor `{ precision, scale }`; they
do not record a native/fixed mode or a client result preference.
`src/migrations/decimal.ts` owns the shared descriptor-transition questions,
storage classification, MySQL list marker, and native-provider fit predicates.
`src/migrations/drivers/sqlite/decimal.ts` owns only SQLite's reserved CHECK
carrier and exact table-rebuild conversion expressions; do not move those
dialect decisions back into the shared module or duplicate the value codec
there. Migration drivers derive `NUMERIC(p,s)` for PostgreSQL, `DECIMAL(p,s)`
for MySQL, and a checked scaled `INTEGER` for SQLite. Decimal lists derive
`NUMERIC(p,s)[]` on PostgreSQL and coefficient-string JSON containers on MySQL
and SQLite.
Literal non-null decimal-list defaults are retained in DDL through the same
field codec as writes: PostgreSQL emits a quoted native array whose members are
padded to scale, MySQL emits a parenthesized quoted coefficient-string JSON
container, and SQLite/libSQL/D1 emit the quoted container. Provider
introspection normalizes only those exact owned spellings so a second push
converges. Function defaults stay application-only. PostgreSQL and SQLite keep
`default(null)` as SQL `NULL`; MySQL omits it because its catalog cannot
distinguish `DEFAULT NULL` from no default and the two are equivalent on a
nullable column. Generic array/object defaults remain suppressed.

The migration planner owns the bounded conversion policy. A MySQL scalar
conversion brackets `MODIFY COLUMN` with one reversible reserved `CHECK`. The
locked command plans interrupted-proof cleanup once before its first sequential
effect, authenticates the reserved name, column, and predicate before returning
any `DROP`, and records that `DROP` through the same last-completed-statement
boundary. A malformed, colliding, or multiple reserved proof refuses before
effects. Every effectful MySQL migration command proves MySQL 8.0.16-or-later
and a strict mode once at pinned-session admission. The proof is command-wide:
provider-authored DDL and manual artifacts cannot be classified safely by
decimal effect. A MySQL decimal-list conversion admits only same-scale precision
widening. It leaves member strings unchanged but still brackets the marker
`MODIFY COLUMN` with `ADD CHECK` and `DROP CHECK`; narrowing and every change
that rewrites members are refused before effects. A generated widening therefore
records the existing irreversible rollback policy instead of emitting an unsafe
narrowing down artifact. Hosted
PlanetScale remains introspection-only and
refuses effectful DDL. D1 accepts ordinary fixed-decimal schema work but its
decimal-specific render-time gate refuses relation-bearing descriptor changes,
decimal adoption, and decimal-column renames. It does not classify an unrelated
column, constraint, key, or enum rebuild merely because that table also carries
a decimal.
A generated SQLite3/libSQL artifact applied later on D1 reaches the same narrow
policy through the per-entry artifact-read boundary. Initially pending entries
are admitted during `apply()` preflight, before the tracking table; an entry
first seen on a post-commit journal reread crosses the same owner before that
entry's artifact or tracking row. The exact generated fixed-decimal
reconstruction sequence identifies its rebuilt table, same-artifact native
table renames replay the live identity forward, and the shared SQLite relation
census checks that state for inbound or outbound foreign keys. Manual artifacts,
relation-free decimal rebuilds, and unrelated SQLite reconstructions keep their
existing admission. Do not replace these local policies with an adapter-wide
decimal capability flag or a broad runtime refusal.

---

## Adding New Migration Operation

1. **Add to DiffOperation union** (`types.ts`)

2. **Detect in differ** (`differ.ts`):
   ```typescript
   if (needsMyOperation(current, desired)) {
     operations.push({ type: "myOperation", ... });
   }
   ```

3. **Generate DDL in migration drivers** (`drivers/postgres/index.ts`, `drivers/sqlite/index.ts`):
   ```typescript
   case "myOperation":
     return `ALTER TABLE ...`;
   ```

4. **Test across all databases**

---

## File Structure

```
src/migrations/
├── index.ts           # Public exports
├── client.ts          # createMigrationClient() API
├── push/              # Direct push workflow (planner, executor, format, enum-removals)
├── context.ts         # MigrationContext (shared state)
├── serializer.ts      # Model → SchemaSnapshot
├── differ.ts          # Snapshot comparison
├── resolver.ts        # Ambiguous change resolution
├── types.ts           # Type definitions
├── utils.ts           # Utilities
├── reset.ts           # Database reset
├── squash.ts          # Squash migrations
├── drivers/
│   ├── index.ts       # Driver registry
│   ├── base.ts        # MigrationDriver base class
│   ├── types.ts       # Driver types
│   ├── postgres/      # PostgreSQL driver
│   ├── mysql/         # MySQL driver
│   ├── sqlite/        # SQLite driver + exact generated-artifact admission
│   └── libsql/        # LibSQL/Turso driver
├── storage/
│   ├── index.ts       # Storage exports
│   ├── driver.ts      # MigrationStorageDriver base
│   └── drivers/
│       └── fs.ts      # Filesystem storage
├── generate/
│   ├── index.ts       # generate(), preview()
│   ├── polymorphic-history.ts # Stable member-history comparison
│   ├── manual-artifact.ts # manualMigration parsing + refusals
│   ├── file-writer.ts # Migration file formatting + the ONE SQL parser
│   ├── journal.ts     # Migrations-directory layout helpers only
│   └── snapshot.ts    # Snapshot operations
└── apply/
    ├── index.ts       # apply(), status(), pending()
    └── down.ts        # Down migrations (the only rollback verb)
```

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema** | Provides models to serialize |
| **Drivers** | Provides database connection |
| **Adapters** | Query-time SQL (not used for migrations) |
| **CLI** | User interface for migration commands |
