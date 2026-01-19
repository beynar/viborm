/**
 * MigrationDriver Base Class
 *
 * Abstract base class for database-specific migration drivers.
 * Each driver implements DDL generation and introspection for its database.
 */

import type { Field, FieldState } from "@schema/fields";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type {
  ColumnDef,
  DiffOperation,
  ReferentialAction,
  SchemaSnapshot,
} from "../types";
import type { Dialect, MigrationCapabilities } from "./types";

/**
 * Context passed to DDL generation methods.
 * Contains information needed for operations that require knowledge of the current schema.
 */
export interface DDLContext {
  /**
   * Current database schema snapshot.
   * Required for SQLite table recreation operations.
   */
  currentSchema?: SchemaSnapshot;
}

// Extract individual operation types from the DiffOperation union
export type CreateTableOperation = Extract<DiffOperation, { type: "createTable" }>;
export type DropTableOperation = Extract<DiffOperation, { type: "dropTable" }>;
export type RenameTableOperation = Extract<DiffOperation, { type: "renameTable" }>;
export type AddColumnOperation = Extract<DiffOperation, { type: "addColumn" }>;
export type DropColumnOperation = Extract<DiffOperation, { type: "dropColumn" }>;
export type RenameColumnOperation = Extract<DiffOperation, { type: "renameColumn" }>;
export type AlterColumnOperation = Extract<DiffOperation, { type: "alterColumn" }>;
export type CreateIndexOperation = Extract<DiffOperation, { type: "createIndex" }>;
export type DropIndexOperation = Extract<DiffOperation, { type: "dropIndex" }>;
export type AddForeignKeyOperation = Extract<DiffOperation, { type: "addForeignKey" }>;
export type DropForeignKeyOperation = Extract<DiffOperation, { type: "dropForeignKey" }>;
export type AddUniqueConstraintOperation = Extract<DiffOperation, { type: "addUniqueConstraint" }>;
export type DropUniqueConstraintOperation = Extract<DiffOperation, { type: "dropUniqueConstraint" }>;
export type AddPrimaryKeyOperation = Extract<DiffOperation, { type: "addPrimaryKey" }>;
export type DropPrimaryKeyOperation = Extract<DiffOperation, { type: "dropPrimaryKey" }>;
export type CreateEnumOperation = Extract<DiffOperation, { type: "createEnum" }>;
export type DropEnumOperation = Extract<DiffOperation, { type: "dropEnum" }>;
export type AlterEnumOperation = Extract<DiffOperation, { type: "alterEnum" }>;

/**
 * Abstract base class for migration drivers.
 *
 * Each database (PostgreSQL, SQLite, LibSQL, etc.) extends this class
 * to provide database-specific DDL generation and schema introspection.
 */
export abstract class MigrationDriver {
  /**
   * The SQL dialect this driver targets.
   */
  abstract readonly dialect: Dialect;

  /**
   * The specific driver name (e.g., "pg", "postgres", "pglite", "sqlite3", "libsql").
   * Used for driver-specific registration and lookup.
   */
  abstract readonly driverName: string;

  /**
   * Capabilities supported by this driver.
   */
  abstract readonly capabilities: MigrationCapabilities;

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  /**
   * Introspects the current database schema.
   *
   * @param executeRaw - Function to execute raw SQL queries
   * @returns The current schema snapshot
   */
  abstract introspect(
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<SchemaSnapshot>;

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  /**
   * Maps a VibORM field type to the native database column type.
   *
   * @param field - The field definition
   * @param fieldState - The field state with type info
   * @returns The native column type string
   */
  abstract mapFieldType(field: Field, fieldState: FieldState): string;

  // Note: getDefaultExpression is implemented below as a common method
  // Override it in subclasses only if database-specific behavior is needed

  /**
   * Gets the column type for an enum field.
   *
   * @param tableName - The table name
   * @param columnName - The column name
   * @param values - The enum values
   * @returns The column type (e.g., "users_status_enum" for PG, "TEXT" for SQLite)
   */
  abstract getEnumColumnType(
    tableName: string,
    columnName: string,
    values: string[]
  ): string;

  // ===========================================================================
  // DDL GENERATION - Table Operations
  // ===========================================================================

  abstract generateCreateTable(op: CreateTableOperation): string;
  abstract generateDropTable(op: DropTableOperation): string;
  abstract generateRenameTable(op: RenameTableOperation): string;

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  abstract generateAddColumn(op: AddColumnOperation): string;
  abstract generateDropColumn(op: DropColumnOperation): string;
  abstract generateRenameColumn(op: RenameColumnOperation): string;
  abstract generateAlterColumn(op: AlterColumnOperation, context?: DDLContext): string;

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  abstract generateCreateIndex(op: CreateIndexOperation): string;
  abstract generateDropIndex(op: DropIndexOperation): string;

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  abstract generateAddForeignKey(op: AddForeignKeyOperation, context?: DDLContext): string;
  abstract generateDropForeignKey(op: DropForeignKeyOperation, context?: DDLContext): string;

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  abstract generateAddUniqueConstraint(op: AddUniqueConstraintOperation): string;
  abstract generateDropUniqueConstraint(op: DropUniqueConstraintOperation): string;

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations
  // ===========================================================================

  abstract generateAddPrimaryKey(op: AddPrimaryKeyOperation, context?: DDLContext): string;
  abstract generateDropPrimaryKey(op: DropPrimaryKeyOperation, context?: DDLContext): string;

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  abstract generateCreateEnum(op: CreateEnumOperation, context?: DDLContext): string;
  abstract generateDropEnum(op: DropEnumOperation, context?: DDLContext): string;
  abstract generateAlterEnum(op: AlterEnumOperation, context?: DDLContext): string;

  // ===========================================================================
  // HELPER METHODS (can be overridden)
  // ===========================================================================

  /**
   * Escapes an identifier (table name, column name, etc.).
   * Default uses double quotes with proper escaping.
   */
  escapeIdentifier(name: string): string {
    if (name == null) {
      throw new MigrationError(
        "Cannot escape null or undefined identifier",
        VibORMErrorCode.INVALID_INPUT
      );
    }
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  /**
   * Escapes a string value for SQL.
   * Default uses single quotes with proper escaping.
   * Returns "NULL" for null/undefined values.
   */
  escapeValue(value: string | null | undefined): string {
    if (value == null) {
      return "NULL";
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /**
   * Formats a referential action for foreign keys.
   */
  formatReferentialAction(action: ReferentialAction): string {
    switch (action) {
      case "cascade":
        return "CASCADE";
      case "setNull":
        return "SET NULL";
      case "restrict":
        return "RESTRICT";
      case "setDefault":
        return "SET DEFAULT";
      default:
        return "NO ACTION";
    }
  }

  // ===========================================================================
  // COMMON IMPLEMENTATIONS (can be overridden for database-specific behavior)
  // ===========================================================================

  /**
   * Gets the SQL default expression for a field.
   * Common implementation that handles most cases.
   * Override for database-specific behavior (e.g., UUID generation, boolean representation).
   *
   * @param fieldState - The field state
   * @returns SQL default expression or undefined if no default
   */
  getDefaultExpression(fieldState: FieldState): string | undefined {
    // Auto-generated values - check for database-level support first
    if (fieldState.autoGenerate) {
      return this.getAutoGenerateExpression(fieldState.autoGenerate);
    }

    // Check for explicit default value
    if (!fieldState.hasDefault || fieldState.default === undefined) {
      return undefined;
    }

    const defaultVal = fieldState.default;

    // Function defaults are generated at runtime
    if (typeof defaultVal === "function") {
      return undefined;
    }

    // Null default
    if (defaultVal === null) {
      return "NULL";
    }

    // Primitive defaults
    if (typeof defaultVal === "string") {
      return this.escapeValue(defaultVal);
    }
    if (typeof defaultVal === "number") {
      if (!Number.isFinite(defaultVal)) {
        throw new MigrationError(
          `Invalid default value: ${defaultVal} is not a finite number`,
          VibORMErrorCode.INVALID_INPUT
        );
      }
      return String(defaultVal);
    }
    if (typeof defaultVal === "boolean") {
      return this.formatBooleanDefault(defaultVal);
    }

    // Arrays and objects are not supported as SQL defaults
    if (typeof defaultVal === "object") {
      throw new MigrationError(
        "Object/array defaults are not supported as SQL DEFAULT values. " +
          "Use a function default to generate these at runtime.",
        VibORMErrorCode.INVALID_INPUT
      );
    }

    return undefined;
  }

  /**
   * Formats a boolean default value.
   * Override for databases that use different representations (e.g., SQLite uses 1/0).
   */
  protected formatBooleanDefault(value: boolean): string {
    return value ? "true" : "false";
  }

  /**
   * Gets the SQL expression for an auto-generated value.
   * Override for databases that support specific generation functions.
   *
   * By default, returns undefined for all types (handled at application level).
   * PostgreSQL overrides this to use gen_random_uuid() for UUID.
   *
   * @param autoGenerate - The auto-generate type
   * @returns SQL expression or undefined if handled at application level
   */
  protected getAutoGenerateExpression(
    _autoGenerate: FieldState["autoGenerate"]
  ): string | undefined {
    // By default, all auto-generate types are handled at application level
    // Databases can override to provide native support (e.g., gen_random_uuid())
    return undefined;
  }

  /**
   * Validates an index type against supported capabilities.
   * Throws MigrationError if the index type is not supported.
   *
   * @param indexType - The index type to validate (e.g., "btree", "hash", "gin")
   * @param indexName - The index name (for error messages)
   */
  protected validateIndexType(indexType: string | undefined, indexName: string): void {
    if (!indexType) return; // Default index type is always supported

    const supported = this.capabilities.supportsIndexTypes;
    if (!supported.includes(indexType)) {
      throw new MigrationError(
        `Index "${indexName}" uses unsupported index type "${indexType}". ` +
          `Supported types for ${this.dialect}: ${supported.join(", ")}`,
        VibORMErrorCode.FEATURE_NOT_SUPPORTED
      );
    }
  }

  /**
   * Generates a column definition string.
   * Common implementation that can be overridden for database-specific syntax.
   *
   * @param column - The column definition
   * @returns SQL column definition string
   */
  protected generateColumnDef(column: ColumnDef): string {
    const parts: string[] = [this.escapeIdentifier(column.name)];

    // Handle type (may be overridden for auto-increment handling)
    const columnType = this.formatColumnType(column);
    parts.push(columnType);

    // NOT NULL constraint
    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    // DEFAULT clause (skip for auto-increment columns)
    if (column.default !== undefined && !column.autoIncrement) {
      parts.push(`DEFAULT ${column.default}`);
    }

    return parts.join(" ");
  }

  /**
   * Formats the column type, handling auto-increment and other special cases.
   * Override for database-specific type handling (e.g., PostgreSQL SERIAL).
   */
  protected formatColumnType(column: ColumnDef): string {
    return column.type;
  }

  // ===========================================================================
  // MIGRATION TRACKING TABLE
  // ===========================================================================

  /**
   * Generates DDL for creating the migration tracking table.
   * Override for database-specific syntax.
   *
   * @param tableName - The tracking table name (already validated)
   * @returns SQL DDL statement
   */
  abstract generateCreateTrackingTable(tableName: string): string;

  /**
   * Generates SQL for selecting applied migrations.
   *
   * @param tableName - The tracking table name
   * @returns SQL SELECT statement
   */
  generateSelectAppliedMigrations(tableName: string): string {
    const table = this.escapeIdentifier(tableName);
    return `SELECT name, checksum, applied_at FROM ${table} ORDER BY id ASC`;
  }

  /**
   * Generates SQL for inserting a migration record.
   *
   * @param tableName - The tracking table name
   * @returns SQL INSERT statement with placeholders
   */
  abstract generateInsertMigration(tableName: string): { sql: string; paramCount: number };

  /**
   * Generates SQL for deleting a migration record.
   *
   * @param tableName - The tracking table name
   * @returns SQL DELETE statement with placeholders
   */
  abstract generateDeleteMigration(tableName: string): { sql: string; paramCount: number };

  /**
   * Generates SQL for clearing all migration records.
   * Used by reset command.
   *
   * @param tableName - The tracking table name
   * @returns SQL DELETE statement
   */
  generateClearMigrations(tableName: string): string {
    const table = this.escapeIdentifier(tableName);
    return `DELETE FROM ${table}`;
  }

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  /**
   * Generates SQL for acquiring a migration lock.
   * Returns null if locking is handled differently (e.g., SQLite transactions).
   *
   * @param lockId - A numeric lock identifier
   * @returns SQL statement or null
   */
  abstract generateAcquireLock(lockId: number): string | null;

  /**
   * Generates SQL for releasing a migration lock.
   * Returns null if locking is handled differently (e.g., SQLite transactions).
   *
   * @param lockId - A numeric lock identifier
   * @returns SQL statement or null
   */
  abstract generateReleaseLock(lockId: number): string | null;

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  /**
   * Generates SQL for listing all user tables.
   * Used by reset command.
   *
   * @returns SQL SELECT statement that returns rows with 'name' column
   */
  abstract generateListTables(): string;

  /**
   * Generates SQL for listing all enum types.
   * Returns null for databases that don't support enums.
   *
   * @returns SQL SELECT statement or null
   */
  abstract generateListEnums(): string | null;

  /**
   * Generates SQL for dropping a table.
   *
   * @param tableName - The table name
   * @param cascade - Whether to cascade (drop dependent objects)
   * @returns SQL DROP TABLE statement
   */
  generateDropTableSQL(tableName: string, cascade = false): string {
    const table = this.escapeIdentifier(tableName);
    return cascade
      ? `DROP TABLE IF EXISTS ${table} CASCADE`
      : `DROP TABLE IF EXISTS ${table}`;
  }

  /**
   * Generates SQL for dropping an enum type.
   * Returns null for databases that don't support enums.
   *
   * @param enumName - The enum name
   * @returns SQL DROP TYPE statement or null
   */
  generateDropEnumSQL(enumName: string): string | null {
    return null; // Override in PostgreSQL driver
  }

  // ===========================================================================
  // DISPATCH (final - not meant to be overridden)
  // ===========================================================================

  /**
   * Generates DDL for a diff operation.
   * Dispatches to the appropriate generate* method.
   *
   * @param operation - The diff operation
   * @param context - Optional context for operations that need schema info (e.g., SQLite table recreation)
   * @returns SQL DDL statement(s)
   */
  generateDDL(operation: DiffOperation, context?: DDLContext): string {
    switch (operation.type) {
      case "createTable":
        return this.generateCreateTable(operation);
      case "dropTable":
        return this.generateDropTable(operation);
      case "renameTable":
        return this.generateRenameTable(operation);
      case "addColumn":
        return this.generateAddColumn(operation);
      case "dropColumn":
        return this.generateDropColumn(operation);
      case "renameColumn":
        return this.generateRenameColumn(operation);
      case "alterColumn":
        return this.generateAlterColumn(operation, context);
      case "createIndex":
        return this.generateCreateIndex(operation);
      case "dropIndex":
        return this.generateDropIndex(operation);
      case "addForeignKey":
        return this.generateAddForeignKey(operation, context);
      case "dropForeignKey":
        return this.generateDropForeignKey(operation, context);
      case "addUniqueConstraint":
        return this.generateAddUniqueConstraint(operation);
      case "dropUniqueConstraint":
        return this.generateDropUniqueConstraint(operation);
      case "addPrimaryKey":
        return this.generateAddPrimaryKey(operation, context);
      case "dropPrimaryKey":
        return this.generateDropPrimaryKey(operation, context);
      case "createEnum":
        return this.generateCreateEnum(operation, context);
      case "dropEnum":
        return this.generateDropEnum(operation, context);
      case "alterEnum":
        return this.generateAlterEnum(operation, context);
      default:
        throw new MigrationError(
          `Unknown operation type: ${(operation as any).type}`,
          VibORMErrorCode.INTERNAL_ERROR
        );
    }
  }
}
