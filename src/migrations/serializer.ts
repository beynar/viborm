/**
 * Model-to-SchemaSnapshot Serializer
 *
 * Converts VibORM model definitions into a database-agnostic SchemaSnapshot
 * that can be compared with the current database state.
 *
 * Database-specific logic is delegated to the MigrationAdapter:
 * - Type mapping (mapFieldType)
 * - Default expressions (getDefaultExpression)
 * - Enum handling (supportsNativeEnums, getEnumColumnType)
 */

import type { MigrationAdapter } from "../adapters/database-adapter";
import type { Field } from "../schema/fields/base";
import type { AnyModel } from "../schema/model";
import type { AnyRelation } from "../schema/relation";
import {
  getJunctionFieldNames,
  getJunctionTableName,
} from "../schema/relation/helpers";
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
    default:
      return "noAction";
  }
}

// =============================================================================
// SERIALIZER
// =============================================================================

export interface SerializeOptions {
  migrationAdapter: MigrationAdapter;
}

/**
 * Serializes a collection of VibORM models into a SchemaSnapshot
 */
export function serializeModels(
  models: Record<string, AnyModel>,
  options: SerializeOptions
): SchemaSnapshot {
  const { migrationAdapter } = options;
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
      // Use model's nameRegistry for column name resolution (supports field reuse)
      const columnName = model["~"].getFieldName(fieldName).sql;

      // Handle enum types (only for databases that support native enums)
      let columnType: string;
      if (fieldState.type === "enum") {
        const enumField = field as any;
        const enumValues = enumField.enumValues as string[] | undefined;

        if (migrationAdapter.supportsNativeEnums && enumValues) {
          // Create native enum type definition
          const enumName = migrationAdapter.getEnumColumnType(
            tableName,
            columnName,
            enumValues
          );
          if (!enumsSet.has(enumName)) {
            enums.push({
              name: enumName,
              values: enumValues,
            });
            enumsSet.add(enumName);
          }
          columnType = enumName;
        } else {
          // Fall back to adapter's default enum column type
          columnType = migrationAdapter.getEnumColumnType(
            tableName,
            columnName,
            enumValues || []
          );
        }
      } else {
        columnType = migrationAdapter.mapFieldType(field as Field, fieldState);
      }

      const columnDef: ColumnDef = {
        name: columnName,
        type: columnType,
        nullable: fieldState.nullable,
        default: migrationAdapter.getDefaultExpression(fieldState),
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
        if (compoundIdSchema?.["~"]) {
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
        if (schema?.["~"]) {
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
        if (targetModel?.["~"]) {
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

  // ==========================================================================
  // JUNCTION TABLES FOR MANY-TO-MANY RELATIONS
  // ==========================================================================
  const junctionTables = new Map<string, TableDef>();

  for (const [modelName, model] of Object.entries(models)) {
    const modelState = model["~"].state;
    const sourceTableName =
      model["~"].names.sql || modelState.tableName || modelName.toLowerCase();

    for (const [relationName, relation] of Object.entries(
      modelState.relations
    )) {
      const relState = (relation as AnyRelation)["~"].state;
      if (relState.type !== "manyToMany") continue;

      const targetModel = relState.getter();
      if (!targetModel?.["~"]) continue;

      // Target model must have hydrated names
      const targetModelName = targetModel["~"].names.ts;
      if (!targetModelName) {
        throw new Error(
          `Target model for relation "${relationName}" has no name. ` +
            "Schema may not be hydrated. Call hydrateSchemaNames() first."
        );
      }

      const targetTableName = targetModel["~"].names.sql;
      if (!targetTableName) {
        throw new Error(
          `Target model "${targetModelName}" has no SQL table name. ` +
            "Schema may not be hydrated. Call hydrateSchemaNames() first."
        );
      }

      // Get junction table name (from .through() or generated)
      const junctionTableName = getJunctionTableName(
        relation as AnyRelation,
        modelName,
        targetModelName
      );

      // Avoid duplicating (post_tag from Post side and from Tag side)
      if (junctionTables.has(junctionTableName)) continue;

      // Get junction field names
      const [sourceFieldName, targetFieldName] = getJunctionFieldNames(
        relation as AnyRelation,
        modelName,
        targetModelName
      );

      // Get PK types from source and target models
      const sourcePkField = getPrimaryKeyFieldDef(model, migrationAdapter);
      const targetPkField = getPrimaryKeyFieldDef(
        targetModel,
        migrationAdapter
      );

      junctionTables.set(junctionTableName, {
        name: junctionTableName,
        columns: [
          {
            name: sourceFieldName,
            type: sourcePkField.type,
            nullable: false,
          },
          {
            name: targetFieldName,
            type: targetPkField.type,
            nullable: false,
          },
        ],
        primaryKey: { columns: [sourceFieldName, targetFieldName] },
        indexes: [],
        foreignKeys: [
          {
            name: `${junctionTableName}_${sourceFieldName}_fkey`,
            columns: [sourceFieldName],
            referencedTable: sourceTableName,
            referencedColumns: [sourcePkField.name],
            onDelete: mapReferentialAction(relState.onDelete),
            onUpdate: mapReferentialAction(relState.onUpdate),
          },
          {
            name: `${junctionTableName}_${targetFieldName}_fkey`,
            columns: [targetFieldName],
            referencedTable: targetTableName,
            referencedColumns: [targetPkField.name],
            onDelete: mapReferentialAction(relState.onDelete),
            onUpdate: mapReferentialAction(relState.onUpdate),
          },
        ],
        uniqueConstraints: [],
      });
    }
  }

  // Append junction tables to the tables array
  tables.push(...junctionTables.values());

  return {
    tables,
    enums: enums.length > 0 ? enums : undefined,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the primary key field definition for a model.
 * Throws if the model uses compound PK (not supported for M2M junction tables).
 */
function getPrimaryKeyFieldDef(
  model: AnyModel,
  migrationAdapter: MigrationAdapter
): { name: string; type: string } {
  const modelState = model["~"].state;
  const modelName = model["~"].names.ts;

  // Compound PKs not supported for junction tables
  if (modelState.compoundId && Object.keys(modelState.compoundId).length > 0) {
    throw new Error(
      `Model "${modelName}" uses compound primary key. ` +
        "Many-to-many relations with compound PKs are not supported. " +
        "Use a single-field surrogate key (e.g., s.string().id().ulid()) instead."
    );
  }

  for (const [fieldName, field] of Object.entries(modelState.scalars)) {
    const fieldState = (field as Field)["~"].state;
    if (fieldState.isId) {
      const columnName = model["~"].getFieldName(fieldName).sql;
      const columnType = migrationAdapter.mapFieldType(
        field as Field,
        fieldState
      );
      return { name: columnName, type: columnType };
    }
  }

  throw new Error(
    `Model "${modelName}" has no primary key field. ` +
      "Schema may not be hydrated."
  );
}

/**
 * Gets the SQL column name for a field using the model's nameRegistry.
 * This supports field reuse across multiple models.
 *
 * @param model - The model containing the field
 * @param fieldName - The field key in the schema
 * @returns The SQL column name
 */
export function getColumnName(model: AnyModel, fieldName: string): string {
  return model["~"].getFieldName(fieldName).sql;
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
