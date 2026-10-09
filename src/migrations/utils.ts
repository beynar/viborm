import { createHash } from "node:crypto";
/**
 * Shared migration helpers that do not own a V1 command.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { MigrationDriver } from "./drivers";
import { orderTableDrops } from "./drop-order";
import type { Dialect, DiffOperation, SchemaSnapshot } from "./types";

/** PostgreSQL/MySQL derived identifiers keep their uniqueness under byte caps. */
export function derivedMigrationName(name: string): string {
  if (Buffer.byteLength(name) <= 63) return name;
  let prefix = "";
  for (const character of name) {
    if (Buffer.byteLength(prefix + character) > 54) break;
    prefix += character;
  }
  return `${prefix}_${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

/** Default generated-key spelling; dialects may supply their physical rule. */
export function defaultGeneratedPrimaryKeyName(
  tableName: string,
  name?: string
): string {
  return name || `${tableName}_pkey`;
}

// DIALECT UTILITIES
// =============================================================================

/**
 * Validates and normalizes the database dialect for migrations.
 * Throws if the dialect is not supported.
 */
export function normalizeDialect(dialect: string): Dialect {
  if (dialect === "postgresql" || dialect === "postgres") {
    return "postgresql";
  }
  if (dialect === "sqlite") {
    return "sqlite";
  }
  if (dialect === "mysql") {
    return "mysql";
  }
  throw new MigrationError(
    `Unsupported dialect for migrations: "${dialect}". ` +
      "Supported dialects: postgresql, sqlite, mysql.",
    VibORMErrorCode.MIGRATION_DIALECT_MISMATCH,
    { meta: { dialect } }
  );
}

// QUERY EXECUTOR
// =============================================================================

/**
 * Type for executing SQL queries and returning rows.
 */
export type QueryExecutor = (
  sql: string,
  params?: unknown[]
) => Promise<unknown[]>;

/**
 * Creates a query executor from a driver.
 * Extracts rows from the QueryResult.
 */
export function createQueryExecutor(driver: AnyDriver): QueryExecutor {
  return async (sql: string, params?: unknown[]) => {
    const result = await driver._executeRaw<Record<string, unknown>>(
      sql,
      params
    );
    return result.rows;
  };
}

// =============================================================================
// OPERATION UTILITIES
// =============================================================================

/**
 * Operation execution order priorities.
 * Lower numbers execute first.
 */
const OPERATION_PRIORITY: Record<DiffOperation["type"], number> = {
  createEnum: 1,
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
  alterEnum: 1.5,
  dropEnum: 18,
};

/**
 * Slot for the index drops that have to run *after* the batch's index creates.
 * Between `createIndex` and `addForeignKey`, so a superseded index is gone
 * before a new constraint is bound to whatever is left.
 */
const SUPERSEDED_INDEX_DROP_PRIORITY =
  (OPERATION_PRIORITY.createIndex + OPERATION_PRIORITY.addForeignKey) / 2;

/**
 * Picks out the `dropIndex` operations whose replacement has to exist first.
 *
 * MySQL binds a foreign key to whichever index covers its columns and refuses
 * to drop that index while it is the last one covering them (errno 1553). A
 * schema edit that supersedes such an index — widening it, or covering the same
 * columns with a unique constraint — plans the drop and its replacement in the
 * same batch, so the replacement has to be in place before the drop runs.
 *
 * Two arrangements keep a drop in its early slot instead:
 * - The batch creates an index of the *same name*, which the drop has to free
 *   first. The name is matched on its own, not per table: PostgreSQL and SQLite
 *   scope an index name to the schema/database, so a batch that frees a name on
 *   one table and takes it on another collides too (Postgres 42P07). Matching
 *   on the name alone can only keep a drop early, never defer one, so it cannot
 *   reopen the 1553 case — there the created index has a different name.
 * - A table that also drops a column loses that column's indexes along with it,
 *   so a drop deferred past the column drop would address an index already
 *   gone. (A dropped *table* cannot collide: index diffs are only produced for
 *   tables present in both snapshots.)
 */
function supersededIndexDrops(operations: DiffOperation[]): Set<DiffOperation> {
  const createdIndexNames = new Set<string>();
  const tablesLosingColumns = new Set<string>();
  for (const op of operations) {
    if (op.type === "createIndex") {
      createdIndexNames.add(op.index.name);
    } else if (op.type === "addUniqueConstraint") {
      createdIndexNames.add(op.constraint.name);
    } else if (op.type === "addPrimaryKey" && op.primaryKey.name) {
      createdIndexNames.add(op.primaryKey.name);
    } else if (op.type === "dropColumn") {
      tablesLosingColumns.add(op.tableName);
    }
  }

  const superseded = new Set<DiffOperation>();
  for (const op of operations) {
    if (
      op.type === "dropIndex" &&
      !createdIndexNames.has(op.indexName) &&
      !tablesLosingColumns.has(op.tableName)
    ) {
      superseded.add(op);
    }
  }
  return superseded;
}

/**
 * Sorts operations for proper execution order:
 * 1. Create enums (before tables that use them)
 * 2. Drop foreign keys (before dropping tables/columns)
 * 3. Drop indexes, constraints, columns
 * 4. Drop tables
 * 5. Create tables
 * 6. Establish table and column renames before operations using the new names
 * 7. Add or alter columns and constraints
 * 8. Create indexes
 * 9. Drop the indexes those creates supersede (see `supersededIndexDrops`)
 * 10. Add foreign keys (after tables/columns exist)
 */
export function sortOperations(operations: DiffOperation[]): DiffOperation[] {
  const superseded = supersededIndexDrops(operations);
  const priorityOf = (op: DiffOperation) =>
    superseded.has(op)
      ? SUPERSEDED_INDEX_DROP_PRIORITY
      : OPERATION_PRIORITY[op.type];
  const baseline = operations
    .map((operation, index) => ({ operation, index }))
    .sort((a, b) => priorityOf(a.operation) - priorityOf(b.operation));
  const renames = baseline.filter(
    ({ operation }) =>
      operation.type === "renameTable" || operation.type === "renameColumn"
  );
  if (renames.length === 0) return baseline.map(({ operation }) => operation);
  const ordered: DiffOperation[] = [];
  const visited = new Set<number>();
  const active = new Set<number>();
  const visit = (entry: (typeof baseline)[number]): void => {
    if (visited.has(entry.index)) return;
    if (active.has(entry.index)) {
      throw new MigrationError(
        "Migration operations contain a cyclic native rename dependency",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
    active.add(entry.index);
    for (const prerequisite of renames) {
      if (prerequisite.index === entry.index) continue;
      const rename = prerequisite.operation;
      const operation = entry.operation;
      if (rename.type === "renameTable") {
        // A later producer can reuse an earlier table name. A column rename
        // before that name was consumed addresses the earlier identity.
        if (
          operation.type === "renameColumn" &&
          prerequisite.index > entry.index &&
          renames.some(
            (earlier) =>
              earlier.index > entry.index &&
              earlier.index < prerequisite.index &&
              earlier.operation.type === "renameTable" &&
              earlier.operation.from === operation.tableName
          )
        )
          continue;
        const needed =
          operation.type === "renameTable"
            ? prerequisite.index < entry.index && rename.to === operation.from
            : operationTargetsTable(operation, rename.to);
        if (needed) visit(prerequisite);
      } else if (rename.type === "renameColumn") {
        const needed =
          operation.type === "renameTable"
            ? prerequisite.index < entry.index &&
              rename.tableName === operation.from
            : operation.type === "renameColumn"
              ? prerequisite.index < entry.index &&
                rename.tableName === operation.tableName &&
                rename.to === operation.from
              : operationTargetsColumn(operation, rename.tableName, rename.to);
        if (needed) visit(prerequisite);
      }
    }
    active.delete(entry.index);
    visited.add(entry.index);
    ordered.push(entry.operation);
  };
  for (const entry of baseline) visit(entry);
  return ordered;
}

/** A table operation that must address the post-rename identity. */
function operationTargetsTable(
  operation: DiffOperation,
  tableName: string
): boolean {
  if (operation.type === "createTable") {
    return operation.table.name === tableName;
  }
  if (operation.type === "alterEnum" || operation.type === "dropEnum") {
    return (
      operation.dependentColumns?.some(
        (column) => column.tableName === tableName
      ) ?? false
    );
  }
  return "tableName" in operation && operation.tableName === tableName;
}

function operationTargetsColumn(
  operation: DiffOperation,
  tableName: string,
  columnName: string
): boolean {
  if (operation.type === "alterEnum" || operation.type === "dropEnum") {
    return (
      operation.dependentColumns?.some(
        (column) =>
          column.tableName === tableName && column.columnName === columnName
      ) ?? false
    );
  }
  return (
    "tableName" in operation &&
    operation.tableName === tableName &&
    "columnName" in operation &&
    operation.columnName === columnName
  );
}

/**
 * Lifts *forward-reference* foreign keys out of `createTable` operations into
 * separate `addForeignKey` operations, so a table whose FK points at a table
 * created later in the same batch does not emit the constraint before its
 * referenced table exists.
 *
 * This is the DDL-ordering fix for `push()` / generated migrations: a schema
 * that declares a child model (the endpoint holding the FK) *before* its parent
 * would otherwise emit `ALTER TABLE child ADD ... FOREIGN KEY REFERENCES parent`
 * (Postgres) or an inline FK (MySQL) immediately after `CREATE TABLE child`,
 * before `CREATE TABLE parent` runs — Postgres `42P01`, MySQL analogous — and
 * the whole transactional push aborts with zero tables created.
 *
 * The transform is capability-gated and deliberately *surgical*:
 * - Drivers that cannot `ALTER TABLE ADD FOREIGN KEY` (SQLite/LibSQL) keep FKs
 *   inline and are returned untouched — they resolve forward references lazily
 *   and rewriting an FK into an `addForeignKey` op would trigger a table
 *   recreation against an introspected-empty current schema.
 * - Only FKs that reference a table created *later* in this batch are lifted.
 *   Backward references (referenced-first schemas, self-references, FKs to
 *   pre-existing tables) already work and are left byte-identical, preserving
 *   the DDL of schemas that were never broken.
 *
 * Lifted `addForeignKey` operations are appended after every other operation so
 * they run once all `CREATE TABLE`s have executed. Non-lifted operations retain
 * their exact input order.
 */
export function extractForwardReferenceForeignKeys(
  operations: DiffOperation[],
  migrationDriver: MigrationDriver
): DiffOperation[] {
  if (!migrationDriver.capabilities.supportsAddForeignKeyViaAlter) {
    return operations;
  }

  // Position of each table within the sequence of createTable operations.
  const createdTablePosition = new Map<string, number>();
  let position = 0;
  for (const op of operations) {
    if (op.type === "createTable") {
      createdTablePosition.set(op.table.name, position);
      position += 1;
    }
  }

  const result: DiffOperation[] = [];
  const liftedForeignKeys: DiffOperation[] = [];

  for (const op of operations) {
    if (op.type !== "createTable") {
      result.push(op);
      continue;
    }

    const selfPosition = createdTablePosition.get(op.table.name);
    // Partition this table's FKs into those that must stay inline and those
    // that point forward to a table created later in the batch.
    const retained = op.table.foreignKeys.filter((fk) => {
      const targetPosition = createdTablePosition.get(fk.referencedTable);
      const isForwardReference =
        targetPosition !== undefined &&
        selfPosition !== undefined &&
        targetPosition > selfPosition;
      return !isForwardReference;
    });

    if (retained.length === op.table.foreignKeys.length) {
      // No forward references — leave the operation byte-identical.
      result.push(op);
      continue;
    }

    const forwardForeignKeys = op.table.foreignKeys.filter(
      (fk) => !retained.includes(fk)
    );

    result.push({
      ...op,
      table: { ...op.table, foreignKeys: retained },
    });
    for (const fk of forwardForeignKeys) {
      liftedForeignKeys.push({
        type: "addForeignKey",
        tableName: op.table.name,
        fk,
      });
    }
  }

  return [...result, ...liftedForeignKeys];
}

/**
 * Materializes the foreign-key drops a dropped-table graph needs, ONCE, for
 * every consumer: push, generated up SQL, and inverted generated down SQL.
 *
 * The differ omits a foreign-key drop when both endpoint tables disappear —
 * there is no surviving table to alter, so nothing produces the operation — and
 * §6.1 removes the `CASCADE` that used to paper over it. Without this stage a
 * `RESTRICT` drop of two mutually-referencing tables fails no matter which
 * order they are emitted in, and a cycle fails in every order.
 *
 * Every implicated key is included regardless of the table order the batch
 * happens to have, including keys whose owning AND referenced tables are both
 * being dropped, and including cycles. `sortOperations` then puts every
 * `dropForeignKey` (priority 2) ahead of every `dropTable` (priority 7).
 *
 * Drivers that cannot `ALTER TABLE ... DROP CONSTRAINT` keep their operations
 * byte-identical: SQLite and LibSQL hold foreign keys inline and rebuild tables
 * instead, so an explicit drop is not a statement they can emit.
 */
export function materializeDroppedTableForeignKeys(
  operations: DiffOperation[],
  current: SchemaSnapshot,
  migrationDriver: MigrationDriver
): DiffOperation[] {
  if (!migrationDriver.capabilities.supportsAddForeignKeyViaAlter) {
    return operations;
  }

  const droppedTables = new Set<string>();
  const plannedDrops = new Set<string>();
  for (const op of operations) {
    if (op.type === "dropTable") {
      droppedTables.add(op.tableName);
    } else if (op.type === "dropForeignKey") {
      plannedDrops.add(`${op.tableName} ${op.fkName}`);
    }
  }
  if (droppedTables.size === 0) {
    return operations;
  }

  const materialized: DiffOperation[] = [];
  for (const table of current.tables) {
    for (const fk of table.foreignKeys) {
      const implicated =
        droppedTables.has(table.name) || droppedTables.has(fk.referencedTable);
      if (implicated && !plannedDrops.has(`${table.name} ${fk.name}`)) {
        materialized.push({
          type: "dropForeignKey",
          tableName: table.name,
          fkName: fk.name,
        });
      }
    }
  }

  return materialized.length === 0
    ? operations
    : [...materialized, ...operations];
}

/**
 * One compile-order owner for generated schema programs. Generate and push
 * both hand this result to the compiler, and nothing sorts it afterwards. Do
 * not lift, materialize or order drops at a second call site. Drops are
 * ordered last, once every foreign-key removal the program makes is known.
 */
export function prepareSchemaProgram(
  operations: DiffOperation[],
  current: SchemaSnapshot,
  migrationDriver: MigrationDriver
): DiffOperation[] {
  return orderTableDrops(
    materializeDroppedTableForeignKeys(
      extractForwardReferenceForeignKeys(operations, migrationDriver),
      current,
      migrationDriver
    ),
    current
  );
}

// =============================================================================
// MIGRATION FILE UTILITIES
// =============================================================================

/**
 * Generate a migration name based on the operations.
 */
export function generateMigrationName(operations: DiffOperation[]): string {
  if (operations.length === 0) {
    return "empty";
  }

  const primaryOp = operations[0];
  if (!primaryOp) {
    return "migration";
  }

  switch (primaryOp.type) {
    case "createTable":
      return operations.length === 1
        ? `create-${primaryOp.table.name}`
        : "initial";
    case "dropTable":
      return `drop-${primaryOp.tableName}`;
    case "addColumn":
      return `add-${primaryOp.column.name}-to-${primaryOp.tableName}`;
    case "dropColumn":
      return `drop-${primaryOp.columnName}-from-${primaryOp.tableName}`;
    case "renameTable":
      return `rename-${primaryOp.from}-to-${primaryOp.to}`;
    case "renameColumn":
      return `rename-${primaryOp.from}-to-${primaryOp.to}`;
    case "createIndex":
      return `add-index-${primaryOp.index.name}`;
    case "dropIndex":
      return `drop-index-${primaryOp.indexName}`;
    case "addForeignKey":
      return `add-fk-${primaryOp.fk.name}`;
    case "dropForeignKey":
      return `drop-fk-${primaryOp.fkName}`;
    case "createEnum":
      return `create-enum-${primaryOp.enumDef.name}`;
    case "dropEnum":
      return `drop-enum-${primaryOp.enumName}`;
    case "alterEnum":
      return `alter-enum-${primaryOp.enumName}`;
    default:
      return "migration";
  }
}
