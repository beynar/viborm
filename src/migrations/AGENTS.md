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

### Migration Journal

Tracks migration history in `meta/_journal.json`:

```typescript
interface MigrationJournal {
  version: string;   // "2" — bumped when entries gained their policy
  dialect: Dialect;
  entries: MigrationEntry[];
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

`readJournal()` is the SINGLE journal funnel — `apply`, `down`, `squash`,
`reset`, `status` and the client accessors all reach the journal through it — so
it validates once: a journal whose `version` is not `"2"`, or any entry missing
`mode`, missing `rollback`, carrying an unknown rollback kind, or declaring
`irreversible` with a blank `reason`, is refused with `V11009`. There is no
legacy reader and no journal migrator; regenerate the estate instead. After that
guard `entry.rollback` is total and no downstream verb re-checks it.

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
  abstract generateDDL(operation: DiffOperation, ctx: DDLContext): string;
  abstract introspect(): Promise<SchemaSnapshot>;
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

### Rule 4: Transactional Apply

Each migration is applied in a transaction. Failure rolls back that migration.

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

### Rule 6b: Rollback Reads Everything Under The Lock — And The Lock Is Weak

`down()` and `squash()` do all of it inside `ctx.withLock`: read the journal,
read applied state, recompute the group, verify checksums, refuse on policy,
validate every artifact, and only then execute. The dry-run return comes AFTER
the whole preflight, because the CLI confirms against the dry run and a preview
that cannot report a refusal is not a preview.

State that honestly: this closes the window between the caller's request and
lock acquisition by recomputing, not by serializing. The lock itself is weaker
than it looks — SQLite and libSQL take no lock at all and report success, and on
PostgreSQL/MySQL the advisory lock is session-scoped and issued outside the
transaction, so it is not connection-pinned. On the substrates the round-trip
tests run on, the in-lock recomputation is the ONLY defence. `apply()` still
does not take the lock at all; that is a known gap, not a claim.

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
│   ├── sqlite/        # SQLite driver
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
