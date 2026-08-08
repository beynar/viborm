import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type { AnyModel } from "../../schema/model";
import { diff, type IndexPredicateCanonicalizer } from "../differ";
import type { MigrationDriver } from "../drivers";
import { getMigrationDriver } from "../drivers";
import { alwaysAddDropResolver, resolveAmbiguousChanges } from "../resolver";
import { serializeModels } from "../serializer";
import type { MigrationStorageDriver } from "../storage/driver";
import {
  type AmbiguousChange,
  type ChangeResolution,
  createAmbiguousChange,
  createDestructiveChange,
  type DiffOperation,
  type ResolveCallback,
  type ResolveChange,
  type SchemaSnapshot,
} from "../types";
import { extractForwardReferenceForeignKeys } from "../utils";
import {
  applyForceEnumResolutions,
  applyResolvedEnumMappings,
  detectEnumValueRemovals,
  type EnumRemoval,
  resolveEnumValueRemovalMappings,
} from "./enum-removals";
import {
  formatAmbiguousChangeDescription,
  formatDestructiveOperation,
} from "./format";

/**
 * Minimal client interface required for migrations.
 * This allows push() to work with any object that has $driver and $schema.
 */
export interface MigrationClient {
  $driver: AnyDriver;
  $schema: Record<string, AnyModel>;
}

export interface PushOptions {
  /** Skip confirmations for destructive and ambiguous changes */
  force?: boolean;
  /**
   * Skip schema validation before pushing. Validation catches definition
   * errors that would otherwise corrupt data silently (e.g. two relation
   * pairs sharing one junction table) — only skip it when deliberately
   * pushing a shape the validator flags.
   */
  skipValidation?: boolean;
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
  _storageDriver?: MigrationStorageDriver;
}

export interface PushPlan {
  operations: DiffOperation[];
  currentSchema: SchemaSnapshot;
}

export function getPushMigrationDriver(
  client: MigrationClient
): MigrationDriver {
  return getMigrationDriver(client.$driver.driverName, client.$driver.dialect);
}

/**
 * Introspects the current database schema without making any changes.
 * Useful for debugging or displaying current state.
 */
export async function introspect(
  client: MigrationClient
): Promise<SchemaSnapshot> {
  return introspectSchema(client.$driver, getPushMigrationDriver(client));
}

export async function introspectSchema(
  driver: AnyDriver,
  migrationDriver: MigrationDriver
): Promise<SchemaSnapshot> {
  return migrationDriver.introspect((sql, params) =>
    driver._executeRaw(sql, params)
  );
}

/**
 * Hands the differ a way to ask the database for its own spelling of a declared
 * partial-index predicate (Decision 7.4). Returns undefined when nobody can
 * answer, and the differ then compares the two texts raw — the reading that
 * plans a drop and a create, which is the safe direction.
 *
 * The whole canonicalization runs inside ONE transaction, for two reasons that
 * both matter: it pins a single connection (the scratch objects it needs are
 * session-local, and a pool hands out a different connection per statement),
 * and a failure anywhere rolls the scratch away instead of leaving it attached
 * to a table this push may be about to drop.
 */
function buildIndexPredicateCanonicalizer(
  driver: AnyDriver,
  migrationDriver: MigrationDriver
): IndexPredicateCanonicalizer | undefined {
  const canonicalize = migrationDriver.canonicalizeIndexPredicates;
  if (!(canonicalize && driver.supportsTransactions)) return;

  return async (tableName, predicates) => {
    try {
      return await driver.withTransaction((tx) =>
        canonicalize.call(
          migrationDriver,
          tableName,
          predicates,
          (sql, params) => tx._executeRaw(sql, params)
        )
      );
    } catch {
      // Fail closed, and stay out of the way. A predicate the database cannot
      // parse, a connection that refused, a dialect that changed under us —
      // none of it may make a push fail, and none of it may be read as "these
      // two predicates are the same". Answering nothing leaves the differ with
      // the raw texts, which is exactly the pre-7.4 behavior.
      return predicates.map(() => undefined);
    }
  };
}

export async function planPush(
  client: MigrationClient,
  migrationDriver: MigrationDriver,
  options: PushOptions
): Promise<PushPlan> {
  const desired = serializeModels(client.$schema, { migrationDriver });
  // Live introspection sees the private columns and index, but a text
  // discriminator cannot reveal historical public/stored member mappings.
  // Push therefore compares structure only. Stored-value history is owned by
  // file-based generate(), where both serialized snapshots are available.
  const current = await introspectSchema(client.$driver, migrationDriver);
  const diffResult = await diff(current, desired, {
    canonicalizeIndexPredicate: buildIndexPredicateCanonicalizer(
      client.$driver,
      migrationDriver
    ),
    // `current` was just introspected. Where that introspection cannot read a
    // constraint's name back, the name it carries is a synthesis and matching
    // on it would make every unchanged constraint read as a change.
    matchConstraintsByShape:
      !migrationDriver.capabilities.introspectionReadsConstraintNames,
  });
  const operations = await resolvePushOperations(
    diffResult,
    desired,
    current,
    options
  );

  // Lift forward-reference FKs out of CREATE TABLE so every referenced table
  // exists before its constraint is added (Postgres/MySQL). No-op on
  // SQLite/LibSQL, which keep FKs inline and resolve forward refs lazily.
  const orderedOperations = extractForwardReferenceForeignKeys(
    operations,
    migrationDriver
  );

  return {
    operations: addFkDropsForDroppedTables(
      orderedOperations,
      current,
      migrationDriver
    ),
    currentSchema: current,
  };
}

/**
 * MySQL ignores DROP TABLE ... CASCADE (error 3730/1217 instead), so every
 * FK that belongs to or references a dropped table must be dropped first.
 * Other dialects drop with CASCADE (PG) or rebuild tables (SQLite), so this
 * is a no-op for them.
 */
function addFkDropsForDroppedTables(
  operations: DiffOperation[],
  current: SchemaSnapshot,
  migrationDriver: MigrationDriver
): DiffOperation[] {
  if (migrationDriver.dialect !== "mysql") {
    return operations;
  }

  const droppedTables = new Set(
    operations
      .filter((op) => op.type === "dropTable")
      .map((op) => (op as { tableName: string }).tableName)
  );
  if (droppedTables.size === 0) {
    return operations;
  }

  const plannedFkDrops = new Set(
    operations
      .filter((op) => op.type === "dropForeignKey")
      .map((op) => {
        const fkOp = op as { tableName: string; fkName: string };
        return `${fkOp.tableName} ${fkOp.fkName}`;
      })
  );

  const fkDrops: DiffOperation[] = [];
  for (const table of current.tables) {
    for (const fk of table.foreignKeys) {
      const implicated =
        droppedTables.has(table.name) || droppedTables.has(fk.referencedTable);
      if (implicated && !plannedFkDrops.has(`${table.name} ${fk.name}`)) {
        fkDrops.push({
          type: "dropForeignKey",
          tableName: table.name,
          fkName: fk.name,
        });
      }
    }
  }

  return [...fkDrops, ...operations];
}

async function resolvePushOperations(
  diffResult: {
    operations: DiffOperation[];
    ambiguousChanges: AmbiguousChange[];
  },
  desired: SchemaSnapshot,
  current: SchemaSnapshot,
  options: PushOptions
): Promise<DiffOperation[]> {
  const force = options.force ?? false;
  const allEnumRemovals = detectEnumValueRemovals(
    diffResult.operations,
    current
  );
  const autoResolvableRemovals = allEnumRemovals.filter(
    (removal) => removal.isNullable
  );
  const enumRemovalsNeedingResolution = allEnumRemovals.filter(
    (removal) => !removal.isNullable
  );

  if (options.resolve) {
    const resolvedOperations = await resolveWithCallback(
      diffResult,
      desired,
      enumRemovalsNeedingResolution,
      options.resolve,
      force
    );
    return applyForceEnumResolutions(
      resolvedOperations,
      autoResolvableRemovals
    );
  }

  if (force) {
    const resolvedOperations = await resolveAmbiguousChanges(
      diffResult,
      desired,
      alwaysAddDropResolver
    );
    return applyForceEnumResolutions(resolvedOperations, allEnumRemovals);
  }

  rejectUnresolvedChanges(diffResult, enumRemovalsNeedingResolution);

  return applyForceEnumResolutions(
    [...diffResult.operations],
    autoResolvableRemovals
  );
}

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

  for (const op of diffResult.operations) {
    if (!isDestructiveOperation(op) && op.type !== "alterEnum") {
      finalOperations.push(op);
    }
  }

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
        if (force) {
          finalOperations.push(op);
        } else {
          throw new MigrationError(
            `Unresolved destructive change: ${change.description}\n` +
              "Return change.proceed() or change.reject() from the resolver, or use force: true.",
            VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
          );
        }
        continue;
      }

      if (
        result === "proceed" ||
        result === "rename" ||
        result === "addAndDrop"
      ) {
        finalOperations.push(op);
      }
    }
  }

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
      if (force) {
        ambiguousResolutions.set(change, { type: "addAndDrop" });
      } else {
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
      ambiguousResolutions.set(change, { type: "addAndDrop" });
    }
  }

  const enumColumnMappings = await resolveEnumValueRemovalMappings(
    enumRemovals,
    resolve,
    force
  );

  if (diffResult.ambiguousChanges.length > 0) {
    const resolvedOperations = applyAmbiguousResolutions(
      diffResult.ambiguousChanges,
      ambiguousResolutions,
      desiredSnapshot
    );
    finalOperations.push(...resolvedOperations);
  }

  finalOperations.push(
    ...applyResolvedEnumMappings(diffResult.operations, enumColumnMappings)
  );

  return sortOperations(finalOperations);
}

function rejectUnresolvedChanges(
  diffResult: {
    operations: DiffOperation[];
    ambiguousChanges: AmbiguousChange[];
  },
  enumRemovalsNeedingResolution: EnumRemoval[]
): void {
  const destructiveOps = diffResult.operations.filter(isDestructiveOperation);
  const hasAmbiguous = diffResult.ambiguousChanges.length > 0;

  if (
    destructiveOps.length === 0 &&
    !hasAmbiguous &&
    enumRemovalsNeedingResolution.length === 0
  ) {
    return;
  }

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

function isDestructiveOperation(op: DiffOperation): boolean {
  if (op.type === "dropTable" || op.type === "dropColumn") {
    return true;
  }
  if (op.type === "alterColumn") {
    const typeChanged =
      normalizeType(op.from.type) !== normalizeType(op.to.type);
    const madeNonNullable = op.from.nullable && !op.to.nullable;
    return typeChanged || madeNonNullable;
  }
  return false;
}

function normalizeType(type: string): string {
  return type.toLowerCase().replace(/\s+/g, " ").trim();
}

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
      throw new MigrationError(
        `Unexpected operation type: ${op.type}`,
        VibORMErrorCode.INTERNAL_ERROR
      );
  }
}

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
        operations.push({ type: "dropTable", tableName: change.droppedTable });
        const newTable = desiredSnapshot.tables.find(
          (table) => table.name === change.addedTable
        );
        if (newTable) {
          operations.push({ type: "createTable", table: newTable });
        }
      }
    }
  }

  return operations;
}

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
    const firstPriority = priority[a.type] ?? 100;
    const secondPriority = priority[b.type] ?? 100;
    return firstPriority - secondPriority;
  });
}
