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

import type { AnyDriver } from "../drivers/driver";
import type { AnyModel } from "../schema/model";

/**
 * Minimal client interface required for migrations.
 * This allows push() to work with any object that has $driver and $schema.
 */
export interface MigrationClient {
  $driver: AnyDriver;
  $schema: Record<string, AnyModel>;
}

import { MigrationError, VibORMErrorCode } from "../errors";
import { diff } from "./differ";
import { getMigrationDriver, type MigrationDriver } from "./drivers";
import { alwaysAddDropResolver, resolveAmbiguousChanges } from "./resolver";
import { serializeModels } from "./serializer";
import {
  type AmbiguousChange,
  type ChangeResolution,
  createAmbiguousChange,
  createDestructiveChange,
  createEnumValueRemovalChange,
  type DiffOperation,
  type PushResult,
  type ResolveCallback,
  type ResolveChange,
  type Resolver,
  type SchemaSnapshot,
} from "./types";

// =============================================================================
// PUSH OPTIONS
// =============================================================================

// Re-export PushResult from types for convenience
export type { PushResult } from "./types";

export interface PushOptions {
  /** Skip confirmations for destructive and ambiguous changes */
  force?: boolean;
  /** Preview SQL without executing */
  dryRun?: boolean;
  /**
   * Drop all tables and enums before pushing schema.
   * If a storage driver is configured, also clears migration tracking.
   * Use with extreme caution - all data will be lost.
   */
  forceReset?: boolean;
  /**
   * Unified callback for resolving changes that require user input.
   * Called once per change, allowing granular control over each decision.
   *
   * Each change has methods for valid resolutions:
   * - Destructive: `change.proceed()`, `change.reject()`
   * - Ambiguous: `change.rename()`, `change.addAndDrop()`, `change.reject()`
   * - Enum value removal: `change.mapValues({...})`, `change.useNull()`, `change.reject()`
   *
   * **Combining with `force`:**
   * When both `resolve` and `force: true` are provided, the resolver takes precedence.
   * If the resolver returns `undefined` (doesn't handle a change), force mode kicks in:
   * - Destructive: auto-accepted
   * - Ambiguous: treated as add+drop
   * - Enum removal: set to NULL
   *
   * This allows patterns like "accept everything except dropping table X".
   *
   * @example
   * ```ts
   * // Protect specific tables while auto-accepting everything else
   * await migrations.push({
   *   force: true,
   *   resolve: async (change) => {
   *     if (change.type === "destructive" && change.table === "users") {
   *       return change.reject(); // Protect users table
   *     }
   *     // Return undefined to let force handle the rest
   *   },
   * });
   * ```
   */
  resolve?: ResolveCallback;
  /**
   * Internal: storage driver passed from migration client.
   * Used for forceReset to clear migration tracking if available.
   * @internal
   */
  _storageDriver?: import("./storage/driver").MigrationStorageDriver;
}

// =============================================================================
// PUSH FUNCTION
// =============================================================================

/**
 * Pushes schema changes directly to the database.
 *
 * @param client - VibORM client containing driver and schema
 * @param options - Push options
 * @returns Push result with operations and SQL statements
 */
export async function push(
  client: MigrationClient,
  options: PushOptions = {}
): Promise<PushResult> {
  const { force = false, dryRun = false, forceReset = false } = options;

  const driver = client.$driver;
  const models = client.$schema;

  // Get the migration driver for this database
  const migrationDriver = getMigrationDriver(driver.driverName, driver.dialect);

  // Handle forceReset - drop all tables before push
  if (forceReset && !dryRun) {
    await resetDatabase(driver, migrationDriver, options._storageDriver);
  }

  // 1. Serialize VibORM models to SchemaSnapshot
  const desired = serializeModels(models, { migrationDriver });

  // 2. Introspect current database state
  const current = await migrationDriver.introspect(async (sql, params) => {
    const result = await driver._executeRaw<any>(sql, params);
    return result;
  });

  // Create DDL context for drivers that need schema info (e.g., SQLite table recreation)
  const ddlContext = { currentSchema: current };

  // 3. Calculate diff
  const diffResult = diff(current, desired);

  // 4. Resolve changes using unified resolve callback
  let finalOperations: DiffOperation[];

  // Detect enum value removals that need resolution (per-column)
  const allEnumRemovals = detectEnumValueRemovals(
    diffResult.operations,
    current
  );

  // Separate removals: nullable columns can be auto-resolved to NULL
  const autoResolvableRemovals = allEnumRemovals.filter((r) => r.isNullable);
  const enumRemovalsNeedingResolution = allEnumRemovals.filter(
    (r) => !r.isNullable
  );

  if (options.resolve) {
    // Resolver provided - use it for all changes
    // If force is also true, unhandled changes (resolver returns undefined) will be auto-accepted
    finalOperations = await resolveWithCallback(
      diffResult,
      desired,
      enumRemovalsNeedingResolution,
      options.resolve,
      force // Pass force flag to auto-accept unhandled changes
    );
    // Auto-resolve nullable column enum removals
    finalOperations = applyForceEnumResolutions(
      finalOperations,
      autoResolvableRemovals
    );
  } else if (force) {
    // Force mode without resolver: auto-accept destructive, treat ambiguous as add+drop
    finalOperations = await resolveAmbiguousChanges(
      diffResult,
      desired,
      alwaysAddDropResolver
    );
    // Auto-resolve ALL enum value removals: set removed values to NULL
    finalOperations = applyForceEnumResolutions(
      finalOperations,
      allEnumRemovals
    );
  } else {
    // No resolve callback and not force: check if resolution is needed
    const destructiveOps = diffResult.operations.filter(isDestructiveOperation);
    const hasAmbiguous = diffResult.ambiguousChanges.length > 0;
    // Only non-nullable columns require resolution
    const hasEnumRemovalsNeedingResolution =
      enumRemovalsNeedingResolution.length > 0;

    if (
      destructiveOps.length > 0 ||
      hasAmbiguous ||
      hasEnumRemovalsNeedingResolution
    ) {
      const descriptions: string[] = [];

      for (const op of destructiveOps) {
        descriptions.push(formatDestructiveOperation(op));
      }

      for (const change of diffResult.ambiguousChanges) {
        descriptions.push(formatAmbiguousChangeDescription(change));
      }

      for (const removal of enumRemovalsNeedingResolution) {
        descriptions.push(
          `[enumValueRemoval] "${removal.tableName}.${removal.columnName}" uses enum "${removal.enumName}" - removing values: ${removal.removedValues.join(", ")} (non-nullable)`
        );
      }

      throw new MigrationError(
        `Changes requiring resolution detected:\n${descriptions.join("\n")}\n\n` +
          "Use --force to auto-accept or provide a resolve callback.",
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }

    // Auto-resolve nullable column enum removals (no prompting needed)
    finalOperations = applyForceEnumResolutions(
      [...diffResult.operations],
      autoResolvableRemovals
    );
  }

  // 6. Generate DDL statements
  const sql: string[] = [];
  for (const op of finalOperations) {
    const ddl = migrationDriver.generateDDL(op, ddlContext);
    // generateDDL may return multiple statements separated by ;\n
    const statements = ddl.split(";\n").filter((s) => s.trim());
    sql.push(...statements);
  }

  // 7. Execute DDL (unless dry run)
  if (!dryRun && sql.length > 0) {
    // Check if driver supports ADD VALUE in transaction
    const canAddValueInTransaction =
      migrationDriver.capabilities.supportsAddEnumValueInTransaction;

    // Separate ALTER TYPE ... ADD VALUE statements if needed
    // (PostgreSQL limitation: ADD VALUE cannot be executed inside a transaction block)
    const addValueStatements: string[] = [];
    const transactionalStatements: string[] = [];

    for (const statement of sql) {
      if (
        !canAddValueInTransaction &&
        statement.trim().match(/^ALTER\s+TYPE\s+.*\s+ADD\s+VALUE\s+/i)
      ) {
        addValueStatements.push(statement);
      } else {
        transactionalStatements.push(statement);
      }
    }

    // Execute ADD VALUE statements outside transaction first
    for (const statement of addValueStatements) {
      await driver._executeRaw(statement + ";");
    }

    // Execute remaining statements in a transaction for atomicity
    if (transactionalStatements.length > 0) {
      await driver._transaction(async () => {
        for (const statement of transactionalStatements) {
          await driver._executeRaw(statement + ";");
        }
      });
    }
  }

  return {
    operations: finalOperations,
    applied: !dryRun && sql.length > 0,
    sql,
  };
}

// =============================================================================
// RESET HELPERS
// =============================================================================

/**
 * Resets the database by dropping all tables and enums.
 * If storage driver is provided, also clears migration tracking.
 */
async function resetDatabase(
  driver: AnyDriver,
  migrationDriver: MigrationDriver,
  storageDriver?: import("./storage/driver").MigrationStorageDriver
): Promise<void> {
  // Get current schema to know what to drop
  const current = await migrationDriver.introspect(async (sql, params) => {
    const result = await driver._executeRaw<any>(sql, params);
    return result;
  });

  // Drop all tables in reverse order (for FK dependencies)
  // NOTE: Reverse order helps with simple FK chains but doesn't handle circular dependencies.
  // PostgreSQL uses CASCADE to handle this. SQLite/MySQL may fail on circular FKs.
  const tablesToDrop = [...current.tables].reverse();
  for (const table of tablesToDrop) {
    const dropSql = migrationDriver.generateDropTableSQL(table.name, true);
    await driver._executeRaw(dropSql + ";");
  }

  // Drop all enums (only for databases that support them)
  if (current.enums) {
    for (const enumDef of current.enums) {
      const dropSql = migrationDriver.generateDropEnumSQL(enumDef.name);
      if (dropSql) {
        await driver._executeRaw(dropSql + ";");
      }
    }
  }

  // If storage driver exists, clear the journal and snapshot
  if (storageDriver) {
    // Write empty journal
    await storageDriver.writeJournal({
      version: "1",
      dialect: driver.dialect as "postgresql" | "sqlite",
      entries: [],
    });
    // Clear snapshot
    await storageDriver.writeSnapshot({ tables: [], enums: [] });
  }
}

// =============================================================================
// RESOLVE HELPERS
// =============================================================================

/** Detected enum value removal needing resolution (per-column) */
interface EnumRemoval {
  enumName: string;
  tableName: string;
  columnName: string;
  isNullable: boolean;
  removedValues: string[];
  availableValues: string[];
}

/**
 * Detects enum value removals that need resolution.
 * Returns one removal per column that uses the enum.
 * Nullable columns can be auto-resolved to NULL.
 */
function detectEnumValueRemovals(
  operations: DiffOperation[],
  currentSchema: SchemaSnapshot
): EnumRemoval[] {
  const removals: EnumRemoval[] = [];

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
        const dependentColumns = op.dependentColumns || [];

        // Create one removal per column
        for (const dep of dependentColumns) {
          const table = currentSchema.tables.find(
            (t) => t.name === dep.tableName
          );
          if (!table) {
            throw new MigrationError(
              `Table "${dep.tableName}" not found in current schema for enum "${op.enumName}"`,
              VibORMErrorCode.INTERNAL_ERROR
            );
          }
          const column = table.columns.find((c) => c.name === dep.columnName);
          if (!column) {
            throw new MigrationError(
              `Column "${dep.columnName}" not found in table "${dep.tableName}" for enum "${op.enumName}"`,
              VibORMErrorCode.INTERNAL_ERROR
            );
          }
          const isNullable = column.nullable;

          removals.push({
            enumName: op.enumName,
            tableName: dep.tableName,
            columnName: dep.columnName,
            isNullable,
            removedValues: unresolvedValues,
            availableValues: op.newValues || [],
          });
        }
      }
    }
  }

  return removals;
}

/**
 * Applies force mode resolutions for enum value removals.
 * Sets all removed values to NULL for each column.
 */
function applyForceEnumResolutions(
  operations: DiffOperation[],
  enumRemovals: EnumRemoval[]
): DiffOperation[] {
  if (enumRemovals.length === 0) {
    return operations;
  }

  // Group removals by enum name
  const removalsByEnum = new Map<string, EnumRemoval[]>();
  for (const removal of enumRemovals) {
    const existing = removalsByEnum.get(removal.enumName) || [];
    existing.push(removal);
    removalsByEnum.set(removal.enumName, existing);
  }

  return operations.map((op) => {
    if (op.type !== "alterEnum" || !op.removeValues) {
      return op;
    }

    const removals = removalsByEnum.get(op.enumName);
    if (!removals || removals.length === 0) {
      return op;
    }

    // Build per-column value replacements (all set to null in force mode)
    const columnValueReplacements: Record<
      string,
      Record<string, string | null>
    > = {
      ...op.columnValueReplacements,
    };

    for (const removal of removals) {
      const columnKey = `${removal.tableName}.${removal.columnName}`;
      const nullMappings: Record<string, null> = {};
      for (const value of removal.removedValues) {
        nullMappings[value] = null;
      }
      columnValueReplacements[columnKey] = {
        ...columnValueReplacements[columnKey],
        ...nullMappings,
      };
    }

    return {
      ...op,
      columnValueReplacements,
    };
  });
}

/**
 * Resolves changes using the unified resolve callback.
 * Calls the callback once per destructive/ambiguous/enum change.
 * For enum value removals, calls once per column using the enum.
 *
 * @param force - If true, unhandled changes (resolver returns undefined) are auto-accepted
 */
async function resolveWithCallback(
  diffResult: {
    operations: DiffOperation[];
    ambiguousChanges: AmbiguousChange[];
  },
  desiredSnapshot: SchemaSnapshot,
  enumRemovals: EnumRemoval[],
  resolve: ResolveCallback,
  force = false
): Promise<DiffOperation[]> {
  const finalOperations: DiffOperation[] = [];
  const ambiguousResolutions = new Map<AmbiguousChange, ChangeResolution>();
  // Per-column mappings: Map<enumName, Map<"tableName.columnName", mappings>>
  const columnMappings = new Map<
    string,
    Map<string, Record<string, string | null>>
  >();

  // 1. Process non-destructive, non-enum operations (pass through)
  for (const op of diffResult.operations) {
    if (!isDestructiveOperation(op) && op.type !== "alterEnum") {
      finalOperations.push(op);
    }
  }

  // 2. Resolve destructive operations
  for (const op of diffResult.operations) {
    if (isDestructiveOperation(op)) {
      const change = operationToResolveChange(op);
      const result = await resolve(change);

      if (result === "reject") {
        throw new MigrationError(
          `Change rejected: ${change.description}`,
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }

      if (result === undefined) {
        // Resolver didn't handle this change
        if (force) {
          // Force mode: auto-accept
          finalOperations.push(op);
        } else {
          // No force: throw error
          throw new MigrationError(
            `Unresolved destructive change: ${change.description}\n` +
              "Return change.proceed() or change.reject() from the resolver, or use force: true.",
            VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
          );
        }
        continue;
      }

      if (result === "proceed") {
        finalOperations.push(op);
      }
      // "rename" and "addAndDrop" are invalid for destructive ops, treat as proceed
      if (result === "rename" || result === "addAndDrop") {
        finalOperations.push(op);
      }
    }
  }

  // 3. Resolve ambiguous changes
  for (const change of diffResult.ambiguousChanges) {
    const resolveChange = ambiguousToResolveChange(change);
    const result = await resolve(resolveChange);

    if (result === "reject") {
      throw new MigrationError(
        `Change rejected: ${resolveChange.description}`,
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }

    if (result === undefined) {
      // Resolver didn't handle this change
      if (force) {
        // Force mode: treat as addAndDrop
        ambiguousResolutions.set(change, { type: "addAndDrop" });
      } else {
        // No force: throw error
        throw new MigrationError(
          `Unresolved ambiguous change: ${resolveChange.description}\n` +
            "Return change.rename() or change.addAndDrop() from the resolver, or use force: true.",
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
      continue;
    }

    if (result === "rename") {
      ambiguousResolutions.set(change, { type: "rename" });
    } else {
      // "addAndDrop" or "proceed" (treat proceed as addAndDrop for ambiguous)
      ambiguousResolutions.set(change, { type: "addAndDrop" });
    }
  }

  // 4. Resolve enum value removals (per-column)
  for (const removal of enumRemovals) {
    const change = createEnumValueRemovalChange({
      enumName: removal.enumName,
      tableName: removal.tableName,
      columnName: removal.columnName,
      isNullable: removal.isNullable,
      removedValues: removal.removedValues,
      availableValues: removal.availableValues,
      description:
        `Column "${removal.tableName}.${removal.columnName}" uses enum "${removal.enumName}" - ` +
        `removing values: ${removal.removedValues.join(", ")}. ` +
        `Map to: ${removal.availableValues.join(", ")} or NULL`,
    });

    const result = await resolve(change);

    if (result === "reject") {
      throw new MigrationError(
        `Change rejected: ${change.description}`,
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }

    const columnKey = `${removal.tableName}.${removal.columnName}`;

    if (result === undefined) {
      // Resolver didn't handle this change
      if (force) {
        // Force mode: set all to null
        if (!columnMappings.has(removal.enumName)) {
          columnMappings.set(removal.enumName, new Map());
        }
        const enumColMappings = columnMappings.get(removal.enumName)!;
        const nullMappings: Record<string, null> = {};
        for (const value of removal.removedValues) {
          nullMappings[value] = null;
        }
        enumColMappings.set(columnKey, nullMappings);
      } else {
        // No force: throw error
        throw new MigrationError(
          `Unresolved enum value removal: ${change.description}\n` +
            "Return change.mapValues() or change.useNull() from the resolver, or use force: true.",
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
      continue;
    }

    if (result === "enumMapped") {
      // Get or create the enum's column mapping
      if (!columnMappings.has(removal.enumName)) {
        columnMappings.set(removal.enumName, new Map());
      }
      const enumColMappings = columnMappings.get(removal.enumName)!;

      if (change._mappings) {
        // Explicit mappings provided via mapValues()
        enumColMappings.set(columnKey, change._mappings);
      } else if (change._useNullDefault) {
        // useNull() was called - create mappings with all values -> null
        const nullMappings: Record<string, null> = {};
        for (const value of removal.removedValues) {
          nullMappings[value] = null;
        }
        enumColMappings.set(columnKey, nullMappings);
      }
    }
    // Other results (proceed, rename, addAndDrop) - no mapping, will use null default
  }

  // 5. Apply ambiguous resolutions
  if (diffResult.ambiguousChanges.length > 0) {
    const resolvedOps = applyAmbiguousResolutions(
      diffResult.ambiguousChanges,
      ambiguousResolutions,
      desiredSnapshot
    );
    finalOperations.push(...resolvedOps);
  }

  // 6. Process alterEnum operations with resolved per-column mappings
  for (const op of diffResult.operations) {
    if (op.type === "alterEnum") {
      const enumColMappings = columnMappings.get(op.enumName);
      if (enumColMappings && enumColMappings.size > 0) {
        // Convert Map to Record for columnValueReplacements
        const columnValueReplacements: Record<
          string,
          Record<string, string | null>
        > = {
          ...op.columnValueReplacements,
        };
        for (const [colKey, mappings] of enumColMappings) {
          columnValueReplacements[colKey] = {
            ...columnValueReplacements[colKey],
            ...mappings,
          };
        }
        finalOperations.push({
          ...op,
          columnValueReplacements,
        });
      } else {
        // No mapping provided, use null as default replacement
        finalOperations.push({
          ...op,
          defaultReplacement: op.defaultReplacement ?? null,
        });
      }
    }
  }

  return sortOperations(finalOperations);
}

/**
 * Checks if an operation is destructive (causes data loss).
 */
function isDestructiveOperation(op: DiffOperation): boolean {
  if (op.type === "dropTable" || op.type === "dropColumn") {
    return true;
  }
  if (op.type === "alterColumn") {
    // Type changes or making non-nullable are potentially destructive
    const typeChanged =
      normalizeType(op.from.type) !== normalizeType(op.to.type);
    const madeNonNullable = op.from.nullable && !op.to.nullable;
    return typeChanged || madeNonNullable;
  }
  return false;
}

/**
 * Normalizes a type string for comparison.
 */
function normalizeType(type: string): string {
  return type.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Converts a destructive operation to a ResolveChange with resolution methods.
 */
function operationToResolveChange(op: DiffOperation): ResolveChange {
  switch (op.type) {
    case "dropTable":
      return createDestructiveChange({
        operation: "dropTable",
        table: op.tableName,
        description: `Drop table "${op.tableName}" (all data will be lost)`,
      });
    case "dropColumn":
      return createDestructiveChange({
        operation: "dropColumn",
        table: op.tableName,
        column: op.columnName,
        description: `Drop column "${op.columnName}" from table "${op.tableName}" (data will be lost)`,
      });
    case "alterColumn":
      return createDestructiveChange({
        operation: "alterColumn",
        table: op.tableName,
        column: op.columnName,
        description: `Alter column "${op.columnName}" in "${op.tableName}" (${op.from.type} → ${op.to.type})`,
      });
    default:
      throw new Error(`Unexpected operation type: ${(op as any).type}`);
  }
}

/**
 * Converts an ambiguous change to a ResolveChange with resolution methods.
 */
function ambiguousToResolveChange(change: AmbiguousChange): ResolveChange {
  if (change.type === "ambiguousColumn") {
    return createAmbiguousChange({
      operation: "renameColumn",
      table: change.tableName,
      column: change.addedColumn.name,
      oldName: change.droppedColumn.name,
      newName: change.addedColumn.name,
      oldType: change.droppedColumn.type,
      newType: change.addedColumn.type,
      description: `Column "${change.droppedColumn.name}" → "${change.addedColumn.name}" in table "${change.tableName}" (rename or add+drop?)`,
    });
  }
  return createAmbiguousChange({
    operation: "renameTable",
    table: change.addedTable,
    oldName: change.droppedTable,
    newName: change.addedTable,
    description: `Table "${change.droppedTable}" → "${change.addedTable}" (rename or add+drop?)`,
  });
}

/**
 * Formats a destructive operation for error messages.
 */
function formatDestructiveOperation(op: DiffOperation): string {
  switch (op.type) {
    case "dropTable":
      return `[destructive] Drop table "${op.tableName}"`;
    case "dropColumn":
      return `[destructive] Drop column "${op.columnName}" from "${op.tableName}"`;
    case "alterColumn":
      return `[destructive] Alter column "${op.columnName}" in "${op.tableName}"`;
    default:
      return `[destructive] ${(op as any).type}`;
  }
}

/**
 * Formats an ambiguous change for error messages.
 */
function formatAmbiguousChangeDescription(change: AmbiguousChange): string {
  if (change.type === "ambiguousColumn") {
    return `[ambiguous] Column "${change.droppedColumn.name}" → "${change.addedColumn.name}" in "${change.tableName}"`;
  }
  return `[ambiguous] Table "${change.droppedTable}" → "${change.addedTable}"`;
}

/**
 * Applies ambiguous resolutions to generate operations.
 */
function applyAmbiguousResolutions(
  changes: AmbiguousChange[],
  resolutions: Map<AmbiguousChange, ChangeResolution>,
  desiredSnapshot: SchemaSnapshot
): DiffOperation[] {
  const operations: DiffOperation[] = [];

  for (const change of changes) {
    const resolution = resolutions.get(change);
    if (!resolution) continue;

    if (change.type === "ambiguousColumn") {
      if (resolution.type === "rename") {
        operations.push({
          type: "renameColumn",
          tableName: change.tableName,
          from: change.droppedColumn.name,
          to: change.addedColumn.name,
        });

        // If column properties differ, also alter it
        if (
          change.droppedColumn.nullable !== change.addedColumn.nullable ||
          change.droppedColumn.default !== change.addedColumn.default
        ) {
          operations.push({
            type: "alterColumn",
            tableName: change.tableName,
            columnName: change.addedColumn.name,
            from: { ...change.droppedColumn, name: change.addedColumn.name },
            to: change.addedColumn,
          });
        }
      } else {
        // addAndDrop
        operations.push(
          {
            type: "dropColumn",
            tableName: change.tableName,
            columnName: change.droppedColumn.name,
          },
          {
            type: "addColumn",
            tableName: change.tableName,
            column: change.addedColumn,
          }
        );
      }
    } else if (change.type === "ambiguousTable") {
      if (resolution.type === "rename") {
        operations.push({
          type: "renameTable",
          from: change.droppedTable,
          to: change.addedTable,
        });
      } else {
        // addAndDrop
        operations.push({ type: "dropTable", tableName: change.droppedTable });
        const newTable = desiredSnapshot.tables.find(
          (t) => t.name === change.addedTable
        );
        if (newTable) {
          operations.push({ type: "createTable", table: newTable });
        }
      }
    }
  }

  return operations;
}

/**
 * Sorts operations in the correct execution order.
 */
function sortOperations(operations: DiffOperation[]): DiffOperation[] {
  const priority: Record<string, number> = {
    createEnum: 0,
    alterEnum: 1,
    dropForeignKey: 2,
    dropIndex: 3,
    dropUniqueConstraint: 4,
    dropPrimaryKey: 5,
    dropColumn: 6,
    dropTable: 7,
    createTable: 8,
    renameTable: 9,
    addColumn: 10,
    renameColumn: 11,
    alterColumn: 12,
    addPrimaryKey: 13,
    addUniqueConstraint: 14,
    createIndex: 15,
    addForeignKey: 16,
    dropEnum: 17,
  };

  return [...operations].sort((a, b) => {
    const pa = priority[a.type] ?? 100;
    const pb = priority[b.type] ?? 100;
    return pa - pb;
  });
}

// =============================================================================
// INTROSPECTION & DDL GENERATION
// =============================================================================

/**
 * Introspects the current database schema without making any changes.
 * Useful for debugging or displaying current state.
 */
export async function introspect(
  client: MigrationClient
): Promise<SchemaSnapshot> {
  const driver = client.$driver;
  const migrationDriver = getMigrationDriver(driver.driverName, driver.dialect);
  return migrationDriver.introspect(async (sql, params) => {
    const result = await driver._executeRaw<any>(sql, params);
    return result;
  });
}

/**
 * Generates DDL statements for transforming current schema to desired schema
 * without executing them. Useful for generating migration files.
 */
export async function generateDDL(
  client: MigrationClient,
  options: { resolver?: Resolver } = {}
): Promise<{ operations: DiffOperation[]; sql: string[] }> {
  const result = await push(client, {
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
