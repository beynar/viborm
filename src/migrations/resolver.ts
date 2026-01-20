/**
 * Resolver System
 *
 * Handles ambiguous changes that require user input to resolve.
 * Provides utilities for converting user resolutions into concrete operations.
 */

import type {
  AmbiguousChange,
  ChangeResolution,
  DiffOperation,
  DiffResult,
  ResolveCallback,
  ResolveChange,
  Resolver,
  SchemaSnapshot,
} from "./types";
import { sortOperations } from "./utils";

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
          {
            type: "createTable",
            table: {
              name: change.addedTable,
              columns: [],
              indexes: [],
              foreignKeys: [],
              uniqueConstraints: [],
            },
          }
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

        // If the column properties differ (other than name), also alter it
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
        // addAndDrop - the actual table definition will need to come from the desired schema
        operations.push({ type: "dropTable", tableName: change.droppedTable });
        // Note: The createTable operation should be added by the caller with full table definition
      }
    }
  }

  return operations;
}

/**
 * Resolves ambiguous changes and returns the final operations list.
 * Handles both rename and addAndDrop resolutions, including adding
 * createTable operations for table renames resolved as addAndDrop.
 *
 * @param diffResult - The result from the differ containing operations and ambiguous changes
 * @param desiredSnapshot - The desired schema snapshot (used for table definitions)
 * @param resolver - The resolver function to use for ambiguous changes
 * @returns Sorted list of final operations
 */
export async function resolveAmbiguousChanges(
  diffResult: DiffResult,
  desiredSnapshot: SchemaSnapshot,
  resolver: Resolver
): Promise<DiffOperation[]> {
  let finalOperations = [...diffResult.operations];

  if (diffResult.ambiguousChanges.length === 0) {
    return finalOperations;
  }

  const resolutions = await resolver(diffResult.ambiguousChanges);
  const resolvedOps = applyResolutions(diffResult.ambiguousChanges, resolutions);
  finalOperations.push(...resolvedOps);

  // For table renames resolved as addAndDrop, add the createTable
  for (const change of diffResult.ambiguousChanges) {
    if (change.type === "ambiguousTable") {
      const resolution = resolutions.get(change);
      if (resolution?.type === "addAndDrop") {
        const newTable = desiredSnapshot.tables.find(
          (t) => t.name === change.addedTable
        );
        if (newTable) {
          finalOperations.push({ type: "createTable", table: newTable });
        }
      }
    }
  }

  return sortOperations(finalOperations);
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
  decide: (change: ResolveChange) => Promise<"proceed" | "reject" | "rename" | "addAndDrop" | "enumMapped">
): ResolveCallback {
  return decide;
}
