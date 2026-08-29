/**
 * Schema Differ
 *
 * Compares two SchemaSnapshots and produces a list of DiffOperations,
 * detecting ambiguous changes that require user input.
 */

import { sameDecimalDescriptor } from "@validation/primitives/decimal-codec";
import {
  decimalChangeNarrows,
  describeDecimalDomain,
  migrationDecimalStorageKind,
} from "./decimal";
import type {
  AmbiguousChange,
  ColumnDef,
  DiffOperation,
  DiffResult,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  ReferentialAction,
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

  /**
   * Recognizes a foreign key and a unique constraint by its SHAPE instead of by
   * its name — see `foreignKeyShape` below for why, and for what breaks without
   * it. Set by `planPush` from the migration driver's
   * `introspectionReadsConstraintNames` capability; left off by `generate`,
   * which diffs two snapshots the serializer wrote and where every name is
   * therefore the declared one.
   */
  matchConstraintsByShape?: boolean;
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

function columnPropertiesEqual(a: ColumnDef, b: ColumnDef): boolean {
  return (
    normalizeType(a.type) === normalizeType(b.type) &&
    a.nullable === b.nullable &&
    normalizeDefault(a.default) === normalizeDefault(b.default) &&
    // The declared domain is compared beside the physical type, not instead of
    // it, because the two carry different amounts of the fact per dialect: a
    // PostgreSQL `numeric(10,5)` spells its whole domain in the type, while a
    // SQLite decimal is `INTEGER` (or `TEXT` for a list) at every precision and
    // scale there is. Left out, a SQLite descriptor change plans NOTHING —
    // the type is byte-identical on both sides — and the column silently keeps
    // storing coefficients at the old scale.
    sameDecimalDescriptor(a.decimal, b.decimal)
  );
}

function columnsEqual(a: ColumnDef, b: ColumnDef): boolean {
  return a.name === b.name && columnPropertiesEqual(a, b);
}

function columnsCanBeRenamed(a: ColumnDef, b: ColumnDef): boolean {
  if (normalizeType(a.type) === normalizeType(b.type)) return true;
  const aDecimalKind = migrationDecimalStorageKind(a);
  return (
    aDecimalKind !== undefined &&
    aDecimalKind === migrationDecimalStorageKind(b)
  );
}

function normalizeType(type: string): string {
  // Normalize type names for comparison
  const normalized = type.toLowerCase().replace(/\s+/g, " ").trim();

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

  // SQL DEFAULT NULL and an omitted default have the same behavior. MySQL's
  // catalog cannot distinguish them, so the snapshot differ must use the one
  // semantic spelling or every nullable column would churn after introspection.
  if (normalized === "null") return undefined;

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

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}

// =============================================================================
// CONSTRAINT IDENTITY
// =============================================================================

function normalizeReferentialAction(
  action: ReferentialAction | undefined
): ReferentialAction {
  // `normalizeIndexUnique`'s twin on the foreign-key side. Every introspection
  // reads a concrete action back from the catalog — "NO ACTION" when the DDL
  // declared none — while a snapshot may leave it undefined, and both spell the
  // same constraint: SQLite and MySQL omit the clause for `noAction`,
  // PostgreSQL writes `ON DELETE NO ACTION`, which is what omitting it means.
  // Left raw, the same key reads as a change and is dropped and re-added on
  // every push.
  return action ?? "noAction";
}

/**
 * What a foreign key IS, with the name left out: the columns it binds, what
 * they point at, and what happens on delete and on update. NUL joins the
 * columns and SOH the parts — no SQL identifier and no action name holds
 * either, so two shapes read alike only when every part does.
 *
 * The name is left out because on some dialects it is not readable. On
 * PostgreSQL and MySQL the catalog carries the name the DDL gave the
 * constraint, so a name IS an identity there and the differ matches on it.
 * SQLite carries no name for either constraint this file matches:
 * `PRAGMA foreign_key_list` has no name column at all, so introspection
 * synthesises `<table>_fk_<n>`, and an inline `CONSTRAINT x UNIQUE (...)` is
 * reported only under SQLite's own `sqlite_autoindex_<table>_<n>`. Matched by
 * name, the declared constraint is therefore missing and the read one extra on
 * every push of an unchanged schema, forever — and the two repairs the differ
 * plans are both wrong:
 *
 *   - the foreign key is dropped and re-added, and SQLite has no
 *     `ALTER TABLE ADD FOREIGN KEY`, so each of those rebuilds the whole table
 *     — copy included — twice per push, for a schema nobody edited;
 *   - the unique constraint's drop is `DROP INDEX "sqlite_autoindex_..."`,
 *     which SQLite refuses ("index associated with UNIQUE or PRIMARY KEY
 *     constraint cannot be dropped"), so the SECOND push of any SQLite schema
 *     carrying a compound unique fails outright.
 *
 * So where the name cannot be read, the shape is the identity: two constraints
 * of one shape are one constraint, whatever the reader called them.
 */
function foreignKeyShape(fk: ForeignKeyDef): string {
  return [
    fk.columns.join("\u0000"),
    fk.referencedTable,
    fk.referencedColumns.join("\u0000"),
    normalizeReferentialAction(fk.onDelete),
    normalizeReferentialAction(fk.onUpdate),
  ].join("\u0001");
}

/** `foreignKeyShape`'s twin: a unique constraint is its column list. */
function uniqueConstraintShape(constraint: UniqueConstraintDef): string {
  return constraint.columns.join("\u0000");
}

/**
 * Pairs each `current` constraint with the `desired` one it is, under whichever
 * identity the dialect supports, and reports what `desired` had left over.
 *
 * Multisets, not maps, on purpose. A database written before
 * `SQLite3MigrationDriver.getCurrentTable` learned to replay the batch can hold
 * several byte-identical foreign keys on one table — they accumulated, one per
 * push, without bound. Keying by identity alone would collapse those into one
 * entry and leave the extras attached forever; pairing k of n leaves n-k
 * unmatched, and unmatched is what gets dropped.
 */
function matchByIdentity<T>(
  current: readonly T[],
  desired: readonly T[],
  identityOf: (item: T) => string
): { matches: Array<T | undefined>; unmatchedDesired: T[] } {
  const availableByIdentity = new Map<string, number[]>();
  for (const [position, item] of desired.entries()) {
    const identity = identityOf(item);
    const positions = availableByIdentity.get(identity);
    if (positions) {
      positions.push(position);
    } else {
      availableByIdentity.set(identity, [position]);
    }
  }

  const consumed = new Set<number>();
  const matches = current.map((item) => {
    const position = availableByIdentity.get(identityOf(item))?.shift();
    if (position === undefined) return undefined;
    consumed.add(position);
    return desired[position];
  });

  return {
    matches,
    unmatchedDesired: desired.filter(
      (_, position) => !consumed.has(position)
    ) as T[],
  };
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
  canonical: CanonicalPredicates,
  matchConstraintsByShape: boolean
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

      if (columnsCanBeRenamed(dropped, added)) {
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

  // Diff foreign keys, under whichever identity this dialect's introspection
  // supports (see `foreignKeyShape`).
  const fkMatch = matchByIdentity(
    current.foreignKeys,
    desired.foreignKeys,
    matchConstraintsByShape ? foreignKeyShape : (fk) => fk.name
  );

  for (const [position, fk] of current.foreignKeys.entries()) {
    const desiredFk = fkMatch.matches[position];
    if (!desiredFk) {
      operations.push({ type: "dropForeignKey", tableName, fkName: fk.name });
    } else if (foreignKeyShape(fk) !== foreignKeyShape(desiredFk)) {
      // The pair is the same constraint under a name; its definition changed,
      // so drop and recreate. Under shape identity a pair IS one shape, so this
      // is the name-identity dialects' branch — it is where a changed
      // referential action or referenced column is caught on Postgres and
      // MySQL, and where SQLite's own drop-and-add falls out of the definition
      // having actually changed rather than out of an unreadable name.
      operations.push({ type: "dropForeignKey", tableName, fkName: fk.name });
      operations.push({ type: "addForeignKey", tableName, fk: desiredFk });
    }
  }

  for (const fk of fkMatch.unmatchedDesired) {
    operations.push({ type: "addForeignKey", tableName, fk });
  }

  // Diff unique constraints — same identity question, same answer.
  const uniqueMatch = matchByIdentity(
    current.uniqueConstraints,
    desired.uniqueConstraints,
    matchConstraintsByShape ? uniqueConstraintShape : (uq) => uq.name
  );

  for (const [position, uq] of current.uniqueConstraints.entries()) {
    const desiredUq = uniqueMatch.matches[position];
    if (!desiredUq) {
      operations.push({
        type: "dropUniqueConstraint",
        tableName,
        constraintName: uq.name,
      });
    } else if (uniqueConstraintShape(uq) !== uniqueConstraintShape(desiredUq)) {
      operations.push({
        type: "dropUniqueConstraint",
        tableName,
        constraintName: uq.name,
      });
      operations.push({
        type: "addUniqueConstraint",
        tableName,
        constraint: desiredUq,
      });
    }
  }

  for (const constraint of uniqueMatch.unmatchedDesired) {
    operations.push({
      type: "addUniqueConstraint",
      tableName,
      constraint,
    });
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
          droppedTableDef: droppedTable,
          addedTableDef: addedTable,
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
        canonicalPredicates,
        options.matchConstraintsByShape ?? false
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

/** The one destructive-operation classification used by every consumer. */
export function isDestructiveOperation(operation: DiffOperation): boolean {
  if (operation.type === "dropTable" || operation.type === "dropColumn") {
    return true;
  }
  return (
    operation.type === "alterColumn" &&
    (normalizeType(operation.from.type) !== normalizeType(operation.to.type) ||
      (operation.from.nullable && !operation.to.nullable) ||
      decimalChangeNarrows(operation.from, operation.to))
  );
}

/** Checks if any operation can cause data loss or refuse existing rows. */
export function hasDestructiveOperations(operations: DiffOperation[]): boolean {
  return operations.some(isDestructiveOperation);
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
      if (
        op.from.decimal &&
        op.to.decimal &&
        decimalChangeNarrows(op.from, op.to)
      ) {
        // The numbers go in the SENTENCE: `precision` and `scale` are not
        // error-metadata keys, so a refusal that put them in `meta` would drop
        // them silently.
        descriptions.push(
          `Narrow the decimal domain of "${op.tableName}"."${op.columnName}" from ${describeDecimalDomain(op.from.decimal)} to ${describeDecimalDomain(op.to.decimal)} (the conversion refuses every value that no longer fits, rather than rounding it)`
        );
      }
    }
  }

  return descriptions;
}
