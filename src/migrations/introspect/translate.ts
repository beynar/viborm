/**
 * A live snapshot → a schema document (the draft `index.ts` canonicalizes).
 *
 * Pure: it reads the snapshot the dialect's own introspection wrote and the
 * catalog facts beside it, and says what it could not carry. Database names are
 * kept as document keys; a relation, which has no database name, is named from
 * its foreign key by one deterministic rule (see `relationNames`).
 */

import type {
  EnumDocument,
  FieldDocument,
  IndexDocument,
  JunctionDocument,
  ModelDocument,
  ModelTargetDocument,
  SchemaDocument,
} from "../../schema/json/document";
import type { MigrationDriver } from "../drivers/base";
import type {
  EnumDef,
  ForeignKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
} from "../types";
import { derivedMigrationName } from "../utils";
import {
  type ColumnContext,
  type ColumnTranslation,
  translatePostgresColumn,
  translateSqliteColumn,
} from "./columns";
import {
  KeyAllocator,
  memberAllocator,
  relationNameFromColumn,
} from "./names";
import type {
  IntrospectionDialect,
  IntrospectionWarning,
  SkippedObject,
} from "./types";

export interface TranslateInput {
  readonly snapshot: SchemaSnapshot;
  readonly dialect: IntrospectionDialect;
  readonly migrationDriver: MigrationDriver;
  /** PostgreSQL identity columns, keyed `table\0column`. */
  readonly identityColumns: ReadonlySet<string>;
  /** Pure join tables to keep as a junction MODEL rather than a generated junction. */
  readonly junctionModels: ReadonlySet<string>;
}

export interface Translation {
  readonly document: SchemaDocument;
  readonly skipped: SkippedObject[];
  readonly warnings: IntrospectionWarning[];
  /** The tables the document declares, models and generated junctions alike. */
  readonly tables: ReadonlySet<string>;
  /** The pure join tables written as a generated junction. */
  readonly generatedJunctions: ReadonlySet<string>;
}

/** One model under construction. */
interface ModelBuild {
  readonly key: string;
  readonly table: TableDef;
  readonly members: KeyAllocator;
  readonly fields: Record<string, FieldDocument>;
  /** Column name → field key, for the translated columns. */
  readonly fieldOf: Map<string, string>;
  readonly document: ModelDocument;
  /** Column sets the document declares unique (id, unique, uniques), sorted. */
  readonly keys: string[][];
}

const JUNCTION_ACTIONS = new Set<ReferentialAction>([
  "cascade",
  "restrict",
  "noAction",
]);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function sorted(columns: readonly string[]): string[] {
  return [...columns].sort();
}

/** One relation pair between two models, before its label is decided. */
interface Pair {
  readonly models: readonly [string, string];
  readonly label: string;
  readonly slots: Array<{ model: ModelBuild; key: string }>;
}

export function translateSnapshot(input: TranslateInput): Translation {
  const { snapshot, dialect, migrationDriver } = input;
  const skipped: SkippedObject[] = [];
  const warnings: IntrospectionWarning[] = [];
  const readsNames =
    migrationDriver.capabilities.introspectionReadsConstraintNames;
  const enums = new Map<string, EnumDef>(
    (snapshot.enums ?? []).map((item) => [item.name, item])
  );
  const translateColumn: (context: ColumnContext) => ColumnTranslation =
    dialect === "postgresql" ? translatePostgresColumn : translateSqliteColumn;

  // SQLite stores a uuid key as a BLOB, and a blob is never a key: a BLOB
  // primary-key column, and every foreign-key column reaching one, is read as
  // the uuid key it is VibORM's spelling of.
  const binaryKeys = new Set<string>();
  if (dialect === "sqlite") {
    const isBlob = (table: TableDef, column: string) =>
      table.columns.find((item) => item.name === column)?.type.toUpperCase() ===
      "BLOB";
    for (const table of snapshot.tables)
      for (const column of table.primaryKey?.columns ?? [])
        if (isBlob(table, column)) binaryKeys.add(`${table.name}\0${column}`);
    for (let grew = true; grew; ) {
      grew = false;
      for (const table of snapshot.tables)
        for (const fk of table.foreignKeys)
          fk.columns.forEach((column, position) => {
            const id = `${table.name}\0${column}`;
            const referenced = `${fk.referencedTable}\0${fk.referencedColumns[position]}`;
            if (!binaryKeys.has(id) && binaryKeys.has(referenced) && isBlob(table, column)) {
              binaryKeys.add(id);
              grew = true;
            }
          });
    }
  }

  const modelKeys = new KeyAllocator();
  const builds = new Map<string, ModelBuild>();
  /** Enum type name → the columns using it. */
  const enumUses = new Map<
    string,
    Array<{ build: ModelBuild; field: string; column: string }>
  >();

  // ---------------------------------------------------------------------------
  // Tables → models with their scalar fields
  // ---------------------------------------------------------------------------
  for (const table of snapshot.tables) {
    const primaryKey = table.primaryKey;
    if (!primaryKey || primaryKey.columns.length === 0) {
      skipped.push({
        kind: "table",
        name: table.name,
        reason:
          "it has no primary key, and a VibORM model is addressed by one",
      });
      continue;
    }
    const translated = new Map<string, ColumnTranslation>();
    for (const column of table.columns) {
      translated.set(
        column.name,
        translateColumn({
          column,
          enums,
          identity: input.identityColumns.has(`${table.name}\0${column.name}`),
          enumColumnType: (values) =>
            migrationDriver.getEnumColumnType(table.name, column.name, values),
          binaryKey: binaryKeys.has(`${table.name}\0${column.name}`),
        })
      );
    }
    const lostKey = primaryKey.columns.find((column) => {
      const result = translated.get(column);
      return result === undefined || "skip" in result;
    });
    if (lostKey !== undefined) {
      const result = translated.get(lostKey);
      skipped.push({
        kind: "table",
        name: table.name,
        reason: `its primary key column "${lostKey}" cannot be translated: ${result && "skip" in result ? result.skip : "it is not a column of the table"}`,
      });
      continue;
    }

    const key = modelKeys.claimName(table.name);
    const fields: Record<string, FieldDocument> = {};
    const document: ModelDocument = { fields };
    if (key !== table.name) document.table = table.name;
    const build: ModelBuild = {
      key,
      table,
      members: memberAllocator(),
      fields,
      fieldOf: new Map(),
      document,
      keys: [],
    };
    for (const column of table.columns) {
      const result = translated.get(column.name)!;
      if ("skip" in result) {
        skipped.push({
          kind: "column",
          table: table.name,
          name: column.name,
          reason: result.skip,
        });
        continue;
      }
      const fieldKey = build.members.claimName(column.name);
      const field = { ...result.field };
      if (fieldKey !== column.name) field.column = column.name;
      fields[fieldKey] = field;
      build.fieldOf.set(column.name, fieldKey);
      if (result.enumType !== undefined) {
        const uses = enumUses.get(result.enumType) ?? [];
        uses.push({ build, field: fieldKey, column: column.name });
        enumUses.set(result.enumType, uses);
      }
      if (result.skippedDefault !== undefined)
        skipped.push({
          kind: "default",
          table: table.name,
          name: column.name,
          reason: result.skippedDefault,
        });
      if (result.approximated !== undefined)
        warnings.push({
          kind: "approximated",
          table: table.name,
          name: column.name,
          message: result.approximated,
        });
    }

    // The primary key
    const pkFields = primaryKey.columns.map((column) => build.fieldOf.get(column)!);
    if (pkFields.length === 1) {
      const field = fields[pkFields[0]!]!;
      if (field.type !== "toOne" && field.type !== "toMany") {
        Object.assign(field, { id: true });
        // `.id()` on a string installs a ULID generator; a database cannot
        // prove the application generated its keys, so none is claimed.
        if (field.type === "string" && field.generate === undefined)
          Object.assign(field, {
            generate: { kind: "ulid", generate: false, implicit: true },
          });
      }
    } else {
      document.ids = [{ fields: pkFields }];
    }
    build.keys.push(sorted(primaryKey.columns));
    builds.set(table.name, build);
  }

  // ---------------------------------------------------------------------------
  // Unique constraints and indexes
  // ---------------------------------------------------------------------------
  for (const build of builds.values()) {
    const { table, fields, document, fieldOf } = build;
    const indexes: IndexDocument[] = [];
    const uniques: Array<{ fields: string[]; name?: string }> = [];
    const missing = (columns: readonly string[]) =>
      columns.find((column) => !fieldOf.has(column));

    for (const constraint of table.uniqueConstraints) {
      const lost = missing(constraint.columns);
      if (lost !== undefined) {
        skipped.push({
          kind: "uniqueConstraint",
          table: table.name,
          name: constraint.name,
          reason: `its column "${lost}" is not translated`,
        });
        continue;
      }
      const keys = constraint.columns.map((column) => fieldOf.get(column)!);
      const derived = (name: string) =>
        derivedMigrationName(`${table.name}_${name}_key`);
      if (keys.length === 1 && (!readsNames || constraint.name === derived(constraint.columns[0]!))) {
        Object.assign(fields[keys[0]!]!, { unique: true });
        build.keys.push(sorted(constraint.columns));
        continue;
      }
      if (!readsNames || constraint.name === derived(keys.join("_"))) {
        uniques.push({ fields: keys });
        build.keys.push(sorted(constraint.columns));
        continue;
      }
      const prefix = `${table.name}_`;
      const named =
        constraint.name.startsWith(prefix) && constraint.name.endsWith("_key")
          ? constraint.name.slice(prefix.length, -"_key".length)
          : undefined;
      if (named !== undefined && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(named)) {
        uniques.push({ fields: keys, name: named });
        build.keys.push(sorted(constraint.columns));
        continue;
      }
      // A total unique btree index and a unique constraint enforce the same
      // key and the differ treats them as one; only the index spelling
      // carries an arbitrary name.
      indexes.push({ fields: keys, name: constraint.name, unique: true });
      warnings.push({
        kind: "approximated",
        table: table.name,
        name: constraint.name,
        message: `the unique constraint "${constraint.name}" is declared as a unique index under the same name, because a document names compound keys "<table>_<name>_key"; it is not a key \`findUnique\` accepts`,
      });
    }

    for (const index of table.indexes) {
      const lost = missing(index.columns);
      const reason = index.raw
        ? "it is a raw index (`.rawIndex()`), which a document cannot declare: keep it in a TypeScript schema"
        : index.where !== undefined
          ? `it is a partial index (WHERE ${index.where}), and a document has no \`where\`: keep it in a TypeScript schema`
          : lost !== undefined
            ? `its column "${lost}" is not translated`
            : undefined;
      if (reason !== undefined) {
        skipped.push({
          kind: "index",
          table: table.name,
          name: index.name,
          reason,
        });
        continue;
      }
      const declared: IndexDocument = {
        fields: index.columns.map((column) => fieldOf.get(column)!),
        name: index.name,
      };
      if (index.unique) declared.unique = true;
      if (index.type !== undefined && index.type !== "btree")
        declared.type = index.type;
      indexes.push(declared);
    }
    if (uniques.length > 0) document.uniques = uniques;
    if (indexes.length > 0) document.indexes = indexes;
  }

  // ---------------------------------------------------------------------------
  // Foreign keys → relations
  // ---------------------------------------------------------------------------
  interface Edge {
    readonly owner: ModelBuild;
    readonly target: ModelBuild;
    readonly fk: ForeignKeyDef;
  }
  const edgesByOwner = new Map<ModelBuild, Edge[]>();
  for (const owner of builds.values()) {
    const edges: Edge[] = [];
    const foreignKeys = [...owner.table.foreignKeys].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const fk of foreignKeys) {
      const target = builds.get(fk.referencedTable);
      const skip = (reason: string) =>
        skipped.push({
          kind: "foreignKey",
          table: owner.table.name,
          name: fk.name,
          reason,
        });
      if (target === undefined) {
        skip(
          `it references "${fk.referencedTable}", which the document does not declare`
        );
        continue;
      }
      const lostOwn = fk.columns.find((column) => !owner.fieldOf.has(column));
      const lostRef = fk.referencedColumns.find(
        (column) => !target.fieldOf.has(column)
      );
      if (lostOwn !== undefined || lostRef !== undefined) {
        skip(
          `its column "${lostOwn ?? `${fk.referencedTable}.${lostRef}`}" is not translated`
        );
        continue;
      }
      if (fk.onDelete === "setDefault" || fk.onUpdate === "setDefault") {
        skip(
          "its referential action is SET DEFAULT, which a VibORM relation does not declare"
        );
        continue;
      }
      if (!target.keys.some((key) => sameSet(key, fk.referencedColumns))) {
        skip(
          `it references (${fk.referencedColumns.join(", ")}) of "${fk.referencedTable}", which the document does not declare as a key`
        );
        continue;
      }
      edges.push({ owner, target, fk });
    }
    edgesByOwner.set(owner, edges);
  }

  /**
   * A pure join table: two foreign keys, together exactly its columns and its
   * primary key, each referencing its target's primary key.
   */
  const joinTables = new Map<ModelBuild, readonly [Edge, Edge]>();
  for (const [owner, edges] of edgesByOwner) {
    if (edges.length !== 2) continue;
    const [first, second] = edges as [Edge, Edge];
    const table = owner.table;
    const columns = table.columns.map((column) => column.name);
    const union = [...first.fk.columns, ...second.fk.columns];
    if (
      table.foreignKeys.length !== 2 ||
      first.fk.columns.some((column) => second.fk.columns.includes(column)) ||
      !sameSet(union, columns) ||
      !sameSet(table.primaryKey?.columns ?? [], columns) ||
      !edges.every((edge) =>
        sameSet(edge.fk.referencedColumns, edge.target.table.primaryKey?.columns ?? [])
      )
    )
      continue;
    joinTables.set(owner, [first, second]);
  }

  const pairs = new Map<string, Pair[]>();
  const addPair = (
    a: ModelBuild,
    b: ModelBuild,
    label: string,
    slots: Array<{ model: ModelBuild; key: string }>
  ) => {
    const models = [a.key, b.key].sort() as [string, string];
    const id = models.join("\0");
    const list = pairs.get(id) ?? [];
    list.push({ models, label, slots });
    pairs.set(id, list);
  };

  const generatedJunctions = new Set<string>();
  const action = (
    value: ReferentialAction | undefined
  ): Exclude<ReferentialAction, "setDefault"> =>
    value === undefined || value === "setDefault" ? "noAction" : value;

  /** The to-one a foreign key gives its owner, and the inverse on its target. */
  const relationNames = (edge: Edge, siblings: readonly Edge[]) => {
    const { owner, target, fk } = edge;
    const single =
      fk.columns.length === 1
        ? relationNameFromColumn(owner.fieldOf.get(fk.columns[0]!)!)
        : undefined;
    const toOne = owner.members.claim(single ?? target.key);
    const shared =
      owner === target ||
      siblings.filter((other) => other.target === target).length > 1;
    const inverse = target.members.claim(
      shared ? `${owner.key}_by_${toOne}` : owner.key
    );
    return { toOne, inverse };
  };

  for (const owner of builds.values()) {
    const edges = edgesByOwner.get(owner) ?? [];
    const join = joinTables.get(owner);
    if (join) {
      const [first, second] = join;
      const asGenerated =
        !input.junctionModels.has(owner.table.name) &&
        first.fk.columns.length === 1 &&
        second.fk.columns.length === 1 &&
        [first.fk, second.fk].every(
          (fk) =>
            JUNCTION_ACTIONS.has(action(fk.onDelete)) &&
            JUNCTION_ACTIONS.has(action(fk.onUpdate))
        );
      if (asGenerated) {
        // The table is the generated junction of one many-to-many pair; it is
        // not a model. `verify.ts` keeps this form only when the junction the
        // pair generates IS this table, and demotes it to a model otherwise.
        builds.delete(owner.table.name);
        generatedJunctions.add(owner.table.name);
        const a = first.target;
        const b = second.target;
        const aName = a.members.claim(
          relationNameFromColumn(second.fk.columns[0]!) ?? b.key
        );
        const bName = b.members.claim(
          relationNameFromColumn(first.fk.columns[0]!) ?? a.key
        );
        const sides = (one: ReferentialAction, other: ReferentialAction) =>
          one === other ? { one } : { source: one, target: other };
        const onDelete = sides(action(first.fk.onDelete), action(second.fk.onDelete));
        const onUpdate = sides(action(first.fk.onUpdate), action(second.fk.onUpdate));
        const junction = {
          table: owner.table.name,
          source: first.fk.columns[0]!,
          target: second.fk.columns[0]!,
          ...("one" in onDelete
            ? { onDelete: onDelete.one }
            : { onDeleteSides: onDelete }),
          ...("one" in onUpdate
            ? { onUpdate: onUpdate.one }
            : { onUpdateSides: onUpdate }),
        } as JunctionDocument;
        a.fields[aName] = { type: "toMany", target: b.key, junction };
        b.fields[bName] = { type: "toMany", target: a.key };
        addPair(a, b, owner.table.name, [
          { model: a, key: aName },
          { model: b, key: bName },
        ]);
        continue;
      }
    }

    const names = new Map<Edge, { toOne: string; inverse: string }>();
    for (const edge of edges) {
      const { target, fk } = edge;
      const { toOne, inverse } = relationNames(edge, edges);
      names.set(edge, { toOne, inverse });
      const relation: ModelTargetDocument = {
        type: "toOne",
        target: target.key,
        fields: fk.columns.map((column) => owner.fieldOf.get(column)!),
        references: fk.referencedColumns.map(
          (column) => target.fieldOf.get(column)!
        ),
        onDelete: action(fk.onDelete),
        onUpdate: action(fk.onUpdate),
      };
      owner.fields[toOne] = relation;
      const unique = owner.keys.some((key) => sameSet(key, fk.columns));
      target.fields[inverse] = unique
        ? { type: "toOne", target: owner.key }
        : { type: "toMany", target: owner.key };
      addPair(owner, target, fk.name, [
        { model: owner, key: toOne },
        { model: target, key: inverse },
      ]);
    }

    if (join) {
      // A junction model: the table keeps its own shape, and the many-to-many
      // walks through it.
      const [first, second] = join;
      const a = first.target;
      const b = second.target;
      const firstName = names.get(first)!.toOne;
      const secondName = names.get(second)!.toOne;
      const aName = a.members.claim(secondName);
      const bName = b.members.claim(firstName);
      a.fields[aName] = {
        type: "toMany",
        target: b.key,
        junction: { model: owner.key, source: firstName, target: secondName },
      };
      b.fields[bName] = { type: "toMany", target: a.key };
      addPair(a, b, owner.table.name, [
        { model: a, key: aName },
        { model: b, key: bName },
      ]);
    }
  }

  // A pairing label where two models share more than one relation, or a
  // model relates to itself: the label is the foreign key's (or the join
  // table's) name, unique per pair of models.
  for (const list of pairs.values()) {
    const ambiguous = list.length > 1 || list[0]!.models[0] === list[0]!.models[1];
    if (!ambiguous) continue;
    for (const pair of list)
      for (const slot of pair.slots)
        Object.assign(slot.model.fields[slot.key]!, { name: pair.label });
  }

  // ---------------------------------------------------------------------------
  // Enums
  // ---------------------------------------------------------------------------
  const enumDocuments: Record<string, EnumDocument> = {};
  const enumKeys = new KeyAllocator();
  for (const [name, def] of enums) {
    const uses = (enumUses.get(name) ?? []).filter((use) =>
      builds.has(use.build.table.name)
    );
    if (uses.length === 0) {
      skipped.push({
        kind: "enum",
        name,
        reason:
          "no translated column uses it, and a document declares an enum through its fields",
      });
      continue;
    }
    const only = uses.length === 1 ? uses[0]! : undefined;
    if (
      only &&
      migrationDriver.getEnumColumnType(only.build.table.name, only.column, def.values) === name
    )
      continue; // the column's own derived type: inline values say exactly this
    const key = enumKeys.claimName(name);
    enumDocuments[key] = { values: [...def.values], name };
    for (const use of uses)
      Object.assign(use.build.fields[use.field]!, { enum: key });
  }

  const models: Record<string, ModelDocument> = {};
  for (const build of builds.values()) models[build.key] = build.document;
  const document: SchemaDocument = {
    version: 1,
    ...(Object.keys(enumDocuments).length > 0 ? { enums: enumDocuments } : {}),
    models,
  };
  return {
    document,
    skipped,
    warnings,
    tables: new Set([
      ...[...builds.values()].map((build) => build.table.name),
      ...generatedJunctions,
    ]),
    generatedJunctions,
  };
}
