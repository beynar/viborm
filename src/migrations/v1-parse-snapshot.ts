/**
 * Hostile parser and hash owner for Migration V1 schema snapshots.
 *
 * Snapshot bytes are admitted only after exact-key validation,
 * re-canonicalization against the original bytes, and hash recomputation.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { DecimalDescriptor } from "../validation/primitives/decimal-codec";
import {
  isBoolean,
  isNumber,
  isRecord,
  isString,
} from "../validation/value-guards";
import {
  assertCanonicalBytes,
  canonicalizeJson,
  parseJsonBytes,
} from "./canonical-json";
import { domainHash, HASH_DOMAIN, type Sha256 } from "./identity";
import { rawIndexFields, rawIndexHash } from "./raw-index";
import type {
  AutoViewCascade,
  AutoViewDef,
  AutoViewObject,
  AutoViewStorage,
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
  ViewDef,
} from "./types";
import {
  exactObject,
  parseIdentifierArray,
  parseItems,
  parseMember,
  parseRequiredString,
  parseStringArray,
  refuse,
} from "./v1-parse-shared";
import { isViewHash, sortAutoViewObjects } from "./view";

const SNAPSHOT_KEYS = [
  "enums",
  "polymorphicStorage",
  "tables",
  "views",
] as const;
const TABLE_KEYS = [
  "columns",
  "foreignKeys",
  "indexes",
  "junction",
  "name",
  "primaryKey",
  "relationStorage",
  "uniqueConstraints",
] as const;
const TABLE_REQUIRED_KEYS = [
  "columns",
  "foreignKeys",
  "indexes",
  "name",
  "uniqueConstraints",
] as const;
const COLUMN_KEYS = [
  "autoIncrement",
  "dateTime",
  "geoPointEncoding",
  "decimal",
  "default",
  "name",
  "nullable",
  "type",
] as const;
const DECIMAL_KEYS = ["precision", "scale"] as const;
const PRIMARY_KEY_KEYS = ["columns", "name", "withoutRowid"] as const;
const INDEX_KEYS = [
  "columns",
  "name",
  "raw",
  "type",
  "unique",
  "where",
] as const;
const RAW_INDEX_KEYS = ["hash", "template"] as const;
const FOREIGN_KEY_KEYS = [
  "columns",
  "name",
  "onDelete",
  "onUpdate",
  "referencedColumns",
  "referencedTable",
] as const;
const UNIQUE_CONSTRAINT_KEYS = ["columns", "name"] as const;
const ENUM_KEYS = ["name", "values"] as const;
const VIEW_KEYS = [
  "auto",
  "dependsOn",
  "hash",
  "indexes",
  "materialized",
  "name",
  "sql",
] as const;
const AUTO_VIEW_KEYS = ["objects", "storage"] as const;
const AUTO_OBJECT_KEYS = ["kind", "name", "table"] as const;
const AUTO_OBJECT_KINDS = ["function", "trigger", "view"] as const;
const AUTO_STORAGE_KEYS = [
  "cascades",
  "columns",
  "grouped",
  "key",
  "keyed",
  "reads",
  "source",
  "sourceKey",
] as const;
const AUTO_KEYED_KEYS = ["NEW", "OLD"] as const;
const AUTO_CASCADE_KEYS = ["children", "table", "trigger"] as const;
const AUTO_CHILD_KEYS = [
  "action",
  "columns",
  "referencedColumns",
  "table",
] as const;
const AUTO_ACTIONS = ["cascade", "setNull"] as const;
const VIEW_REQUIRED_KEYS = ["dependsOn", "hash", "name", "sql"] as const;
const RELATION_STORAGE_KEYS = [
  "idColumn",
  "index",
  "kind",
  "typeColumn",
] as const;
const POLYMORPHIC_TO_ONE_KEYS = [
  "kind",
  "members",
  "ownerTable",
  "relation",
  "storageRef",
] as const;
const POLYMORPHIC_TO_MANY_KEYS = [
  "kind",
  "members",
  "ownerTable",
  "relation",
] as const;
const POLYMORPHIC_TO_ONE_MEMBER_KEYS = [
  "publicType",
  "storedType",
  "targetTable",
] as const;
const POLYMORPHIC_TO_MANY_MEMBER_KEYS = [
  "inverseCardinality",
  "memberJunctionTable",
  "publicType",
  "storedType",
  "targetTable",
] as const;

function parseColumn(value: unknown, label: string): ColumnDef {
  const record = exactObject(
    value,
    COLUMN_KEYS,
    ["name", "nullable", "type"],
    label
  );
  if (!isBoolean(record.nullable)) refuse(`${label}.nullable must be boolean`);
  const column: ColumnDef = {
    name: parseRequiredString(record.name, `${label}.name`),
    type: parseRequiredString(record.type, `${label}.type`),
    nullable: record.nullable,
  };
  if ("default" in record) {
    if (!isString(record.default)) refuse(`${label}.default must be a string`);
    column.default = record.default;
  }
  if ("autoIncrement" in record) {
    if (!isBoolean(record.autoIncrement)) {
      refuse(`${label}.autoIncrement must be boolean`);
    }
    column.autoIncrement = record.autoIncrement;
  }
  if ("decimal" in record) {
    column.decimal = parseDecimalDescriptor(record.decimal, `${label}.decimal`);
  }
  if ("geoPointEncoding" in record) {
    if (
      (record.geoPointEncoding !== "legacy" &&
        record.geoPointEncoding !== "binary64") ||
      column.type.toUpperCase() !== "VIBORM_GEO_TEXT" ||
      column.decimal !== undefined ||
      "dateTime" in record
    )
      refuse(`${label}.geoPointEncoding contradicts its physical type`);
    column.geoPointEncoding = record.geoPointEncoding;
  }
  if ("dateTime" in record) {
    if (
      !isString(record.dateTime) ||
      (record.dateTime !== "text" &&
        record.dateTime !== "epochMillis" &&
        record.dateTime !== "julianDay")
    ) {
      refuse(`${label}.dateTime must name a DateTime physical form`);
    }
    const physicalType =
      record.dateTime === "text"
        ? "TEXT"
        : record.dateTime === "epochMillis"
          ? "INTEGER"
          : "REAL";
    if (column.type.toUpperCase() !== physicalType) {
      refuse(`${label}.dateTime contradicts its physical type`);
    }
    if (column.decimal !== undefined) {
      refuse(`${label} cannot be both DateTime and fixed-decimal storage`);
    }
    column.dateTime = record.dateTime;
  }
  return column;
}

function parseDecimalDescriptor(
  value: unknown,
  label: string
): DecimalDescriptor {
  const record = exactObject(value, DECIMAL_KEYS, DECIMAL_KEYS, label);
  if (
    !(isNumber(record.precision) && Number.isSafeInteger(record.precision)) ||
    record.precision < 1
  ) {
    refuse(`${label}.precision must be a positive safe integer`);
  }
  if (
    !(isNumber(record.scale) && Number.isSafeInteger(record.scale)) ||
    Object.is(record.scale, -0) ||
    record.scale < 0 ||
    record.scale > record.precision
  ) {
    refuse(`${label}.scale must be a safe integer between 0 and precision`);
  }
  return { precision: record.precision, scale: record.scale };
}

function parsePrimaryKey(value: unknown, label: string): PrimaryKeyDef {
  const record = exactObject(value, PRIMARY_KEY_KEYS, ["columns"], label);
  const primaryKey: PrimaryKeyDef = {
    columns: parseIdentifierArray(record.columns, `${label}.columns`),
  };
  if ("name" in record) {
    primaryKey.name = parseRequiredString(record.name, `${label}.name`);
  }
  if ("withoutRowid" in record) {
    if (record.withoutRowid !== true)
      refuse(`${label}.withoutRowid must be true when present`);
    primaryKey.withoutRowid = true;
  }
  return primaryKey;
}

function parseIndex(value: unknown, label: string): IndexDef {
  const record = exactObject(
    value,
    INDEX_KEYS,
    ["columns", "name", "unique"],
    label
  );
  if (!isBoolean(record.unique)) refuse(`${label}.unique must be boolean`);
  const index: IndexDef = {
    name: parseRequiredString(record.name, `${label}.name`),
    columns: parseIdentifierArray(record.columns, `${label}.columns`),
    unique: record.unique,
  };
  if ("type" in record) {
    if (
      record.type !== "btree" &&
      record.type !== "hash" &&
      record.type !== "gin" &&
      record.type !== "gist" &&
      record.type !== "fulltext" &&
      record.type !== "spatial"
    ) {
      refuse(`${label}.type is invalid`);
    }
    index.type = record.type;
  }
  if ("where" in record) {
    if (!isString(record.where)) refuse(`${label}.where must be a string`);
    index.where = record.where;
  }
  if ("raw" in record) {
    const raw = exactObject(
      record.raw,
      RAW_INDEX_KEYS,
      RAW_INDEX_KEYS,
      `${label}.raw`
    );
    if (!isString(raw.template))
      refuse(`${label}.raw.template must be a string`);
    if (raw.hash !== rawIndexHash(raw.template))
      refuse(`${label}.raw.hash does not match its template`);
    if (index.unique || index.type !== undefined || index.where !== undefined)
      refuse(`${label} is raw and cannot also be unique, typed or partial`);
    if (rawIndexFields(raw.template).length !== index.columns.length)
      refuse(`${label}.columns are not the fields its template names`);
    index.raw = { hash: raw.hash, template: raw.template };
  }
  return index;
}

const REFERENTIAL_ACTIONS: readonly ReferentialAction[] = [
  "cascade",
  "setNull",
  "restrict",
  "noAction",
  "setDefault",
];

function parseForeignKey(value: unknown, label: string): ForeignKeyDef {
  const record = exactObject(
    value,
    FOREIGN_KEY_KEYS,
    ["columns", "name", "referencedColumns", "referencedTable"],
    label
  );
  const foreignKey: ForeignKeyDef = {
    name: parseRequiredString(record.name, `${label}.name`),
    columns: parseIdentifierArray(record.columns, `${label}.columns`),
    referencedTable: parseRequiredString(
      record.referencedTable,
      `${label}.referencedTable`
    ),
    referencedColumns: parseIdentifierArray(
      record.referencedColumns,
      `${label}.referencedColumns`
    ),
  };
  if ("onDelete" in record) {
    foreignKey.onDelete = parseMember(
      record.onDelete,
      REFERENTIAL_ACTIONS,
      `${label}.onDelete is not a referential action`
    );
  }
  if ("onUpdate" in record) {
    foreignKey.onUpdate = parseMember(
      record.onUpdate,
      REFERENTIAL_ACTIONS,
      `${label}.onUpdate is not a referential action`
    );
  }
  return foreignKey;
}

function parseUniqueConstraint(
  value: unknown,
  label: string
): UniqueConstraintDef {
  const record = exactObject(
    value,
    UNIQUE_CONSTRAINT_KEYS,
    UNIQUE_CONSTRAINT_KEYS,
    label
  );
  return {
    name: parseRequiredString(record.name, `${label}.name`),
    columns: parseIdentifierArray(record.columns, `${label}.columns`),
  };
}

function parseRelationStorage(
  value: unknown,
  label: string
): Readonly<Record<string, PolymorphicToOneStorageRegistryEntry>> {
  if (!isRecord(value)) refuse(`${label} must be an object`);
  const entries: Record<string, PolymorphicToOneStorageRegistryEntry> = {};
  for (const [storageRef, rawEntry] of Object.entries(value)) {
    const entryLabel = `${label}.${storageRef}`;
    const record = exactObject(
      rawEntry,
      RELATION_STORAGE_KEYS,
      RELATION_STORAGE_KEYS,
      entryLabel
    );
    if (record.kind !== "polymorphicToOne") {
      refuse(`${entryLabel}.kind must be polymorphicToOne`);
    }
    Object.defineProperty(entries, storageRef, {
      configurable: true,
      enumerable: true,
      value: {
        kind: "polymorphicToOne",
        typeColumn: parseRequiredString(
          record.typeColumn,
          `${entryLabel}.typeColumn`
        ),
        idColumn: parseRequiredString(
          record.idColumn,
          `${entryLabel}.idColumn`
        ),
        index: parseRequiredString(record.index, `${entryLabel}.index`),
      },
      writable: true,
    });
  }
  return entries;
}

function parseTable(value: unknown, label: string): TableDef {
  const record = exactObject(value, TABLE_KEYS, TABLE_REQUIRED_KEYS, label);
  if (!Array.isArray(record.columns))
    refuse(`${label}.columns must be an array`);
  if (!Array.isArray(record.indexes))
    refuse(`${label}.indexes must be an array`);
  if (!Array.isArray(record.foreignKeys)) {
    refuse(`${label}.foreignKeys must be an array`);
  }
  if (!Array.isArray(record.uniqueConstraints)) {
    refuse(`${label}.uniqueConstraints must be an array`);
  }
  const table: TableDef = {
    name: parseRequiredString(record.name, `${label}.name`),
    columns: parseItems(record.columns, `${label}.columns`, parseColumn),
    indexes: parseItems(record.indexes, `${label}.indexes`, parseIndex),
    foreignKeys: parseItems(
      record.foreignKeys,
      `${label}.foreignKeys`,
      parseForeignKey
    ),
    uniqueConstraints: parseItems(
      record.uniqueConstraints,
      `${label}.uniqueConstraints`,
      parseUniqueConstraint
    ),
  };
  if ("primaryKey" in record) {
    table.primaryKey = parsePrimaryKey(
      record.primaryKey,
      `${label}.primaryKey`
    );
  }
  if ("relationStorage" in record) {
    table.relationStorage = parseRelationStorage(
      record.relationStorage,
      `${label}.relationStorage`
    );
  }
  if (record.junction === true) table.junction = true;
  return table;
}

function parseEnum(value: unknown, label: string): EnumDef {
  const record = exactObject(value, ENUM_KEYS, ENUM_KEYS, label);
  return {
    name: parseRequiredString(record.name, `${label}.name`),
    values: parseStringArray(record.values, `${label}.values`),
  };
}

/** Strictly ascending: each once, in the one order a snapshot writes them. */
function ascending(names: readonly string[]): boolean {
  return names.every((name, index) => index === 0 || names[index - 1]! < name);
}

/** What keeps a view kept by triggers, as the serializer writes it: every member, its objects sorted. */
function parseAutoView(value: unknown, label: string): AutoViewDef {
  const record = exactObject(value, AUTO_VIEW_KEYS, AUTO_VIEW_KEYS, label);
  if (!Array.isArray(record.objects) || record.objects.length === 0)
    refuse(`${label}.objects must be a non-empty array`);
  const objects = parseItems(
    record.objects,
    `${label}.objects`,
    (item, itemLabel): AutoViewObject => {
      const object = exactObject(
        item,
        AUTO_OBJECT_KEYS,
        ["kind", "name"],
        itemLabel
      );
      return {
        kind: parseMember(
          object.kind,
          AUTO_OBJECT_KINDS,
          `${itemLabel}.kind is not a kind of object`
        ),
        name: parseRequiredString(object.name, `${itemLabel}.name`),
        ...("table" in object
          ? { table: parseRequiredString(object.table, `${itemLabel}.table`) }
          : {}),
      };
    }
  );
  if (JSON.stringify(sortAutoViewObjects(objects)) !== JSON.stringify(objects))
    refuse(`${label}.objects must be sorted by kind, then name`);
  const storage = exactObject(
    record.storage,
    AUTO_STORAGE_KEYS,
    ["columns", "grouped", "key", "reads", "source", "sourceKey"],
    `${label}.storage`
  );
  if (!Array.isArray(storage.columns) || storage.columns.length === 0)
    refuse(`${label}.storage.columns must be a non-empty array`);
  if (typeof storage.grouped !== "boolean")
    refuse(`${label}.storage.grouped must be boolean`);
  const reads = parseIdentifierArray(storage.reads, `${label}.storage.reads`);
  if (!ascending(reads))
    refuse(`${label}.storage.reads must be sorted, each name once`);
  const parsed: AutoViewStorage = {
    source: parseRequiredString(storage.source, `${label}.storage.source`),
    columns: parseItems(
      storage.columns,
      `${label}.storage.columns`,
      parseColumn
    ),
    key: parseIdentifierArray(storage.key, `${label}.storage.key`),
    sourceKey: parseIdentifierArray(
      storage.sourceKey,
      `${label}.storage.sourceKey`
    ),
    grouped: storage.grouped,
    reads,
  };
  if ("keyed" in storage) {
    const keyed = exactObject(
      storage.keyed,
      AUTO_KEYED_KEYS,
      AUTO_KEYED_KEYS,
      `${label}.storage.keyed`
    );
    parsed.keyed = {
      OLD: parseRequiredString(keyed.OLD, `${label}.storage.keyed.OLD`),
      NEW: parseRequiredString(keyed.NEW, `${label}.storage.keyed.NEW`),
    };
  }
  if ("cascades" in storage) {
    if (!Array.isArray(storage.cascades) || storage.cascades.length === 0)
      refuse(
        `${label}.storage.cascades must be a non-empty array when present`
      );
    parsed.cascades = parseItems(
      storage.cascades,
      `${label}.storage.cascades`,
      (item, itemLabel): AutoViewCascade => {
        const cascade = exactObject(
          item,
          AUTO_CASCADE_KEYS,
          AUTO_CASCADE_KEYS,
          itemLabel
        );
        if (!Array.isArray(cascade.children) || cascade.children.length === 0)
          refuse(`${itemLabel}.children must be a non-empty array`);
        return {
          table: parseRequiredString(cascade.table, `${itemLabel}.table`),
          trigger: parseRequiredString(cascade.trigger, `${itemLabel}.trigger`),
          children: parseItems(
            cascade.children,
            `${itemLabel}.children`,
            (child, childLabel) => {
              const entry = exactObject(
                child,
                AUTO_CHILD_KEYS,
                AUTO_CHILD_KEYS,
                childLabel
              );
              return {
                table: parseRequiredString(entry.table, `${childLabel}.table`),
                columns: parseIdentifierArray(
                  entry.columns,
                  `${childLabel}.columns`
                ),
                referencedColumns: parseIdentifierArray(
                  entry.referencedColumns,
                  `${childLabel}.referencedColumns`
                ),
                action: parseMember(
                  entry.action,
                  AUTO_ACTIONS,
                  `${childLabel}.action is not a cascade's`
                ),
              };
            }
          ),
        };
      }
    );
  }
  return { objects, storage: parsed };
}

function parseView(value: unknown, label: string): ViewDef {
  const record = exactObject(value, VIEW_KEYS, VIEW_REQUIRED_KEYS, label);
  if (!isViewHash(record.hash))
    refuse(`${label}.hash must be 40 lowercase hex characters`);
  const dependsOn = parseIdentifierArray(
    record.dependsOn,
    `${label}.dependsOn`
  );
  if (!ascending(dependsOn))
    refuse(`${label}.dependsOn must be sorted, each name once`);
  const view: ViewDef = {
    name: parseRequiredString(record.name, `${label}.name`),
    hash: record.hash,
    sql: parseRequiredString(record.sql, `${label}.sql`),
    dependsOn,
  };
  // Each present only as the serializer writes it: `true`, and indexes on a
  // materialized view alone, never an empty list.
  if ("materialized" in record) {
    if (record.materialized !== true)
      refuse(`${label}.materialized must be true when present`);
    view.materialized = true;
  }
  if ("auto" in record) {
    if (view.materialized)
      refuse(`${label} is materialized or kept by triggers, not both`);
    view.auto = parseAutoView(record.auto, `${label}.auto`);
  }
  if ("indexes" in record) {
    if (!(view.materialized || view.auto))
      refuse(`${label}.indexes belong to a materialized view`);
    if (!Array.isArray(record.indexes) || record.indexes.length === 0)
      refuse(`${label}.indexes must be a non-empty array when present`);
    view.indexes = parseItems(record.indexes, `${label}.indexes`, parseIndex);
  }
  return view;
}

function parseToOneMember(
  value: unknown,
  label: string
): PolymorphicToOneSnapshotMember {
  const record = exactObject(
    value,
    POLYMORPHIC_TO_ONE_MEMBER_KEYS,
    POLYMORPHIC_TO_ONE_MEMBER_KEYS,
    label
  );
  return {
    publicType: parseRequiredString(record.publicType, `${label}.publicType`),
    storedType: parseRequiredString(record.storedType, `${label}.storedType`),
    targetTable: parseRequiredString(
      record.targetTable,
      `${label}.targetTable`
    ),
  };
}

function parseToManyMember(
  value: unknown,
  label: string
): PolymorphicToManySnapshotMember {
  const record = exactObject(
    value,
    POLYMORPHIC_TO_MANY_MEMBER_KEYS,
    POLYMORPHIC_TO_MANY_MEMBER_KEYS,
    label
  );
  if (
    record.inverseCardinality !== "one" &&
    record.inverseCardinality !== "many"
  ) {
    refuse(`${label}.inverseCardinality must be one or many`);
  }
  return {
    publicType: parseRequiredString(record.publicType, `${label}.publicType`),
    storedType: parseRequiredString(record.storedType, `${label}.storedType`),
    targetTable: parseRequiredString(
      record.targetTable,
      `${label}.targetTable`
    ),
    memberJunctionTable: parseRequiredString(
      record.memberJunctionTable,
      `${label}.memberJunctionTable`
    ),
    inverseCardinality: record.inverseCardinality,
  };
}

function parsePolymorphicStorage(
  value: unknown,
  label: string
): PolymorphicSnapshotStorage {
  if (!isRecord(value)) refuse(`${label} must be an object`);
  if (value.kind === "toOne") {
    const record = exactObject(
      value,
      POLYMORPHIC_TO_ONE_KEYS,
      POLYMORPHIC_TO_ONE_KEYS,
      label
    );
    if (!Array.isArray(record.members)) {
      refuse(`${label}.members must be an array`);
    }
    return {
      ownerTable: parseRequiredString(record.ownerTable, `${label}.ownerTable`),
      relation: parseRequiredString(record.relation, `${label}.relation`),
      kind: "toOne",
      storageRef: parseRequiredString(record.storageRef, `${label}.storageRef`),
      members: parseItems(record.members, `${label}.members`, parseToOneMember),
    };
  }
  if (value.kind === "toMany") {
    const record = exactObject(
      value,
      POLYMORPHIC_TO_MANY_KEYS,
      POLYMORPHIC_TO_MANY_KEYS,
      label
    );
    if (!Array.isArray(record.members)) {
      refuse(`${label}.members must be an array`);
    }
    return {
      ownerTable: parseRequiredString(record.ownerTable, `${label}.ownerTable`),
      relation: parseRequiredString(record.relation, `${label}.relation`),
      kind: "toMany",
      members: parseItems(
        record.members,
        `${label}.members`,
        parseToManyMember
      ),
    };
  }
  refuse(`${label}.kind must be toOne or toMany`);
}

export function parseSnapshotDocument(
  bytes: Uint8Array,
  expectedHash: Sha256
): SchemaSnapshot {
  const parsed = parseJsonBytes(bytes, `snapshots/${expectedHash}.json`);
  const record = exactObject(parsed, SNAPSHOT_KEYS, ["tables"], "snapshot");
  if (!Array.isArray(record.tables)) refuse("snapshot.tables must be an array");
  const snapshot: SchemaSnapshot = {
    tables: parseItems(record.tables, "snapshot.tables", parseTable),
  };
  if ("enums" in record) {
    if (!Array.isArray(record.enums)) refuse("snapshot.enums must be an array");
    snapshot.enums = parseItems(record.enums, "snapshot.enums", parseEnum);
  }
  if ("polymorphicStorage" in record) {
    if (!Array.isArray(record.polymorphicStorage)) {
      refuse("snapshot.polymorphicStorage must be an array");
    }
    snapshot.polymorphicStorage = record.polymorphicStorage.map(
      (storage, index) =>
        parsePolymorphicStorage(
          storage,
          `snapshot.polymorphicStorage[${index}]`
        )
    );
  }
  if ("views" in record) {
    if (!Array.isArray(record.views) || record.views.length === 0)
      refuse("snapshot.views must be a non-empty array when present");
    const views = parseItems(record.views, "snapshot.views", parseView);
    if (!ascending(views.map(({ name }) => name)))
      refuse("snapshot.views must be sorted by name, each name once");
    snapshot.views = views;
  }
  assertCanonicalBytes(bytes, snapshot, `snapshots/${expectedHash}.json`);
  const actual = domainHash(HASH_DOMAIN.snapshot, bytes);
  if (actual !== expectedHash) {
    throw new MigrationError(
      "snapshot filename does not match its canonical bytes",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return snapshot;
}

export function encodeSnapshot(snapshot: SchemaSnapshot): {
  bytes: Uint8Array;
  snapshotHash: Sha256;
} {
  const bytes = canonicalizeJson(omitUndefinedKeys(snapshot));
  return { bytes, snapshotHash: domainHash(HASH_DOMAIN.snapshot, bytes) };
}

function omitUndefinedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedKeys(item));
  }
  if (!isRecord(value)) return value;
  const admitted: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined) continue;
    admitted[key] = omitUndefinedKeys(item);
  }
  return admitted;
}
