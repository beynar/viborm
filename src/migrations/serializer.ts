/**
 * Model-to-SchemaSnapshot Serializer
 *
 * Converts VibORM model definitions into a database-agnostic SchemaSnapshot
 * that can be compared with the current database state.
 *
 * Database-specific logic is delegated to the MigrationDriver:
 * - Type mapping (mapScalarType)
 * - Default expressions (getDefaultExpression)
 * - Enum handling (capabilities.supportsNativeEnums, getEnumColumnType)
 */

import {
  type AnyModel,
  getModelKeyCatalog,
  getTableName as getModelTableName,
  type ModelState,
} from "../schema/model";
import type { AnyRelation } from "../schema/relation";
import {
  findPairedManyToManyState,
  getJunctionConstraintName,
  getJunctionFieldGroups,
  getJunctionTableName,
  junctionSourceSideIsFirst,
} from "../schema/relation/helpers";
import type { Scalar } from "../schema/scalars/base";
import type { MigrationDriver } from "./drivers";
import type {
  ColumnDef,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PolymorphicSnapshotMember,
  PolymorphicSnapshotStorage,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "./types";

// =============================================================================
// REFERENTIAL ACTION MAPPING
// =============================================================================

/**
 * A partial index holds only the rows its predicate keeps. It cannot answer a
 * lookup for an excluded row, and its UNIQUE cannot constrain one — so it is
 * neither coverage for the foreign-key index nor uniqueness for a 1:1 relation.
 * Truthiness, because that is what the emitters use to decide whether to write
 * the WHERE at all (`postgres/index.ts`, `sqlite/index.ts`).
 */
function isTotalIndex(index: { where?: string | undefined }): boolean {
  return !index.where;
}

function mapReferentialAction(
  action: "cascade" | "setNull" | "restrict" | "noAction" | undefined,
  fallback: ReferentialAction
): ReferentialAction {
  switch (action) {
    case "cascade":
      return "cascade";
    case "setNull":
      return "setNull";
    case "restrict":
      return "restrict";
    case "noAction":
      return "noAction";
    default:
      return fallback;
  }
}

// =============================================================================
// SERIALIZER
// =============================================================================

export interface SerializeOptions {
  migrationDriver: MigrationDriver;
}

/**
 * Serializes a collection of VibORM models into a SchemaSnapshot
 */
export function serializeModels(
  models: Record<string, AnyModel>,
  options: SerializeOptions
): SchemaSnapshot {
  const { migrationDriver } = options;
  const tables: TableDef[] = [];
  const enums: EnumDef[] = [];
  const enumsSet = new Set<string>();
  const polymorphicStorage: PolymorphicSnapshotStorage[] = [];

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

    // Process scalars
    for (const [fieldName, scalar] of Object.entries(modelState.scalars)) {
      const scalarState = (scalar as Scalar)["~"].state;
      // Use model's nameRegistry for column name resolution (supports field reuse)
      const columnName = model["~"].getFieldName(fieldName).sql;

      // Handle enum types (only for databases that support native enums)
      let columnType: string;
      if (scalarState.type === "enum") {
        const enumScalar = scalar as any;
        const enumValues = enumScalar.enumValues as string[] | undefined;

        if (migrationDriver.capabilities.supportsNativeEnums && enumValues) {
          // Use explicit enum name if provided, otherwise auto-generate
          const enumName = scalarState.enumName
            ? scalarState.enumName
            : migrationDriver.getEnumColumnType(
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
          // Fall back to driver's default enum column type
          columnType = migrationDriver.getEnumColumnType(
            tableName,
            columnName,
            enumValues || []
          );
        }
      } else {
        columnType = migrationDriver.mapScalarType(
          scalar as Scalar,
          scalarState
        );
      }

      const columnDef: ColumnDef = {
        name: columnName,
        type: columnType,
        nullable: scalarState.nullable,
        default: migrationDriver.getDefaultExpression(scalarState),
        autoIncrement: scalarState.autoGenerate === "increment",
      };

      columns.push(columnDef);

      // Track primary key columns
      if (scalarState.isId) {
        pkColumns.push(columnName);
      }

      // Handle unique constraints on individual fields
      if (scalarState.isUnique && !scalarState.isId) {
        uniqueConstraints.push({
          name: `${tableName}_${columnName}_key`,
          columns: [columnName],
        });
      }
    }

    // Handle compound primary key
    if (modelState.compoundId) {
      const firstKey = Object.keys(modelState.compoundId)[0];
      const compoundIdSchema = firstKey
        ? modelState.compoundId[firstKey]
        : undefined;
      if (compoundIdSchema?.entries) {
        pkColumns.push(
          ...Object.keys(compoundIdSchema.entries).map(
            (field) => model["~"].getFieldName(field).sql
          )
        );
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
    const compoundUniques: ModelState["compoundUniques"] =
      modelState.compoundUniques;
    if (compoundUniques) {
      for (const [constraintName, schema] of Object.entries(compoundUniques)) {
        if (schema?.entries) {
          uniqueConstraints.push({
            name: `${tableName}_${constraintName}_key`,
            columns: Object.keys(schema.entries).map(
              (field) => model["~"].getFieldName(field).sql
            ),
          });
        }
      }
    }

    // Process indexes from model state
    const declaredIndexColumns: string[][] = [];
    for (const indexDef of modelState.indexes) {
      const indexName =
        indexDef.options.name ||
        `${tableName}_${indexDef.fields.join("_")}_idx`;
      // `.map()` renames the column, so the DDL has to name the column and not
      // the TypeScript field — the same resolution the compound uniques and the
      // FK columns already do. One resolution serves both readers: the CREATE
      // INDEX below, and the foreign-key index's coverage decision, which has
      // to compare the same names or it emits a duplicate index.
      const columns = indexDef.fields.map(
        (field) => model["~"].getFieldName(field).sql
      );
      const declared: IndexDef = {
        name: indexName,
        columns,
        unique: indexDef.options.unique,
        type: indexDef.options.type,
        where: indexDef.options.where,
      };
      indexes.push(declared);
      if (isTotalIndex(declared)) {
        declaredIndexColumns.push(columns);
      }
    }

    // Polymorphic storage is relation-owned, so it never appears in the public
    // scalar map. Its cached descriptor is the single source for the two
    // private columns, their index, and generated-file member history.
    for (const storage of model["~"].polymorphicStorage.values()) {
      const typeScalarState = storage.typeColumn.scalar["~"].state;
      const idScalarState = storage.idColumn.scalar["~"].state;
      columns.push(
        {
          name: storage.typeColumn.name,
          type: migrationDriver.mapScalarType(
            storage.typeColumn.scalar,
            typeScalarState
          ),
          nullable: storage.typeColumn.nullable,
        },
        {
          name: storage.idColumn.name,
          type: migrationDriver.mapScalarType(
            storage.idColumn.scalar,
            idScalarState
          ),
          nullable: storage.idColumn.nullable,
        }
      );
      indexes.push({
        name: storage.indexName,
        columns: [storage.typeColumn.name, storage.idColumn.name],
        unique: storage.inverseCardinality === "one",
      });

      const members: PolymorphicSnapshotMember[] = [];
      for (const [publicType, member] of storage.members) {
        const targetModelName = member.targetModel["~"].names.ts;
        members.push({
          publicType,
          storedType: member.storedType,
          targetTable: getModelTableName(
            member.targetModel,
            targetModelName?.toLowerCase() ?? "unknown"
          ),
          referencedColumn: member.targetModel["~"].getFieldName(
            member.referencedField
          ).sql,
        });
      }
      polymorphicStorage.push({
        ownerTable: tableName,
        relation: storage.relationName,
        typeColumn: storage.typeColumn.name,
        idColumn: storage.idColumn.name,
        members,
      });
    }

    // A `oneToOne` foreign key gets a unique constraint at the bottom of the
    // relation loop, and that constraint is an index — so it covers the
    // foreign-key index exactly as a declared unique does. It is collected HERE,
    // before the loop, because `uniqueConstraints` grows INSIDE it: one model may
    // name the same columns from a `manyToOne` and from a `oneToOne` (legal, and
    // measured through `serializeModels`), and reading the half-built list made
    // the answer depend on which relation the schema happened to spell first —
    // `many` before `one` emitted the redundant index, `one` before `many` did
    // not. The condition mirrors the branch that pushes the constraint, target
    // model included, so this claims coverage only where the constraint follows.
    const oneToOneFkColumns: string[][] = [];
    for (const relation of Object.values(modelState.relations)) {
      const oneToOneState = (relation as AnyRelation)["~"].state;
      if (
        oneToOneState.type === "oneToOne" &&
        oneToOneState.fields &&
        oneToOneState.references &&
        oneToOneState.getter()?.["~"]
      ) {
        oneToOneFkColumns.push(
          oneToOneState.fields.map(
            (field: string) => model["~"].getFieldName(field).sql
          )
        );
      }
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

          // Resolve TS field names to actual column names (.map() support)
          const fkColumns = relationState.fields.map(
            (field: string) => model["~"].getFieldName(field).sql
          );
          const referencedColumns = relationState.references.map(
            (field: string) => targetModel["~"].getFieldName(field).sql
          );

          // Prisma parity: without an explicit .onDelete(), optional to-one
          // relations (all FK scalars nullable) default to SET NULL and
          // required ones to RESTRICT, so deletes behave identically across
          // databases (MySQL checks self-referencing FKs row-by-row where
          // PG/SQLite validate at statement end).
          const fkNullable = relationState.fields.every((field: string) => {
            const fkScalar = modelState.scalars[field] as Scalar | undefined;
            return fkScalar?.["~"].state.nullable === true;
          });
          const defaultOnDelete: ReferentialAction = fkNullable
            ? "setNull"
            : "restrict";

          foreignKeys.push({
            name: `${tableName}_${fkColumns.join("_")}_fkey`,
            columns: fkColumns,
            referencedTable: targetTableName,
            referencedColumns,
            onDelete: mapReferentialAction(
              relationState.onDelete,
              defaultOnDelete
            ),
            onUpdate: mapReferentialAction(relationState.onUpdate, "noAction"),
          });

          // The inverse of a manyToOne is to-many: every include, relation
          // filter and nested-write locate reads this table through the FK
          // columns. MySQL/InnoDB indexes an FK constraint by itself;
          // PostgreSQL and SQLite do not, so serialize the index on every
          // dialect — one snapshot shape for the differ, and on MySQL the
          // explicit index takes the place of the implicit one. A oneToOne FK
          // needs nothing here: the unique constraint below is its index.
          if (relationState.type === "manyToOne") {
            // The primary key, every unique constraint and every declared index
            // is backed by an index on all three dialects, and an index serves
            // any prefix of its columns — so a FK index over such a prefix
            // would only duplicate one the database already has.
            const coveringColumns = [
              pkColumns,
              ...uniqueConstraints.map((unique) => unique.columns),
              ...oneToOneFkColumns,
              ...declaredIndexColumns,
            ];
            const alreadyIndexed = coveringColumns.some((columns) =>
              fkColumns.every(
                (column, position) => columns[position] === column
              )
            );
            if (!alreadyIndexed) {
              // An index the schema declares over exactly these columns but
              // does not cover them — a partial index — auto-names itself the
              // way this one does, and a database keeps one index per name. So
              // the automatic index falls back on the name of the constraint it
              // serves. Only a schema that has no foreign-key index today can
              // take the fallback, so no database that already holds the index
              // is renamed into a drop and a create.
              //
              // A schema may of course have spent BOTH names on indexes of its
              // own — `.index([...], { name: "<table>_<cols>_fkey_idx" })` is
              // legal. Then this index has no name left to take, and pushing it
              // anyway put two entries under one name into the snapshot: the
              // differ emitted two `CREATE INDEX` and the second failed the
              // whole push (measured on better-sqlite3: `index
              // zz_fb_kid_ownerId_fkey_idx already exists`). The index is a read
              // optimization, not a correctness requirement, so it yields to the
              // names the schema declared.
              const declaredNames = new Set(indexes.map((index) => index.name));
              const preferredName = `${tableName}_${fkColumns.join("_")}_idx`;
              const name = declaredNames.has(preferredName)
                ? `${tableName}_${fkColumns.join("_")}_fkey_idx`
                : preferredName;
              if (!declaredNames.has(name)) {
                indexes.push({ name, columns: fkColumns, unique: false });
              }
            }
          }

          // 1:1 FK must be unique at the DB level, or it degrades to N:1
          if (relationState.type === "oneToOne") {
            const fkKey = [...fkColumns].sort().join(",");
            const alreadyUnique =
              [...pkColumns].sort().join(",") === fkKey ||
              uniqueConstraints.some(
                (u) => [...u.columns].sort().join(",") === fkKey
              ) ||
              indexes.some(
                (i) =>
                  i.unique &&
                  isTotalIndex(i) &&
                  [...i.columns].sort().join(",") === fkKey
              );
            if (!alreadyUnique) {
              uniqueConstraints.push({
                name: `${tableName}_${fkColumns.join("_")}_key`,
                columns: fkColumns,
              });
            }
          }
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
  const junctionTables = new Map<string, { def: TableDef; pairKey: string }>();

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

      // Get junction table name (from .through() on either side, or generated)
      const junctionTableName = getJunctionTableName(
        relation as AnyRelation,
        modelName,
        targetModelName
      );

      // Referential actions may be configured on either side of the pair.
      // Prisma parity: implicit junction FKs default to CASCADE so deleting
      // an endpoint row removes its associations.
      const paired = findPairedManyToManyState(relation as AnyRelation);
      if (
        relState.onDelete &&
        paired?.onDelete &&
        relState.onDelete !== paired.onDelete
      ) {
        throw new Error(
          `Many-to-many relation pair for junction "${junctionTableName}" disagrees on onDelete: '${relState.onDelete}' vs '${paired.onDelete}'.`
        );
      }
      if (
        relState.onUpdate &&
        paired?.onUpdate &&
        relState.onUpdate !== paired.onUpdate
      ) {
        throw new Error(
          `Many-to-many relation pair for junction "${junctionTableName}" disagrees on onUpdate: '${relState.onUpdate}' vs '${paired.onUpdate}'.`
        );
      }
      const onDelete = mapReferentialAction(
        relState.onDelete ?? paired?.onDelete,
        "cascade"
      );
      const onUpdate = mapReferentialAction(
        relState.onUpdate ?? paired?.onUpdate,
        "cascade"
      );

      const sourcePkFields = getPrimaryKeyFieldDefs(model, migrationDriver);
      const targetPkFields = getPrimaryKeyFieldDefs(
        targetModel,
        migrationDriver
      );
      const fieldGroups = getJunctionFieldGroups(
        relation as AnyRelation,
        modelName,
        targetModelName,
        sourcePkFields.map((field) => field.field),
        targetPkFields.map((field) => field.field)
      );
      const sourceMembers = sourcePkFields.map((pk, index) => {
        const column = fieldGroups.source.fields[index];
        if (column === undefined) {
          throw new Error(
            "Junction source expansion did not match its primary-key arity."
          );
        }
        return { column, pk };
      });
      const targetMembers = targetPkFields.map((pk, index) => {
        const column = fieldGroups.target.fields[index];
        if (column === undefined) {
          throw new Error(
            "Junction target expansion did not match its primary-key arity."
          );
        }
        return { column, pk };
      });

      // Canonical column order: sorted model names decide (as the generated
      // table name does), so both sides serialize the identical table.
      const sourceSide = {
        group: fieldGroups.source,
        members: sourceMembers,
        table: sourceTableName,
        sortKey: modelName.toLowerCase(),
      };
      const targetSide = {
        group: fieldGroups.target,
        members: targetMembers,
        table: targetTableName,
        sortKey: targetModelName.toLowerCase(),
      };
      let [first, second] = [sourceSide, targetSide];
      if (
        !junctionSourceSideIsFirst(
          modelName,
          fieldGroups.source.fields,
          targetModelName,
          fieldGroups.target.fields
        )
      ) {
        [first, second] = [second, first];
      }

      const firstColumns = first.members.map((member) => member.column);
      const secondColumns = second.members.map((member) => member.column);

      const junctionDef: TableDef = {
        name: junctionTableName,
        columns: [
          ...first.members.map((member) => ({
            name: member.column,
            type: member.pk.type,
            nullable: false,
          })),
          ...second.members.map((member) => ({
            name: member.column,
            type: member.pk.type,
            nullable: false,
          })),
        ],
        primaryKey: { columns: [...firstColumns, ...secondColumns] },
        // The PK covers first-side lookups; reverse traversal needs one
        // index over the complete second-side stored reference.
        indexes: [
          {
            name: getJunctionConstraintName(
              junctionTableName,
              second.group,
              "idx"
            ),
            columns: secondColumns,
            unique: false,
          },
        ],
        foreignKeys: [
          {
            name: getJunctionConstraintName(
              junctionTableName,
              first.group,
              "fkey"
            ),
            columns: firstColumns,
            referencedTable: first.table,
            referencedColumns: first.members.map((member) => member.pk.column),
            onDelete,
            onUpdate,
          },
          {
            name: getJunctionConstraintName(
              junctionTableName,
              second.group,
              "fkey"
            ),
            columns: secondColumns,
            referencedTable: second.table,
            referencedColumns: second.members.map((member) => member.pk.column),
            onDelete,
            onUpdate,
          },
        ],
        uniqueConstraints: [],
      };

      // Both sides of a pair serialize identically after canonicalization, so
      // a mismatch means two different relation pairs collide on one table.
      // Pair identity (models + relation name) catches collisions even when
      // the column defs happen to be byte-identical.
      const pairKey = `${[first.sortKey, second.sortKey].join("::")}::${
        relState.name ?? paired?.name ?? ""
      }`;
      const existing = junctionTables.get(junctionTableName);
      if (existing) {
        if (
          existing.pairKey !== pairKey ||
          JSON.stringify(existing.def) !== JSON.stringify(junctionDef)
        ) {
          throw new Error(
            `Junction table "${junctionTableName}" is shared by multiple distinct many-to-many relation pairs. ` +
              "Give each pair a distinct .name() or its own .through() table name."
          );
        }
        continue;
      }
      junctionTables.set(junctionTableName, { def: junctionDef, pairKey });
    }
  }

  // Append junction tables to the tables array
  for (const { def } of junctionTables.values()) {
    tables.push(def);
  }

  return {
    tables: tables.map((table) => migrationDriver.finalizeTable(table)),
    enums: enums.length > 0 ? enums : undefined,
    ...(polymorphicStorage.length > 0 ? { polymorphicStorage } : {}),
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get every primary-key member in model-key order.
 */
function getPrimaryKeyFieldDefs(
  model: AnyModel,
  migrationDriver: MigrationDriver
): readonly { field: string; column: string; type: string }[] {
  const modelState = model["~"].state;
  const modelName = model["~"].names.ts;
  const rowKey = getModelKeyCatalog(model).rowKey?.fields;
  if (!rowKey || rowKey.length === 0) {
    throw new Error(
      `Model "${modelName}" has no primary key. Schema may not be hydrated.`
    );
  }
  return rowKey.map((field) => {
    const scalar = modelState.scalars[field];
    if (!scalar) {
      throw new Error(
        `Primary-key field '${field}' of model "${modelName}" is not a scalar.`
      );
    }
    const scalarState = scalar["~"].state;
    return {
      field,
      column: model["~"].getFieldName(field).sql,
      type: migrationDriver.mapScalarType(scalar, scalarState),
    };
  });
}

export { getColumnName } from "../schema/model";

/**
 * Gets the SQL table name for a model
 */
export function getTableName(model: AnyModel, modelName: string): string {
  return getModelTableName(model, modelName.toLowerCase());
}
