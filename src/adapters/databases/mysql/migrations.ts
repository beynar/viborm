/**
 * MySQL Migration Adapter (Stub)
 *
 * Migration support for MySQL is not yet implemented.
 */

import type { DiffOperation, SchemaSnapshot } from "../../../migrations/types";
import type { Field } from "../../../schema/fields/base";
import type { FieldState } from "../../../schema/fields/common";
import type { MigrationAdapter } from "../../database-adapter";

const notImplemented = (): never => {
  throw new Error(
    "MySQL migrations are not yet implemented. Please use PostgreSQL."
  );
};

/**
 * Maps VibORM field types to MySQL column types.
 * Note: MySQL doesn't have native array types, TIME WITH TIMEZONE, etc.
 * Arrays are stored as JSON.
 */
function mapFieldType(field: Field, fieldState: FieldState): string {
  const nativeType = field["~"].nativeType;

  // If a native type is specified and it's for MySQL, use it
  if (nativeType && nativeType.db === "mysql") {
    return nativeType.type;
  }

  // MySQL doesn't support native arrays - use JSON for array types
  if (fieldState.array) {
    return "JSON";
  }

  switch (fieldState.type) {
    case "string":
      return "TEXT";
    case "int":
      // AUTO_INCREMENT is handled separately via ColumnDef.autoIncrement flag
      return "INT";
    case "float":
      return "DOUBLE";
    case "decimal":
      // Using DECIMAL with high precision for consistency
      return "DECIMAL(65,30)";
    case "boolean":
      return "TINYINT(1)";
    case "datetime":
      // MySQL DATETIME doesn't store timezone, TIMESTAMP converts to UTC
      // withTimezone: true → TIMESTAMP (stores as UTC), false → DATETIME (stores as-is)
      return fieldState.withTimezone ? "TIMESTAMP" : "DATETIME(3)";
    case "date":
      return "DATE";
    case "time":
      // MySQL TIME doesn't have timezone variant
      return "TIME";
    case "bigint":
      // AUTO_INCREMENT is handled separately via ColumnDef.autoIncrement flag
      return "BIGINT";
    case "json":
      return "JSON";
    case "blob":
      return "LONGBLOB";
    case "enum":
      // Enum type is set via getEnumColumnType, this is a fallback
      return "VARCHAR(255)";
    case "vector":
      // MySQL doesn't have native vector type
      return "JSON";
    case "point":
      return "POINT";
    default:
      return "TEXT";
  }
}

/**
 * Converts a VibORM default value to a MySQL default expression.
 * Note: uuid, now, ulid, nanoid, cuid are always generated at the ORM level
 * for cross-database consistency.
 */
function getDefaultExpression(fieldState: FieldState): string | undefined {
  // Handle auto-generate types - all generated at ORM level for consistency
  if (fieldState.autoGenerate) {
    switch (fieldState.autoGenerate) {
      case "increment":
        // Handled by column type (AUTO_INCREMENT)
        return undefined;
      case "uuid":
      case "now":
      case "updatedAt":
      case "ulid":
      case "nanoid":
      case "cuid":
        // All generated at ORM level for cross-database consistency
        return undefined;
      default:
        return undefined;
    }
  }

  // Handle explicit default value
  if (fieldState.hasDefault && fieldState.default !== undefined) {
    const defaultVal = fieldState.default;

    // Skip function defaults (generated at runtime)
    if (typeof defaultVal === "function") {
      return undefined;
    }

    // Handle null default
    if (defaultVal === null) {
      return "NULL";
    }

    // Handle primitive defaults
    if (typeof defaultVal === "string") {
      return `'${defaultVal.replace(/'/g, "''")}'`;
    }
    if (typeof defaultVal === "number") {
      return String(defaultVal);
    }
    if (typeof defaultVal === "boolean") {
      // MySQL uses 1/0 for booleans
      return defaultVal ? "1" : "0";
    }
  }

  return undefined;
}

/**
 * MySQL supports native ENUM types, but they're column-level (not reusable like PostgreSQL).
 * Returns the full ENUM definition with values.
 */
function getEnumColumnType(
  _tableName: string,
  _columnName: string,
  values: string[]
): string {
  // MySQL ENUM is defined inline: ENUM('value1', 'value2', ...)
  const quotedValues = values
    .map((v) => `'${v.replace(/'/g, "''")}'`)
    .join(", ");
  return `ENUM(${quotedValues})`;
}

export const mysqlMigrations: MigrationAdapter = {
  introspect: async (): Promise<SchemaSnapshot> => notImplemented(),
  generateDDL: (_operation: DiffOperation): string => notImplemented(),
  mapFieldType,
  getDefaultExpression,
  supportsNativeEnums: false,
  getEnumColumnType,
};
