/**
 * Resolver System
 *
 * Handles ambiguous changes that require user input to resolve.
 * Provides utilities for converting user resolutions into concrete operations.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import {
  type DiffOptions,
  diff,
  getDestructiveOperationDescriptions,
  isDestructiveOperation,
} from "./differ";
import { applyNativeRename } from "./native-rename";
import type {
  AmbiguousChange,
  AmbiguousResolveChange,
  ChangeResolution,
  DestructiveResolveChange,
  DiffOperation,
  DiffResult,
  EnumValueRemovalChange,
  ResolveCallback,
  ResolveChange,
  ResolveResult,
  Resolver,
  SchemaSnapshot,
} from "./types";
import {
  createAmbiguousChange,
  createDestructiveChange,
  readEnumResolutionDecision,
} from "./types";
import { sortOperations } from "./utils";
import type { MigrationApprovalV1 } from "./v1-types";

export function validateResolveResult(
  expected: "ambiguous",
  change: AmbiguousResolveChange,
  result: unknown
): "rename" | "addAndDrop" | "reject" | undefined;
export function validateResolveResult(
  expected: "destructive",
  change: DestructiveResolveChange,
  result: unknown
): "proceed" | "reject" | undefined;
export function validateResolveResult(
  expected: "enumValueRemoval",
  change: EnumValueRemovalChange,
  result: unknown
): "enumMapped" | "reject" | undefined;
export function validateResolveResult(
  expected: ResolveChange["type"],
  change: ResolveChange,
  result: unknown
): ResolveResult | undefined {
  if (result === undefined) return undefined;

  if (result === "reject") return result;
  if (
    expected === "ambiguous" &&
    (result === "rename" || result === "addAndDrop")
  ) {
    return result;
  }
  if (expected === "destructive" && result === "proceed") {
    return result;
  }
  if (expected === "enumValueRemoval" && result === "enumMapped") {
    const decision = readEnumResolutionDecision(change);
    if (decision !== undefined && decision.kind !== "mixed") return result;
  }

  const received =
    typeof result === "string"
      ? `"${result}"`
      : result === null
        ? "null"
        : typeof result;
  throw new MigrationError(
    `The resolve callback returned an invalid resolution result ${received} for a ${expected} change. ` +
      "Return one of the methods on the exact change object that was supplied; a result for another change kind cannot authorize this migration.",
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    {
      meta: {
        type: "invalid-resolution-result",
      },
    }
  );
}

// =============================================================================
// RESOLUTION APPLICATION
// =============================================================================

/**
 * Converts resolved ambiguous changes into concrete diff operations
 */
export function applyResolutions(
  changes: AmbiguousChange[],
  resolutions: Map<AmbiguousChange, ChangeResolution>
): DiffOperation[] {
  const operations: DiffOperation[] = [];

  for (const change of changes) {
    const resolution = resolutions.get(change);
    if (!resolution) {
      throw new MigrationError(
        `Missing resolution for ${formatAmbiguousChange(change)}`,
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }

    if (change.type === "ambiguousColumn") {
      if (resolution.type === "rename") {
        operations.push({
          type: "renameColumn",
          tableName: change.tableName,
          from: change.droppedColumn.name,
          to: change.addedColumn.name,
        });
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
        operations.push(
          { type: "dropTable", tableName: change.droppedTable },
          { type: "createTable", table: change.addedTableDef }
        );
      }
    }
  }

  return operations;
}

/**
 * Resolves every ambiguity exposed by accepted changes.
 *
 * Each decision is applied to a working source snapshot, then the ordinary
 * differ runs again with the original options. Native renames therefore expose
 * nested ambiguities and descriptor alterations through the same owner that
 * found the outer change; no local table differ or pre-rename operation list is
 * retained.
 */
export async function resolveAmbiguousChanges(
  initialDiffResult: DiffResult,
  currentSnapshot: SchemaSnapshot,
  desiredSnapshot: SchemaSnapshot,
  resolver: Resolver,
  options: DiffOptions = {}
): Promise<DiffOperation[]> {
  let workingSnapshot = currentSnapshot;
  let diffResult = initialDiffResult;
  const resolutionOperations: DiffOperation[] = [];
  const resolvedAmbiguities = new Set<string>();
  const liveTableNames = new Map(
    currentSnapshot.tables.map((table) => [table.name, table.name])
  );

  while (diffResult.ambiguousChanges.length > 0) {
    const resolutions = await resolver(diffResult.ambiguousChanges);

    for (const change of diffResult.ambiguousChanges) {
      const key = ambiguityKey(change);
      if (resolvedAmbiguities.has(key)) {
        throw new MigrationError(
          `Ambiguous migration change did not converge after resolution: ${key}`,
          VibORMErrorCode.INTERNAL_ERROR
        );
      }
      resolvedAmbiguities.add(key);

      const resolution = resolutions.get(change);
      if (!resolution)
        throw new MigrationError(
          `Missing resolution for ${formatAmbiguousChange(change)}`,
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      const operations = applyResolutions(
        [change],
        new Map([[change, resolution]])
      );
      resolutionOperations.push(...operations);

      for (const operation of operations) {
        workingSnapshot = applyResolutionEffect(
          workingSnapshot,
          operation,
          options.projectRename
        );
        if (operation.type === "renameTable") {
          const liveName = liveTableNames.get(operation.from) ?? operation.from;
          liveTableNames.delete(operation.from);
          liveTableNames.set(operation.to, liveName);
        } else if (operation.type === "dropTable") {
          liveTableNames.delete(operation.tableName);
        }
      }
    }

    diffResult = await diff(
      workingSnapshot,
      desiredSnapshot,
      optionsForWorkingSnapshot(options, liveTableNames)
    );
  }

  return sortOperations([...resolutionOperations, ...diffResult.operations]);
}

function ambiguityKey(change: AmbiguousChange): string {
  return change.type === "ambiguousTable"
    ? `table:${change.droppedTable}\u0000${change.addedTable}`
    : `column:${change.tableName}\u0000${change.droppedColumn.name}\u0000${change.addedColumn.name}`;
}

function optionsForWorkingSnapshot(
  options: DiffOptions,
  liveTableNames: ReadonlyMap<string, string>
): DiffOptions {
  const canonicalize = options.canonicalizeIndexPredicate;
  if (!canonicalize) return options;
  return {
    ...options,
    canonicalizeIndexPredicate: (tableName, predicates) =>
      canonicalize(liveTableNames.get(tableName) ?? tableName, predicates),
  };
}

function applyResolutionEffect(
  snapshot: SchemaSnapshot,
  operation: DiffOperation,
  projectRename: typeof applyNativeRename = applyNativeRename
): SchemaSnapshot {
  if (operation.type === "renameTable" || operation.type === "renameColumn") {
    return projectRename(snapshot, operation);
  }
  if (operation.type === "dropTable") {
    return {
      ...snapshot,
      tables: snapshot.tables.filter(
        (table) => table.name !== operation.tableName
      ),
    };
  }
  if (operation.type === "createTable") {
    return { ...snapshot, tables: [...snapshot.tables, operation.table] };
  }
  if (operation.type === "dropColumn") {
    return {
      ...snapshot,
      tables: snapshot.tables.map((table) =>
        table.name === operation.tableName
          ? {
              ...table,
              columns: table.columns.filter(
                (column) => column.name !== operation.columnName
              ),
            }
          : table
      ),
    };
  }
  if (operation.type === "addColumn") {
    return {
      ...snapshot,
      tables: snapshot.tables.map((table) =>
        table.name === operation.tableName
          ? { ...table, columns: [...table.columns, operation.column] }
          : table
      ),
    };
  }
  return snapshot;
}

export function ambiguousToResolveChange(
  change: AmbiguousChange
): ResolveChange {
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
 * `admittedDrops` collects the drop each `addAndDrop` answer already decided,
 * so the destructive question is not asked a second time for it.
 */
export function callbackAsResolver(
  callback: ResolveCallback,
  admittedDrops?: Set<string>
): Resolver {
  return async (changes) => {
    const resolutions = new Map<AmbiguousChange, ChangeResolution>();
    for (const change of changes) {
      const resolveChange = ambiguousToResolveChange(change);
      const result = await callback(resolveChange);
      if (result === "rename") {
        resolutions.set(change, { type: "rename" });
        continue;
      }
      if (result === "addAndDrop") {
        resolutions.set(change, { type: "addAndDrop" });
        admittedDrops?.add(ambiguousDropKey(change));
        continue;
      }
      throw new MigrationError(
        `Unresolved ambiguous change: ${resolveChange.description}\n` +
          "Generate requires change.rename() or change.addAndDrop() from the resolver.",
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }
    return resolutions;
  };
}

// =============================================================================
// DESTRUCTIVE CHANGES
// =============================================================================

export function ambiguousDropKey(change: AmbiguousChange): string {
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

/**
 * Puts every destructive operation (enum value removals excepted: they have
 * their own mapping question) to `resolve` once, for push and generate alike.
 * A rejected or unanswered change refuses, unless `force` admits an unanswered
 * one. Without a callback nothing is asked: the refusal names every change.
 * Returns the approval of every destructive change, in operation order; a drop
 * an `addAndDrop` answer already decided is approved by that answer.
 */
export async function approveDestructiveOperations(
  operations: readonly DiffOperation[],
  resolve: ResolveCallback | undefined,
  force: boolean,
  admittedDrops: ReadonlySet<string> = new Set()
): Promise<MigrationApprovalV1[]> {
  const destructive = operations.filter(
    (operation) =>
      operation.type !== "alterEnum" && isDestructiveOperation(operation)
  );
  const facts = destructive.map(describeDestructiveOperation);
  const changes = facts.map(({ column, ...change }) =>
    createDestructiveChange(column === null ? change : { ...change, column })
  );
  if (!resolve && changes.length > 0) {
    throw new MigrationError(
      `Destructive changes need an approval:\n${changes.map((change) => `- ${change.description}`).join("\n")}\n\n` +
        "Pass a resolve callback that returns change.proceed() or change.reject() for each one.",
      VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
      {
        meta: {
          hint: "Review the changes, then pass generate() a resolve callback that approves them with change.proceed(); for the CLI, set migrations.resolve in viborm.config.ts.",
        },
      }
    );
  }
  for (const [index, change] of changes.entries()) {
    if (!admittedDrops.has(destructiveDropKey(destructive[index]!))) {
      const result = validateResolveResult(
        "destructive",
        change,
        await resolve?.(change)
      );
      if (result === "reject") {
        throw new MigrationError(
          `Change rejected: ${change.description}`,
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
      if (result === undefined && !force) {
        throw new MigrationError(
          `Unresolved destructive change: ${change.description}\n` +
            "Return change.proceed() or change.reject() from the resolver.",
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
    }
  }
  return facts.map(({ operation, table, column }) => ({
    operation,
    table,
    column,
  }));
}

function describeDestructiveOperation(
  op: DiffOperation
): MigrationApprovalV1 & { readonly description: string } {
  switch (op.type) {
    case "dropTable":
      return {
        operation: "dropTable",
        table: op.tableName,
        column: null,
        description: `Drop table "${op.tableName}" (all data will be lost)`,
      };
    case "dropColumn":
      return {
        operation: "dropColumn",
        table: op.tableName,
        column: op.columnName,
        description: `Drop column "${op.columnName}" from table "${op.tableName}" (data will be lost)`,
      };
    case "addColumn":
      return {
        operation: "addColumn",
        table: op.tableName,
        column: op.column.name,
        description: `Add required column "${op.tableName}.${op.column.name}" without a backfill default (fails on populated tables)`,
      };
    case "alterColumn":
      return {
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
      };
    default:
      throw new MigrationError(
        `Unexpected operation type: ${op.type}`,
        VibORMErrorCode.INTERNAL_ERROR
      );
  }
}

// =============================================================================
// DEFAULT RESOLVERS
// =============================================================================

/**
 * Resolver that always chooses "rename" for all ambiguous changes.
 * Useful for preserving data when the intent is clear.
 */
export const alwaysRenameResolver: Resolver = async (changes) => {
  const resolutions = new Map<AmbiguousChange, ChangeResolution>();
  for (const change of changes) {
    resolutions.set(change, { type: "rename" });
  }
  return resolutions;
};

/**
 * Resolver that always chooses "addAndDrop" for all ambiguous changes.
 * Useful for clean slate scenarios where data loss is acceptable.
 */
export const alwaysAddDropResolver: Resolver = async (changes) => {
  const resolutions = new Map<AmbiguousChange, ChangeResolution>();
  for (const change of changes) {
    resolutions.set(change, { type: "addAndDrop" });
  }
  return resolutions;
};

/**
 * Resolver that throws an error if any ambiguous changes are detected.
 * Useful for CI/CD pipelines where human intervention is not possible.
 */
export const strictResolver: Resolver = async (changes) => {
  if (changes.length > 0) {
    const descriptions = changes.map((change) => {
      if (change.type === "ambiguousColumn") {
        return `Column "${change.droppedColumn.name}" was removed and "${change.addedColumn.name}" was added in table "${change.tableName}"`;
      }
      return `Table "${change.droppedTable}" was removed and "${change.addedTable}" was added`;
    });

    throw new MigrationError(
      `Ambiguous changes detected that require resolution:\n${descriptions.join("\n")}\n\n` +
        "Supply a resolve callback choosing rename() or addAndDrop() for each change.",
      VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
    );
  }
  return new Map();
};

// =============================================================================
// RESOLVER HELPERS
// =============================================================================

/**
 * Creates a resolver from a simple decision function
 */
export function createResolver(
  decide: (
    change: AmbiguousChange
  ) => "rename" | "addAndDrop" | Promise<"rename" | "addAndDrop">
): Resolver {
  return async (changes) => {
    const resolutions = new Map<AmbiguousChange, ChangeResolution>();
    for (const change of changes) {
      const decision = await decide(change);
      resolutions.set(change, { type: decision });
    }
    return resolutions;
  };
}

/**
 * Creates a resolver that uses predefined resolutions
 */
export function createPredefinedResolver(
  predefined: Array<{
    type: "column" | "table";
    from: string;
    to: string;
    tableName?: string;
    resolution: "rename" | "addAndDrop";
  }>
): Resolver {
  return async (changes) => {
    const resolutions = new Map<AmbiguousChange, ChangeResolution>();

    for (const change of changes) {
      const match = predefined.find((p) => {
        if (change.type === "ambiguousColumn" && p.type === "column") {
          return (
            p.from === change.droppedColumn.name &&
            p.to === change.addedColumn.name &&
            (!p.tableName || p.tableName === change.tableName)
          );
        }
        if (change.type === "ambiguousTable" && p.type === "table") {
          return p.from === change.droppedTable && p.to === change.addedTable;
        }
        return false;
      });

      if (match) {
        resolutions.set(change, { type: match.resolution });
      }
      // If no match found, the change will be handled by the default (add+drop)
    }

    return resolutions;
  };
}

/**
 * Formats ambiguous changes for display
 */
export function formatAmbiguousChange(change: AmbiguousChange): string {
  if (change.type === "ambiguousColumn") {
    return (
      `Column rename detected in table "${change.tableName}":\n` +
      `  "${change.droppedColumn.name}" (${change.droppedColumn.type}) → "${change.addedColumn.name}" (${change.addedColumn.type})`
    );
  }
  return (
    "Table rename detected:\n" +
    `  "${change.droppedTable}" → "${change.addedTable}"`
  );
}

/**
 * Formats all ambiguous changes for display
 */
export function formatAmbiguousChanges(changes: AmbiguousChange[]): string {
  if (changes.length === 0) {
    return "No ambiguous changes detected.";
  }

  return changes.map(formatAmbiguousChange).join("\n\n");
}

// =============================================================================
// UNIFIED RESOLVE CALLBACKS
// =============================================================================

/**
 * Rejects all changes requiring resolution.
 * Useful for CI/CD pipelines where human intervention is not possible.
 */
export const rejectAllResolver: ResolveCallback = async (change) =>
  change.reject();

/**
 * Accepts destructive changes, treats ambiguous column changes as renames,
 * and maps enum value removals to NULL.
 * A table pair stays undecided, so the plan refuses: the dropped side may be
 * another application's table, and only a callback naming the pair may
 * rename it.
 */
export const lenientResolver: ResolveCallback = async (change) => {
  if (change.type === "destructive") {
    return change.proceed();
  }
  if (change.type === "ambiguous") {
    return change.operation === "renameColumn" ? change.rename() : undefined;
  }

  // enumValueRemoval: set all removed values to null
  return change.useNull();
};

/**
 * Accepts destructive changes, treats ambiguous changes as add+drop,
 * and maps enum value removals to NULL.
 * Useful when you don't care about preserving data in ambiguous scenarios.
 */
export const addDropResolver: ResolveCallback = async (change) => {
  if (change.type === "destructive") {
    return change.proceed();
  }
  if (change.type === "ambiguous") {
    return change.addAndDrop();
  }
  // enumValueRemoval: set all removed values to null
  return change.useNull();
};

/**
 * Creates a unified resolver from a decision function.
 *
 * @example
 * ```ts
 * const resolver = createUnifiedResolver(async (change) => {
 *   if (change.type === "destructive") {
 *     return confirm(`Accept: ${change.description}?`) ? change.proceed() : change.reject();
 *   }
 *   if (change.type === "ambiguous") {
 *     return change.rename();
 *   }
 *   if (change.type === "enumValueRemoval") {
 *     return change.mapValues({ 'OLD': 'NEW' });
 *   }
 *   return change.reject();
 * });
 * ```
 */
export function createUnifiedResolver(
  decide: (
    change: ResolveChange
  ) => Promise<"proceed" | "reject" | "rename" | "addAndDrop" | "enumMapped">
): ResolveCallback {
  return decide;
}
