/**
 * SQLite Migration Driver
 *
 * Implements the MigrationDriver interface for SQLite databases.
 * Uses table recreation for operations SQLite doesn't support natively.
 */

import type { Scalar, ScalarState } from "@schema/scalars";
import { sameDecimalDescriptor } from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import {
  decimalConversionRequired,
  describeDecimalDomain,
  sqliteDecimalStorageKind,
} from "../../decimal";
import { foreignKeyPragmasCannotBeLifted } from "../../foreign-keys";
import { applyNativeRename } from "../../native-rename";
import type { ColumnDef, DiffOperation, TableDef } from "../../types";
import {
  type AddColumnOperation,
  type AddForeignKeyOperation,
  type AddPrimaryKeyOperation,
  type AddUniqueConstraintOperation,
  type AlterColumnOperation,
  type AlterEnumOperation,
  type CreateEnumOperation,
  type CreateIndexOperation,
  type CreateTableOperation,
  type DDLContext,
  type DropColumnOperation,
  type DropEnumOperation,
  type DropForeignKeyOperation,
  type DropIndexOperation,
  type DropPrimaryKeyOperation,
  type DropTableOperation,
  type DropUniqueConstraintOperation,
  MigrationDriver,
  type RenameColumnOperation,
  type RenameTableOperation,
} from "../base";
import { getSQLiteType } from "../type-mapping";
import type { MigrationCapabilities } from "../types";
import { sqliteDecimalCheck, sqliteDecimalCopyExpression } from "./decimal";
import { SQLITE_GEO_POINT_TYPE, sqliteGeoPointCheck } from "./geo-point";
import { introspect } from "./introspect";

/**
 * One preceding operation of the batch, applied to the table definition a later
 * recreation will rebuild. `SQLite3MigrationDriver.getCurrentTable` explains
 * why the introspected definition alone is not enough, and what each list costs
 * when it is left behind.
 */
function applyToTable(table: TableDef, op: DiffOperation): TableDef {
  if (!("tableName" in op) || op.tableName !== table.name) {
    return table;
  }
  switch (op.type) {
    case "addColumn":
      return { ...table, columns: [...table.columns, op.column] };
    case "dropColumn":
      return {
        ...table,
        columns: table.columns.filter(
          (column) => column.name !== op.columnName
        ),
      };
    case "alterColumn":
      return {
        ...table,
        columns: table.columns.map((column) =>
          column.name === op.columnName ? op.to : column
        ),
      };
    case "createIndex":
      return { ...table, indexes: [...table.indexes, op.index] };
    case "dropIndex":
      return {
        ...table,
        indexes: table.indexes.filter((index) => index.name !== op.indexName),
      };
    case "addForeignKey":
      return { ...table, foreignKeys: [...table.foreignKeys, op.fk] };
    case "dropForeignKey":
      return {
        ...table,
        foreignKeys: table.foreignKeys.filter((fk) => fk.name !== op.fkName),
      };
    case "addUniqueConstraint":
      return {
        ...table,
        uniqueConstraints: [...table.uniqueConstraints, op.constraint],
      };
    case "dropUniqueConstraint":
      return {
        ...table,
        uniqueConstraints: table.uniqueConstraints.filter(
          (constraint) => constraint.name !== op.constraintName
        ),
      };
    case "addPrimaryKey":
      return { ...table, primaryKey: op.primaryKey };
    case "dropPrimaryKey":
      return { ...table, primaryKey: undefined };
    default:
      // `dropTable` is the only remaining operation that names this table, and
      // nothing rebuilds a table the same batch dropped.
      return table;
  }
}

/**
 * The schema-level table set after every preceding operation in the batch.
 *
 * Per-table replay cannot see a table created earlier in the same batch, and
 * retaining a dropped table invents relations the database no longer has.
 * This owner first evolves membership, then applies each operation's local and
 * inbound effects to every table that exists at that point.
 */
function replaySchemaTables(
  tables: readonly TableDef[],
  operations: readonly DiffOperation[]
): TableDef[] {
  let replayed = [...tables];
  for (const operation of operations) {
    if (operation.type === "createTable") {
      replayed = [...replayed, operation.table];
      continue;
    }
    if (operation.type === "dropTable") {
      replayed = replayed.filter((table) => table.name !== operation.tableName);
      continue;
    }
    if (operation.type === "renameTable" || operation.type === "renameColumn") {
      replayed = applyNativeRename({ tables: replayed }, operation).tables;
      continue;
    }
    replayed = replayed.map((table) => applyToTable(table, operation));
  }
  return replayed;
}

/** Whether a table carries an outbound FK or is the target of an inbound FK. */
export function sqliteTableBearsRelations(
  tableName: string,
  tables: readonly TableDef[],
  rebuiltTable?: TableDef,
  precedingOperations: readonly DiffOperation[] = []
): boolean {
  if (rebuiltTable && rebuiltTable.foreignKeys.length > 0) return true;
  const replayed = replaySchemaTables(tables, precedingOperations);
  for (const table of replayed) {
    if (table.name === tableName && table.foreignKeys.length > 0) return true;
    if (
      table.foreignKeys.some(
        (foreignKey) => foreignKey.referencedTable === tableName
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * SQLite3 Migration Driver
 *
 * Handles migrations for better-sqlite3 and similar synchronous SQLite drivers.
 * Uses table recreation for operations SQLite doesn't support natively:
 * - ALTER COLUMN (type, default, NOT NULL changes)
 * - ADD/DROP FOREIGN KEY
 * - ADD/DROP PRIMARY KEY
 *
 * LibSQL extends this class and overrides methods for operations it supports.
 */
export class SQLite3MigrationDriver extends MigrationDriver {
  readonly dialect = "sqlite" as const;
  readonly driverName: string = "sqlite3";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: false,
    supportsAddEnumValueInTransaction: true, // N/A but doesn't matter
    supportsIndexTypes: ["btree"],
    supportsNativeArrays: false,
    // No `ALTER TABLE ADD FOREIGN KEY`: FKs stay inline in CREATE TABLE and
    // rely on SQLite's lazy reference resolution (forward refs are fine).
    supportsAddForeignKeyViaAlter: false,
    // `PRAGMA foreign_key_list` has no name column, and an inline
    // `CONSTRAINT x UNIQUE (...)` is only ever reported as
    // `sqlite_autoindex_<table>_<n>`. Neither name survives a round trip.
    introspectionReadsConstraintNames: false,
  };

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  introspect = introspect;

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  mapScalarType(scalar: Scalar, scalarState: ScalarState): string {
    const nativeType = scalar["~"].nativeType;

    // If a native type is specified and it's for SQLite, use it
    if (nativeType && nativeType.db === "sqlite") {
      return nativeType.type;
    }

    // Use centralized type mapping
    return getSQLiteType({
      type: scalarState.type,
      array: scalarState.array,
      decimal: scalarState.decimal,
    });
  }

  // getDefaultExpression is inherited from base class
  // Override formatBooleanDefault for SQLite's 1/0 representation

  /**
   * SQLite uses 1/0 for boolean values instead of true/false.
   */
  protected override formatBooleanDefault(value: boolean): string {
    return value ? "1" : "0";
  }

  getEnumColumnType(
    _tableName: string,
    columnName: string,
    values: string[]
  ): string {
    // SQLite uses TEXT with CHECK constraint for enum validation
    const escapedValues = values
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    return `TEXT CHECK(${this.escapeIdentifier(columnName)} IN (${escapedValues}))`;
  }

  // ===========================================================================
  // HELPER: Column Definition
  // ===========================================================================

  protected generateColumnDef(column: ColumnDef, _context: DDLContext): string {
    // SQLite auto-increment only works with INTEGER PRIMARY KEY
    // Validate that autoIncrement columns use INTEGER type
    if (column.autoIncrement && column.type.toUpperCase() !== "INTEGER") {
      throw new MigrationError(
        "SQLite auto-increment requires INTEGER type. " +
          `Column "${column.name}" has type "${column.type}" which is not compatible with auto-increment. ` +
          "Note: SQLite auto-increment is implicit when using INTEGER PRIMARY KEY.",
        VibORMErrorCode.INVALID_INPUT,
        {
          meta: { column: column.name, type: column.type, autoIncrement: true },
        }
      );
    }

    if (column.autoIncrement) {
      return `${this.escapeIdentifier(column.name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }

    const parts: string[] = [this.escapeIdentifier(column.name), column.type];

    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    if (column.default !== undefined) {
      parts.push(`DEFAULT ${column.default}`);
    }

    if (column.type.toUpperCase() === SQLITE_GEO_POINT_TYPE) {
      parts.push(
        sqliteGeoPointCheck(column, (name) => this.escapeIdentifier(name))
      );
    }

    // The reserved decimal CHECK is a DERIVED render of the column's own
    // descriptor, emitted as a column CONSTRAINT beside the type — never
    // folded INTO `column.type`. `getEnumColumnType` above does fold its CHECK
    // into the type, and the measured cost is a full table recreation on every
    // push forever: `PRAGMA table_info.type` reports only the `type-name`
    // production, so the desired `TEXT CHECK(...)` never equals the
    // introspected `TEXT`. A named constraint reads back out of
    // `sqlite_master.sql` instead, which is where introspection recovers the
    // descriptor from.
    const kind = sqliteDecimalStorageKind(column);
    if (column.decimal && kind) {
      parts.push(
        sqliteDecimalCheck(column, column.decimal, kind, (name) =>
          this.escapeIdentifier(name)
        )
      );
    }

    return parts.join(" ");
  }

  // ===========================================================================
  // TABLE RECREATION
  // ===========================================================================

  /**
   * Generates SQL for table recreation.
   * This is the Drizzle-style pattern for operations SQLite doesn't support.
   *
   * Steps:
   * 1. PRAGMA foreign_keys=OFF
   * 2. Create new table with desired schema
   * 3. Copy data from old table (using explicit column mapping by name)
   * 4. Drop old table
   * 5. Rename new table
   * 6. Recreate indexes
   * 7. PRAGMA foreign_keys=ON
   *
   * @param tableName - The table to recreate
   * @param newTable - The new table definition
   * @param currentTable - The current table definition (required for safe column mapping)
   * @param columnRenames - Optional map of old column name to new column name
   */
  protected compileTableRecreation(
    tableName: string,
    newTable: TableDef,
    currentTable: TableDef,
    context: DDLContext,
    columnRenames?: Map<string, string>
  ): string[] {
    const statements: string[] = [];
    const tempName = `__new_${tableName}`;
    const currentColumns = new Map(
      currentTable.columns.map((column) => [column.name, column])
    );
    const sourceNames = new Map<string, string>();
    for (const [oldName, newName] of columnRenames ?? []) {
      sourceNames.set(newName, oldName);
    }
    const usesCorrelatedListCopy = newTable.columns.some((column) => {
      const sourceName = sourceNames.get(column.name) ?? column.name;
      return (
        this.decimalConversionKind(currentColumns.get(sourceName), column) ===
        "list"
      );
    });
    // A list conversion opens correlated `json_each` tables whose ten virtual
    // column names are ordinary legal user column names. Every outer read is
    // qualified through this one statement-local alias so `"value"`, `"key"`,
    // and their siblings cannot be captured by the inner table. Ordinary and
    // scalar-only recreations retain their original unaliased SQL.
    const sourceAlias = "__viborm_source";

    // 1. Disable foreign keys
    statements.push("PRAGMA foreign_keys=OFF");

    // 2. Create new table
    statements.push(
      this.generateCreateTableDef({ ...newTable, name: tempName }, context)
    );

    // 3. Copy data - EXPLICIT column mapping by NAME, not position
    // Build a set of current column names for quick lookup
    // For each column in the new table, find the corresponding source column.
    // `source` is an EXPRESSION, not an identifier: a decimal column whose
    // declared domain moved is converted here, inside the database, on the way
    // across.
    const copyColumns: Array<{ source: string; target: string }> = [];

    for (const col of newTable.columns) {
      const sourceName = sourceNames.get(col.name) ?? col.name;

      // Only copy if source column exists in current table
      const currentColumn = currentColumns.get(sourceName);
      if (currentColumn !== undefined) {
        const source = usesCorrelatedListCopy
          ? `${this.escapeIdentifier(sourceAlias)}.${this.escapeIdentifier(sourceName)}`
          : this.escapeIdentifier(sourceName);
        copyColumns.push({
          source: this.copySourceExpression(
            tableName,
            sourceName,
            currentColumn,
            col,
            source
          ),
          target: col.name,
        });
      } else if (!col.nullable && col.default === undefined) {
        // New NOT NULL column without default - INSERT will fail
        throw new MigrationError(
          `Cannot add NOT NULL column "${col.name}" without a default value during table recreation. ` +
            "SQLite requires a default value or nullable column for table recreation.",
          VibORMErrorCode.FEATURE_NOT_SUPPORTED
        );
      }
      // New columns with defaults or nullable will get their default/NULL values
    }

    if (copyColumns.length > 0) {
      const selectCols = copyColumns.map((c) => c.source).join(", ");
      const insertCols = copyColumns
        .map((c) => this.escapeIdentifier(c.target))
        .join(", ");

      statements.push(
        `INSERT INTO ${this.escapeIdentifier(tempName)} (${insertCols}) ` +
          `SELECT ${selectCols} FROM ${this.escapeIdentifier(tableName)}` +
          (usesCorrelatedListCopy
            ? ` AS ${this.escapeIdentifier(sourceAlias)}`
            : "")
      );
    }

    // 4. Drop old table
    statements.push(`DROP TABLE ${this.escapeIdentifier(tableName)}`);

    // 5. Rename new table
    statements.push(
      `ALTER TABLE ${this.escapeIdentifier(tempName)} RENAME TO ${this.escapeIdentifier(tableName)}`
    );

    // 6. Recreate indexes (they were dropped with the old table)
    for (const idx of newTable.indexes) {
      statements.push(
        this.generateCreateIndex(
          { type: "createIndex", tableName, index: idx },
          context
        )
      );
    }

    // 7. Re-enable foreign keys
    statements.push("PRAGMA foreign_keys=ON");

    return this.filterStatements(statements);
  }

  /**
   * What the recreation SELECTs for one column of the rebuilt table.
   *
   * Ordinarily the column itself. When the column's declared decimal domain
   * moved, it is the conversion expression instead: SQLite stores the unscaled
   * coefficient, so a scale change makes every stored integer mean a different
   * number until it is rescaled, and the whole conversion runs inside the
   * database because the rebuild is one `INSERT ... SELECT` this process never
   * reads a row of.
   *
   * A change that moves the STORAGE SHAPE — a scalar becoming a list, or the
   * other way — gets no conversion and no second guard: the value is copied as
   * it stands and the target column's own reserved CHECK refuses it, which
   * aborts the rebuild inside its transaction and leaves the old table exactly
   * as it was.
   *
   * A source column that declares NO domain is the third case, and it is a
   * conversion too. An `INTEGER` holding logical integers, adopted as
   * `decimal(p,s)`, has to become a coefficient: copied as it stands, `123`
   * would silently start reading as 1.23. Only that one adoption is converted.
   * A TEXT source or a list target has no proven logical scale, and SQLite can
   * coerce numeric text after the copy, so every other unmarked source refuses
   * here before the recreation exists.
   */
  private copySourceExpression(
    tableName: string,
    sourceName: string,
    currentColumn: ColumnDef | undefined,
    targetColumn: ColumnDef,
    source: string
  ): string {
    const to = targetColumn.decimal;
    const targetKind = sqliteDecimalStorageKind(targetColumn);
    if (to === undefined || targetKind === undefined) return source;

    const from = currentColumn?.decimal;
    if (from === undefined) {
      const adopting =
        targetKind === "scalar" &&
        currentColumn?.type.toUpperCase() === "INTEGER";
      if (!adopting) {
        throw new MigrationError(
          `The declared change to "${tableName}"."${sourceName}" would adopt unmarked ${currentColumn?.type ?? "unknown"} storage as a fixed-decimal ${targetKind}. ` +
            "Only a scalar INTEGER has one exact descriptor-free meaning that can be rescaled into the target domain. TEXT and every list container carry no proven member scale, while other SQLite affinities can already have changed the stored value. " +
            "The change is refused before any statement runs, so the schema and data stay unchanged. Use an explicit migration that validates and rewrites the source values.",
          VibORMErrorCode.FEATURE_NOT_SUPPORTED,
          {
            meta: {
              table: tableName,
              column: sourceName,
              feature: "decimal storage adoption",
              dialect: "sqlite",
            },
          }
        );
      }
      return sqliteDecimalCopyExpression(source, undefined, to, "scalar");
    }
    if (sameDecimalDescriptor(from, to)) return source;
    const conversionKind = this.decimalConversionKind(
      currentColumn,
      targetColumn
    );
    if (conversionKind === undefined) return source;
    return sqliteDecimalCopyExpression(source, from, to, conversionKind);
  }

  /** The shared-storage decimal conversion one copied column requires. */
  private decimalConversionKind(
    currentColumn: ColumnDef | undefined,
    targetColumn: ColumnDef
  ): "scalar" | "list" | undefined {
    const from = currentColumn?.decimal;
    const to = targetColumn.decimal;
    if (
      currentColumn === undefined ||
      from === undefined ||
      to === undefined ||
      sameDecimalDescriptor(from, to)
    ) {
      return undefined;
    }
    const targetKind = sqliteDecimalStorageKind(targetColumn);
    if (
      targetKind === undefined ||
      sqliteDecimalStorageKind(currentColumn) !== targetKind
    ) {
      return undefined;
    }
    return targetKind;
  }

  /**
   * Refuses a decimal conversion the substrate cannot rebuild safely, BEFORE
   * any statement runs.
   *
   * Every SQLite descriptor change is a table recreation, and a recreation
   * drops and rebuilds the table with foreign-key enforcement disabled. That
   * disable is only real when `PRAGMA foreign_keys=OFF` runs OUTSIDE the
   * transaction — SQLite documents it as a no-op inside one — and a batch-only
   * driver has no outside to run it in. On such a driver the pragma travels
   * inside the batch and does nothing, so `DROP TABLE` either raises the
   * constraint or silently fires the referential action on every child row.
   *
   * D1 is the shipped case, and plan §7.4 states the prerequisite exactly: a
   * relation-bearing rebuild is admitted only after the foreign-key-safe
   * rebuild is proven across the ten relation shapes. Until then this refuses
   * with the substrate reason rather than shipping an unsafe drop/recreate or
   * a manual shadow-column instruction.
   *
   * Only relation-bearing tables are refused: a table with no reference in
   * either direction has nothing the disabled enforcement could damage, so
   * fresh decimal schemas and ordinary descriptor changes stay available.
   *
   * The question remains decimal-owned: descriptor changes, adoption into a
   * decimal domain, and a decimal-column rename all require this reconstruction
   * and therefore ask this owner. A recreation requested by another column,
   * constraint, key, or enum does not become a decimal conversion merely
   * because the same table also contains a decimal. General D1 reconstruction
   * safety is an existing migration concern outside this decimal boundary.
   */
  private assertDecimalReconstructionAdmitted(
    tableName: string,
    column: ColumnDef,
    table: TableDef,
    context: DDLContext
  ): void {
    if (column.decimal === undefined) return;
    const driver = this.executionDriver;
    if (!(driver && foreignKeyPragmasCannotBeLifted(driver))) return;
    if (
      !sqliteTableBearsRelations(
        tableName,
        context.currentSchema?.tables ?? [],
        table,
        context.precedingOperations
      )
    ) {
      return;
    }
    throw new MigrationError(
      `Rebuilding "${tableName}"."${column.name}", a fixed-decimal column at ${describeDecimalDomain(column.decimal)}, recreates the whole table, and the driver "${driver.driverName}" executes migrations as one native batch. ` +
        "SQLite treats `PRAGMA foreign_keys=OFF` as a no-op inside a transaction, and a batch has no outside to run it in, so the rebuild would drop a table that still has enforced references — raising on one referential action and silently deleting or nulling child rows on another. " +
        "The change is refused before any statement runs, so the schema and its data are exactly as they were. Recreate the table without its references, or run the change on a driver that executes statements individually.",
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      {
        meta: {
          driver: driver.driverName,
          table: tableName,
          column: column.name,
          feature: "decimal descriptor conversion",
        },
      }
    );
  }

  /**
   * Helper to generate CREATE TABLE DDL without indexes
   */
  protected generateCreateTableDef(
    table: TableDef,
    context: DDLContext
  ): string {
    const parts: string[] = [];

    // Columns
    for (const col of table.columns) {
      parts.push(this.generateColumnDef(col, context));
    }

    // Primary key (if composite or not INTEGER autoincrement)
    if (table.primaryKey) {
      const isSingleIntegerPK =
        table.primaryKey.columns.length === 1 &&
        table.columns.find(
          (c) =>
            c.name === table.primaryKey!.columns[0] &&
            c.type.toUpperCase() === "INTEGER" &&
            c.autoIncrement
        );

      if (!isSingleIntegerPK) {
        const pkCols = table.primaryKey.columns
          .map((c) => this.escapeIdentifier(c))
          .join(", ");
        parts.push(`PRIMARY KEY (${pkCols})`);
      }
    }

    // Unique constraints
    for (const uq of table.uniqueConstraints) {
      const uqCols = uq.columns.map((c) => this.escapeIdentifier(c)).join(", ");
      parts.push(
        `CONSTRAINT ${this.escapeIdentifier(uq.name)} UNIQUE (${uqCols})`
      );
    }

    // Foreign keys
    for (const fk of table.foreignKeys) {
      const fkCols = fk.columns.map((c) => this.escapeIdentifier(c)).join(", ");
      const refCols = fk.referencedColumns
        .map((c) => this.escapeIdentifier(c))
        .join(", ");

      let fkDef = `CONSTRAINT ${this.escapeIdentifier(fk.name)} `;
      fkDef += `FOREIGN KEY (${fkCols}) `;
      fkDef += `REFERENCES ${this.escapeIdentifier(fk.referencedTable)} (${refCols})`;

      if (fk.onDelete && fk.onDelete !== "noAction") {
        fkDef += ` ON DELETE ${this.formatReferentialAction(fk.onDelete)}`;
      }
      if (fk.onUpdate && fk.onUpdate !== "noAction") {
        fkDef += ` ON UPDATE ${this.formatReferentialAction(fk.onUpdate)}`;
      }

      parts.push(fkDef);
    }

    return `CREATE TABLE ${this.escapeIdentifier(table.name)} (\n  ${parts.join(",\n  ")}\n)`;
  }

  /**
   * The table definition a recreation has to rebuild — the introspected one,
   * moved on by every preceding operation of the same batch.
   *
   * `currentSchema` is read once, before the first statement runs, so on its own
   * it describes the table as it was. A recreation drops the table and rebuilds
   * whatever this definition names, so read raw it destroys everything the same
   * batch created earlier and resurrects everything the same batch dropped. Each
   * list is a measured hazard, not a hypothetical:
   *
   * - INDEXES. `createIndex` runs at priority 15 and `addForeignKey` at 16, and
   *   SQLite recreates the table for every foreign-key change — so on a database
   *   that predates the FK index each foreign-key push created the index and
   *   then threw it away, forever.
   *
   * - FOREIGN KEYS. `dropForeignKey` runs at 2 and `addForeignKey` at 16, and
   *   the differ plans that pair for every changed key. With the pre-batch list
   *   the add rebuilt the table around the constraint the drop had just removed
   *   AND its replacement: measured on better-sqlite3, `zz_posts` held 1, then
   *   2, then 3 identical foreign keys after three idempotent pushes.
   *
   * - COLUMNS. `addColumn` runs at 10 and `alterColumn` at 12, and `alterColumn`
   *   is a recreation on SQLite. Measured: pushing a model that both widens one
   *   column's type and adds another emitted the `ALTER TABLE ... ADD COLUMN`,
   *   then rebuilt the table from the pre-batch column list — and the new column
   *   was gone. The push reported success, and the next one added and lost it
   *   again. Two `alterColumn`s in one batch reverted each other the same way.
   *
   * - UNIQUE CONSTRAINTS. `dropUniqueConstraint` runs at 4 and
   *   `addUniqueConstraint` at 14, and both ARE recreations here — the
   *   constraint is inline in `CREATE TABLE` (see
   *   `generateAddUniqueConstraint`). So the pair a changed constraint plans
   *   reads its own predecessor, and a later recreation at 16 has to rebuild
   *   around the constraint the add put there rather than the one the drop
   *   removed.
   *
   * - PRIMARY KEY. `dropPrimaryKey` runs at 5 and `addPrimaryKey` at 13, both
   *   ahead of `addForeignKey`, so a later recreation would rebuild around the
   *   key that was just replaced.
   *
   * - INBOUND FOREIGN KEYS. Native SQLite table and column renames rewrite
   *   references stored in OTHER tables. If one of those tables is recreated
   *   later in the batch, its pre-batch definition would restore the old table
   *   or column name unless the same replay carries the rename's remote effect.
   *
   * These are all the operations that move any of those five out of `TableDef`,
   * plus the two native renames whose effects cross table boundaries. Replaying
   * them gives what the database actually holds when the recreation runs.
   */
  protected getCurrentTable(
    tableName: string,
    context: DDLContext
  ): TableDef | undefined {
    return replaySchemaTables(
      context.currentSchema?.tables ?? [],
      context.precedingOperations ?? []
    ).find((table) => table.name === tableName);
  }

  // ===========================================================================
  // DDL GENERATION - Table Operations
  // ===========================================================================

  generateCreateTable(op: CreateTableOperation, context: DDLContext): string {
    return this.compileCreateTable(op, context).join(";\n");
  }

  override compileCreateTable(
    op: CreateTableOperation,
    context: DDLContext
  ): readonly string[] {
    const { table } = op;
    const statements: string[] = [this.generateCreateTableDef(table, context)];

    // Create indexes separately
    for (const idx of table.indexes) {
      statements.push(
        this.generateCreateIndex(
          {
            type: "createIndex",
            tableName: table.name,
            index: idx,
          },
          context
        )
      );
    }

    return this.filterStatements(statements);
  }

  generateDropTable(op: DropTableOperation, _context: DDLContext): string {
    return `DROP TABLE ${this.escapeIdentifier(op.tableName)}`;
  }

  generateRenameTable(op: RenameTableOperation, _context: DDLContext): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.from)} RENAME TO ${this.escapeIdentifier(op.to)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  generateAddColumn(op: AddColumnOperation, context: DDLContext): string {
    const colDef = this.generateColumnDef(op.column, context);
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} ADD COLUMN ${colDef}`;
  }

  generateDropColumn(op: DropColumnOperation, _context: DDLContext): string {
    // SQLite 3.35.0+ supports DROP COLUMN
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP COLUMN ${this.escapeIdentifier(op.columnName)}`;
  }

  /**
   * Renames a column — natively first, then through a table recreation when
   * that column is a decimal.
   *
   * The descriptor rides in a CHECK constraint whose NAME contains the column
   * name, and `ALTER TABLE … RENAME COLUMN` rewrites column REFERENCES inside a
   * CHECK body but never a constraint NAME. So the native rename leaves the
   * carrier behind, pointing at a column that no longer exists: introspection
   * reads the renamed column as carrying no domain, the next push plans an
   * alteration between a domain and nothing, and the stored coefficient is
   * copied unchanged under whatever scale the schema now declares — 12345
   * meaning 123.45 silently becomes 1.2345. It is not even destructive by the
   * differ's reading, because no domain narrowed, so no prompt fires.
   *
   * The native statement has a second job a recreation cannot perform: SQLite
   * rewrites inbound foreign keys stored in OTHER tables. Only after that
   * schema-wide propagation does the ordinary recreation replace the stale
   * carrier name on the already-renamed table. The reconstruction therefore
   * copies the new column name from a current definition that already contains
   * the rename; it is not a second rename mechanism.
   */
  generateRenameColumn(op: RenameColumnOperation, context: DDLContext): string {
    return this.compileRenameColumn(op, context).join(";\n");
  }

  override compileRenameColumn(
    op: RenameColumnOperation,
    context: DDLContext
  ): readonly string[] {
    const currentTable = this.getCurrentTable(op.tableName, context);
    const renamed = currentTable?.columns.find(
      (column) => column.name === op.from
    );
    if (currentTable === undefined || renamed?.decimal === undefined) {
      // SQLite 3.25.0+ supports RENAME COLUMN
      return this.filterStatements([
        `ALTER TABLE ${this.escapeIdentifier(op.tableName)} RENAME COLUMN ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`,
      ]);
    }

    const nativeRename =
      `ALTER TABLE ${this.escapeIdentifier(op.tableName)} ` +
      `RENAME COLUMN ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`;
    const renamedTable = applyNativeRename({ tables: [currentTable] }, op)
      .tables[0];
    if (renamedTable === undefined) {
      throw new MigrationError(
        `Cannot rename column: table "${op.tableName}" disappeared from the current schema.`,
        VibORMErrorCode.INTERNAL_ERROR,
        { meta: { table: op.tableName, column: op.from } }
      );
    }
    this.assertDecimalReconstructionAdmitted(
      op.tableName,
      renamed,
      renamedTable,
      context
    );
    return this.filterStatements([
      nativeRename,
      ...this.compileTableRecreation(
        op.tableName,
        renamedTable,
        renamedTable,
        context
      ),
    ]);
  }

  generateAlterColumn(op: AlterColumnOperation, context: DDLContext): string {
    return this.compileAlterColumn(op, context).join(";\n");
  }

  override compileAlterColumn(
    op: AlterColumnOperation,
    context: DDLContext
  ): readonly string[] {
    // A derived SQLite driver may own a native single-statement form.
    if (
      this.generateAlterColumn !==
      SQLite3MigrationDriver.prototype.generateAlterColumn
    ) {
      return super.compileAlterColumn(op, context);
    }

    return this.compileAlterColumnByRecreation(op, context);
  }

  /** SQLite's value-preserving ALTER COLUMN implementation. */
  protected compileAlterColumnByRecreation(
    op: AlterColumnOperation,
    context: DDLContext
  ): readonly string[] {
    // SQLite doesn't support ALTER COLUMN - need table recreation
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot alter column: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL."
      );
    }

    // Build new table definition with the altered column
    const newColumns = currentTable.columns.map((col) => {
      if (col.name === op.columnName) {
        return op.to;
      }
      return col;
    });

    const newTable: TableDef = {
      ...currentTable,
      columns: newColumns,
    };

    if (decimalConversionRequired(op.from, op.to)) {
      this.assertDecimalReconstructionAdmitted(
        op.tableName,
        op.to,
        newTable,
        context
      );
    }

    return this.compileTableRecreation(
      op.tableName,
      newTable,
      currentTable,
      context
    );
  }

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  generateCreateIndex(op: CreateIndexOperation, _context: DDLContext): string {
    const { tableName, index } = op;

    // Validate index type against capabilities (SQLite only supports btree)
    this.validateIndexType(index.type, index.name);

    const unique = index.unique ? "UNIQUE " : "";
    const cols = index.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    // SQLite has supported partial indexes since 3.8.0. Dropping the predicate
    // silently would build a different index from the declared one, and the
    // differ would re-create it on every push forever, because introspection
    // reads the predicate back.
    const where = index.where ? ` WHERE ${index.where}` : "";
    // SQLite doesn't support USING clause - it only has btree indexes
    return `CREATE ${unique}INDEX ${this.escapeIdentifier(index.name)} ON ${this.escapeIdentifier(tableName)} (${cols})${where}`;
  }

  generateDropIndex(op: DropIndexOperation, _context: DDLContext): string {
    return `DROP INDEX ${this.escapeIdentifier(op.indexName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations (require table recreation)
  // ===========================================================================

  generateAddForeignKey(
    op: AddForeignKeyOperation,
    context: DDLContext
  ): string {
    return this.compileAddForeignKey(op, context).join(";\n");
  }

  override compileAddForeignKey(
    op: AddForeignKeyOperation,
    context: DDLContext
  ): readonly string[] {
    // LibSQL owns the native single-column form; its multi-column fallback
    // remains a SQLite recreation and therefore keeps these boundaries.
    if (
      op.fk.columns.length <= 1 &&
      this.generateAddForeignKey !==
        SQLite3MigrationDriver.prototype.generateAddForeignKey
    ) {
      return super.compileAddForeignKey(op, context);
    }

    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot add foreign key: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL."
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      foreignKeys: [...currentTable.foreignKeys, op.fk],
    };

    return this.compileTableRecreation(
      op.tableName,
      newTable,
      currentTable,
      context
    );
  }

  generateDropForeignKey(
    op: DropForeignKeyOperation,
    context: DDLContext
  ): string {
    return this.compileDropForeignKey(op, context).join(";\n");
  }

  override compileDropForeignKey(
    op: DropForeignKeyOperation,
    context: DDLContext
  ): readonly string[] {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot drop foreign key: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL."
      );
    }

    const currentForeignKey = currentTable.foreignKeys.find(
      (fk) => fk.name === op.fkName
    );
    // Preserve a derived driver's native single-column form and its own
    // missing/invalid-constraint diagnostics.
    if (
      (!currentForeignKey || currentForeignKey.columns.length <= 1) &&
      this.generateDropForeignKey !==
        SQLite3MigrationDriver.prototype.generateDropForeignKey
    ) {
      return super.compileDropForeignKey(op, context);
    }

    const newTable: TableDef = {
      ...currentTable,
      foreignKeys: currentTable.foreignKeys.filter(
        (fk) => fk.name !== op.fkName
      ),
    };

    return this.compileTableRecreation(
      op.tableName,
      newTable,
      currentTable,
      context
    );
  }

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  /**
   * A unique constraint is INLINE in `CREATE TABLE` on SQLite, so both halves
   * of the diff go through a table recreation. There is no other spelling that
   * round-trips.
   *
   * SQLite has two ways to spell "these columns are unique" and only one of
   * them survives introspection as a constraint. An inline
   * `CONSTRAINT x UNIQUE (...)` is reported by `PRAGMA index_list` with
   * `origin = "u"`, which `introspect` files under `uniqueConstraints` —
   * matched by shape against the declared one (see
   * `introspectionReadsConstraintNames`), so an unchanged schema plans nothing.
   * A standalone `CREATE UNIQUE INDEX` is reported with `origin = "c"` and
   * filed under `indexes` instead, where no declared unique constraint will
   * ever match it.
   *
   * Measured on better-sqlite3 at `f78fa83`, with the add as a standalone
   * index: push #2 of a model that gained `.unique(["slug", "tenant"])`
   * planned `addUniqueConstraint` and created the index; push #3 read that
   * index back under the wrong bucket and planned `addUniqueConstraint` again
   * beside `dropIndex` on the same name — and since `addUniqueConstraint` (14)
   * runs ahead of a superseded index drop (15.5), the push died on
   * `index "…_slug_tenant_key" already exists`. Every later push died the same
   * way. Before the shape matching landed the FK churn rebuilt the table on
   * every push and destroyed the index before push #3 could collide with it,
   * so the same schema pushed green forever and the unique was never enforced.
   *
   * The drop had no working spelling at all: every `dropUniqueConstraint` the
   * differ plans here names a constraint read out of `PRAGMA index_list` with
   * `origin = "u"`, i.e. `sqlite_autoindex_<table>_<n>`, and SQLite refuses
   * `DROP INDEX` on an index it created itself.
   *
   * A database written by the old add still holds the standalone index. It
   * heals on the next push: the recreation rebuilds the table with the
   * constraint inline, and the stale index — dropped with the old table and
   * re-created by step 6 of the recreation, because it is still in the
   * introspected definition — is removed by the `dropIndex` the same batch
   * plans for it.
   */
  generateAddUniqueConstraint(
    op: AddUniqueConstraintOperation,
    context: DDLContext
  ): string {
    return this.compileAddUniqueConstraint(op, context).join(";\n");
  }

  override compileAddUniqueConstraint(
    op: AddUniqueConstraintOperation,
    context: DDLContext
  ): readonly string[] {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot add unique constraint: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL."
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      uniqueConstraints: [...currentTable.uniqueConstraints, op.constraint],
    };

    return this.compileTableRecreation(
      op.tableName,
      newTable,
      currentTable,
      context
    );
  }

  generateDropUniqueConstraint(
    op: DropUniqueConstraintOperation,
    context: DDLContext
  ): string {
    return this.compileDropUniqueConstraint(op, context).join(";\n");
  }

  override compileDropUniqueConstraint(
    op: DropUniqueConstraintOperation,
    context: DDLContext
  ): readonly string[] {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot drop unique constraint: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL."
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      uniqueConstraints: currentTable.uniqueConstraints.filter(
        (constraint) => constraint.name !== op.constraintName
      ),
    };

    return this.compileTableRecreation(
      op.tableName,
      newTable,
      currentTable,
      context
    );
  }

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations (require table recreation)
  // ===========================================================================

  generateAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    context: DDLContext
  ): string {
    return this.compileAddPrimaryKey(op, context).join(";\n");
  }

  override compileAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    context: DDLContext
  ): readonly string[] {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot add primary key: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL."
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      primaryKey: op.primaryKey,
    };

    return this.compileTableRecreation(
      op.tableName,
      newTable,
      currentTable,
      context
    );
  }

  generateDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    context: DDLContext
  ): string {
    return this.compileDropPrimaryKey(op, context).join(";\n");
  }

  override compileDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    context: DDLContext
  ): readonly string[] {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot drop primary key: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL."
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      primaryKey: undefined,
    };

    return this.compileTableRecreation(
      op.tableName,
      newTable,
      currentTable,
      context
    );
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  generateCreateEnum(_op: CreateEnumOperation, _context: DDLContext): string {
    // SQLite enums use CHECK constraints embedded in column definitions
    // No separate enum type creation needed
    return "-- SQLite: enum CHECK constraint is part of column definition";
  }

  generateDropEnum(op: DropEnumOperation, context: DDLContext): string {
    return this.compileDropEnum(op, context).join(";\n");
  }

  override compileDropEnum(
    op: DropEnumOperation,
    context: DDLContext
  ): readonly string[] {
    // Dropping an enum means removing CHECK constraints from dependent columns
    // This requires table recreation for each dependent table
    const { enumName, dependentColumns } = op;

    if (!dependentColumns || dependentColumns.length === 0) {
      return this.filterStatements([
        `-- SQLite: no dependent columns for enum "${enumName}"`,
      ]);
    }

    const statements: string[] = [];

    for (const dep of dependentColumns) {
      const currentTable = this.getCurrentTable(dep.tableName, context);
      if (!currentTable) {
        throw new MigrationError(
          `Table "${dep.tableName}" not found for enum "${enumName}"`,
          VibORMErrorCode.INTERNAL_ERROR
        );
      }

      // Change the column type to plain TEXT (remove CHECK constraint)
      const newColumns = currentTable.columns.map((col) => {
        if (col.name === dep.columnName && col.type.includes("CHECK")) {
          return { ...col, type: "TEXT" };
        }
        return col;
      });

      const newTable: TableDef = { ...currentTable, columns: newColumns };
      statements.push(
        ...this.compileTableRecreation(
          dep.tableName,
          newTable,
          currentTable,
          context
        )
      );
    }

    return this.filterStatements(statements);
  }

  generateAlterEnum(op: AlterEnumOperation, context: DDLContext): string {
    return this.compileAlterEnum(op, context).join(";\n\n");
  }

  override compileAlterEnum(
    op: AlterEnumOperation,
    context: DDLContext
  ): readonly string[] {
    // Altering an enum means updating CHECK constraints on dependent columns
    // This requires table recreation for each dependent column
    const { enumName, newValues, dependentColumns } = op;
    const statements: string[] = [];

    if (!newValues || newValues.length === 0) {
      return this.filterStatements([
        `-- SQLite: no new values provided for enum "${enumName}"`,
      ]);
    }

    if (!dependentColumns || dependentColumns.length === 0) {
      return this.filterStatements([
        `-- SQLite: no dependent columns found for enum "${enumName}"`,
      ]);
    }

    // Migrate rows off removed values before recreating the table — copying
    // a row that still holds a removed value would violate the new CHECK.
    // Replacement targets must satisfy the OLD check (surviving values or
    // NULL); mapping to a value added in the same alter is not supported.
    statements.push(...this.buildEnumReplacementUpdates(op));

    // Generate new CHECK constraint
    const escapedValues = newValues
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(", ");

    for (const dep of dependentColumns) {
      const currentTable = this.getCurrentTable(dep.tableName, context);
      if (!currentTable) {
        statements.push(`-- SQLite: table "${dep.tableName}" not found`);
        continue;
      }

      // Build new CHECK constraint for this column
      const newCheckType = `TEXT CHECK(${this.escapeIdentifier(dep.columnName)} IN (${escapedValues}))`;

      // Update the column type with new CHECK
      const newColumns = currentTable.columns.map((col) => {
        if (col.name === dep.columnName) {
          return { ...col, type: newCheckType };
        }
        return col;
      });

      const newTable: TableDef = { ...currentTable, columns: newColumns };
      statements.push(
        ...this.compileTableRecreation(
          dep.tableName,
          newTable,
          currentTable,
          context
        )
      );
    }

    return this.filterStatements(statements);
  }

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  generateAcquireLock(_lockId: number): string | null {
    // SQLite uses file-based locking via transactions
    // Return null to signal that locking is handled differently
    return null;
  }

  generateReleaseLock(_lockId: number): string | null {
    // SQLite uses file-based locking via transactions
    return null;
  }

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  generateInventoryTables(): { sql: string; params: unknown[] } {
    return {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      params: [],
    };
  }

  generateInventoryEnums(): { sql: string; params: unknown[] } | null {
    // SQLite doesn't support enums
    return null;
  }
}

// Export singleton instance
export const sqlite3MigrationDriver = new SQLite3MigrationDriver();
