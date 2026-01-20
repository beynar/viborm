/**
 * SQLite Migration Driver
 *
 * Implements the MigrationDriver interface for SQLite databases.
 * Uses table recreation for operations SQLite doesn't support natively.
 */

import type { Field, FieldState } from "@schema/fields";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import type { ColumnDef, SchemaSnapshot, TableDef } from "../../types";
import { getSQLiteType } from "../type-mapping";
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
import type { MigrationCapabilities } from "../types";
import { introspect } from "./introspect";

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
  readonly driverName = "sqlite3";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: false,
    supportsAddEnumValueInTransaction: true, // N/A but doesn't matter
    supportsIndexTypes: ["btree"],
    supportsNativeArrays: false,
  };

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  introspect = introspect;

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  mapFieldType(field: Field, fieldState: FieldState): string {
    const nativeType = field["~"].nativeType;

    // If a native type is specified and it's for SQLite, use it
    if (nativeType && nativeType.db === "sqlite") {
      return nativeType.type;
    }

    // Use centralized type mapping
    return getSQLiteType({
      type: fieldState.type,
      array: fieldState.array,
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
    const escapedValues = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
    return `TEXT CHECK(${this.escapeIdentifier(columnName)} IN (${escapedValues}))`;
  }

  // ===========================================================================
  // HELPER: Column Definition
  // ===========================================================================

  protected generateColumnDef(column: ColumnDef): string {
    const parts: string[] = [this.escapeIdentifier(column.name), column.type];

    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    if (column.default !== undefined) {
      parts.push(`DEFAULT ${column.default}`);
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
   * @param columnRenames - Optional map of old column name → new column name (for renames)
   */
  protected generateTableRecreation(
    tableName: string,
    newTable: TableDef,
    currentTable: TableDef,
    columnRenames?: Map<string, string>
  ): string {
    const statements: string[] = [];
    const tempName = `__new_${tableName}`;

    // 1. Disable foreign keys
    statements.push("PRAGMA foreign_keys=OFF");

    // 2. Create new table
    statements.push(
      this.generateCreateTableDef({ ...newTable, name: tempName })
    );

    // 3. Copy data - EXPLICIT column mapping by NAME, not position
    // Build a set of current column names for quick lookup
    const currentColumnNames = new Set(currentTable.columns.map((c) => c.name));

    // For each column in the new table, find the corresponding source column
    const copyColumns: Array<{ source: string; target: string }> = [];

    for (const col of newTable.columns) {
      // Check if this column was renamed
      let sourceName = col.name;
      if (columnRenames) {
        // columnRenames maps old name → new name, so we need to reverse lookup
        for (const [oldName, newName] of columnRenames) {
          if (newName === col.name) {
            sourceName = oldName;
            break;
          }
        }
      }

      // Only copy if source column exists in current table
      if (currentColumnNames.has(sourceName)) {
        copyColumns.push({ source: sourceName, target: col.name });
      } else if (!col.nullable && col.default === undefined) {
        // New NOT NULL column without default - INSERT will fail
        throw new MigrationError(
          `Cannot add NOT NULL column "${col.name}" without a default value during table recreation. ` +
            `SQLite requires a default value or nullable column for table recreation.`,
          VibORMErrorCode.FEATURE_NOT_SUPPORTED
        );
      }
      // New columns with defaults or nullable will get their default/NULL values
    }

    if (copyColumns.length > 0) {
      const selectCols = copyColumns
        .map((c) => this.escapeIdentifier(c.source))
        .join(", ");
      const insertCols = copyColumns
        .map((c) => this.escapeIdentifier(c.target))
        .join(", ");

      statements.push(
        `INSERT INTO ${this.escapeIdentifier(tempName)} (${insertCols}) ` +
          `SELECT ${selectCols} FROM ${this.escapeIdentifier(tableName)}`
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
        this.generateCreateIndex({ type: "createIndex", tableName, index: idx })
      );
    }

    // 7. Re-enable foreign keys
    statements.push("PRAGMA foreign_keys=ON");

    return statements.join(";\n");
  }

  /**
   * Helper to generate CREATE TABLE DDL without indexes
   */
  protected generateCreateTableDef(table: TableDef): string {
    const parts: string[] = [];

    // Columns
    for (const col of table.columns) {
      parts.push(this.generateColumnDef(col));
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
   * Gets the current table definition from the schema context.
   */
  protected getCurrentTable(tableName: string, context?: DDLContext): TableDef | undefined {
    return context?.currentSchema?.tables.find((t) => t.name === tableName);
  }

  // ===========================================================================
  // DDL GENERATION - Table Operations
  // ===========================================================================

  generateCreateTable(op: CreateTableOperation): string {
    const { table } = op;
    const statements: string[] = [this.generateCreateTableDef(table)];

    // Create indexes separately
    for (const idx of table.indexes) {
      statements.push(
        this.generateCreateIndex({ type: "createIndex", tableName: table.name, index: idx })
      );
    }

    return statements.join(";\n");
  }

  generateDropTable(op: DropTableOperation): string {
    return `DROP TABLE ${this.escapeIdentifier(op.tableName)}`;
  }

  generateRenameTable(op: RenameTableOperation): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.from)} RENAME TO ${this.escapeIdentifier(op.to)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  generateAddColumn(op: AddColumnOperation): string {
    const colDef = this.generateColumnDef(op.column);
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} ADD COLUMN ${colDef}`;
  }

  generateDropColumn(op: DropColumnOperation): string {
    // SQLite 3.35.0+ supports DROP COLUMN
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP COLUMN ${this.escapeIdentifier(op.columnName)}`;
  }

  generateRenameColumn(op: RenameColumnOperation): string {
    // SQLite 3.25.0+ supports RENAME COLUMN
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} RENAME COLUMN ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`;
  }

  generateAlterColumn(op: AlterColumnOperation, context?: DDLContext): string {
    // SQLite doesn't support ALTER COLUMN - need table recreation
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot alter column: table "${op.tableName}" not found in current schema. ` +
          `Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL.`
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

    return this.generateTableRecreation(op.tableName, newTable, currentTable);
  }

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  generateCreateIndex(op: CreateIndexOperation): string {
    const { tableName, index } = op;

    // Validate index type against capabilities (SQLite only supports btree)
    this.validateIndexType(index.type, index.name);

    const unique = index.unique ? "UNIQUE " : "";
    const cols = index.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    // SQLite doesn't support USING clause - it only has btree indexes
    return `CREATE ${unique}INDEX ${this.escapeIdentifier(index.name)} ON ${this.escapeIdentifier(tableName)} (${cols})`;
  }

  generateDropIndex(op: DropIndexOperation): string {
    return `DROP INDEX ${this.escapeIdentifier(op.indexName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations (require table recreation)
  // ===========================================================================

  generateAddForeignKey(op: AddForeignKeyOperation, context?: DDLContext): string {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot add foreign key: table "${op.tableName}" not found in current schema. ` +
          `Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL.`
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      foreignKeys: [...currentTable.foreignKeys, op.fk],
    };

    return this.generateTableRecreation(op.tableName, newTable, currentTable);
  }

  generateDropForeignKey(op: DropForeignKeyOperation, context?: DDLContext): string {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot drop foreign key: table "${op.tableName}" not found in current schema. ` +
          `Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL.`
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      foreignKeys: currentTable.foreignKeys.filter((fk) => fk.name !== op.fkName),
    };

    return this.generateTableRecreation(op.tableName, newTable, currentTable);
  }

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  generateAddUniqueConstraint(op: AddUniqueConstraintOperation): string {
    const { tableName, constraint } = op;
    const cols = constraint.columns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    return `CREATE UNIQUE INDEX ${this.escapeIdentifier(constraint.name)} ON ${this.escapeIdentifier(tableName)} (${cols})`;
  }

  generateDropUniqueConstraint(op: DropUniqueConstraintOperation): string {
    return `DROP INDEX ${this.escapeIdentifier(op.constraintName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations (require table recreation)
  // ===========================================================================

  generateAddPrimaryKey(op: AddPrimaryKeyOperation, context?: DDLContext): string {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot add primary key: table "${op.tableName}" not found in current schema. ` +
          `Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL.`
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      primaryKey: op.primaryKey,
    };

    return this.generateTableRecreation(op.tableName, newTable, currentTable);
  }

  generateDropPrimaryKey(op: DropPrimaryKeyOperation, context?: DDLContext): string {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot drop primary key: table "${op.tableName}" not found in current schema. ` +
          `Pass currentSchema in DDLContext or call setCurrentSchema() before generating DDL.`
      );
    }

    const newTable: TableDef = {
      ...currentTable,
      primaryKey: undefined,
    };

    return this.generateTableRecreation(op.tableName, newTable, currentTable);
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  generateCreateEnum(_op: CreateEnumOperation, _context?: DDLContext): string {
    // SQLite enums use CHECK constraints embedded in column definitions
    // No separate enum type creation needed
    return "-- SQLite: enum CHECK constraint is part of column definition";
  }

  generateDropEnum(op: DropEnumOperation, context?: DDLContext): string {
    // Dropping an enum means removing CHECK constraints from dependent columns
    // This requires table recreation for each dependent table
    const statements: string[] = [];
    const { enumName, dependentColumns } = op;

    // Use dependentColumns metadata when available (preferred)
    if (dependentColumns && dependentColumns.length > 0) {
      for (const dep of dependentColumns) {
        const currentTable = this.getCurrentTable(dep.tableName, context);
        if (!currentTable) {
          statements.push(
            `-- SQLite: table "${dep.tableName}" not found for enum "${enumName}"`
          );
          continue;
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
          this.generateTableRecreation(dep.tableName, newTable, currentTable)
        );
      }

      return statements.length > 0
        ? statements.join(";\n")
        : `-- SQLite: no columns to update for enum "${enumName}"`;
    }

    // Fallback: parse enum name to find table/column (legacy behavior)
    // LIMITATION: This regex is ambiguous for names with underscores
    const match = enumName.match(/^(.+)_([^_]+)_enum$/);
    if (!match) {
      return `-- SQLite: cannot parse enum name "${enumName}" and no dependentColumns provided`;
    }

    const tableName = match[1]!;
    const columnName = match[2]!;
    const currentTable = this.getCurrentTable(tableName, context);

    if (!currentTable) {
      return `-- SQLite: table "${tableName}" not found for enum "${enumName}" (naming may be ambiguous)`;
    }

    // Verify column exists with CHECK constraint
    const targetColumn = currentTable.columns.find(
      (col) => col.name === columnName && col.type.includes("CHECK")
    );
    if (!targetColumn) {
      return `-- SQLite: column "${columnName}" with CHECK constraint not found in "${tableName}" for enum "${enumName}"`;
    }

    // Change the column type to plain TEXT (remove CHECK constraint)
    const newColumns = currentTable.columns.map((col) => {
      if (col.name === columnName && col.type.includes("CHECK")) {
        return { ...col, type: "TEXT" };
      }
      return col;
    });

    const newTable: TableDef = { ...currentTable, columns: newColumns };
    statements.push(this.generateTableRecreation(tableName, newTable, currentTable));

    return statements.join(";\n");
  }

  generateAlterEnum(op: AlterEnumOperation, context?: DDLContext): string {
    // Altering an enum means updating CHECK constraints on dependent columns
    // This requires table recreation for each dependent column
    const { enumName, newValues, dependentColumns } = op;
    const statements: string[] = [];

    if (!newValues || newValues.length === 0) {
      return `-- SQLite: no new values provided for enum "${enumName}"`;
    }

    if (!dependentColumns || dependentColumns.length === 0) {
      return `-- SQLite: no dependent columns found for enum "${enumName}"`;
    }

    // Generate new CHECK constraint
    const escapedValues = newValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");

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
      statements.push(this.generateTableRecreation(dep.tableName, newTable, currentTable));
    }

    return statements.join(";\n\n");
  }

  // ===========================================================================
  // MIGRATION TRACKING TABLE
  // ===========================================================================

  generateCreateTrackingTable(tableName: string): string {
    const table = this.escapeIdentifier(tableName);
    return `CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
)`;
  }

  generateInsertMigration(tableName: string): { sql: string; paramCount: number } {
    const table = this.escapeIdentifier(tableName);
    return {
      sql: `INSERT INTO ${table} (name, checksum) VALUES (?, ?)`,
      paramCount: 2,
    };
  }

  generateDeleteMigration(tableName: string): { sql: string; paramCount: number } {
    const table = this.escapeIdentifier(tableName);
    return {
      sql: `DELETE FROM ${table} WHERE name = ?`,
      paramCount: 1,
    };
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

  generateResetSQL(): string[] {
    // SQLite doesn't support dynamic SQL in a single statement.
    // The CLI should:
    // 1. Query sqlite_master for tables
    // 2. Execute DROP TABLE for each
    // Return empty to signal programmatic reset is needed.
    return [];
  }

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  generateListTables(): string {
    return `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
  }

  generateListEnums(): string | null {
    // SQLite doesn't support enums
    return null;
  }
}

// Export singleton instance
export const sqlite3MigrationDriver = new SQLite3MigrationDriver();
