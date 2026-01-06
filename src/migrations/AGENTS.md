# Migrations - Schema Diffing & Database Sync

**Location:** `src/migrations/`  
**Layer:** L10 - Migrations (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Detects schema changes and pushes them to the database via serializer→differ→resolver→push workflow. Similar to Prisma's `db push` or Drizzle's `push` command.

## Why This Layer Exists

VibORM needs to sync TypeScript schema definitions to actual database tables. The workflow:

1. **Serialize** models to database-agnostic snapshot
2. **Introspect** current database state
3. **Diff** to find changes
4. **Resolve** ambiguous changes (rename vs drop+add)
5. **Push** changes with user confirmation

This is intentionally simpler than migration files. For production, we recommend proper migration tools. `push` is for development iteration.

---

## Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `push.ts` | Workflow orchestration | ~250 |
| `serializer.ts` | Model → SchemaSnapshot | ~200 |
| `differ.ts` | Compare snapshots, detect changes | ~300 |
| `resolver.ts` | Ambiguous change resolution | ~100 |
| `types.ts` | SchemaSnapshot, DiffOperation types | ~150 |

---

## The Push Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  Models (TypeScript)         Database (actual)              │
│         │                           │                       │
│         ▼                           ▼                       │
│  serialize()              introspect()                      │
│         │                           │                       │
│         ▼                           ▼                       │
│  SchemaSnapshot ────────────────────┘                       │
│  (desired)                  (current)                       │
│                    │                                        │
│                    ▼                                        │
│               differ()                                      │
│                    │                                        │
│                    ▼                                        │
│         DiffOperations + AmbiguousChanges                   │
│                    │                                        │
│                    ▼                                        │
│    User resolves ambiguities (rename or drop+add?)          │
│                    │                                        │
│                    ▼                                        │
│         adapter.generateSQL(operations)                     │
│                    │                                        │
│                    ▼                                        │
│         driver.execute(sql)                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### SchemaSnapshot (Database-Agnostic)

Normalized representation that works for any database:

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
}
```

**Why database-agnostic:** Same diff algorithm works for PostgreSQL, MySQL, SQLite.

### DiffOperation (Resolved Changes)

Unambiguous operations ready to execute:

```typescript
type DiffOperation =
  | { type: "createTable"; table: TableDef }
  | { type: "dropTable"; tableName: string }
  | { type: "renameTable"; from: string; to: string }
  | { type: "addColumn"; tableName: string; column: ColumnDef }
  | { type: "dropColumn"; tableName: string; columnName: string }
  | { type: "renameColumn"; tableName: string; from: string; to: string }
  // ... more operations
```

### AmbiguousChange (Needs User Input)

When we can't tell if it's a rename or drop+add:

```typescript
// Column "email" dropped, column "user_email" added
// Is this a RENAME (preserve data) or DROP+ADD (lose data)?
type AmbiguousChange = {
  type: "ambiguousColumn";
  tableName: string;
  droppedColumn: ColumnDef;
  addedColumn: ColumnDef;
};
```

**Why ask:** Getting this wrong causes data loss. Better to ask than guess.

---

## Core Rules

### Rule 1: Database-Agnostic Snapshots
SchemaSnapshot format is the same for all databases. Dialect differences handled by adapters during SQL generation.

### Rule 2: Explicit Ambiguity Resolution
When column/table dropped AND added, always ask user. Never assume rename.

### Rule 3: Destructive Change Confirmation
Operations like `dropTable`, `dropColumn` require explicit confirmation. Use `--accept-data-loss` flag to skip.

### Rule 4: Dry Run First
Always support `--dry-run` to preview SQL before execution.

---

## Anti-Patterns

### Assuming Rename
Detecting column drop + add and automatically treating as rename. Could cause data loss if actually separate operations.

### Dialect-Specific Serialization
Putting PostgreSQL-specific type mappings in serializer. Adapter handles dialect during SQL generation.

### Silent Destructive Operations
Dropping tables or columns without confirmation. Data loss must require explicit approval.

### Skipping Dry Run Support
Executing migrations without preview option. Users must be able to see SQL first.

### Ignoring Database Capabilities
Using native arrays in MySQL migration (not supported). Check adapter capabilities first.

---

## CLI Commands

```bash
# Preview changes (dry run)
viborm push --dry-run

# Apply changes
viborm push

# Force (skip confirmations)
viborm push --accept-data-loss

# Reset and push
viborm push --force-reset
```

---

## Adding New Migration Operation

1. **Add to DiffOperation union** (`types.ts`)

2. **Detect in differ** (`differ.ts`):
   ```typescript
   if (needsMyOperation(current, desired)) {
     operations.push({ type: "myOperation", ... });
   }
   ```

3. **Generate SQL in adapter** (`adapters/*/migrations.ts`):
   ```typescript
   if (op.type === "myOperation") {
     return sql`ALTER TABLE ...`;
   }
   ```

4. **Test across all databases**

---

## Invisible Knowledge

### Why not migration files
Migration files (like Prisma) require running `migrate dev` for every change. VibORM's `push` is for fast iteration - change schema, push, see results. For production, use proper migration tools.

### Why ambiguity resolution exists
Early version assumed renames. User renamed `email` to `userEmail` and it worked. Later, user deleted `oldField` and added `newField` (unrelated) - VibORM "renamed" and copied wrong data. Now we always ask.

### Why serialization is separate from diffing
Serializer is pure (models → snapshot). Differ is pure (snapshots → operations). This separation makes testing easy and enables dry-run without database access.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema** ([schema/AGENTS.md](../schema/AGENTS.md)) | Provides models to serialize |
| **Adapters** ([adapters/AGENTS.md](../adapters/AGENTS.md)) | Generates dialect-specific DDL |
| **Drivers** | Executes migration SQL |
