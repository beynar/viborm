/**
 * Migration Utilities
 *
 * Shared utilities for migration operations. Consolidates duplicated code
 * from push.ts, generate/index.ts, and apply/index.ts.
 */

import { relative, resolve } from "node:path";
import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import type {
  Dialect,
  DiffOperation,
  EnumValueRemoval,
  EnumValueResolver,
  MigrationEntry,
} from "./types";

// =============================================================================
// CONSTANTS
// =============================================================================

export const DEFAULT_MIGRATIONS_DIR = "./migrations";
export const DEFAULT_TABLE_NAME = "_viborm_migrations";

// =============================================================================
// DIALECT UTILITIES
// =============================================================================

/**
 * Validates and normalizes the database dialect for migrations.
 * Throws if the dialect is not supported.
 */
export function normalizeDialect(dialect: string): Dialect {
  if (dialect === "postgresql" || dialect === "postgres") {
    return "postgresql";
  }
  if (dialect === "sqlite") {
    return "sqlite";
  }
  if (dialect === "mysql") {
    return "mysql";
  }
  throw new MigrationError(
    `Unsupported dialect for migrations: "${dialect}". ` +
      "Supported dialects: postgresql, sqlite, mysql.",
    VibORMErrorCode.MIGRATION_DIALECT_MISMATCH,
    { meta: { dialect } }
  );
}

// =============================================================================
// PATH UTILITIES
// =============================================================================

/**
 * Validates and resolves the migrations directory path.
 * Ensures the path doesn't escape the project root (security).
 */
export function validateMigrationsDir(dir: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, dir);
  const rel = relative(cwd, resolved);

  // Ensure path doesn't escape project root
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new MigrationError(
      `Invalid migrations directory: "${dir}". Path must be within project root.`,
      VibORMErrorCode.INVALID_INPUT,
      { meta: { migrationsDir: dir } }
    );
  }

  return resolved;
}

// =============================================================================
// TABLE NAME UTILITIES
// =============================================================================

/**
 * Validates the migration table name to prevent SQL injection.
 * Only allows alphanumeric characters and underscores.
 */
export function validateTableName(tableName: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new MigrationError(
      `Invalid migration table name: "${tableName}". ` +
        "Only alphanumeric characters and underscores are allowed.",
      VibORMErrorCode.INVALID_INPUT,
      { meta: { table: tableName } }
    );
  }
  return tableName;
}

// =============================================================================
// QUERY EXECUTOR
// =============================================================================

/**
 * Type for executing SQL queries and returning rows.
 */
export type QueryExecutor = (
  sql: string,
  params?: unknown[]
) => Promise<unknown[]>;

/**
 * Creates a query executor from a driver.
 * Extracts rows from the QueryResult.
 */
export function createQueryExecutor(driver: AnyDriver): QueryExecutor {
  return async (sql: string, params?: unknown[]) => {
    const result = await driver._executeRaw<Record<string, unknown>>(
      sql,
      params
    );
    return result.rows;
  };
}

// =============================================================================
// OPERATION UTILITIES
// =============================================================================

/**
 * Operation execution order priorities.
 * Lower numbers execute first.
 */
const OPERATION_PRIORITY: Record<DiffOperation["type"], number> = {
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

/**
 * Sorts operations for proper execution order:
 * 1. Create enums (before tables that use them)
 * 2. Drop foreign keys (before dropping tables/columns)
 * 3. Drop indexes, constraints, columns
 * 4. Drop tables
 * 5. Create tables
 * 6. Add columns, constraints
 * 7. Create indexes
 * 8. Add foreign keys (after tables/columns exist)
 */
export function sortOperations(operations: DiffOperation[]): DiffOperation[] {
  return [...operations].sort(
    (a, b) => OPERATION_PRIORITY[a.type] - OPERATION_PRIORITY[b.type]
  );
}

// =============================================================================
// ENUM VALUE RESOLUTION
// =============================================================================

/**
 * Resolves enum value removals by calling the resolver callback (if provided)
 * and merging the resolutions into the operations.
 */
export async function resolveEnumValueRemovals(
  operations: DiffOperation[],
  resolver?: EnumValueResolver
): Promise<DiffOperation[]> {
  // Find alterEnum operations with removeValues that need resolution
  const removals: EnumValueRemoval[] = [];

  for (const op of operations) {
    if (
      op.type === "alterEnum" &&
      op.removeValues &&
      op.removeValues.length > 0
    ) {
      // Check if any removed values lack replacements
      const unresolvedValues = op.removeValues.filter((v) => {
        const hasExplicit = op.valueReplacements && v in op.valueReplacements;
        const hasDefault = op.defaultReplacement !== undefined;
        return !(hasExplicit || hasDefault);
      });

      if (unresolvedValues.length > 0) {
        removals.push({
          enumName: op.enumName,
          removedValues: unresolvedValues,
          newValues: op.newValues || [],
          dependentColumns: op.dependentColumns || [],
        });
      }
    }
  }

  // If no unresolved removals or no resolver, return operations unchanged
  if (removals.length === 0 || !resolver) {
    return operations;
  }

  // Call the resolver
  const resolutions = await resolver(removals);

  // Merge resolutions into operations
  return operations.map((op) => {
    if (op.type !== "alterEnum" || !op.removeValues) {
      return op;
    }

    const resolution = resolutions.get(op.enumName);
    if (!resolution) {
      return op;
    }

    // Merge the resolution into the operation
    return {
      ...op,
      valueReplacements: {
        ...op.valueReplacements,
        ...resolution.valueReplacements,
      },
      defaultReplacement:
        resolution.defaultReplacement ?? op.defaultReplacement,
    };
  });
}

// =============================================================================
// MIGRATION FILE UTILITIES
// =============================================================================

/**
 * Formats a migration filename from entry.
 * Example: 0000_initial.sql, 0001_add-users.sql
 */
export function formatMigrationFilename(entry: MigrationEntry): string {
  const paddedIdx = String(entry.idx).padStart(4, "0");
  return `${paddedIdx}_${entry.name}.sql`;
}

/**
 * Generate a migration name based on the operations.
 */
export function generateMigrationName(operations: DiffOperation[]): string {
  if (operations.length === 0) {
    return "empty";
  }

  const primaryOp = operations[0];
  if (!primaryOp) {
    return "migration";
  }

  switch (primaryOp.type) {
    case "createTable":
      return operations.length === 1
        ? `create-${primaryOp.table.name}`
        : "initial";
    case "dropTable":
      return `drop-${primaryOp.tableName}`;
    case "addColumn":
      return `add-${primaryOp.column.name}-to-${primaryOp.tableName}`;
    case "dropColumn":
      return `drop-${primaryOp.columnName}-from-${primaryOp.tableName}`;
    case "renameTable":
      return `rename-${primaryOp.from}-to-${primaryOp.to}`;
    case "renameColumn":
      return `rename-${primaryOp.from}-to-${primaryOp.to}`;
    case "createIndex":
      return `add-index-${primaryOp.index.name}`;
    case "dropIndex":
      return `drop-index-${primaryOp.indexName}`;
    case "addForeignKey":
      return `add-fk-${primaryOp.fk.name}`;
    case "dropForeignKey":
      return `drop-fk-${primaryOp.fkName}`;
    case "createEnum":
      return `create-enum-${primaryOp.enumDef.name}`;
    case "dropEnum":
      return `drop-enum-${primaryOp.enumName}`;
    case "alterEnum":
      return `alter-enum-${primaryOp.enumName}`;
    default:
      return "migration";
  }
}
