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
| `push.ts` | Direct push workflow (serialize → diff → execute) |
| `client.ts` | `createMigrationClient()` programmatic API |
| `generate/index.ts` | Generate migration files |
| `apply/index.ts` | Apply/rollback migrations |
| `context.ts` | Shared context (locking, tracking, execution) |
| `serializer.ts` | Model → SchemaSnapshot |
| `differ.ts` | Compare snapshots, detect changes |
| `resolver.ts` | Ambiguous/destructive change resolution |
| `types.ts` | SchemaSnapshot, DiffOperation, MigrationEntry types |

### Subdirectories

| Directory | Purpose |
|-----------|---------|
| `drivers/` | Migration-specific drivers (DDL generation, introspection) |
| `storage/` | Storage drivers for migration files (filesystem, etc.) |
| `generate/` | Migration file generation and formatting |
| `apply/` | Apply, rollback, status, down operations |

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

### Migration Journal

Tracks migration history in `meta/_journal.json`:

```typescript
interface MigrationJournal {
  version: string;
  dialect: Dialect;
  entries: MigrationEntry[];
}

interface MigrationEntry {
  idx: number;       // Sequential index
  version: string;   // Timestamp version
  name: string;      // kebab-case name
  when: number;      // Unix timestamp
  checksum: string;  // SHA256 of SQL content
}
```

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
viborm migrate status
viborm migrate drop --last
```

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

---

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Do This Instead |
|--------------|--------------|-----------------|
| Assuming rename | Data loss if actually drop+add | Ask user via resolver |
| Modifying applied migrations | Checksum mismatch error | Create new migration |
| Skipping storage driver | Can't use file-based operations | Use `createFsStorageDriver()` |
| Hardcoded dialect SQL | Breaks other databases | Use `migrationDriver.generateDDL()` |
| Silent destructive ops | Unexpected data loss | Require confirmation |

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
├── push.ts            # Direct push workflow
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
│   └── sqlite/        # SQLite driver
├── storage/
│   ├── index.ts       # Storage exports
│   ├── driver.ts      # MigrationStorageDriver base
│   └── drivers/
│       └── fs.ts      # Filesystem storage
├── generate/
│   ├── index.ts       # generate(), preview()
│   ├── file-writer.ts # Migration file formatting
│   ├── journal.ts     # Journal operations
│   └── snapshot.ts    # Snapshot operations
└── apply/
    ├── index.ts       # apply(), status(), pending(), rollback()
    ├── down.ts        # Down migrations
    └── tracker.ts     # Tracking table operations
```

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema** | Provides models to serialize |
| **Drivers** | Provides database connection |
| **Adapters** | Query-time SQL (not used for migrations) |
| **CLI** | User interface for migration commands |
