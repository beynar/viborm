/**
 * PostgreSQL Field Type Mapping
 *
 * Maps ORM field types to PostgreSQL native types.
 */

import type { Field, FieldState } from "@schema/fields";

/**
 * Maps VibORM field types to PostgreSQL column types.
 * Uses full field state to access properties like withTimezone, autoGenerate, etc.
 */
export function mapFieldType(field: Field, fieldState: FieldState): string {
  const nativeType = field["~"].nativeType;

  // If a native type is specified and it's for PostgreSQL, use it
  if (nativeType && nativeType.db === "pg") {
    return fieldState.array ? `${nativeType.type}[]` : nativeType.type;
  }

  // Default mappings based on field type
  let baseType: string;

  switch (fieldState.type) {
    case "string":
      baseType = "text";
      break;
    case "int":
      // AUTO_INCREMENT (serial) is handled by DDL generator via ColumnDef.autoIncrement
      baseType = "integer";
      break;
    case "float":
      baseType = "double precision";
      break;
    case "decimal":
      baseType = "numeric";
      break;
    case "boolean":
      baseType = "boolean";
      break;
    case "datetime":
      // withTimezone: true → timestamptz, false/undefined → timestamp
      baseType = fieldState.withTimezone ? "timestamptz" : "timestamp";
      break;
    case "date":
      baseType = "date";
      break;
    case "time":
      // withTimezone: true → timetz, false/undefined → time
      baseType = fieldState.withTimezone ? "timetz" : "time";
      break;
    case "bigint":
      // AUTO_INCREMENT (bigserial) is handled by DDL generator via ColumnDef.autoIncrement
      baseType = "bigint";
      break;
    case "json":
      baseType = "jsonb";
      break;
    case "blob":
      baseType = "bytea";
      break;
    case "vector":
      baseType = "vector";
      break;
    case "point":
      baseType = "point";
      break;
    case "enum":
      // Enum type is set via getEnumColumnType, this is a fallback
      baseType = "text";
      break;
    default:
      baseType = "text";
  }

  return fieldState.array ? `${baseType}[]` : baseType;
}
