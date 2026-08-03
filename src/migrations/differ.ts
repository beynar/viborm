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
// PARTIAL-INDEX PREDICATE CANONICALIZATION (Decision 7.4)
// =============================================================================

/**
 * Asks the database for its own spelling of each declared index predicate.
 *
 * The differ has no connection of its own; the push path owns one and hands
 * this in (`planPush`). One call carries every predicate of one table, so the
 * round trip is paid once per table that has a partial index whose two
 * spellings differ — usually never, at most once per push.
 *
 * The result is positional. `undefined` at a position means the database did
 * not answer for that predicate, and the differ then treats it as
 * uncomparable — never as equal.
 */
export type IndexPredicateCanonicalizer = (
  tableName: string,
  predicates: readonly string[]
) => Promise<ReadonlyArray<string | undefined>>;

export interface DiffOptions {
  /**
   * Canonicalizes partial-index predicates through the live database. Omitted
   * by callers with no connection (`generate`, which diffs two snapshots) and
   * by dialects whose catalog stores the declared statement verbatim; the
   * differ then compares the two texts raw, which is the fail-closed reading.
   */
  canonicalizeIndexPredicate?: IndexPredicateCanonicalizer;
}

/** Canonical spellings, keyed by table and by the predicate as declared. */
type CanonicalPredicates = ReadonlyMap<string, string>;

const EMPTY_CANONICAL_PREDICATES: CanonicalPredicates = new Map();

/** NUL joins the halves: no table name and no SQL text can contain one. */
function predicateKey(tableName: string, predicate: string): string {
  return `${tableName}\u0000${predicate}`;
}

/**
 * Asks the database for its spelling of every predicate that a partial index
 * present in both snapshots spells two ways.
 *
 * Scoped on purpose. A predicate only one side carries, or that both sides
 * spell identically, is settled without a round trip — so a schema with no
 * partial index, or one that already converged, costs nothing.
 */
async function canonicalizeChangedPredicates(
  currentTables: ReadonlyMap<string, TableDef>,
  desiredTables: ReadonlyMap<string, TableDef>,
  canonicalize: IndexPredicateCanonicalizer | undefined
): Promise<CanonicalPredicates> {
  if (!canonicalize) return EMPTY_CANONICAL_PREDICATES;

  const canonical = new Map<string, string>();

  for (const [tableName, desiredTable] of desiredTables) {
    const currentTable = currentTables.get(tableName);
    if (!currentTable) continue;

    const currentIndexes = new Map(
      currentTable.indexes.map((i) => [i.name, i])
    );
    const pending = new Set<string>();

    for (const desiredIndex of desiredTable.indexes) {
      const currentIndex = currentIndexes.get(desiredIndex.name);
      if (!currentIndex) continue;
      const left = normalizeIndexWhere(currentIndex.where);
      const right = normalizeIndexWhere(desiredIndex.where);
      if (left === undefined || right === undefined || left === right) continue;
      pending.add(left);
      pending.add(right);
    }

    if (pending.size === 0) continue;

    const predicates = [...pending];
    const spellings = await canonicalize(tableName, predicates);
    for (const [position, predicate] of predicates.entries()) {
      const spelling = spellings[position];
      if (spelling !== undefined) {
        canonical.set(predicateKey(tableName, predicate), spelling);
      }
    }
  }

  return canonical;
}

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

function normalizeIndexType(type: IndexDef["type"]): string {
  // An index with no declared type is a B-tree on every dialect. The two
  // snapshot producers spell that differently — introspection reads "btree"
  // back from the Postgres/MySQL catalog, SQLite reports no type at all, and
  // the serializer leaves an undeclared type undefined — so the same index
  // must not read as a change.
  return type ?? "btree";
}

function normalizeIndexUnique(unique: IndexDef["unique"]): boolean {
  // `type`'s twin (above): the serializer leaves a plain `.index()`'s `unique`
  // undefined while every introspection reads a boolean back from the catalog,
  // so the same index must not read as a change. Left raw, every push re-plans
  // drop+create forever — and on MySQL the drop is a hard 1553 abort when the
  // declared index is the one InnoDB bound the FK to.
  return unique ?? false;
}

function normalizeIndexWhere(where: IndexDef["where"]): string | undefined {
  // `type`'s and `unique`'s third twin, and the one place the partial index's
  // two spellings are reconciled. The serializer passes the declared predicate
  // through untouched; the emitter writes ` WHERE ${where}`, and SQLite stores
  // that statement verbatim, padding and all. Reading it back consumes the
  // whitespace run that separates `WHERE` from the predicate, so a declaration
  // written with padding comes back without its leading part — the same index
  // in two spellings. Left raw, every push re-plans drop+create forever.
  const trimmed = where?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The one place the two snapshots' predicates are compared, and the reader of
 * the canonical spellings the database supplied (Decision 7.4).
 *
 * `normalizeIndexWhere` above reconciles the *padding* of one text; it cannot
 * reconcile two texts. PostgreSQL's catalog does not store the declared
 * statement — `pg_get_expr(indpred, indrelid)` deparses it, so a declared
 * `published = true` reads back as `(published = true)`, and every push drops
 * and re-creates every partial index. No client-side normalization closes that
 * while staying fail-closed: flatten whitespace and parentheses and
 * `a AND (b OR c)` starts comparing equal to `(a AND b) OR c`, so a real change
 * would stop being seen. So the database is asked, and `canonical` holds what
 * it answered. Two predicates are the same predicate only when BOTH were
 * canonicalized and the two canonical spellings are identical.
 */
function indexWhereEqual(
  tableName: string,
  a: IndexDef,
  b: IndexDef,
  canonical: CanonicalPredicates
): boolean {
  const left = normalizeIndexWhere(a.where);
  const right = normalizeIndexWhere(b.where);
  if (left === right) return true;
  // A predicate that appears or disappears is a real change on every dialect,
  // and no round trip can make a partial index equal to a total one.
  if (left === undefined || right === undefined) return false;

  const leftCanonical = canonical.get(predicateKey(tableName, left));
  const rightCanonical = canonical.get(predicateKey(tableName, right));
  // Fail closed. Without both spellings — no canonicalizer, a dialect that has
  // none, a connection that refused, a predicate the database could not parse —
  // two texts that do not read alike stay a change.
  return leftCanonical !== undefined && leftCanonical === rightCanonical;
}

function indexesEqual(
  tableName: string,
  a: IndexDef,
  b: IndexDef,
  canonical: CanonicalPredicates
): boolean {
  return (
    a.name === b.name &&
    normalizeIndexUnique(a.unique) === normalizeIndexUnique(b.unique) &&
    arraysEqual(a.columns, b.columns) &&
    normalizeIndexType(a.type) === normalizeIndexType(b.type) &&
    indexWhereEqual(tableName, a, b, canonical)
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
  desired: TableDef,
  canonical: CanonicalPredicates
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
      operations.push({ type: "dropIndex", tableName, indexName: name });
    } else if (!indexesEqual(tableName, idx, desiredIdx, canonical)) {
      // Index changed - drop and recreate
      operations.push({ type: "dropIndex", tableName, indexName: name });
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
export async function diff(
  current: SchemaSnapshot,
  desired: SchemaSnapshot,
  options: DiffOptions = {}
): Promise<DiffResult> {
  const operations: DiffOperation[] = [];
  const ambiguousChanges: AmbiguousChange[] = [];

  // Build table maps
  const currentTables = new Map(current.tables.map((t) => [t.name, t]));
  const desiredTables = new Map(desired.tables.map((t) => [t.name, t]));

  const canonicalPredicates = await canonicalizeChangedPredicates(
    currentTables,
    desiredTables,
    options.canonicalizeIndexPredicate
  );

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
      const tableDiff = diffTable(
        name,
        currentTable,
        desiredTable,
        canonicalPredicates
      );
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
        const dependentColumns: Array<{
          tableName: string;
          columnName: string;
        }> = [];
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
          dependentColumns:
            dependentColumns.length > 0 ? dependentColumns : undefined,
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
