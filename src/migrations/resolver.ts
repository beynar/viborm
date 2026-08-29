/**
 * Resolver System
 *
 * Handles ambiguous changes that require user input to resolve.
 * Provides utilities for converting user resolutions into concrete operations.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { type DiffOptions, diff } from "./differ";
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
import { readEnumResolutionDecision } from "./types";
import { sortOperations } from "./utils";

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
      // If no resolution provided, default to add+drop (safer)
      if (change.type === "ambiguousColumn") {
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
      } else if (change.type === "ambiguousTable") {
        operations.push(
          { type: "dropTable", tableName: change.droppedTable },
          { type: "createTable", table: change.addedTableDef }
        );
      }
      continue;
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

      const resolution = resolutions.get(change) ?? { type: "addAndDrop" };
      const operations = applyResolutions(
        [change],
        new Map([[change, resolution]])
      );
      resolutionOperations.push(...operations);

      for (const operation of operations) {
        workingSnapshot = applyResolutionEffect(workingSnapshot, operation);
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
  operation: DiffOperation
): SchemaSnapshot {
  if (operation.type === "renameTable" || operation.type === "renameColumn") {
    return applyNativeRename(snapshot, operation);
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

    throw new Error(
      `Ambiguous changes detected that require resolution:\n${descriptions.join("\n")}\n\n` +
        "Use a custom resolver or the CLI interactive mode to resolve these changes."
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
 * Accepts destructive changes, treats ambiguous changes as renames,
 * and maps enum value removals to NULL.
 * Useful for development when you know all changes are intentional renames.
 */
export const lenientResolver: ResolveCallback = async (change) => {
  if (change.type === "destructive") {
    return change.proceed();
  }
  if (change.type === "ambiguous") {
    return change.rename();
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
