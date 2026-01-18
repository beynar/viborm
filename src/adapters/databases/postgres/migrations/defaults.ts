/**
 * PostgreSQL Default Expression Generation
 *
 * Converts VibORM default values to PostgreSQL default expressions.
 */

import type { FieldState } from "@schema/fields";

/**
 * Converts a VibORM default value to a PostgreSQL default expression.
 * Note: uuid, now, ulid, nanoid, cuid are always generated at the ORM level
 * for cross-database consistency.
 */
export function getDefaultExpression(
  fieldState: FieldState
): string | undefined {
  // Handle auto-generate types - all generated at ORM level for consistency
  if (fieldState.autoGenerate) {
    switch (fieldState.autoGenerate) {
      case "increment":
        // Handled by column type (serial/bigserial)
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
      return defaultVal ? "true" : "false";
    }
  }

  return undefined;
}

/**
 * PostgreSQL supports native enum types via CREATE TYPE ... AS ENUM.
 */
export function getEnumColumnType(
  tableName: string,
  columnName: string,
  _values: string[]
): string {
  return `${tableName}_${columnName}_enum`;
}
