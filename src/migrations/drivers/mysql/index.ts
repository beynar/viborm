/**
 * MySQL Migration Driver
 *
 * Implements the MigrationDriver interface for MySQL databases.
 * Supports all DDL operations natively with MySQL-specific syntax.
 */

import type { Field, FieldState } from "@schema/fields";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import type { ColumnDef } from "../../types";
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

/**
 * MySQL-specific DropIndexOperation that requires tableName.
 * MySQL's DROP INDEX syntax requires ON tableName.
 */
type MySqlDropIndexOperation = DropIndexOperation & { tableName: string };

/**
 * Type guard to check if a DropIndexOperation has the required tableName for MySQL.
 */
function isMySqlDropIndexOp(
  op: DropIndexOperation
): op is MySqlDropIndexOperation {
  return typeof (op as MySqlDropIndexOperation).tableName === "string";
}
import { getMySQLType } from "../type-mapping";
import type { MigrationCapabilities } from "../types";
import { introspect } from "./introspect";

export class MySQLMigrationDriver extends MigrationDriver {
  readonly dialect = "mysql" as const;
  readonly driverName = "mysql";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: true, // MySQL has inline ENUM type
    supportsAddEnumValueInTransaction: true, // MODIFY COLUMN works in transactions
    supportsIndexTypes: ["btree", "hash", "fulltext", "spatial"],
    supportsNativeArrays: false, // Use JSON instead
  };

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  introspect = introspect;

  // ===========================================================================
  // IDENTIFIER ESCAPING (MySQL uses backticks)
  // ===========================================================================

  override escapeIdentifier(name: string): string {
    if (name == null) {
      throw new MigrationError(
        "Cannot escape null or undefined identifier",
        VibORMErrorCode.INVALID_INPUT
      );
    }
    return `\`${String(name).replace(/`/g, "``")}\``;
  }

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  mapFieldType(field: Field, fieldState: FieldState): string {
    const nativeType = field["~"].nativeType;

    // If a native type is specified and it's for MySQL, use it
    if (nativeType && nativeType.db === "mysql") {
      return nativeType.type;
    }

    // Use centralized type mapping
    return getMySQLType({
      type: fieldState.type,
      array: fieldState.array,
    });
  }

  /**
   * MySQL uses 1/0 for boolean values (TINYINT(1)).
   */
  protected override formatBooleanDefault(value: boolean): string {
    return value ? "1" : "0";
  }

  /**
   * MySQL supports native auto-generation for certain values.
   */
  protected override getAutoGenerateExpression(
    autoGenerate: FieldState["autoGenerate"]
  ): string | undefined {
    switch (autoGenerate) {
      case "now":
        return "CURRENT_TIMESTAMP";
      case "uuid":
        // MySQL 8.0+ has UUID() function, but it's not suitable for DEFAULT
        // Use application-level generation instead
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * MySQL enum values are part of the column definition.
   * Returns ENUM('val1', 'val2', ...) syntax.
   */
  getEnumColumnType(
    _tableName: string,
    _columnName: string,
    values: string[]
  ): string {
    const escapedValues = values
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    return `ENUM(${escapedValues})`;
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Generates a column definition string for MySQL.
   */
  protected override generateColumnDef(column: ColumnDef): string {
    const parts: string[] = [this.escapeIdentifier(column.name)];

    // Handle auto-increment (MySQL uses AUTO_INCREMENT keyword)
    if (column.autoIncrement) {
      // MySQL requires INT/BIGINT for AUTO_INCREMENT
      const type = column.type.toUpperCase();
      if (type.includes("BIGINT")) {
        parts.push("BIGINT");
      } else {
        parts.push("INT");
      }
      parts.push("AUTO_INCREMENT");
    } else {
      parts.push(column.type);
    }

    // NOT NULL constraint
    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    // DEFAULT clause (skip for auto-increment columns and TEXT/BLOB types)
    // MySQL doesn't allow DEFAULT values for TEXT/BLOB columns
    if (column.default !== undefined && !column.autoIncrement) {
      const upperType = column.type.toUpperCase();
      const isTextOrBlob =
        upperType.includes("TEXT") ||
        upperType.includes("BLOB") ||
        upperType === "TINYTEXT" ||
        upperType === "MEDIUMTEXT" ||
        upperType === "LONGTEXT" ||
        upperType === "TINYBLOB" ||
        upperType === "MEDIUMBLOB" ||
        upperType === "LONGBLOB";

      if (!isTextOrBlob) {
        parts.push(`DEFAULT ${column.default}`);
      }
    }

    return parts.join(" ");
  }

  // ===========================================================================
  // DDL GENERATION - Table Operations
  // ===========================================================================

  generateCreateTable(op: CreateTableOperation): string {
    const { table } = op;
    const columnDefs = table.columns.map((col) => this.generateColumnDef(col));

    // Primary key
    if (table.primaryKey) {
      const pkCols = table.primaryKey.columns
        .map((c) => this.escapeIdentifier(c))
        .join(", ");
      columnDefs.push(`PRIMARY KEY (${pkCols})`);
    }

    // Unique constraints
    for (const uq of table.uniqueConstraints) {
      const uqCols = uq.columns.map((c) => this.escapeIdentifier(c)).join(", ");
      columnDefs.push(
        `CONSTRAINT ${this.escapeIdentifier(uq.name)} UNIQUE (${uqCols})`
      );
    }

    // Foreign keys (inline in CREATE TABLE for MySQL)
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
      columnDefs.push(fkDef);
    }

    const sql = `CREATE TABLE ${this.escapeIdentifier(table.name)} (\n  ${columnDefs.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

    const statements = [sql];

    // Indexes are created separately
    for (const idx of table.indexes) {
      statements.push(
        this.generateCreateIndex({
          type: "createIndex",
          tableName: table.name,
          index: idx,
        })
      );
    }

    return statements.join(";\n");
  }

  generateDropTable(op: DropTableOperation): string {
    // MySQL doesn't have CASCADE for DROP TABLE in the same way
    // Foreign key checks need to be disabled or FKs dropped first
    return `DROP TABLE IF EXISTS ${this.escapeIdentifier(op.tableName)}`;
  }

  generateRenameTable(op: RenameTableOperation): string {
    return `RENAME TABLE ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  generateAddColumn(op: AddColumnOperation): string {
    const colDef = this.generateColumnDef(op.column);
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} ADD COLUMN ${colDef}`;
  }

  generateDropColumn(op: DropColumnOperation): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP COLUMN ${this.escapeIdentifier(op.columnName)}`;
  }

  generateRenameColumn(op: RenameColumnOperation): string {
    // MySQL 8.0+ supports RENAME COLUMN
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} RENAME COLUMN ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`;
  }

  generateAlterColumn(op: AlterColumnOperation, _context?: DDLContext): string {
    const { tableName, columnName, to } = op;
    const table = this.escapeIdentifier(tableName);

    // Build the new column definition
    const colDef = this.generateColumnDef(to);

    // If column name changed, use CHANGE COLUMN (which handles rename + alter)
    if (columnName !== to.name) {
      return `ALTER TABLE ${table} CHANGE COLUMN ${this.escapeIdentifier(columnName)} ${colDef}`;
    }

    // Otherwise use MODIFY COLUMN for same-name alterations
    return `ALTER TABLE ${table} MODIFY COLUMN ${colDef}`;
  }

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  generateCreateIndex(op: CreateIndexOperation): string {
    const { tableName, index } = op;

    // Validate index type
    this.validateIndexType(index.type, index.name);

    const unique = index.unique ? "UNIQUE " : "";
    const cols = index.columns.map((c) => this.escapeIdentifier(c)).join(", ");

    // MySQL index type syntax
    let indexType = "";
    if (index.type && index.type !== "btree") {
      indexType = ` USING ${index.type.toUpperCase()}`;
    }

    return `CREATE ${unique}INDEX ${this.escapeIdentifier(index.name)} ON ${this.escapeIdentifier(tableName)} (${cols})${indexType}`;
  }

  generateDropIndex(op: DropIndexOperation): string {
    // MySQL DROP INDEX always requires the table name
    if (!isMySqlDropIndexOp(op)) {
      throw new MigrationError(
        `MySQL DROP INDEX requires tableName. Index: "${op.indexName}"`,
        VibORMErrorCode.INVALID_INPUT
      );
    }
    return `DROP INDEX ${this.escapeIdentifier(op.indexName)} ON ${this.escapeIdentifier(op.tableName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  generateAddForeignKey(
    op: AddForeignKeyOperation,
    _context?: DDLContext
  ): string {
    const { tableName, fk } = op;
    const cols = fk.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    const refCols = fk.referencedColumns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");

    let sql = `ALTER TABLE ${this.escapeIdentifier(tableName)} `;
    sql += `ADD CONSTRAINT ${this.escapeIdentifier(fk.name)} `;
    sql += `FOREIGN KEY (${cols}) `;
    sql += `REFERENCES ${this.escapeIdentifier(fk.referencedTable)} (${refCols})`;

    if (fk.onDelete && fk.onDelete !== "noAction") {
      sql += ` ON DELETE ${this.formatReferentialAction(fk.onDelete)}`;
    }
    if (fk.onUpdate && fk.onUpdate !== "noAction") {
      sql += ` ON UPDATE ${this.formatReferentialAction(fk.onUpdate)}`;
    }

    return sql;
  }

  generateDropForeignKey(
    op: DropForeignKeyOperation,
    _context?: DDLContext
  ): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP FOREIGN KEY ${this.escapeIdentifier(op.fkName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  generateAddUniqueConstraint(op: AddUniqueConstraintOperation): string {
    const { tableName, constraint } = op;
    const cols = constraint.columns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    return `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(constraint.name)} UNIQUE (${cols})`;
  }

  generateDropUniqueConstraint(op: DropUniqueConstraintOperation): string {
    // MySQL uses DROP INDEX for unique constraints
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP INDEX ${this.escapeIdentifier(op.constraintName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations
  // ===========================================================================

  generateAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    _context?: DDLContext
  ): string {
    const { tableName, primaryKey } = op;
    const cols = primaryKey.columns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    return `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD PRIMARY KEY (${cols})`;
  }

  generateDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    _context?: DDLContext
  ): string {
    // MySQL doesn't name primary keys in DROP
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP PRIMARY KEY`;
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // MySQL doesn't have standalone enum types - they're part of column defs
  // ===========================================================================

  generateCreateEnum(_op: CreateEnumOperation, _context?: DDLContext): string {
    // MySQL enums are inline with column definitions
    return "-- MySQL: ENUM type is part of column definition";
  }

  generateDropEnum(_op: DropEnumOperation, _context?: DDLContext): string {
    // No standalone enum to drop
    return "-- MySQL: ENUM type is part of column definition";
  }

  generateAlterEnum(op: AlterEnumOperation, context?: DDLContext): string {
    // To alter an enum in MySQL, we need to MODIFY COLUMN for each dependent column
    const { enumName, newValues, dependentColumns } = op;

    if (!newValues || newValues.length === 0) {
      return `-- MySQL: no new values provided for enum "${enumName}"`;
    }

    if (!dependentColumns || dependentColumns.length === 0) {
      return `-- MySQL: no dependent columns found for enum "${enumName}"`;
    }

    const statements: string[] = [];
    const enumType = this.getEnumColumnType("", "", newValues);

    for (const dep of dependentColumns) {
      const currentTable = context?.currentSchema?.tables.find(
        (t) => t.name === dep.tableName
      );
      const column = currentTable?.columns.find(
        (c) => c.name === dep.columnName
      );

      if (!column) {
        statements.push(
          `-- MySQL: column "${dep.columnName}" not found in table "${dep.tableName}"`
        );
        continue;
      }

      const table = this.escapeIdentifier(dep.tableName);
      const col = this.escapeIdentifier(dep.columnName);
      const nullable = column.nullable ? "" : " NOT NULL";
      const defaultVal =
        column.default !== undefined ? ` DEFAULT ${column.default}` : "";

      statements.push(
        `ALTER TABLE ${table} MODIFY COLUMN ${col} ${enumType}${nullable}${defaultVal}`
      );
    }

    return statements.join(";\n");
  }

  // ===========================================================================
  // MIGRATION TRACKING TABLE
  // ===========================================================================

  generateCreateTrackingTable(tableName: string): string {
    const table = this.escapeIdentifier(tableName);
    return `CREATE TABLE IF NOT EXISTS ${table} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
  }

  generateInsertMigration(tableName: string): {
    sql: string;
    paramCount: number;
  } {
    const table = this.escapeIdentifier(tableName);
    return {
      sql: `INSERT INTO ${table} (name, checksum) VALUES (?, ?)`,
      paramCount: 2,
    };
  }

  generateDeleteMigration(tableName: string): {
    sql: string;
    paramCount: number;
  } {
    const table = this.escapeIdentifier(tableName);
    return {
      sql: `DELETE FROM ${table} WHERE name = ?`,
      paramCount: 1,
    };
  }

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  generateAcquireLock(lockId: number): string | null {
    // MySQL uses GET_LOCK for advisory locking
    // Returns 1 if lock acquired, 0 if timeout, NULL if error
    return `SELECT GET_LOCK('viborm_migration_${lockId}', 30)`;
  }

  generateReleaseLock(lockId: number): string | null {
    return `SELECT RELEASE_LOCK('viborm_migration_${lockId}')`;
  }

  generateResetSQL(): string[] {
    // MySQL requires disabling foreign key checks to drop tables
    return [
      "SET FOREIGN_KEY_CHECKS = 0",
      // Tables will be dropped programmatically
      "SET FOREIGN_KEY_CHECKS = 1",
    ];
  }

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  generateListTables(): string {
    return `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`;
  }

  generateListEnums(): string | null {
    // MySQL doesn't have standalone enum types
    return null;
  }
}

// Export singleton instance
export const mysqlMigrationDriver = new MySQLMigrationDriver();
