import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type { AnyModel } from "../../schema/model";
import type { ResolvedRelationIndex } from "../../schema/validation/relation-resolution";
import { admitLiveMigrationCapability } from "../admission";
import {
  type DiffOptions,
  diff,
  getDestructiveOperationDescriptions,
  type IndexPredicateCanonicalizer,
  isDestructiveOperation,
} from "../differ";
import type { BoundMigrationDriver, MigrationDriver } from "../drivers";
import { getMigrationDriver } from "../drivers";
import { applyNativeRename } from "../native-rename";
import {
  alwaysAddDropResolver,
  resolveAmbiguousChanges,
  validateResolveResult,
} from "../resolver";
import { serializeResolvedModels } from "../serializer";
import { createEmptySnapshot } from "../storage/driver";
import {
  type AmbiguousChange,
  type AmbiguousResolveChange,
  type ChangeResolution,
  createAmbiguousChange,
  createDestructiveChange,
  type DestructiveResolveChange,
  type DiffOperation,
  type DiffResult,
  type ResolveCallback,
  type Resolver,
  type SchemaSnapshot,
} from "../types";
import {
  extractForwardReferenceForeignKeys,
  materializeDroppedTableForeignKeys,
  sortOperations,
} from "../utils";
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
}

// Push deliberately carries NO storage owner. Ordinary push and force-reset
// synchronize the live namespace and nothing else: they read no journal, write
// no journal or snapshot, and cannot rewrite an estate's history as a side
// effect of a schema sync.

export interface PushPlan {
  operations: DiffOperation[];
  currentSchema: SchemaSnapshot;
}

export function getPushMigrationDriver(
  client: MigrationClient
): BoundMigrationDriver {
  return getMigrationDriver(client.$driver);
}

/**
 * Introspects the current database schema without making any changes.
 * Useful for debugging or displaying current state.
 *
 * It changes nothing, but it READS live state, so it is a live migration
 * command and takes the one shared admission owner like every other one —
 * before any provider work. Without this gate an unbound MySQL client would
 * publish an inventory of whatever database its connection happened to default
 * to, which is exactly the ambient-default target §3.3 refuses to accept.
 * `push({ dryRun: true })` performs the same introspection behind the same
 * `read-only` admission; this entry point must not be the way around it.
 */
export async function introspect(
  client: MigrationClient
): Promise<SchemaSnapshot> {
  const migrationDriver = getPushMigrationDriver(client);
  admitLiveMigrationCapability(migrationDriver, "read-only", "introspect()");
  return introspectSchema(client.$driver, migrationDriver);
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

/**
 * The COMPLETE empty-to-desired program, compiled before a force-reset entry.
 *
 * §6.2: "Before entry, serialize and validate the desired schema, resolve its
 * relation index, compile the empty-to-desired DDL, and prove that program
 * contains no commit-boundary statement." Diffing against the LIVE database
 * would describe a program for a database this command is about to empty, so
 * the baseline is the empty snapshot — the state the clear produces.
 *
 * Nothing here reads live state, so it runs before the clear and its result is
 * what the one locked transaction executes.
 */
export async function planRebuildFromEmpty(
  client: MigrationClient,
  migrationDriver: MigrationDriver,
  options: PushOptions,
  relations: ResolvedRelationIndex
): Promise<PushPlan> {
  const desired = serializeResolvedModels(
    client.$schema,
    migrationDriver,
    relations
  );
  const current = createEmptySnapshot();
  const diffOptions: DiffOptions = {
    matchConstraintsByShape:
      !migrationDriver.capabilities.introspectionReadsConstraintNames,
  };
  const diffResult = await diff(current, desired, diffOptions);
  const operations = await resolvePushOperations(
    diffResult,
    desired,
    current,
    options,
    diffOptions
  );

  return {
    operations: extractForwardReferenceForeignKeys(operations, migrationDriver),
    currentSchema: current,
  };
}

export async function planPush(
  client: MigrationClient,
  migrationDriver: MigrationDriver,
  options: PushOptions,
  relations: ResolvedRelationIndex
): Promise<PushPlan> {
  const desired = serializeResolvedModels(
    client.$schema,
    migrationDriver,
    relations
  );
  // Live introspection sees the private columns and index, but a text
  // discriminator cannot reveal historical public/stored member mappings.
  // Push therefore compares structure only. Stored-value history is owned by
  // file-based generate(), where both serialized snapshots are available.
  const current = await introspectSchema(client.$driver, migrationDriver);
  const diffOptions: DiffOptions = {
    canonicalizeIndexPredicate: buildIndexPredicateCanonicalizer(
      client.$driver,
      migrationDriver
    ),
    // `current` was just introspected. Where that introspection cannot read a
    // constraint's name back, the name it carries is a synthesis and matching
    // on it would make every unchanged constraint read as a change.
    matchConstraintsByShape:
      !migrationDriver.capabilities.introspectionReadsConstraintNames,
  };
  const diffResult = await diff(current, desired, diffOptions);
  const operations = await resolvePushOperations(
    diffResult,
    desired,
    current,
    options,
    diffOptions
  );

  // Lift forward-reference FKs out of CREATE TABLE so every referenced table
  // exists before its constraint is added (Postgres/MySQL). No-op on
  // SQLite/LibSQL, which keep FKs inline and resolve forward refs lazily.
  const orderedOperations = extractForwardReferenceForeignKeys(
    operations,
    migrationDriver
  );

  return {
    operations: materializeDroppedTableForeignKeys(
      orderedOperations,
      current,
      migrationDriver
    ),
    currentSchema: current,
  };
}

async function resolvePushOperations(
  diffResult: DiffResult,
  desired: SchemaSnapshot,
  current: SchemaSnapshot,
  options: PushOptions,
  diffOptions: DiffOptions
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
    return resolveWithCallback(
      diffResult,
      current,
      desired,
      diffOptions,
      enumRemovalsNeedingResolution,
      autoResolvableRemovals,
      options.resolve,
      force
    );
  }

  if (force) {
    const resolvedOperations = await resolveAmbiguousChanges(
      diffResult,
      current,
      desired,
      alwaysAddDropResolver,
      diffOptions
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
  diffResult: DiffResult,
  current: SchemaSnapshot,
  desired: SchemaSnapshot,
  diffOptions: DiffOptions,
  enumRemovals: EnumRemoval[],
  autoResolvableRemovals: EnumRemoval[],
  resolve: ResolveCallback,
  force = false
): Promise<DiffOperation[]> {
  const admittedAmbiguousDrops = new Set<string>();
  const ambiguityResolver: Resolver = async (changes) => {
    const resolutions = new Map<AmbiguousChange, ChangeResolution>();
    for (const change of changes) {
      const resolveChange = ambiguousToResolveChange(change);
      const result = validateResolveResult(
        "ambiguous",
        resolveChange,
        await resolve(resolveChange)
      );

      if (result === "reject") {
        throw new MigrationError(
          `Change rejected: ${resolveChange.description}`,
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
      if (result === undefined) {
        if (force) {
          resolutions.set(change, { type: "addAndDrop" });
          admittedAmbiguousDrops.add(ambiguousDropKey(change));
          continue;
        }
        throw new MigrationError(
          `Unresolved ambiguous change: ${resolveChange.description}\n` +
            "Return change.rename() or change.addAndDrop() from the resolver, or use force: true.",
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
      resolutions.set(change, {
        type: result === "rename" ? "rename" : "addAndDrop",
      });
      if (result !== "rename") {
        admittedAmbiguousDrops.add(ambiguousDropKey(change));
      }
    }
    return resolutions;
  };

  const resolvedOperations = await resolveAmbiguousChanges(
    diffResult,
    current,
    desired,
    ambiguityResolver,
    diffOptions
  );
  const resolvedEnumRemovals = retargetEnumRemovals(
    enumRemovals,
    current,
    resolvedOperations
  );
  const resolvedAutoRemovals = retargetEnumRemovals(
    autoResolvableRemovals,
    current,
    resolvedOperations
  );
  const finalOperations = await resolveDestructiveOperations(
    resolvedOperations.filter((op) => op.type !== "alterEnum"),
    resolve,
    force,
    admittedAmbiguousDrops
  );
  const enumColumnMappings = await resolveEnumValueRemovalMappings(
    resolvedEnumRemovals,
    resolve,
    force
  );

  finalOperations.push(
    ...applyResolvedEnumMappings(resolvedOperations, enumColumnMappings)
  );

  return sortOperations(
    applyForceEnumResolutions(finalOperations, resolvedAutoRemovals)
  );
}

function retargetEnumRemovals(
  removals: EnumRemoval[],
  current: SchemaSnapshot,
  operations: DiffOperation[]
): EnumRemoval[] {
  let renamedCurrent = current;
  for (const operation of operations) {
    if (operation.type === "renameTable" || operation.type === "renameColumn") {
      renamedCurrent = applyNativeRename(renamedCurrent, operation);
    }
  }

  return removals.map((removal) => {
    const tablePosition = current.tables.findIndex(
      (table) => table.name === removal.tableName
    );
    const currentTable = current.tables[tablePosition];
    const columnPosition = currentTable?.columns.findIndex(
      (column) => column.name === removal.columnName
    );
    const table = renamedCurrent.tables[tablePosition];
    const column =
      columnPosition === undefined ? undefined : table?.columns[columnPosition];
    if (!(currentTable && table && column)) {
      throw new MigrationError(
        `Cannot retarget enum removal for "${removal.tableName}.${removal.columnName}" through the accepted renames.`,
        VibORMErrorCode.INTERNAL_ERROR
      );
    }
    return { ...removal, tableName: table.name, columnName: column.name };
  });
}

async function resolveDestructiveOperations(
  operations: DiffOperation[],
  resolve: ResolveCallback,
  force: boolean,
  admittedDrops: ReadonlySet<string> = new Set()
): Promise<DiffOperation[]> {
  const admitted: DiffOperation[] = [];
  for (const op of operations) {
    if (
      !isDestructiveOperation(op) ||
      admittedDrops.has(destructiveDropKey(op))
    ) {
      admitted.push(op);
      continue;
    }

    const change = operationToResolveChange(op);
    const result = validateResolveResult(
      "destructive",
      change,
      await resolve(change)
    );
    if (result === "reject") {
      throw new MigrationError(
        `Change rejected: ${change.description}`,
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }
    if (result === undefined) {
      if (force) {
        admitted.push(op);
      } else {
        throw new MigrationError(
          `Unresolved destructive change: ${change.description}\n` +
            "Return change.proceed() or change.reject() from the resolver, or use force: true.",
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
      continue;
    }
    if (result === "proceed") {
      admitted.push(op);
    }
  }
  return admitted;
}

function ambiguousDropKey(change: AmbiguousChange): string {
  return change.type === "ambiguousTable"
    ? `table\u0000${change.droppedTable}`
    : `column\u0000${change.tableName}\u0000${change.droppedColumn.name}`;
}

function destructiveDropKey(operation: DiffOperation): string {
  if (operation.type === "dropTable") {
    return `table\u0000${operation.tableName}`;
  }
  if (operation.type === "dropColumn") {
    return `column\u0000${operation.tableName}\u0000${operation.columnName}`;
  }
  return "";
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

function operationToResolveChange(op: DiffOperation): DestructiveResolveChange {
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
        // The SAME sentences the differ already writes for this operation, and
        // not a second summary of it. Rendering `from.type → to.type` here was
        // silent about the one change whose type does not move: a narrowing
        // decimal domain on SQLite reads `(INTEGER → INTEGER)`, so the user was
        // asked to accept a data-refusing change with nothing on screen to say
        // what it was. Every destructive alterColumn produces at least one
        // description, because the differ's description and classifier share
        // the same owner and ask the same three questions.
        description: getDestructiveOperationDescriptions([op]).join("; "),
      });
    default:
      throw new MigrationError(
        `Unexpected operation type: ${op.type}`,
        VibORMErrorCode.INTERNAL_ERROR
      );
  }
}

function ambiguousToResolveChange(
  change: AmbiguousChange
): AmbiguousResolveChange {
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
