import { MigrationError, VibORMErrorCode } from "../../errors";
import { validateResolveResult } from "../resolver";
import {
  createEnumValueRemovalChange,
  type DiffOperation,
  type ResolveCallback,
  readEnumResolutionDecision,
  type SchemaSnapshot,
} from "../types";

export interface EnumRemoval {
  enumName: string;
  tableName: string;
  columnName: string;
  isNullable: boolean;
  removedValues: string[];
  availableValues: string[];
}

type ColumnMappings = Record<string, string | null>;

export type EnumColumnMappings = Map<string, Map<string, ColumnMappings>>;

/**
 * Detects enum value removals that need resolution.
 * Returns one removal per column that uses the enum.
 * Nullable columns can be auto-resolved to NULL.
 */
export function detectEnumValueRemovals(
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
      const unresolvedValues = op.removeValues.filter((value) => {
        const hasExplicit =
          op.valueReplacements !== undefined && value in op.valueReplacements;
        const hasDefault = op.defaultReplacement !== undefined;
        return !(hasExplicit || hasDefault);
      });

      if (unresolvedValues.length > 0) {
        const dependentColumns = op.dependentColumns || [];

        for (const dependentColumn of dependentColumns) {
          const table = currentSchema.tables.find(
            (tableDef) => tableDef.name === dependentColumn.tableName
          );
          if (!table) {
            throw new MigrationError(
              `Table "${dependentColumn.tableName}" not found in current schema for enum "${op.enumName}"`,
              VibORMErrorCode.INTERNAL_ERROR
            );
          }

          const column = table.columns.find(
            (columnDef) => columnDef.name === dependentColumn.columnName
          );
          if (!column) {
            throw new MigrationError(
              `Column "${dependentColumn.columnName}" not found in table "${dependentColumn.tableName}" for enum "${op.enumName}"`,
              VibORMErrorCode.INTERNAL_ERROR
            );
          }

          removals.push({
            enumName: op.enumName,
            tableName: dependentColumn.tableName,
            columnName: dependentColumn.columnName,
            isNullable: column.nullable,
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
export function applyForceEnumResolutions(
  operations: DiffOperation[],
  enumRemovals: EnumRemoval[]
): DiffOperation[] {
  if (enumRemovals.length === 0) {
    return operations;
  }

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

    const columnValueReplacements: Record<string, ColumnMappings> = {
      ...op.columnValueReplacements,
    };

    for (const removal of removals) {
      const columnKey = getColumnKey(removal);
      columnValueReplacements[columnKey] = {
        ...columnValueReplacements[columnKey],
        ...createNullMappings(removal.removedValues),
      };
    }

    return {
      ...op,
      columnValueReplacements,
    };
  });
}

export async function resolveEnumValueRemovalMappings(
  enumRemovals: EnumRemoval[],
  resolve: ResolveCallback,
  force: boolean
): Promise<EnumColumnMappings> {
  const columnMappings: EnumColumnMappings = new Map();

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

    const result = validateResolveResult(
      "enumValueRemoval",
      change,
      await resolve(change)
    );

    if (result === "reject") {
      throw new MigrationError(
        `Change rejected: ${change.description}`,
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }

    const columnKey = getColumnKey(removal);

    if (result === undefined) {
      if (force) {
        setColumnMappings(
          columnMappings,
          removal.enumName,
          columnKey,
          createNullMappings(removal.removedValues)
        );
      } else {
        throw new MigrationError(
          `Unresolved enum value removal: ${change.description}\n` +
            "Return change.mapValues() or change.useNull() from the resolver, or use force: true.",
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        );
      }
      continue;
    }

    if (result === "enumMapped") {
      const decision = readEnumResolutionDecision(change);
      if (decision?.kind === "mapValues") {
        setColumnMappings(
          columnMappings,
          removal.enumName,
          columnKey,
          decision.mappings
        );
      } else if (decision?.kind === "useNull") {
        setColumnMappings(
          columnMappings,
          removal.enumName,
          columnKey,
          createNullMappings(removal.removedValues)
        );
      }
    }
  }

  return columnMappings;
}

export function applyResolvedEnumMappings(
  operations: DiffOperation[],
  columnMappings: EnumColumnMappings
): DiffOperation[] {
  const enumOperations: DiffOperation[] = [];

  for (const op of operations) {
    if (op.type === "alterEnum") {
      const enumColumnMappings = columnMappings.get(op.enumName);
      if (enumColumnMappings && enumColumnMappings.size > 0) {
        const columnValueReplacements: Record<string, ColumnMappings> = {
          ...op.columnValueReplacements,
        };

        for (const [columnKey, mappings] of enumColumnMappings) {
          columnValueReplacements[columnKey] = {
            ...columnValueReplacements[columnKey],
            ...mappings,
          };
        }

        enumOperations.push({
          ...op,
          columnValueReplacements,
        });
      } else {
        enumOperations.push({
          ...op,
          defaultReplacement: op.defaultReplacement ?? null,
        });
      }
    }
  }

  return enumOperations;
}

function setColumnMappings(
  columnMappings: EnumColumnMappings,
  enumName: string,
  columnKey: string,
  mappings: ColumnMappings
): void {
  let enumMappings = columnMappings.get(enumName);
  if (!enumMappings) {
    enumMappings = new Map();
    columnMappings.set(enumName, enumMappings);
  }
  enumMappings.set(columnKey, mappings);
}

function createNullMappings(values: string[]): Record<string, null> {
  const nullMappings: Record<string, null> = {};
  for (const value of values) {
    nullMappings[value] = null;
  }
  return nullMappings;
}

function getColumnKey(removal: EnumRemoval): string {
  return `${removal.tableName}.${removal.columnName}`;
}
