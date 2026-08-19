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
import {
  type AnyRelation,
  getCompatiblePolymorphicInverseBinding,
  type PolymorphicJunctionMember,
} from "../schema/relation";
import { getJunctionTableName } from "../schema/relation/helpers";
import {
  resolveJunctionPairActions,
  resolveOrdinaryJunctionTopology,
} from "../schema/relation/junction-topology";
import type { Scalar } from "../schema/scalars/base";
import type { MigrationDriver } from "./drivers";
import type {
  ColumnDef,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PolymorphicSnapshotStorage,
  PolymorphicToManySnapshotMember,
  PolymorphicToOneSnapshotMember,
  PolymorphicToOneStorageRegistryEntry,
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
  // One registry for EVERY junction-shaped table — polymorphic member
  // junctions (registered by the model loop below, model iteration order then
  // member declaration order) and ordinary many-to-many junctions (registered
  // by the walk that follows) — so the "one table name, one definition"
  // invariant covers both routes through the same map.
  const junctionTables = new Map<string, { def: TableDef; pairKey: string }>();

  for (const [modelName, model] of Object.entries(models)) {
    const modelState = model["~"].state;
    const tableName =
      model["~"].names.sql || modelState.tableName || modelName.toLowerCase();

    const columns: ColumnDef[] = [];
    const indexes: IndexDef[] = [];
    const foreignKeys: ForeignKeyDef[] = [];
    const uniqueConstraints: UniqueConstraintDef[] = [];
    const relationStorage: Record<
      string,
      PolymorphicToOneStorageRegistryEntry
    > = {};
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
    // scalar map. Its cached descriptor is the single source for the toOne
    // private columns and index, the toMany member junction tables, and
    // generated-file member history.
    for (const storage of model["~"].polymorphicStorage.values()) {
      if (storage.kind === "toMany") {
        const members: PolymorphicToManySnapshotMember[] = [];
        for (const member of storage.members.values()) {
          const memberDef = serializeMemberJunction(
            model,
            tableName,
            member,
            migrationDriver
          );
          // pairName is always set for a member junction: the stored topology
          // is built exclusively by definition validation, which passes
          // `${model}.${relation}.${publicType}` — already distinct from every
          // ordinary pairKey spelling.
          const pairKey = member.junction.pairName!;
          const existing = junctionTables.get(memberDef.name);
          if (
            existing &&
            (existing.pairKey !== pairKey ||
              JSON.stringify(existing.def) !== JSON.stringify(memberDef))
          ) {
            throw new Error(
              `Junction table "${memberDef.name}" is shared by multiple distinct relation pairs. ` +
                "Give each pair a distinct .name() or its own .through() table name."
            );
          }
          if (!existing) {
            junctionTables.set(memberDef.name, { def: memberDef, pairKey });
          }

          const targetModelName = member.targetModel["~"].names.ts;
          members.push({
            publicType: member.publicType,
            storedType: member.storedType,
            targetTable: getModelTableName(
              member.targetModel,
              targetModelName?.toLowerCase() ?? "unknown"
            ),
            memberJunctionTable: member.junction.table,
            inverseCardinality: member.inverseCardinality,
          });
        }
        polymorphicStorage.push({
          ownerTable: tableName,
          relation: storage.relationName,
          kind: "toMany",
          members,
        });
        continue;
      }
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
      // The physical facts stay in the TableDef above where the structural
      // differ owns them; the registry annotates which of those parts are
      // relation-owned, keyed by the storage ref the metadata entry carries.
      relationStorage[storage.typeColumn.name] = {
        kind: "polymorphicToOne",
        typeColumn: storage.typeColumn.name,
        idColumn: storage.idColumn.name,
        index: storage.indexName,
      };

      const members: PolymorphicToOneSnapshotMember[] = [];
      for (const [publicType, member] of storage.members) {
        const targetModelName = member.targetModel["~"].names.ts;
        members.push({
          publicType,
          storedType: member.storedType,
          targetTable: getModelTableName(
            member.targetModel,
            targetModelName?.toLowerCase() ?? "unknown"
          ),
        });
      }
      polymorphicStorage.push({
        ownerTable: tableName,
        relation: storage.relationName,
        kind: "toOne",
        storageRef: storage.typeColumn.name,
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
      // Key omitted when empty so ordinary tables keep their exact shape.
      ...(Object.keys(relationStorage).length > 0 ? { relationStorage } : {}),
    });
  }

  // ==========================================================================
  // JUNCTION TABLES FOR MANY-TO-MANY RELATIONS
  // ==========================================================================
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

      // A fields-less manyToMany whose compatible polymorphic binding
      // resolves is a polymorphic member VIEW: its storage is the member
      // junction tables serialized above, so it owns no ordinary junction —
      // byte-parallel to the validator's reservation skip
      // (`rules/polymorphic.ts` junctionPhysicalNames).
      if (getCompatiblePolymorphicInverseBinding(relState, model)) continue;

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
      const pairActions = resolveJunctionPairActions(
        relation as AnyRelation,
        junctionTableName
      );
      const onDelete = mapReferentialAction(pairActions.onDelete, "cascade");
      const onUpdate = mapReferentialAction(pairActions.onUpdate, "cascade");

      const sourcePkFields = getPrimaryKeyFieldDefs(model, migrationDriver);
      const targetPkFields = getPrimaryKeyFieldDefs(
        targetModel,
        migrationDriver
      );
      const topology = resolveOrdinaryJunctionTopology({
        relation: relation as AnyRelation,
        table: junctionTableName,
        source: {
          model,
          modelName,
          rowKey: sourcePkFields.map((field) => field.field),
        },
        target: {
          model: targetModel,
          modelName: targetModelName,
          rowKey: targetPkFields.map((field) => field.field),
        },
      });
      // Decorate the owner's members with the driver-typed key defs by index:
      // the members were zipped from these same row-key lists, so both sides
      // carry exactly one member per key def and the lookup cannot miss.
      const sourceMembers = topology.source.members.map((member, index) => ({
        column: member.junctionField,
        pk: sourcePkFields[index]!,
      }));
      const targetMembers = topology.target.members.map((member, index) => ({
        column: member.junctionField,
        pk: targetPkFields[index]!,
      }));

      // Canonical column order: sorted model names decide (as the generated
      // table name does), so both sides serialize the identical table.
      const sourceSide = {
        members: sourceMembers,
        table: sourceTableName,
        sortKey: modelName.toLowerCase(),
      };
      const targetSide = {
        members: targetMembers,
        table: targetTableName,
        sortKey: targetModelName.toLowerCase(),
      };
      let [first, second] = [sourceSide, targetSide];
      if (!topology.sourceIsFirst) {
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
            name: topology.reverseIndexName(),
            columns: secondColumns,
            unique: false,
          },
        ],
        foreignKeys: [
          {
            name: topology.foreignKeyName(
              topology.sourceIsFirst ? "source" : "target"
            ),
            columns: firstColumns,
            referencedTable: first.table,
            referencedColumns: first.members.map((member) => member.pk.column),
            onDelete,
            onUpdate,
          },
          {
            name: topology.foreignKeyName(
              topology.sourceIsFirst ? "target" : "source"
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
        topology.pairName ?? ""
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
 * Serialize ONE polymorphic collection member's junction table, byte-reusing
 * the ordinary junction template: canonical orientation, driver types zipped
 * BY INDEX against the stored topology's sides, PK without a name, one
 * unconditional reverse index, and two FIXED-cascade foreign keys —
 * `resolveJunctionPairActions` is NEVER called on this path (member actions
 * are cascade by design; a hostile referential-action spelling never reaches
 * this DDL). Consumes ONLY the stored `ResolvedJunctionTopology`: every
 * physical name comes from the topology's own methods, never reconstructed
 * from naming conventions.
 */
function serializeMemberJunction(
  ownerModel: AnyModel,
  ownerTableName: string,
  member: PolymorphicJunctionMember,
  migrationDriver: MigrationDriver
): TableDef {
  const junction = member.junction;
  const targetModelName = member.targetModel["~"].names.ts;
  const targetTableName = getModelTableName(
    member.targetModel,
    targetModelName?.toLowerCase() ?? "unknown"
  );
  const sourcePkFields = getPrimaryKeyFieldDefs(ownerModel, migrationDriver);
  const targetPkFields = getPrimaryKeyFieldDefs(
    member.targetModel,
    migrationDriver
  );
  // Decorate the sides with the driver-typed key defs by index: the stored
  // topology zipped its members from the same model-key-catalog row keys these
  // defs come from, so both lists carry exactly one entry per key def.
  const sourceMembers = junction.source.members.map(
    (junctionMember, index) => ({
      column: junctionMember.junctionField,
      pk: sourcePkFields[index]!,
    })
  );
  const targetMembers = junction.target.members.map(
    (junctionMember, index) => ({
      column: junctionMember.junctionField,
      pk: targetPkFields[index]!,
    })
  );

  const sourceSide = { members: sourceMembers, table: ownerTableName };
  const targetSide = { members: targetMembers, table: targetTableName };
  let [first, second] = [sourceSide, targetSide];
  if (!junction.sourceIsFirst) {
    [first, second] = [second, first];
  }

  const firstColumns = first.members.map(
    (junctionMember) => junctionMember.column
  );
  const secondColumns = second.members.map(
    (junctionMember) => junctionMember.column
  );

  return {
    name: junction.table,
    columns: [
      ...first.members.map((junctionMember) => ({
        name: junctionMember.column,
        type: junctionMember.pk.type,
        nullable: false,
      })),
      ...second.members.map((junctionMember) => ({
        name: junctionMember.column,
        type: junctionMember.pk.type,
        nullable: false,
      })),
    ],
    primaryKey: { columns: [...firstColumns, ...secondColumns] },
    // The PK covers first-side lookups; reverse traversal needs one index
    // over the complete second-side stored reference — emitted
    // UNCONDITIONALLY so every member table shares one template shape.
    // Accepted redundancy: when a SINGULAR-inverse member's target sorts
    // canonical-second, the unique constraint below covers the same columns;
    // DDL shape must not become conditional on canonical sort order.
    indexes: [
      {
        name: junction.reverseIndexName(),
        columns: secondColumns,
        unique: false,
      },
    ],
    foreignKeys: [
      {
        name: junction.foreignKeyName(
          junction.sourceIsFirst ? "source" : "target"
        ),
        columns: firstColumns,
        referencedTable: first.table,
        referencedColumns: first.members.map(
          (junctionMember) => junctionMember.pk.column
        ),
        onDelete: "cascade",
        onUpdate: "cascade",
      },
      {
        name: junction.foreignKeyName(
          junction.sourceIsFirst ? "target" : "source"
        ),
        columns: secondColumns,
        referencedTable: second.table,
        referencedColumns: second.members.map(
          (junctionMember) => junctionMember.pk.column
        ),
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    ],
    // The unique side is the complete ordered TARGET side, NOT the reverse
    // index flipped: when the target sorts canonical-first the reverse index
    // covers the OWNER side, and the PK prefix does not make target columns
    // unique. The name is asked LAST (idx → first fkey → second fkey → key)
    // so the other three refusal positions stay where they are.
    uniqueConstraints:
      member.inverseCardinality === "one"
        ? [
            {
              name: junction.uniqueTargetName(),
              columns: targetMembers.map(
                (junctionMember) => junctionMember.column
              ),
            },
          ]
        : [],
  };
}

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
