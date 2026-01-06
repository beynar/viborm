/**
 * Model-to-SchemaSnapshot Serializer
 *
 * Converts VibORM model definitions into a database-agnostic SchemaSnapshot
 * that can be compared with the current database state.
 */

import type { Dialect } from "../drivers/types";
import type { Field } from "../schema/fields/base";
import type { FieldState } from "../schema/fields/common";
import type { AnyModel } from "../schema/model";
import type { AnyRelation } from "../schema/relation";
import type {
  ColumnDef,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "./types";

// =============================================================================
// TYPE MAPPING
// =============================================================================

/**
 * Maps VibORM field types to PostgreSQL column types
 */
function mapFieldTypeToPostgres(field: Field, fieldState: FieldState): string {
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
      baseType = fieldState.autoGenerate === "increment" ? "serial" : "integer";
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
      baseType = "timestamptz";
      break;
    case "date":
      baseType = "date";
      break;
    case "time":
      baseType = "time";
      break;
    case "bigint":
      baseType =
        fieldState.autoGenerate === "increment" ? "bigserial" : "bigint";
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
      // Enum fields need special handling - we'll use the enum name
      baseType = "text"; // Will be overridden by enum handling
      break;
    default:
      baseType = "text";
  }

  return fieldState.array ? `${baseType}[]` : baseType;
}

/**
 * Maps VibORM field types to MySQL column types
 */
function mapFieldTypeToMySQL(field: Field, fieldState: FieldState): string {
  const nativeType = field["~"].nativeType;

  if (nativeType && nativeType.db === "mysql") {
    // MySQL doesn't have native array types
    return nativeType.type;
  }

  switch (fieldState.type) {
    case "string":
      return "TEXT";
    case "int":
      return fieldState.autoGenerate === "increment"
        ? "INT AUTO_INCREMENT"
        : "INT";
    case "float":
      return "DOUBLE";
    case "decimal":
      return "DECIMAL(65,30)";
    case "boolean":
      return "TINYINT(1)";
    case "datetime":
      return "DATETIME(3)";
    case "date":
      return "DATE";
    case "time":
      return "TIME";
    case "bigint":
      return fieldState.autoGenerate === "increment"
        ? "BIGINT AUTO_INCREMENT"
        : "BIGINT";
    case "json":
      return "JSON";
    case "blob":
      return "LONGBLOB";
    case "enum":
      return "VARCHAR(255)";
    default:
      return "TEXT";
  }
}

/**
 * Maps VibORM field types to SQLite column types
 */
function mapFieldTypeToSQLite(field: Field, fieldState: FieldState): string {
  const nativeType = field["~"].nativeType;

  if (nativeType && nativeType.db === "sqlite") {
    return nativeType.type;
  }

  switch (fieldState.type) {
    case "string":
    case "enum":
    case "json":
      return "TEXT";
    case "int":
    case "bigint":
    case "boolean":
      return "INTEGER";
    case "float":
    case "decimal":
      return "REAL";
    case "datetime":
    case "date":
    case "time":
      return "TEXT";
    case "blob":
      return "BLOB";
    default:
      return "TEXT";
  }
}

/**
 * Maps VibORM field type to SQL type based on dialect
 */
export function mapFieldType(
  field: Field,
  fieldState: FieldState,
  dialect: Dialect
): string {
  switch (dialect) {
    case "postgresql":
      return mapFieldTypeToPostgres(field, fieldState);
    case "mysql":
      return mapFieldTypeToMySQL(field, fieldState);
    case "sqlite":
      return mapFieldTypeToSQLite(field, fieldState);
    default:
      return mapFieldTypeToPostgres(field, fieldState);
  }
}

// =============================================================================
// DEFAULT VALUE HANDLING
// =============================================================================

/**
 * Converts a VibORM default value to a SQL default expression
 */
function getDefaultExpression(
  fieldState: FieldState,
  dialect: Dialect
): string | undefined {
  // Handle auto-generate types
  if (fieldState.autoGenerate) {
    switch (fieldState.autoGenerate) {
      case "increment":
        // Handled by column type (serial/bigserial in PG, AUTO_INCREMENT in MySQL)
        return undefined;
      case "uuid":
        if (dialect === "postgresql") return "gen_random_uuid()";
        return undefined; // Generated in application
      case "now":
        if (dialect === "postgresql") return "now()";
        if (dialect === "mysql") return "CURRENT_TIMESTAMP";
        return "CURRENT_TIMESTAMP";
      case "updatedAt":
        // This is typically handled via triggers or application logic
        return undefined;
      case "ulid":
      case "nanoid":
      case "cuid":
        // These are generated in the application
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
      if (dialect === "postgresql") return defaultVal ? "true" : "false";
      if (dialect === "mysql") return defaultVal ? "1" : "0";
      return defaultVal ? "1" : "0";
    }
  }

  return undefined;
}

// =============================================================================
// REFERENTIAL ACTION MAPPING
// =============================================================================

function mapReferentialAction(
  action: "cascade" | "setNull" | "restrict" | "noAction" | undefined
): ReferentialAction {
  switch (action) {
    case "cascade":
      return "cascade";
    case "setNull":
      return "setNull";
    case "restrict":
      return "restrict";
    case "noAction":
    default:
      return "noAction";
  }
}

// =============================================================================
// SERIALIZER
// =============================================================================

export interface SerializeOptions {
  dialect: Dialect;
}

/**
 * Serializes a collection of VibORM models into a SchemaSnapshot
 */
export function serializeModels(
  models: Record<string, AnyModel>,
  options: SerializeOptions
): SchemaSnapshot {
  const { dialect } = options;
  const tables: TableDef[] = [];
  const enums: EnumDef[] = [];
  const enumsSet = new Set<string>();

  for (const [modelName, model] of Object.entries(models)) {
    const modelState = model["~"].state;
    const tableName =
      model["~"].names.sql || modelState.tableName || modelName.toLowerCase();

    const columns: ColumnDef[] = [];
    const indexes: IndexDef[] = [];
    const foreignKeys: ForeignKeyDef[] = [];
    const uniqueConstraints: UniqueConstraintDef[] = [];
    let primaryKey: PrimaryKeyDef | undefined;
    const pkColumns: string[] = [];

    // Process scalar fields
    for (const [fieldName, field] of Object.entries(modelState.scalars)) {
      const fieldState = (field as Field)["~"].state;
      const columnName =
        (field as Field)["~"].names.sql || fieldState.columnName || fieldName;

      // Handle enum types for PostgreSQL
      if (fieldState.type === "enum" && dialect === "postgresql") {
        const enumField = field as any;
        if (enumField.values && Array.isArray(enumField.values)) {
          const enumName = `${tableName}_${columnName}_enum`;
          if (!enumsSet.has(enumName)) {
            enums.push({
              name: enumName,
              values: enumField.values,
            });
            enumsSet.add(enumName);
          }
        }
      }

      const columnDef: ColumnDef = {
        name: columnName,
        type:
          fieldState.type === "enum" && dialect === "postgresql"
            ? `${tableName}_${columnName}_enum`
            : mapFieldType(field as Field, fieldState, dialect),
        nullable: fieldState.nullable,
        default: getDefaultExpression(fieldState, dialect),
        autoIncrement: fieldState.autoGenerate === "increment",
      };

      columns.push(columnDef);

      // Track primary key columns
      if (fieldState.isId) {
        pkColumns.push(columnName);
      }

      // Handle unique constraints on individual fields
      if (fieldState.isUnique && !fieldState.isId) {
        uniqueConstraints.push({
          name: `${tableName}_${columnName}_key`,
          columns: [columnName],
        });
      }
    }

    // Handle compound primary key
    if (modelState.compoundId) {
      const compoundIdKeys = Object.keys(modelState.compoundId);
      if (compoundIdKeys.length > 0) {
        // The compound ID name contains the field names
        const firstKey = compoundIdKeys[0]!;
        // Extract field names from the compound ID schema
        const compoundIdSchema = modelState.compoundId[firstKey];
        if (compoundIdSchema && compoundIdSchema["~"]) {
          const schemaState = compoundIdSchema["~"];
          if (schemaState.def && typeof schemaState.def === "object") {
            pkColumns.push(...Object.keys(schemaState.def));
          }
        }
      }
    }

    // Set primary key
    if (pkColumns.length > 0) {
      primaryKey = {
        columns: pkColumns,
        name: `${tableName}_pkey`,
      };
    }

    // Handle compound unique constraints
    if (modelState.compoundUniques) {
      for (const [constraintName, schema] of Object.entries(
        modelState.compoundUniques
      )) {
        if (schema && schema["~"]) {
          const schemaState = schema["~"];
          if (schemaState.def && typeof schemaState.def === "object") {
            uniqueConstraints.push({
              name: `${tableName}_${constraintName}_key`,
              columns: Object.keys(schemaState.def),
            });
          }
        }
      }
    }

    // Process indexes from model state
    for (const indexDef of modelState.indexes) {
      const indexName =
        indexDef.options.name ||
        `${tableName}_${indexDef.fields.join("_")}_idx`;
      indexes.push({
        name: indexName,
        columns: indexDef.fields,
        unique: indexDef.options.unique,
        type: indexDef.options.type,
        where: indexDef.options.where,
      });
    }

    // Process relations to generate foreign keys
    for (const [relationName, relation] of Object.entries(
      modelState.relations
    )) {
      const relationState = (relation as AnyRelation)["~"].state;

      // Only process manyToOne and oneToOne relations that define foreign keys
      if (
        (relationState.type === "manyToOne" ||
          relationState.type === "oneToOne") &&
        relationState.fields &&
        relationState.references
      ) {
        // Get the target model
        const targetModel = relationState.getter();
        if (targetModel && targetModel["~"]) {
          const targetModelState = targetModel["~"].state;
          const targetTableName =
            targetModel["~"].names.sql ||
            targetModelState.tableName ||
            relationName.toLowerCase();

          foreignKeys.push({
            name: `${tableName}_${relationState.fields.join("_")}_fkey`,
            columns: relationState.fields,
            referencedTable: targetTableName,
            referencedColumns: relationState.references,
            onDelete: mapReferentialAction(relationState.onDelete),
            onUpdate: mapReferentialAction(relationState.onUpdate),
          });
        }
      }
    }

    tables.push({
      name: tableName,
      columns,
      primaryKey,
      indexes,
      foreignKeys,
      uniqueConstraints,
    });
  }

  return {
    tables,
    enums: enums.length > 0 ? enums : undefined,
  };
}

/**
 * Gets the SQL column name for a field
 */
export function getColumnName(field: Field, fieldName: string): string {
  return field["~"].names.sql || field["~"].state.columnName || fieldName;
}

/**
 * Gets the SQL table name for a model
 */
export function getTableName(model: AnyModel, modelName: string): string {
  return (
    model["~"].names.sql ||
    model["~"].state.tableName ||
    modelName.toLowerCase()
  );
}
