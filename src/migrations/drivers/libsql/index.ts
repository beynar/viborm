/**
 * LibSQL Migration Driver
 *
 * Extends SQLite3 driver with native ALTER COLUMN support.
 * LibSQL supports ALTER TABLE ALTER COLUMN syntax that SQLite doesn't,
 * avoiding expensive table recreation for column modifications.
 *
 * CAVEAT: LibSQL's ALTER COLUMN only validates newly inserted/updated rows,
 * NOT existing data. This differs from PostgreSQL's behavior where constraints
 * are validated against all existing rows.
 */

import type { ColumnDef, ReferentialAction } from "../../types";
import type {
  AddForeignKeyOperation,
  AlterColumnOperation,
  DDLContext,
  DropForeignKeyOperation,
} from "../base";
import { SQLite3MigrationDriver } from "../sqlite";
import type { MigrationCapabilities } from "../types";

export class LibSQLMigrationDriver extends SQLite3MigrationDriver {
  override readonly driverName: string = "libsql";

  // Same capabilities as SQLite3 (no native enums, no arrays, btree only)
  override readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: false,
    supportsAddEnumValueInTransaction: true,
    supportsIndexTypes: ["btree"],
    supportsNativeArrays: false,
  };

  // ===========================================================================
  // LIBSQL-SPECIFIC: ALTER COLUMN (native support)
  // ===========================================================================

  /**
   * LibSQL supports ALTER TABLE ... ALTER COLUMN ... TO syntax.
   * This avoids table recreation for column type/default/nullable changes.
   *
   * Syntax: ALTER TABLE t ALTER COLUMN c TO c <new_column_def>
   *
   * CAVEAT: LibSQL's ALTER COLUMN only validates newly inserted/updated rows,
   * NOT existing data. This is different from PostgreSQL's behavior.
   */
  override generateAlterColumn(
    op: AlterColumnOperation,
    _context?: DDLContext
  ): string {
    const { tableName, columnName, to } = op;
    const table = this.escapeIdentifier(tableName);
    const col = this.escapeIdentifier(columnName);

    // Build new column definition
    const colDef = this.generateColumnDef(to);

    // LibSQL syntax: ALTER TABLE t ALTER COLUMN old_name TO new_def
    return `ALTER TABLE ${table} ALTER COLUMN ${col} TO ${colDef}`;
  }

  // ===========================================================================
  // LIBSQL-SPECIFIC: FOREIGN KEYS (native support via ALTER COLUMN)
  // ===========================================================================

  // ===========================================================================
  // HELPER: Build column definition with optional REFERENCES
  // ===========================================================================

  /**
   * Builds a column definition string with optional foreign key REFERENCES clause.
   * Used for LibSQL's ALTER COLUMN TO syntax.
   */
  private buildColumnDefWithReferences(
    column: ColumnDef,
    fkRef?: {
      refTable: string;
      refCol: string;
      onDelete?: ReferentialAction;
      onUpdate?: ReferentialAction;
    }
  ): string {
    const parts: string[] = [this.escapeIdentifier(column.name), column.type];

    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    if (column.default !== undefined) {
      parts.push(`DEFAULT ${column.default}`);
    }

    if (fkRef) {
      parts.push(
        `REFERENCES ${this.escapeIdentifier(fkRef.refTable)}(${this.escapeIdentifier(fkRef.refCol)})`
      );
      if (fkRef.onDelete && fkRef.onDelete !== "noAction") {
        parts.push(`ON DELETE ${this.formatReferentialAction(fkRef.onDelete)}`);
      }
      if (fkRef.onUpdate && fkRef.onUpdate !== "noAction") {
        parts.push(`ON UPDATE ${this.formatReferentialAction(fkRef.onUpdate)}`);
      }
    }

    return parts.join(" ");
  }

  // ===========================================================================
  // LIBSQL-SPECIFIC: FOREIGN KEYS (native support via ALTER COLUMN)
  // ===========================================================================

  /**
   * LibSQL can add foreign keys by redefining the column with REFERENCES.
   * This avoids table recreation for single-column foreign keys.
   *
   * Note: Multi-column FKs still require table recreation.
   */
  override generateAddForeignKey(
    op: AddForeignKeyOperation,
    context?: DDLContext
  ): string {
    const { tableName, fk } = op;

    // For multi-column FKs, fall back to table recreation
    if (fk.columns.length > 1) {
      return super.generateAddForeignKey(op, context);
    }

    // Validate columns exist FIRST (before any array access)
    const fkColumn = fk.columns[0];
    const refColumn = fk.referencedColumns[0];
    if (!(fkColumn && refColumn)) {
      throw new Error(
        `Invalid foreign key: columns array is empty for table "${tableName}".`
      );
    }

    const currentTable = this.getCurrentTable(tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot add foreign key: table "${tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext."
      );
    }

    // Find the column to alter
    const column = currentTable.columns.find((c) => c.name === fkColumn);
    if (!column) {
      throw new Error(
        `Cannot add foreign key: column "${fkColumn}" not found in table "${tableName}".`
      );
    }

    const table = this.escapeIdentifier(tableName);
    const col = this.escapeIdentifier(fkColumn);

    // Build column definition with REFERENCES using helper
    const colDef = this.buildColumnDefWithReferences(column, {
      refTable: fk.referencedTable,
      refCol: refColumn,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    });

    return `ALTER TABLE ${table} ALTER COLUMN ${col} TO ${colDef}`;
  }

  /**
   * LibSQL can drop foreign keys by redefining the column without REFERENCES.
   * This avoids table recreation for single-column foreign keys.
   */
  override generateDropForeignKey(
    op: DropForeignKeyOperation,
    context?: DDLContext
  ): string {
    const currentTable = this.getCurrentTable(op.tableName, context);
    if (!currentTable) {
      throw new Error(
        `Cannot drop foreign key: table "${op.tableName}" not found in current schema. ` +
          "Pass currentSchema in DDLContext."
      );
    }

    // Find the FK to drop
    const fk = currentTable.foreignKeys.find((f) => f.name === op.fkName);
    if (!fk) {
      throw new Error(
        `Cannot drop foreign key: constraint "${op.fkName}" not found in table "${op.tableName}".`
      );
    }

    // For multi-column FKs, fall back to table recreation
    if (fk.columns.length > 1) {
      return super.generateDropForeignKey(op, context);
    }

    const fkColumn = fk.columns[0];
    if (!fkColumn) {
      throw new Error(
        `Invalid foreign key: columns array is empty for constraint "${op.fkName}".`
      );
    }

    // Find the column
    const column = currentTable.columns.find((c) => c.name === fkColumn);
    if (!column) {
      throw new Error(
        `Cannot drop foreign key: column "${fkColumn}" not found in table "${op.tableName}".`
      );
    }

    const table = this.escapeIdentifier(op.tableName);
    const col = this.escapeIdentifier(fkColumn);

    // Rebuild column definition WITHOUT REFERENCES using helper
    const colDef = this.buildColumnDefWithReferences(column);

    return `ALTER TABLE ${table} ALTER COLUMN ${col} TO ${colDef}`;
  }

  // ===========================================================================
  // PRIMARY KEY OPERATIONS
  // LibSQL still requires table recreation for PK changes
  // ===========================================================================

  // generateAddPrimaryKey and generateDropPrimaryKey inherit from SQLite3
  // which uses table recreation. LibSQL does not support native PK modifications.
}

// Export singleton instance
export const libsqlMigrationDriver = new LibSQLMigrationDriver();
