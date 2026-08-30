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
import {
  exactObject,
  parseIdentifierArray,
  parseRequiredString,
  parseStringArray,
  refuse,
} from "./v1-parse-shared";

const SNAPSHOT_KEYS = ["enums", "polymorphicStorage", "tables"] as const;
const TABLE_KEYS = [
  "columns",
  "foreignKeys",
  "indexes",
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
  "decimal",
  "default",
  "name",
  "nullable",
  "type",
] as const;
const DECIMAL_KEYS = ["precision", "scale"] as const;
const PRIMARY_KEY_KEYS = ["columns", "name"] as const;
const INDEX_KEYS = ["columns", "name", "type", "unique", "where"] as const;
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
  return index;
}

function parseReferentialAction(
  value: unknown,
  label: string
): ReferentialAction {
  if (
    value === "cascade" ||
    value === "setNull" ||
    value === "restrict" ||
    value === "noAction" ||
    value === "setDefault"
  ) {
    return value;
  }
  refuse(`${label} is not a referential action`);
}

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
    foreignKey.onDelete = parseReferentialAction(
      record.onDelete,
      `${label}.onDelete`
    );
  }
  if ("onUpdate" in record) {
    foreignKey.onUpdate = parseReferentialAction(
      record.onUpdate,
      `${label}.onUpdate`
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
    columns: record.columns.map((column, index) =>
      parseColumn(column, `${label}.columns[${index}]`)
    ),
    indexes: record.indexes.map((index, position) =>
      parseIndex(index, `${label}.indexes[${position}]`)
    ),
    foreignKeys: record.foreignKeys.map((foreignKey, index) =>
      parseForeignKey(foreignKey, `${label}.foreignKeys[${index}]`)
    ),
    uniqueConstraints: record.uniqueConstraints.map((constraint, index) =>
      parseUniqueConstraint(constraint, `${label}.uniqueConstraints[${index}]`)
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
  return table;
}

function parseEnum(value: unknown, label: string): EnumDef {
  const record = exactObject(value, ENUM_KEYS, ENUM_KEYS, label);
  return {
    name: parseRequiredString(record.name, `${label}.name`),
    values: parseStringArray(record.values, `${label}.values`),
  };
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
      members: record.members.map((member, index) =>
        parseToOneMember(member, `${label}.members[${index}]`)
      ),
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
      members: record.members.map((member, index) =>
        parseToManyMember(member, `${label}.members[${index}]`)
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
    tables: record.tables.map((table, index) =>
      parseTable(table, `snapshot.tables[${index}]`)
    ),
  };
  if ("enums" in record) {
    if (!Array.isArray(record.enums)) refuse("snapshot.enums must be an array");
    snapshot.enums = record.enums.map((enumDef, index) =>
      parseEnum(enumDef, `snapshot.enums[${index}]`)
    );
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
