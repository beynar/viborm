/**
 * Push Workflow
 *
 * Orchestrates the database schema push operation:
 * 1. Serialize VibORM models to SchemaSnapshot
 * 2. Introspect current database state
 * 3. Calculate diff
 * 4. Resolve ambiguous changes
 * 5. Generate and execute DDL
 */

import type { DatabaseAdapter } from "../adapters/database-adapter";
import type { Driver } from "../drivers/driver";
import type { AnyModel } from "../schema/model";
import {
  diff,
  getDestructiveOperationDescriptions,
  hasDestructiveOperations,
} from "./differ";
import { applyResolutions, strictResolver } from "./resolver";
import { serializeModels } from "./serializer";
import {
  type DiffOperation,
  MigrationError,
  type PushResult,
  type Resolver,
  type SchemaSnapshot,
} from "./types";

// =============================================================================
// ADAPTER REGISTRY
// =============================================================================

import { postgresAdapter } from "../adapters/databases/postgres/postgres-adapter";
import { sqliteAdapter } from "../adapters/databases/sqlite/sqlite-adapter";

function getAdapterForDialect(dialect: string): DatabaseAdapter {
  switch (dialect) {
    case "postgresql":
      return postgresAdapter;
    case "sqlite":
      return sqliteAdapter;
    // TODO: Add mysql adapter when migrations are implemented
    default:
      throw new MigrationError(
        `Migrations not yet supported for dialect: ${dialect}`,
        "UNSUPPORTED_DIALECT"
      );
  }
}

// =============================================================================
// PUSH OPTIONS
// =============================================================================

export interface PushOptions {
  /** Skip confirmations for destructive changes */
  force?: boolean;
  /** Preview SQL without executing */
  dryRun?: boolean;
  /** Custom resolver for ambiguous changes (defaults to strictResolver) */
  resolver?: Resolver;
  /** Called when destructive operations are detected (for CLI confirmation) */
  onDestructive?: (descriptions: string[]) => Promise<boolean>;
}

// =============================================================================
// PUSH FUNCTION
// =============================================================================

/**
 * Pushes schema changes directly to the database.
 *
 * @param driver - Database driver for executing queries
 * @param models - Record of model name to model definition
 * @param options - Push options
 * @returns Push result with operations and SQL statements
 */
export async function push(
  driver: Driver,
  models: Record<string, AnyModel>,
  options: PushOptions = {}
): Promise<PushResult> {
  const { force = false, dryRun = false, resolver = strictResolver } = options;

  // Get the adapter for this database dialect
  const adapter = getAdapterForDialect(driver.dialect);

  // 1. Serialize VibORM models to SchemaSnapshot
  const desired = serializeModels(models, {
    migrationAdapter: adapter.migrations,
  });

  // 2. Introspect current database state
  const current = await adapter.migrations.introspect(async (sql, params) => {
    const result = await driver.executeRaw<any>(sql, params);
    return result;
  });

  // 3. Calculate diff
  const diffResult = diff(current, desired);

  // 4. Resolve ambiguous changes
  let finalOperations = [...diffResult.operations];

  if (diffResult.ambiguousChanges.length > 0) {
    const resolutions = await resolver(diffResult.ambiguousChanges);
    const resolvedOps = applyResolutions(
      diffResult.ambiguousChanges,
      resolutions
    );
    finalOperations.push(...resolvedOps);

    // For table renames that were resolved as addAndDrop, we need to add the createTable
    for (const change of diffResult.ambiguousChanges) {
      if (change.type === "ambiguousTable") {
        const resolution = resolutions.get(change);
        if (resolution?.type === "addAndDrop") {
          // Find the table definition from desired schema
          const newTable = desired.tables.find(
            (t) => t.name === change.addedTable
          );
          if (newTable) {
            finalOperations.push({ type: "createTable", table: newTable });
          }
        }
      }
    }

    // Re-sort operations after adding resolved ones
    finalOperations = sortOperations(finalOperations);
  }

  // 5. Check for destructive operations
  if (hasDestructiveOperations(finalOperations) && !force) {
    const descriptions = getDestructiveOperationDescriptions(finalOperations);

    if (options.onDestructive) {
      const confirmed = await options.onDestructive(descriptions);
      if (!confirmed) {
        throw new MigrationError(
          "Destructive changes were not confirmed",
          "DESTRUCTIVE_CHANGES_REJECTED"
        );
      }
    } else {
      throw new MigrationError(
        `Destructive changes detected:\n${descriptions.join("\n")}\n\n` +
          "Use --force to proceed or provide an onDestructive callback.",
        "DESTRUCTIVE_CHANGES"
      );
    }
  }

  // 6. Generate DDL statements
  const sql: string[] = [];
  for (const op of finalOperations) {
    const ddl = adapter.migrations.generateDDL(op);
    // generateDDL may return multiple statements separated by ;\n
    const statements = ddl.split(";\n").filter((s) => s.trim());
    sql.push(...statements);
  }

  // 7. Execute DDL (unless dry run)
  if (!dryRun && sql.length > 0) {
    // Execute in a transaction for atomicity
    await driver.transaction(async (tx) => {
      for (const statement of sql) {
        await tx.executeRaw(statement + ";");
      }
    });
  }

  return {
    operations: finalOperations,
    applied: !dryRun && sql.length > 0,
    sql,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Sort operations for proper execution order
 */
function sortOperations(operations: DiffOperation[]): DiffOperation[] {
  const priority: Record<DiffOperation["type"], number> = {
    createEnum: 1,
    dropForeignKey: 2,
    dropIndex: 3,
    dropUniqueConstraint: 4,
    dropPrimaryKey: 5,
    dropColumn: 6,
    dropTable: 7,
    createTable: 8,
    addColumn: 9,
    alterColumn: 10,
    renameTable: 11,
    renameColumn: 12,
    addPrimaryKey: 13,
    addUniqueConstraint: 14,
    createIndex: 15,
    addForeignKey: 16,
    alterEnum: 17,
    dropEnum: 18,
  };

  return [...operations].sort((a, b) => priority[a.type] - priority[b.type]);
}

/**
 * Introspects the current database schema without making any changes.
 * Useful for debugging or displaying current state.
 */
export async function introspect(driver: Driver): Promise<SchemaSnapshot> {
  const adapter = getAdapterForDialect(driver.dialect);
  return adapter.migrations.introspect(async (sql, params) => {
    const result = await driver.executeRaw<any>(sql, params);
    return result;
  });
}

/**
 * Generates DDL statements for transforming current schema to desired schema
 * without executing them. Useful for generating migration files.
 */
export async function generateDDL(
  driver: Driver,
  models: Record<string, AnyModel>,
  options: { resolver?: Resolver } = {}
): Promise<{ operations: DiffOperation[]; sql: string[] }> {
  const result = await push(driver, models, {
    ...options,
    dryRun: true,
    force: true,
  });

  return {
    operations: result.operations,
    sql: result.sql,
  };
}

/**
 * Formats an operation for human-readable display
 */
export function formatOperation(op: DiffOperation): string {
  switch (op.type) {
    case "createTable":
      return `+ Create table "${op.table.name}" with ${op.table.columns.length} columns`;
    case "dropTable":
      return `- Drop table "${op.tableName}"`;
    case "renameTable":
      return `~ Rename table "${op.from}" → "${op.to}"`;
    case "addColumn":
      return `+ Add column "${op.column.name}" (${op.column.type}) to "${op.tableName}"`;
    case "dropColumn":
      return `- Drop column "${op.columnName}" from "${op.tableName}"`;
    case "renameColumn":
      return `~ Rename column "${op.from}" → "${op.to}" in "${op.tableName}"`;
    case "alterColumn":
      return `~ Alter column "${op.columnName}" in "${op.tableName}"`;
    case "createIndex":
      return `+ Create index "${op.index.name}" on "${op.tableName}"`;
    case "dropIndex":
      return `- Drop index "${op.indexName}"`;
    case "addForeignKey":
      return `+ Add foreign key "${op.fk.name}" to "${op.tableName}"`;
    case "dropForeignKey":
      return `- Drop foreign key "${op.fkName}" from "${op.tableName}"`;
    case "addUniqueConstraint":
      return `+ Add unique constraint "${op.constraint.name}" to "${op.tableName}"`;
    case "dropUniqueConstraint":
      return `- Drop unique constraint "${op.constraintName}" from "${op.tableName}"`;
    case "addPrimaryKey":
      return `+ Add primary key to "${op.tableName}"`;
    case "dropPrimaryKey":
      return `- Drop primary key "${op.constraintName}" from "${op.tableName}"`;
    case "createEnum":
      return `+ Create enum "${op.enumDef.name}" with values [${op.enumDef.values.join(", ")}]`;
    case "dropEnum":
      return `- Drop enum "${op.enumName}"`;
    case "alterEnum": {
      const parts: string[] = [];
      if (op.addValues?.length) parts.push(`add: ${op.addValues.join(", ")}`);
      if (op.removeValues?.length)
        parts.push(`remove: ${op.removeValues.join(", ")}`);
      return `~ Alter enum "${op.enumName}" (${parts.join("; ")})`;
    }
    default:
      return `Unknown operation: ${(op as any).type}`;
  }
}

/**
 * Formats all operations for human-readable display
 */
export function formatOperations(operations: DiffOperation[]): string {
  if (operations.length === 0) {
    return "No changes detected.";
  }

  return operations.map(formatOperation).join("\n");
}
