/**
 * PostgreSQL Migration Driver
 *
 * Implements the MigrationDriver interface for PostgreSQL databases.
 * Supports all DDL operations natively.
 */

import type { Field, FieldState } from "@schema/fields";
import type { ColumnDef, SchemaSnapshot } from "../../types";
import { getPostgresType } from "../type-mapping";
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

export class PostgresMigrationDriver extends MigrationDriver {
  readonly dialect = "postgresql" as const;
  readonly driverName = "postgresql";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: true,
    supportsAddEnumValueInTransaction: false,
    supportsIndexTypes: ["btree", "hash", "gin", "gist"],
    supportsNativeArrays: true,
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

    // If a native type is specified and it's for PostgreSQL, use it
    if (nativeType && nativeType.db === "pg") {
      return fieldState.array ? `${nativeType.type}[]` : nativeType.type;
    }

    // Use centralized type mapping
    return getPostgresType({
      type: fieldState.type,
      array: fieldState.array,
      withTimezone: fieldState.withTimezone,
    });
  }

  // getDefaultExpression is inherited from base class
  // PostgreSQL uses "true"/"false" for booleans which is the base default

  /**
   * PostgreSQL supports native UUID generation via gen_random_uuid().
   * This is more efficient than generating UUIDs at the application level.
   */
  protected override getAutoGenerateExpression(
    autoGenerate: import("@schema/fields").FieldState["autoGenerate"]
  ): string | undefined {
    switch (autoGenerate) {
      case "uuid":
        // gen_random_uuid() is available in PostgreSQL 13+ (pgcrypto extension in older versions)
        return "gen_random_uuid()";
      case "now":
        // Use database-level NOW() for consistent timestamps
        return "NOW()";
      default:
        // Other types (ulid, nanoid, cuid, increment, updatedAt) handled elsewhere
        return undefined;
    }
  }

  getEnumColumnType(
    tableName: string,
    columnName: string,
    _values: string[]
  ): string {
    return `${tableName}_${columnName}_enum`;
  }

  // ===========================================================================
  // OVERRIDES: Column Definition Helpers
  // ===========================================================================

  /**
   * Formats the column type for PostgreSQL.
   * Handles SERIAL types for auto-increment and enum type escaping.
   */
  protected override formatColumnType(column: ColumnDef): string {
    // Handle auto-increment with SERIAL types
    if (column.autoIncrement) {
      if (column.type === "integer" || column.type === "int4") {
        return "SERIAL";
      }
      if (column.type === "bigint" || column.type === "int8") {
        return "BIGSERIAL";
      }
      if (column.type === "smallint" || column.type === "int2") {
        return "SMALLSERIAL";
      }
    }

    // Handle enum types (need to be escaped as identifiers)
    if (column.type.endsWith("_enum")) {
      return this.escapeIdentifier(column.type);
    }

    // Handle array of enum types
    if (column.type.endsWith("[]")) {
      const baseType = column.type.slice(0, -2);
      if (baseType.endsWith("_enum")) {
        return `${this.escapeIdentifier(baseType)}[]`;
      }
    }

    return column.type;
  }

  // ===========================================================================
  // DDL GENERATION - Table Operations
  // ===========================================================================

  generateCreateTable(op: CreateTableOperation): string {
    const { table } = op;
    const columnDefs = table.columns.map((col) => this.generateColumnDef(col));

    if (table.primaryKey) {
      const pkCols = table.primaryKey.columns
        .map((c) => this.escapeIdentifier(c))
        .join(", ");
      const pkName = table.primaryKey.name
        ? `CONSTRAINT ${this.escapeIdentifier(table.primaryKey.name)} `
        : "";
      columnDefs.push(`${pkName}PRIMARY KEY (${pkCols})`);
    }

    for (const uq of table.uniqueConstraints) {
      const uqCols = uq.columns.map((c) => this.escapeIdentifier(c)).join(", ");
      columnDefs.push(
        `CONSTRAINT ${this.escapeIdentifier(uq.name)} UNIQUE (${uqCols})`
      );
    }

    const sql = `CREATE TABLE ${this.escapeIdentifier(table.name)} (\n  ${columnDefs.join(",\n  ")}\n)`;

    const statements = [sql];

    for (const idx of table.indexes) {
      statements.push(
        this.generateCreateIndex({ type: "createIndex", tableName: table.name, index: idx })
      );
    }

    for (const fk of table.foreignKeys) {
      statements.push(
        this.generateAddForeignKey({ type: "addForeignKey", tableName: table.name, fk })
      );
    }

    return statements.join(";\n");
  }

  generateDropTable(op: DropTableOperation): string {
    return `DROP TABLE ${this.escapeIdentifier(op.tableName)} CASCADE`;
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
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP COLUMN ${this.escapeIdentifier(op.columnName)}`;
  }

  generateRenameColumn(op: RenameColumnOperation): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} RENAME COLUMN ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`;
  }

  generateAlterColumn(op: AlterColumnOperation, _context?: DDLContext): string {
    const { tableName, columnName, from, to } = op;
    const statements: string[] = [];
    const table = this.escapeIdentifier(tableName);
    const col = this.escapeIdentifier(columnName);

    if (from.type !== to.type) {
      statements.push(
        `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${to.type} USING ${col}::${to.type}`
      );
    }

    if (from.nullable !== to.nullable) {
      if (to.nullable) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`);
      } else {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`);
      }
    }

    if (from.default !== to.default) {
      if (to.default === undefined) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`);
      } else {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${to.default}`);
      }
    }

    return statements.join(";\n");
  }

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  generateCreateIndex(op: CreateIndexOperation): string {
    const { tableName, index } = op;

    // Validate index type against capabilities
    this.validateIndexType(index.type, index.name);

    const unique = index.unique ? "UNIQUE " : "";
    const indexType = index.type ? `USING ${index.type} ` : "";
    const cols = index.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    const where = index.where ? ` WHERE ${index.where}` : "";
    return `CREATE ${unique}INDEX ${this.escapeIdentifier(index.name)} ON ${this.escapeIdentifier(tableName)} ${indexType}(${cols})${where}`;
  }

  generateDropIndex(op: DropIndexOperation): string {
    return `DROP INDEX ${this.escapeIdentifier(op.indexName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  generateAddForeignKey(op: AddForeignKeyOperation, _context?: DDLContext): string {
    const { tableName, fk } = op;
    const cols = fk.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    const refCols = fk.referencedColumns.map((c) => this.escapeIdentifier(c)).join(", ");
    const onDelete = fk.onDelete ? ` ON DELETE ${this.formatReferentialAction(fk.onDelete)}` : "";
    const onUpdate = fk.onUpdate ? ` ON UPDATE ${this.formatReferentialAction(fk.onUpdate)}` : "";
    return `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${this.escapeIdentifier(fk.referencedTable)} (${refCols})${onDelete}${onUpdate}`;
  }

  generateDropForeignKey(op: DropForeignKeyOperation, _context?: DDLContext): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP CONSTRAINT ${this.escapeIdentifier(op.fkName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  generateAddUniqueConstraint(op: AddUniqueConstraintOperation): string {
    const { tableName, constraint } = op;
    const cols = constraint.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    return `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(constraint.name)} UNIQUE (${cols})`;
  }

  generateDropUniqueConstraint(op: DropUniqueConstraintOperation): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP CONSTRAINT ${this.escapeIdentifier(op.constraintName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations
  // ===========================================================================

  generateAddPrimaryKey(op: AddPrimaryKeyOperation, _context?: DDLContext): string {
    const { tableName, primaryKey } = op;
    const cols = primaryKey.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    const name = primaryKey.name
      ? this.escapeIdentifier(primaryKey.name)
      : this.escapeIdentifier(`${tableName}_pkey`);
    return `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${name} PRIMARY KEY (${cols})`;
  }

  generateDropPrimaryKey(op: DropPrimaryKeyOperation, _context?: DDLContext): string {
    return `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP CONSTRAINT ${this.escapeIdentifier(op.constraintName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  generateCreateEnum(op: CreateEnumOperation, _context?: DDLContext): string {
    const { enumDef } = op;
    const values = enumDef.values.map((v) => this.escapeValue(v)).join(", ");
    return `CREATE TYPE ${this.escapeIdentifier(enumDef.name)} AS ENUM (${values})`;
  }

  generateDropEnum(op: DropEnumOperation, _context?: DDLContext): string {
    return `DROP TYPE ${this.escapeIdentifier(op.enumName)}`;
  }

  // ===========================================================================
  // MIGRATION TRACKING TABLE
  // ===========================================================================

  generateCreateTrackingTable(tableName: string): string {
    const table = this.escapeIdentifier(tableName);
    return `CREATE TABLE IF NOT EXISTS ${table} (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
)`;
  }

  generateInsertMigration(tableName: string): { sql: string; paramCount: number } {
    const table = this.escapeIdentifier(tableName);
    return {
      sql: `INSERT INTO ${table} (name, checksum) VALUES ($1, $2)`,
      paramCount: 2,
    };
  }

  generateDeleteMigration(tableName: string): { sql: string; paramCount: number } {
    const table = this.escapeIdentifier(tableName);
    return {
      sql: `DELETE FROM ${table} WHERE name = $1`,
      paramCount: 1,
    };
  }

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  generateAcquireLock(lockId: number): string | null {
    return `SELECT pg_advisory_lock(${lockId})`;
  }

  generateReleaseLock(lockId: number): string | null {
    return `SELECT pg_advisory_unlock(${lockId})`;
  }

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  generateListTables(): string {
    return `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  }

  generateListEnums(): string | null {
    return `SELECT t.typname AS name
      FROM pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = 'public'
      ORDER BY t.typname`;
  }

  override generateDropEnumSQL(enumName: string): string | null {
    return `DROP TYPE IF EXISTS ${this.escapeIdentifier(enumName)} CASCADE`;
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  generateAlterEnum(op: AlterEnumOperation, _context?: DDLContext): string {
    const {
      enumName,
      addValues,
      removeValues,
      newValues,
      dependentColumns,
      valueReplacements,
    } = op;
    const statements: string[] = [];

    // Simple case: only adding values
    if (addValues && (!removeValues || removeValues.length === 0)) {
      for (const value of addValues) {
        statements.push(
          `ALTER TYPE ${this.escapeIdentifier(enumName)} ADD VALUE ${this.escapeValue(value)}`
        );
      }
      return statements.join(";\n");
    }

    // Complex case: removing values requires enum recreation
    if (removeValues && removeValues.length > 0) {
      if (!newValues || newValues.length === 0) {
        throw new Error(
          `Cannot alter enum "${enumName}": newValues required when removing values`
        );
      }

      // Step 1: Convert dependent columns to text
      if (dependentColumns && dependentColumns.length > 0) {
        for (const { tableName, columnName } of dependentColumns) {
          statements.push(
            `ALTER TABLE ${this.escapeIdentifier(tableName)} ALTER COLUMN ${this.escapeIdentifier(columnName)} TYPE text`
          );
        }
      }

      // Step 2: Migrate data for removed values
      if (dependentColumns && dependentColumns.length > 0) {
        for (const removedValue of removeValues) {
          let replacement: string | null | undefined;
          if (valueReplacements && removedValue in valueReplacements) {
            replacement = valueReplacements[removedValue];
          } else if (op.defaultReplacement !== undefined) {
            replacement = op.defaultReplacement;
          }

          if (replacement !== undefined) {
            for (const { tableName, columnName } of dependentColumns) {
              const newValue = replacement === null ? "NULL" : this.escapeValue(replacement);
              statements.push(
                `UPDATE ${this.escapeIdentifier(tableName)} SET ${this.escapeIdentifier(columnName)} = ${newValue} WHERE ${this.escapeIdentifier(columnName)} = ${this.escapeValue(removedValue)}`
              );
            }
          }
        }
      }

      // Step 3: Drop old enum
      statements.push(`DROP TYPE ${this.escapeIdentifier(enumName)}`);

      // Step 4: Create new enum
      const values = newValues.map((v) => this.escapeValue(v)).join(", ");
      statements.push(
        `CREATE TYPE ${this.escapeIdentifier(enumName)} AS ENUM (${values})`
      );

      // Step 5: Convert columns back to enum
      const unreplacedValues = removeValues.filter((v) => {
        const hasExplicit = valueReplacements && v in valueReplacements;
        const hasDefault = op.defaultReplacement !== undefined;
        return !(hasExplicit || hasDefault);
      });

      if (unreplacedValues.length > 0 && dependentColumns?.length) {
        const valuesList = unreplacedValues.map((v) => `'${v}'`).join(", ");
        statements.push(
          `-- WARNING: The following removed values have no replacement: ${valuesList}\n` +
            "-- If rows exist with these values, the migration will fail.\n" +
            "-- To fix this, do one of the following:\n" +
            `--   1. Add valueReplacements: { "${unreplacedValues[0]}": "newValue" }\n` +
            "--   2. Set defaultReplacement to your field's default value"
        );
      }

      if (dependentColumns && dependentColumns.length > 0) {
        for (const { tableName, columnName } of dependentColumns) {
          statements.push(
            `ALTER TABLE ${this.escapeIdentifier(tableName)} ALTER COLUMN ${this.escapeIdentifier(columnName)} TYPE ${this.escapeIdentifier(enumName)} USING ${this.escapeIdentifier(columnName)}::${this.escapeIdentifier(enumName)}`
          );
        }
      }
    }

    return statements.join(";\n");
  }
}

// Export singleton instance
export const postgresMigrationDriver = new PostgresMigrationDriver();
