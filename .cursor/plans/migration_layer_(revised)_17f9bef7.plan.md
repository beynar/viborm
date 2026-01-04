---
name: Migration Layer (Revised)
overview: Add a migration layer to VibORM with CLI commands (push, migrate) that synchronize TypeScript schema definitions with the database. Includes interactive prompts for ambiguous changes (renames vs add+drop) following the Drizzle resolver pattern.
todos:
  - id: migration-types
    content: Define SchemaSnapshot, TableDef, ColumnDef, DiffOperation, AmbiguousChange types
    status: pending
  - id: serializer
    content: Implement Model-to-SchemaSnapshot serializer in src/migrations/serializer.ts
    status: pending
    dependencies:
      - migration-types
  - id: adapter-interface
    content: Extend DatabaseAdapter interface with migrations methods
    status: pending
    dependencies:
      - migration-types
  - id: pg-introspect
    content: Implement PostgreSQL introspection via pg_catalog queries
    status: pending
    dependencies:
      - adapter-interface
  - id: pg-ddl
    content: Implement PostgreSQL DDL generation for all DiffOperation types
    status: pending
    dependencies:
      - adapter-interface
  - id: differ
    content: Implement schema differ with ambiguous change detection
    status: pending
    dependencies:
      - migration-types
  - id: resolvers
    content: Implement resolver system for ambiguous changes (rename vs add+drop)
    status: pending
    dependencies:
      - differ
  - id: cli
    content: Implement CLI with viborm push and viborm migrate commands
    status: pending
    dependencies:
      - resolvers
  - id: push-api
    content: Wire up push() function with full pipeline including resolvers
    status: pending
    dependencies:
      - serializer
      - pg-introspect
      - pg-ddl
      - differ
      - resolvers
---

# Migration Layer Implementation (Revised)

## 1. Overview

Add database migration capabilities to VibORM with:

- **CLI commands**: `viborm push` and `viborm migrate`
- **Interactive resolvers**: Prompt user for ambiguous changes (column/table renames vs add+drop)
- **Push mode**: Direct schema sync without migration files (like `prisma db push`)
- **Migrate mode**: Generate migration files with history tracking (future phase)

## 2. User-Facing API

### CLI Commands

```bash
# Push schema directly to database (no migration files)
viborm push --schema ./src/schema.ts

# Push with options
viborm push --schema ./src/schema.ts --force    # Skip confirmations
viborm push --schema ./src/schema.ts --dry-run  # Preview SQL only

# Generate migration files (Phase 3)
viborm migrate generate --name add_user_avatar
viborm migrate deploy
```



### Programmatic API

```typescript
import { push, createMigrationEngine } from "viborm/migrations";

// Simple push (non-interactive, throws on ambiguous changes)
await push(driver, { user, post, comment }, {
  force: false,
  dryRun: false,
});

// With custom resolver (for programmatic use)
await push(driver, models, {
  resolver: async (ambiguousChanges) => {
    // Return resolved operations
    return ambiguousChanges.map(change => ({
      ...change,
      resolution: "rename", // or "add_drop"
    }));
  },
});
```



## 3. Layer Analysis

### Layer 1: User API

**Affected:** Yes**Reason:** Need to export the new `push` function**Changes:**

- Add `src/migrations/index.ts` exports
- Consider adding to main `src/index.ts`

### Layer 2: Schema Definition

**Affected:** No (read-only)**Reason:** We only READ existing field/model state via `model["~"].state` and `field["~"].state`. No modifications needed - the existing state contains all metadata required (type, nullable, isId, isUnique, autoGenerate, columnName, etc.)

### Layer 3: Query Schema

**Affected:** No**Reason:** Migration layer doesn't involve query validation schemas (where, create, update). It operates on schema metadata, not query inputs.

### Layer 4: Validation Library

**Affected:** No**Reason:** No new validation primitives needed for migrations.

### Layer 5: Schema Validation (Definition-time)

**Affected:** Maybe (Phase 2)**Reason:** Could add rules to warn about migration-breaking changes, but not required for MVP.

### Layer 6: Query Engine

**Affected:** No**Reason:** Migration uses raw DDL execution, not the query builder. The push operation bypasses query engine entirely.

### Layer 7: Database Adapters

**Affected:** Yes (PRIMARY)**Reason:** DDL generation and database introspection are database-specific. Per project guidelines, all database-specific SQL must live in adapters.**Changes:**

- Extend `DatabaseAdapter` interface in [`src/adapters/database-adapter.ts`](src/adapters/database-adapter.ts)
- Add introspection methods to each adapter
- Add DDL generation methods to each adapter

### Layer 8: Driver Layer

**Affected:** No**Reason:** Existing `driver.execute()` and `driver.executeRaw()` are sufficient for DDL execution.

### Layer 9: Client Layer

**Affected:** No**Reason:** `push` is a standalone function, not a client method. No result type inference needed.

## 4. Architecture

```javascript
src/
├── migrations/                    # NEW - Database-agnostic orchestration
│   ├── index.ts                   # Public API exports
│   ├── types.ts                   # SchemaSnapshot, DiffOperation, AmbiguousChange types
│   ├── serializer.ts              # Model → SchemaSnapshot
│   ├── differ.ts                  # Compare snapshots → DiffOperation[] + AmbiguousChange[]
│   ├── resolver.ts                # Resolver interface and default implementations
│   └── push.ts                    # Orchestrates the push workflow
│
├── cli/                           # NEW - CLI layer
│   ├── index.ts                   # CLI entry point (viborm command)
│   ├── commands/
│   │   ├── push.ts                # viborm push command
│   │   └── migrate.ts             # viborm migrate command (Phase 3)
│   ├── prompts.ts                 # Interactive prompts using @clack/prompts
│   └── utils.ts                   # CLI utilities (config loading, etc.)
│
├── adapters/
│   ├── database-adapter.ts        # MODIFY - Add migration interface
│   └── databases/
│       ├── postgres/
│       │   └── postgres-adapter.ts    # MODIFY - Add migration methods
│       ├── mysql/
│       │   └── mysql-adapter.ts       # MODIFY - Add migration methods
│       └── sqlite/
│           └── sqlite-adapter.ts      # MODIFY - Add migration methods
```



## 5. Core Types

```typescript
// src/migrations/types.ts

// =============================================================================
// SCHEMA SNAPSHOT (database-agnostic representation)
// =============================================================================

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

interface ColumnDef {
  name: string;
  type: string;         // Normalized (e.g., "varchar(255)")
  nullable: boolean;
  default?: string;     // SQL expression
  autoIncrement?: boolean;
}

// =============================================================================
// DIFF OPERATIONS (resolved, ready to execute)
// =============================================================================

type DiffOperation =
  | { type: "createTable"; table: TableDef }
  | { type: "dropTable"; tableName: string }
  | { type: "renameTable"; from: string; to: string }
  | { type: "addColumn"; tableName: string; column: ColumnDef }
  | { type: "dropColumn"; tableName: string; columnName: string }
  | { type: "renameColumn"; tableName: string; from: string; to: string }
  | { type: "alterColumn"; tableName: string; from: ColumnDef; to: ColumnDef }
  | { type: "createIndex"; tableName: string; index: IndexDef }
  | { type: "dropIndex"; indexName: string }
  | { type: "addForeignKey"; tableName: string; fk: ForeignKeyDef }
  | { type: "dropForeignKey"; tableName: string; fkName: string };

// =============================================================================
// AMBIGUOUS CHANGES (require user input to resolve)
// =============================================================================

/** Detected when columns are added AND dropped in the same table */
type AmbiguousColumnChange = {
  type: "ambiguousColumn";
  tableName: string;
  droppedColumn: ColumnDef;
  addedColumn: ColumnDef;
};

/** Detected when tables are added AND dropped */
type AmbiguousTableChange = {
  type: "ambiguousTable";
  droppedTable: string;
  addedTable: string;
};

type AmbiguousChange = AmbiguousColumnChange | AmbiguousTableChange;

/** User's resolution for an ambiguous change */
type ChangeResolution = 
  | { type: "rename" }           // Treat as rename (preserve data)
  | { type: "addAndDrop" };      // Treat as separate add + drop (data loss)

// =============================================================================
// DIFF RESULT (output of differ, before resolution)
// =============================================================================

interface DiffResult {
  /** Operations that are unambiguous and ready to execute */
  operations: DiffOperation[];
  /** Changes that need user input to resolve */
  ambiguousChanges: AmbiguousChange[];
}

// =============================================================================
// RESOLVER (handles ambiguous changes)
// =============================================================================

/** Callback to resolve ambiguous changes (used by CLI or programmatic API) */
type Resolver = (changes: AmbiguousChange[]) => Promise<Map<AmbiguousChange, ChangeResolution>>;
```



## 6. Adapter Interface Extension

```typescript
// src/adapters/database-adapter.ts (additions)

interface DatabaseAdapter {
  // ... existing methods ...

  /**
    * MIGRATIONS
    * Database introspection and DDL generation
   */
  migrations: {
    /** Introspect current database schema */
    introspect: (driver: Driver) => Promise<SchemaSnapshot>;
    
    /** Generate DDL for a diff operation */
    generateDDL: (operation: DiffOperation) => Sql;
    
    /** Map VibORM field type to native SQL type */
    mapFieldType: (field: Field, forCreate: boolean) => string;
  };
}
```



## 7. Push Workflow

```typescript
// src/migrations/push.ts

interface PushOptions {
  force?: boolean;       // Skip confirmations for destructive changes
  dryRun?: boolean;      // Preview SQL without executing
  resolver?: Resolver;   // Custom resolver for ambiguous changes
}

async function push(
  driver: Driver,
  models: Record<string, AnyModel>,
  options: PushOptions = {}
): Promise<PushResult> {
  const adapter = getAdapterForDialect(driver.dialect);
  
  // 1. Serialize VibORM models to snapshot
  const desired = serializeModels(models, adapter);
  
  // 2. Introspect current database state
  const current = await adapter.migrations.introspect(driver);
  
  // 3. Calculate diff (returns operations + ambiguous changes)
  const diffResult = diff(current, desired);
  
  // 4. Resolve ambiguous changes
  let finalOperations = [...diffResult.operations];
  
  if (diffResult.ambiguousChanges.length > 0) {
    if (!options.resolver) {
      throw new MigrationError(
        "Ambiguous changes detected. Provide a resolver or use CLI for interactive mode."
      );
    }
    
    const resolutions = await options.resolver(diffResult.ambiguousChanges);
    const resolvedOps = applyResolutions(diffResult.ambiguousChanges, resolutions);
    finalOperations.push(...resolvedOps);
  }
  
  // 5. Check for destructive operations
  if (hasDestructiveOperations(finalOperations) && !options.force) {
    throw new MigrationError("Destructive changes detected. Use --force to proceed.");
  }
  
  // 6. Generate and execute DDL
  if (!options.dryRun) {
    for (const op of finalOperations) {
      const ddl = adapter.migrations.generateDDL(op);
      await driver.execute(ddl);
    }
  }
  
  return { operations: finalOperations, applied: !options.dryRun };
}

/** Convert resolutions to concrete operations */
function applyResolutions(
  changes: AmbiguousChange[],
  resolutions: Map<AmbiguousChange, ChangeResolution>
): DiffOperation[] {
  const ops: DiffOperation[] = [];
  
  for (const change of changes) {
    const resolution = resolutions.get(change);
    if (!resolution) continue;
    
    if (change.type === "ambiguousColumn") {
      if (resolution.type === "rename") {
        ops.push({
          type: "renameColumn",
          tableName: change.tableName,
          from: change.droppedColumn.name,
          to: change.addedColumn.name,
        });
      } else {
        ops.push(
          { type: "dropColumn", tableName: change.tableName, columnName: change.droppedColumn.name },
          { type: "addColumn", tableName: change.tableName, column: change.addedColumn }
        );
      }
    }
    // Similar for ambiguousTable...
  }
  
  return ops;
}
```



## 7.1 CLI Interactive Prompts

```typescript
// src/cli/prompts.ts
import * as p from "@clack/prompts";

/** Interactive resolver using CLI prompts */
export async function interactiveResolver(
  changes: AmbiguousChange[]
): Promise<Map<AmbiguousChange, ChangeResolution>> {
  const resolutions = new Map<AmbiguousChange, ChangeResolution>();
  
  for (const change of changes) {
    if (change.type === "ambiguousColumn") {
      const answer = await p.select({
        message: `Column "${change.droppedColumn.name}" was removed and "${change.addedColumn.name}" was added in table "${change.tableName}". Is this a rename?`,
        options: [
          { 
            value: "rename", 
            label: `Rename: ${change.droppedColumn.name} → ${change.addedColumn.name}`,
            hint: "Data will be preserved"
          },
          { 
            value: "addAndDrop", 
            label: `Add + Drop: Create new column, delete old one`,
            hint: "Data in old column will be LOST"
          },
        ],
      });
      
      resolutions.set(change, { type: answer as "rename" | "addAndDrop" });
    }
    
    if (change.type === "ambiguousTable") {
      const answer = await p.select({
        message: `Table "${change.droppedTable}" was removed and "${change.addedTable}" was added. Is this a rename?`,
        options: [
          { 
            value: "rename", 
            label: `Rename: ${change.droppedTable} → ${change.addedTable}`,
            hint: "Data will be preserved"
          },
          { 
            value: "addAndDrop", 
            label: `Add + Drop: Create new table, delete old one`,
            hint: "ALL DATA in old table will be LOST"
          },
        ],
      });
      
      resolutions.set(change, { type: answer as "rename" | "addAndDrop" });
    }
  }
  
  return resolutions;
}
```



## 7.2 CLI Push Command

```typescript
// src/cli/commands/push.ts
import { Command } from "commander";
import * as p from "@clack/prompts";
import { push } from "../../migrations";
import { interactiveResolver } from "../prompts";

export const pushCommand = new Command("push")
  .description("Push schema changes directly to database")
  .option("--schema <path>", "Path to schema file", "./src/schema.ts")
  .option("--force", "Skip confirmation for destructive changes")
  .option("--dry-run", "Preview SQL without executing")
  .action(async (options) => {
    p.intro("viborm push");
    
    // 1. Load schema and driver from config
    const { driver, models } = await loadConfig(options.schema);
    
    // 2. Run push with interactive resolver
    const result = await push(driver, models, {
      force: options.force,
      dryRun: options.dryRun,
      resolver: interactiveResolver,
    });
    
    // 3. Display results
    if (options.dryRun) {
      p.note(result.operations.map(formatOperation).join("\n"), "Pending changes");
    } else {
      p.outro(`Applied ${result.operations.length} changes`);
    }
  });
```



## 8. Files Summary

| File | Action | Purpose |

|------|--------|---------|

| `src/migrations/index.ts` | CREATE | Public exports |

| `src/migrations/types.ts` | CREATE | SchemaSnapshot, DiffOperation, AmbiguousChange types |

| `src/migrations/serializer.ts` | CREATE | Model state → SchemaSnapshot |

| `src/migrations/differ.ts` | CREATE | Compare snapshots, detect ambiguous changes |

| `src/migrations/resolver.ts` | CREATE | Resolver interface and utilities |

| `src/migrations/push.ts` | CREATE | Push orchestration with resolver support |

| `src/cli/index.ts` | CREATE | CLI entry point (viborm command) |

| `src/cli/commands/push.ts` | CREATE | viborm push command |

| `src/cli/commands/migrate.ts` | CREATE | viborm migrate command (Phase 4) |

| `src/cli/prompts.ts` | CREATE | Interactive prompts using @clack/prompts |

| `src/cli/utils.ts` | CREATE | Config loading, schema import |

| `src/adapters/database-adapter.ts` | MODIFY | Add migrations interface |

| `src/adapters/databases/postgres/postgres-adapter.ts` | MODIFY | Add PG migration methods |

| `src/adapters/databases/mysql/mysql-adapter.ts` | MODIFY | Add MySQL migration methods |

| `src/adapters/databases/sqlite/sqlite-adapter.ts` | MODIFY | Add SQLite migration methods |

| `tests/migrations/serializer.test.ts` | CREATE | Serializer tests |

| `tests/migrations/differ.test.ts` | CREATE | Differ + ambiguous detection tests |

| `tests/migrations/resolver.test.ts` | CREATE | Resolver tests |

| `tests/migrations/push.test.ts` | CREATE | Integration tests |

## 9. Implementation Phases

### Phase 1: Core Infrastructure (PostgreSQL only)

1. Define types (SchemaSnapshot, DiffOperation, AmbiguousChange)
2. Implement serializer (Model → SchemaSnapshot)
3. Extend DatabaseAdapter with migrations interface
4. Implement PostgreSQL introspection (pg_catalog queries)
5. Implement PostgreSQL DDL generation
6. Implement differ with ambiguous change detection
7. Implement resolver system
8. Wire up push() function with resolver support

### Phase 2: CLI

1. Set up CLI infrastructure (commander + @clack/prompts)
2. Implement `viborm push` command
3. Implement interactive prompts for ambiguous changes
4. Add config file support (viborm.config.ts)

### Phase 3: Multi-Database

1. MySQL introspection + DDL
2. SQLite introspection + DDL

### Phase 4: Migration Files (Future)

1. Migration file generation (`viborm migrate generate`)
2. Migration history table (`__viborm_migrations`)
3. `viborm migrate deploy` command
4. Rollback support

## 10. Dependencies

```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "@clack/prompts": "^0.7.0"
  }
}
```



## 11. Example CLI Session

```javascript
$ viborm push --schema ./src/schema.ts

◆  viborm push

│  Introspecting database...
│  Comparing schemas...

◆  Column "username" was removed and "name" was added in table "users". Is this a rename?
│  ○ Rename: username → name (Data will be preserved)
│  ● Add + Drop: Create new column, delete old one (Data in old column will be LOST)

◆  The following changes will be applied:
│
│  Table: users
│    ✓ Rename column: username → name
│    + Add column: avatar (varchar(255))
│
│  Table: posts
│    + Add index: idx_posts_author_id
│

◇  Apply changes? (y/n)
│  y

◆  Applied 3 changes successfully

└  Done in 1.2s
```



## 12. Questions Resolved

| Question | Decision |

|----------|----------|

| Destructive operations | Require `--force` flag or interactive confirmation |

| Ambiguous changes | Interactive prompts in CLI, resolver callback in API |

| Initial scope | PostgreSQL only for Phase 1 |

| CLI framework | Commander + @clack/prompts |