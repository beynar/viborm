import type { AnyDriver } from "../../drivers/driver";
import type { ResolvedMigrationLimits } from "../../drivers/shared/pinned-session";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type { AnyModel } from "../../schema/model";
import type { ResolvedRelationIndex } from "../../schema/validation/relation-resolution";
import { admitLiveMigrationCapability } from "../admission";
import {
  type DiffOptions,
  diff,
  type IndexPredicateCanonicalizer,
  isDestructiveOperation,
} from "../differ";
import type { BoundMigrationDriver, MigrationDriver } from "../drivers";
import { getMigrationDriver } from "../drivers";
import { emptyManagedSnapshot } from "../empty-snapshot";
import { applyNativeRename } from "../native-rename";
import {
  alwaysAddDropResolver,
  ambiguousDropKey,
  approveDestructiveOperations,
  resolveAmbiguousChanges,
  validateResolveResult,
} from "../resolver";
import { serializeResolvedModels } from "../serializer";
import { MANAGED_TABLES, MIGRATION_LIMITS } from "../target";
import {
  type AmbiguousChange,
  type AmbiguousResolveChange,
  type ChangeResolution,
  createAmbiguousChange,
  type DiffOperation,
  type DiffResult,
  type ResolveCallback,
  type Resolver,
  type SchemaSnapshot,
} from "../types";
import { prepareSchemaProgram, sortOperations } from "../utils";
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
  readonly [MANAGED_TABLES]?: readonly string[] | undefined;
  readonly [MIGRATION_LIMITS]?: ResolvedMigrationLimits | undefined;
}

export interface PushOptions {
  /** Planner-only auto-resolution; public V1 push does not expose this key. */
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
   * Rebuild from the empty snapshot. Public V1 requires preview consent before
   * executing the resulting force-reset plan.
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
   * A change the callback leaves undecided (returns `undefined`) refuses the
   * plan with MIGRATION_DESTRUCTIVE_REJECTED. Public `migrations.push()` has no
   * `force`; only the planner-internal `force` above turns an undecided change
   * into add+drop, acceptance or NULL.
   *
   * @example
   * ```ts
   * // Accept dropping a column, refuse everything else
   * await migrations.push({
   *   dryRun: true,
   *   resolve: async (change) => {
   *     if (change.type === "destructive" && change.operation === "dropColumn") {
   *       return change.proceed();
   *     }
   *     return change.reject();
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
  return getMigrationDriver(
    client.$driver,
    client[MANAGED_TABLES],
    client[MIGRATION_LIMITS]
  );
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
  const current = emptyManagedSnapshot();
  const diffOptions: DiffOptions = {
    projectRename: migrationDriver.projectNativeRename.bind(migrationDriver),
    refuseConstraintNameChurn:
      migrationDriver.capabilities.introspectionReadsConstraintNames,
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
    operations: prepareSchemaProgram(operations, current, migrationDriver),
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
    projectRename: migrationDriver.projectNativeRename.bind(migrationDriver),
    canonicalizeIndexPredicate: buildIndexPredicateCanonicalizer(
      client.$driver,
      migrationDriver
    ),
    // `current` was just introspected. Where that introspection cannot read a
    // constraint's name back, the name it carries is a synthesis and matching
    // on it would make every unchanged constraint read as a change.
    refuseConstraintNameChurn:
      migrationDriver.capabilities.introspectionReadsConstraintNames,
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
    operations: prepareSchemaProgram(operations, current, migrationDriver),
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

  if (options.resolve) {
    return resolveWithCallback(
      diffResult,
      current,
      desired,
      diffOptions,
      allEnumRemovals,
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

  rejectUnresolvedChanges(diffResult, allEnumRemovals);
  return [...diffResult.operations];
}

async function resolveWithCallback(
  diffResult: DiffResult,
  current: SchemaSnapshot,
  desired: SchemaSnapshot,
  diffOptions: DiffOptions,
  enumRemovals: EnumRemoval[],
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
        const advice =
          change.type === "ambiguousTable"
            ? `If "${change.droppedTable}" is not this schema's table, set migrations.tables so push does not manage it; otherwise name the pair with change.rename() or change.addAndDrop().`
            : "Return change.rename() or change.addAndDrop() from the resolver.";
        throw new MigrationError(
          `Unresolved ambiguous change: ${resolveChange.description}\n${advice}`,
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
    resolvedOperations,
    diffOptions.projectRename
  );
  await approveDestructiveOperations(
    resolvedOperations,
    resolve,
    force,
    admittedAmbiguousDrops
  );
  const finalOperations: DiffOperation[] = resolvedOperations.filter(
    (op) => op.type !== "alterEnum"
  );
  const enumColumnMappings = await resolveEnumValueRemovalMappings(
    resolvedEnumRemovals,
    resolve,
    force
  );

  finalOperations.push(
    ...applyResolvedEnumMappings(resolvedOperations, enumColumnMappings)
  );

  return sortOperations(finalOperations);
}

function retargetEnumRemovals(
  removals: EnumRemoval[],
  current: SchemaSnapshot,
  operations: DiffOperation[],
  projectRename: typeof applyNativeRename = applyNativeRename
): EnumRemoval[] {
  let renamedCurrent = current;
  for (const operation of operations) {
    if (operation.type === "renameTable" || operation.type === "renameColumn") {
      renamedCurrent = projectRename(renamedCurrent, operation);
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
      "Provide a resolve callback to choose each change explicitly.",
    VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
  );
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
