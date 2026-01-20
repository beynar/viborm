/**
 * Schema Differ
 *
 * Compares two SchemaSnapshots and produces a list of DiffOperations,
 * detecting ambiguous changes that require user input.
 */

import type {
  AmbiguousChange,
  ColumnDef,
  DiffOperation,
  DiffResult,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "./types";
import { sortOperations } from "./utils";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function columnsEqual(a: ColumnDef, b: ColumnDef): boolean {
  return (
    a.name === b.name &&
    normalizeType(a.type) === normalizeType(b.type) &&
    a.nullable === b.nullable &&
    normalizeDefault(a.default) === normalizeDefault(b.default)
  );
}

function normalizeType(type: string): string {
  // Normalize type names for comparison
  const normalized = type.toLowerCase().trim();

  // Handle common aliases
  const aliases: Record<string, string> = {
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    float4: "real",
    float8: "double precision",
    bool: "boolean",
    timestamptz: "timestamp with time zone",
    timetz: "time with time zone",
  };

  return aliases[normalized] || normalized;
}

function normalizeDefault(defaultVal: string | undefined): string | undefined {
  if (defaultVal === undefined) return undefined;

  // Normalize common default expressions
  const normalized = defaultVal.trim().toLowerCase();

  // Handle NULL
  if (normalized === "null") return "null";

  // Handle boolean values
  if (normalized === "true" || normalized === "'t'" || normalized === "1")
    return "true";
  if (normalized === "false" || normalized === "'f'" || normalized === "0")
    return "false";

  return defaultVal;
}

function indexesEqual(a: IndexDef, b: IndexDef): boolean {
  return (
    a.name === b.name &&
    a.unique === b.unique &&
    arraysEqual(a.columns, b.columns) &&
    a.type === b.type &&
    a.where === b.where
  );
}

function foreignKeysEqual(a: ForeignKeyDef, b: ForeignKeyDef): boolean {
  return (
    a.name === b.name &&
    arraysEqual(a.columns, b.columns) &&
    a.referencedTable === b.referencedTable &&
    arraysEqual(a.referencedColumns, b.referencedColumns) &&
    a.onDelete === b.onDelete &&
    a.onUpdate === b.onUpdate
  );
}

function uniqueConstraintsEqual(
  a: UniqueConstraintDef,
  b: UniqueConstraintDef
): boolean {
  return a.name === b.name && arraysEqual(a.columns, b.columns);
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}

function enumsEqual(a: EnumDef, b: EnumDef): boolean {
  return a.name === b.name && arraysEqual(a.values, b.values);
}

// =============================================================================
// TABLE DIFFER
// =============================================================================

interface TableDiffResult {
  operations: DiffOperation[];
  ambiguousChanges: AmbiguousChange[];
}

function diffTable(
  tableName: string,
  current: TableDef,
  desired: TableDef
): TableDiffResult {
  const operations: DiffOperation[] = [];
  const ambiguousChanges: AmbiguousChange[] = [];

  // Build column maps
  const currentColumns = new Map(current.columns.map((c) => [c.name, c]));
  const desiredColumns = new Map(desired.columns.map((c) => [c.name, c]));

  // Find dropped and added columns
  const droppedColumns: ColumnDef[] = [];
  const addedColumns: ColumnDef[] = [];

  for (const [name, col] of currentColumns) {
    if (!desiredColumns.has(name)) {
      droppedColumns.push(col);
    }
  }

  for (const [name, col] of desiredColumns) {
    if (!currentColumns.has(name)) {
      addedColumns.push(col);
    }
  }

  // Detect potential column renames (ambiguous changes)
  // A rename is suspected when a column is dropped and another is added
  // with compatible types
  const usedDropped = new Set<string>();
  const usedAdded = new Set<string>();

  for (const dropped of droppedColumns) {
    for (const added of addedColumns) {
      if (usedDropped.has(dropped.name) || usedAdded.has(added.name)) continue;

      // Check if types are compatible (could be a rename)
      const droppedType = normalizeType(dropped.type);
      const addedType = normalizeType(added.type);

      if (droppedType === addedType) {
        // This could be a rename - mark as ambiguous
        ambiguousChanges.push({
          type: "ambiguousColumn",
          tableName,
          droppedColumn: dropped,
          addedColumn: added,
        });
        usedDropped.add(dropped.name);
        usedAdded.add(added.name);
      }
    }
  }

  // Add operations for non-ambiguous drops and adds
  for (const dropped of droppedColumns) {
    if (!usedDropped.has(dropped.name)) {
      operations.push({
        type: "dropColumn",
        tableName,
        columnName: dropped.name,
      });
    }
  }

  for (const added of addedColumns) {
    if (!usedAdded.has(added.name)) {
      operations.push({
        type: "addColumn",
        tableName,
        column: added,
      });
    }
  }

  // Check for column modifications (same name, different properties)
  for (const [name, desiredCol] of desiredColumns) {
    const currentCol = currentColumns.get(name);
    if (currentCol && !columnsEqual(currentCol, desiredCol)) {
      operations.push({
        type: "alterColumn",
        tableName,
        columnName: name,
        from: currentCol,
        to: desiredCol,
      });
    }
  }

  // Diff indexes
  const currentIndexes = new Map(current.indexes.map((i) => [i.name, i]));
  const desiredIndexes = new Map(desired.indexes.map((i) => [i.name, i]));

  for (const [name, idx] of currentIndexes) {
    const desiredIdx = desiredIndexes.get(name);
    if (!desiredIdx) {
      operations.push({ type: "dropIndex", indexName: name });
    } else if (!indexesEqual(idx, desiredIdx)) {
      // Index changed - drop and recreate
      operations.push({ type: "dropIndex", indexName: name });
      operations.push({ type: "createIndex", tableName, index: desiredIdx });
    }
  }

  for (const [name, idx] of desiredIndexes) {
    if (!currentIndexes.has(name)) {
      operations.push({ type: "createIndex", tableName, index: idx });
    }
  }

  // Diff foreign keys
  const currentFks = new Map(current.foreignKeys.map((fk) => [fk.name, fk]));
  const desiredFks = new Map(desired.foreignKeys.map((fk) => [fk.name, fk]));

  for (const [name, fk] of currentFks) {
    const desiredFk = desiredFks.get(name);
    if (!desiredFk) {
      operations.push({ type: "dropForeignKey", tableName, fkName: name });
    } else if (!foreignKeysEqual(fk, desiredFk)) {
      // FK changed - drop and recreate
      operations.push({ type: "dropForeignKey", tableName, fkName: name });
      operations.push({ type: "addForeignKey", tableName, fk: desiredFk });
    }
  }

  for (const [name, fk] of desiredFks) {
    if (!currentFks.has(name)) {
      operations.push({ type: "addForeignKey", tableName, fk });
    }
  }

  // Diff unique constraints
  const currentUniques = new Map(
    current.uniqueConstraints.map((u) => [u.name, u])
  );
  const desiredUniques = new Map(
    desired.uniqueConstraints.map((u) => [u.name, u])
  );

  for (const [name, uq] of currentUniques) {
    const desiredUq = desiredUniques.get(name);
    if (!desiredUq) {
      operations.push({
        type: "dropUniqueConstraint",
        tableName,
        constraintName: name,
      });
    } else if (!uniqueConstraintsEqual(uq, desiredUq)) {
      operations.push({
        type: "dropUniqueConstraint",
        tableName,
        constraintName: name,
      });
      operations.push({
        type: "addUniqueConstraint",
        tableName,
        constraint: desiredUq,
      });
    }
  }

  for (const [name, uq] of desiredUniques) {
    if (!currentUniques.has(name)) {
      operations.push({
        type: "addUniqueConstraint",
        tableName,
        constraint: uq,
      });
    }
  }

  // Diff primary key
  const currentPk = current.primaryKey;
  const desiredPk = desired.primaryKey;

  if (currentPk && !desiredPk) {
    operations.push({
      type: "dropPrimaryKey",
      tableName,
      constraintName: currentPk.name || `${tableName}_pkey`,
    });
  } else if (!currentPk && desiredPk) {
    operations.push({
      type: "addPrimaryKey",
      tableName,
      primaryKey: desiredPk,
    });
  } else if (
    currentPk &&
    desiredPk &&
    !arraysEqual(currentPk.columns, desiredPk.columns)
  ) {
    operations.push({
      type: "dropPrimaryKey",
      tableName,
      constraintName: currentPk.name || `${tableName}_pkey`,
    });
    operations.push({
      type: "addPrimaryKey",
      tableName,
      primaryKey: desiredPk,
    });
  }

  return { operations, ambiguousChanges };
}

// =============================================================================
// MAIN DIFFER
// =============================================================================

/**
 * Compares two schema snapshots and returns the operations needed to
 * transform the current schema into the desired schema.
 */
export function diff(
  current: SchemaSnapshot,
  desired: SchemaSnapshot
): DiffResult {
  const operations: DiffOperation[] = [];
  const ambiguousChanges: AmbiguousChange[] = [];

  // Build table maps
  const currentTables = new Map(current.tables.map((t) => [t.name, t]));
  const desiredTables = new Map(desired.tables.map((t) => [t.name, t]));

  // Find dropped and added tables
  const droppedTables: string[] = [];
  const addedTables: string[] = [];

  for (const [name] of currentTables) {
    if (!desiredTables.has(name)) {
      droppedTables.push(name);
    }
  }

  for (const [name] of desiredTables) {
    if (!currentTables.has(name)) {
      addedTables.push(name);
    }
  }

  // Detect potential table renames (ambiguous changes)
  const usedDropped = new Set<string>();
  const usedAdded = new Set<string>();

  // For table renames, we check if the structure is similar
  for (const droppedName of droppedTables) {
    const droppedTable = currentTables.get(droppedName)!;

    for (const addedName of addedTables) {
      if (usedDropped.has(droppedName) || usedAdded.has(addedName)) continue;

      const addedTable = desiredTables.get(addedName)!;

      // Check if tables have similar structure (same column names)
      const droppedColNames = new Set(droppedTable.columns.map((c) => c.name));
      const addedColNames = new Set(addedTable.columns.map((c) => c.name));

      // Calculate similarity (Jaccard index)
      const intersection = [...droppedColNames].filter((n) =>
        addedColNames.has(n)
      );
      const union = new Set([...droppedColNames, ...addedColNames]);
      const similarity = intersection.length / union.size;

      // If tables are very similar (>= 70% column overlap), suggest rename
      if (similarity >= 0.7) {
        ambiguousChanges.push({
          type: "ambiguousTable",
          droppedTable: droppedName,
          addedTable: addedName,
        });
        usedDropped.add(droppedName);
        usedAdded.add(addedName);
      }
    }
  }

  // Add operations for non-ambiguous table drops and creates
  for (const name of droppedTables) {
    if (!usedDropped.has(name)) {
      operations.push({ type: "dropTable", tableName: name });
    }
  }

  for (const name of addedTables) {
    if (!usedAdded.has(name)) {
      const table = desiredTables.get(name)!;
      operations.push({ type: "createTable", table });
    }
  }

  // Diff existing tables
  for (const [name, desiredTable] of desiredTables) {
    const currentTable = currentTables.get(name);
    if (currentTable) {
      const tableDiff = diffTable(name, currentTable, desiredTable);
      operations.push(...tableDiff.operations);
      ambiguousChanges.push(...tableDiff.ambiguousChanges);
    }
  }

  // Diff enums (PostgreSQL specific)
  if (current.enums || desired.enums) {
    const currentEnums = new Map((current.enums || []).map((e) => [e.name, e]));
    const desiredEnums = new Map((desired.enums || []).map((e) => [e.name, e]));

    // Dropped enums
    for (const [name] of currentEnums) {
      if (!desiredEnums.has(name)) {
        // Find all columns that depend on this enum
        const dependentColumns: Array<{ tableName: string; columnName: string }> = [];
        for (const table of current.tables) {
          for (const column of table.columns) {
            if (column.type === name) {
              dependentColumns.push({
                tableName: table.name,
                columnName: column.name,
              });
            }
          }
        }
        operations.push({
          type: "dropEnum",
          enumName: name,
          dependentColumns: dependentColumns.length > 0 ? dependentColumns : undefined,
        });
      }
    }

    // Added enums
    for (const [name, enumDef] of desiredEnums) {
      if (!currentEnums.has(name)) {
        operations.push({ type: "createEnum", enumDef });
      }
    }

    // Modified enums
    for (const [name, desiredEnum] of desiredEnums) {
      const currentEnum = currentEnums.get(name);
      if (currentEnum && !enumsEqual(currentEnum, desiredEnum)) {
        const addValues = desiredEnum.values.filter(
          (v) => !currentEnum.values.includes(v)
        );
        const removeValues = currentEnum.values.filter(
          (v) => !desiredEnum.values.includes(v)
        );

        if (addValues.length > 0 || removeValues.length > 0) {
          // When removing values, we need to find all columns that use this enum
          // so we can temporarily convert them to text during the recreation
          let dependentColumns:
            | Array<{ tableName: string; columnName: string }>
            | undefined;

          if (removeValues.length > 0) {
            dependentColumns = [];
            // Search through all tables (current schema) for columns using this enum
            for (const table of current.tables) {
              for (const column of table.columns) {
                if (column.type === name) {
                  dependentColumns.push({
                    tableName: table.name,
                    columnName: column.name,
                  });
                }
              }
            }
          }

          operations.push({
            type: "alterEnum",
            enumName: name,
            addValues: addValues.length > 0 ? addValues : undefined,
            removeValues: removeValues.length > 0 ? removeValues : undefined,
            newValues: removeValues.length > 0 ? desiredEnum.values : undefined,
            dependentColumns:
              dependentColumns && dependentColumns.length > 0
                ? dependentColumns
                : undefined,
          });
        }
      }
    }
  }

  // Sort operations for proper execution order
  return {
    operations: sortOperations(operations),
    ambiguousChanges,
  };
}

// =============================================================================
// DESTRUCTIVE OPERATION CHECKS
// =============================================================================

/**
 * Checks if any operations are destructive (could cause data loss)
 */
export function hasDestructiveOperations(operations: DiffOperation[]): boolean {
  return operations.some(
    (op) =>
      op.type === "dropTable" ||
      op.type === "dropColumn" ||
      (op.type === "alterColumn" &&
        // Type changes or making non-nullable are potentially destructive
        (normalizeType(op.from.type) !== normalizeType(op.to.type) ||
          (op.from.nullable && !op.to.nullable)))
  );
}

/**
 * Gets a human-readable description of destructive operations
 */
export function getDestructiveOperationDescriptions(
  operations: DiffOperation[]
): string[] {
  const descriptions: string[] = [];

  for (const op of operations) {
    if (op.type === "dropTable") {
      descriptions.push(`Drop table "${op.tableName}" (all data will be lost)`);
    } else if (op.type === "dropColumn") {
      descriptions.push(
        `Drop column "${op.columnName}" from table "${op.tableName}" (data will be lost)`
      );
    } else if (op.type === "alterColumn") {
      if (normalizeType(op.from.type) !== normalizeType(op.to.type)) {
        descriptions.push(
          `Change type of "${op.tableName}"."${op.columnName}" from ${op.from.type} to ${op.to.type} (may cause data loss)`
        );
      }
      if (op.from.nullable && !op.to.nullable) {
        descriptions.push(
          `Make "${op.tableName}"."${op.columnName}" NOT NULL (may fail if column contains NULL values)`
        );
      }
    }
  }

  return descriptions;
}
