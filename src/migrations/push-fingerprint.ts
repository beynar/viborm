/**
 * Live schema fingerprint and push target identity.
 *
 * `bindingId` is minted from the original client driver, never a pinned
 * producer. This module hashes the snapshot it is given; callers strip
 * control tables before fingerprinting.
 */

import { randomUUID } from "node:crypto";
import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import { isRecord } from "../validation/value-guards";
import { canonicalizeJson, canonicalizeJsonText } from "./canonical-json";
import type { IndexPredicateCanonicalizer } from "./differ";
import type { BoundMigrationDriver, MigrationDriver } from "./drivers";
import { domainHash, HASH_DOMAIN, type Sha256 } from "./identity";
import type { MigrationClient } from "./push/planner";
import type { SchemaSnapshot, TableDef } from "./types";
import { encodeSnapshot } from "./v1-parse-snapshot";
import type { PushTargetIdentity } from "./v1-types";

const BINDINGS = new WeakMap<object, string>();

export function bindingId(client: MigrationClient): string {
  const existing = BINDINGS.get(client.$driver);
  if (existing) return existing;
  const id = randomUUID();
  BINDINGS.set(client.$driver, id);
  return id;
}

export async function pushTargetIdentity(
  client: MigrationClient,
  producer: AnyDriver,
  driver: BoundMigrationDriver
): Promise<PushTargetIdentity> {
  const id = bindingId(client);
  if (driver.target.dialect === "postgresql") {
    const result = await producer._executeRaw<{ database: unknown }>(
      "SELECT current_database() AS database"
    );
    const database = result.rows[0]?.database;
    if (typeof database !== "string" || database.length === 0) {
      throw new MigrationError(
        "PostgreSQL did not return its current database identity",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
    return {
      dialect: "postgresql",
      database,
      namespace: driver.namespace ?? driver.target.namespace,
      bindingId: id,
    };
  }
  if (driver.target.dialect === "mysql") {
    if (!driver.namespace) {
      throw new MigrationError(
        "MySQL push has no resolved database identity",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
    return {
      dialect: "mysql",
      database: driver.namespace,
      bindingId: id,
    };
  }
  return { dialect: "sqlite", location: null, bindingId: id };
}

export function hashSnapshot(snapshot: SchemaSnapshot): Sha256 {
  return encodeSnapshot(snapshot).snapshotHash;
}

export function bindIndexPredicateCanonicalizer(
  producer: AnyDriver,
  driver: MigrationDriver
): IndexPredicateCanonicalizer | undefined {
  const canonicalize = driver.canonicalizeIndexPredicates;
  if (!canonicalize) return;
  return async (tableName, predicates) => {
    try {
      return await canonicalize.call(
        driver,
        tableName,
        predicates,
        (sql, params) => producer._executeRaw(sql, params)
      );
    } catch {
      return predicates.map(() => undefined);
    }
  };
}

export async function canonicalizeSnapshotPredicates(
  snapshot: SchemaSnapshot,
  canonicalize: IndexPredicateCanonicalizer | undefined
): Promise<SchemaSnapshot> {
  if (!canonicalize) return snapshot;
  const tables: TableDef[] = [];
  for (const table of snapshot.tables) {
    const pending = table.indexes.filter((index) => index.where);
    if (pending.length === 0) {
      tables.push(table);
      continue;
    }
    const predicates = pending.map((index) => index.where!);
    const spellings = await canonicalize(table.name, predicates);
    let next = 0;
    tables.push({
      ...table,
      indexes: table.indexes.map((index) => {
        if (!index.where) return index;
        const spelling = spellings[next++];
        return spelling === undefined ? index : { ...index, where: spelling };
      }),
    });
  }
  return { ...snapshot, tables };
}

export async function fingerprintLive(
  snapshot: SchemaSnapshot,
  driver: MigrationDriver,
  producer: AnyDriver
): Promise<Sha256> {
  return fingerprintSnapshot(
    await canonicalizeSnapshotPredicates(
      snapshot,
      bindIndexPredicateCanonicalizer(producer, driver)
    ),
    driver
  );
}

export function fingerprintSnapshot(
  snapshot: SchemaSnapshot,
  driver: MigrationDriver
): Sha256 {
  const tables = snapshot.tables
    .map((table) => ({
      name: table.name,
      columns: table.columns
        .map((column) => ({
          name: column.name,
          type: normalizeType(column.type),
          nullable: column.nullable,
          default: normalizeDefault(column.default) ?? null,
          autoIncrement: column.autoIncrement ?? false,
        }))
        .sort(byName),
      primaryKey: table.primaryKey
        ? {
            columns: table.primaryKey.columns,
            ...(driver.dialect === "postgresql"
              ? { name: table.primaryKey.name || `${table.name}_pkey` }
              : {}),
          }
        : null,
      indexes: table.indexes
        .map((index) => ({
          name: index.name,
          columns: index.columns,
          unique: index.unique ?? false,
          type: index.type ?? "btree",
          where: index.where?.trim() || null,
        }))
        .sort(byName),
      foreignKeys: table.foreignKeys
        .map((foreignKey) => ({
          name: driver.capabilities.introspectionReadsConstraintNames
            ? foreignKey.name
            : null,
          columns: foreignKey.columns,
          referencedTable: foreignKey.referencedTable,
          referencedColumns: foreignKey.referencedColumns,
          onDelete: foreignKey.onDelete ?? "noAction",
          onUpdate: foreignKey.onUpdate ?? "noAction",
        }))
        .sort(byCanonicalValue),
      uniqueConstraints: table.uniqueConstraints
        .map((constraint) => ({
          name: driver.capabilities.introspectionReadsConstraintNames
            ? constraint.name
            : null,
          columns: constraint.columns,
        }))
        .sort(byCanonicalValue),
    }))
    .sort(byName);
  const enums = [...(snapshot.enums ?? [])]
    .map((item) => ({ name: item.name, values: item.values }))
    .sort(byName);
  return domainHash(HASH_DOMAIN.snapshot, canonicalizeJson({ tables, enums }));
}

export function normalizeType(type: string): string {
  const normalized = type.toLowerCase().replace(/\s+/g, " ").trim();
  const array = normalized.endsWith("[]");
  const base = array ? normalized.slice(0, -2).trim() : normalized;
  const aliases: Record<string, string> = {
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    float4: "real",
    float8: "double precision",
    bool: "boolean",
    timestamptz: "timestamp with time zone",
    timetz: "time with time zone",
  };
  const mapped = aliases[base] ?? base;
  return array ? `${mapped}[]` : mapped;
}

const BARE_FUNCTION_DEFAULT = /^[a-z_][a-z0-9_]*\(\)$/;

export function normalizeDefault(
  value: string | undefined
): string | undefined {
  if (value === undefined) return;
  const normalized = value.trim().toLowerCase();
  if (normalized === "null") return;
  if (normalized === "true" || normalized === "'t'" || normalized === "1") {
    return "true";
  }
  if (normalized === "false" || normalized === "'f'" || normalized === "0") {
    return "false";
  }
  if (BARE_FUNCTION_DEFAULT.test(normalized)) {
    return normalized;
  }
  return value;
}

export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = canonicalValue(item);
    }
    return result;
  }
  return value;
}

export function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const member of Object.values(value)) freezeDeep(member);
  return Object.freeze(value);
}

function byName(
  left: { readonly name: string },
  right: { readonly name: string }
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function byCanonicalValue(left: unknown, right: unknown): number {
  const a = canonicalizeJsonText(left);
  const b = canonicalizeJsonText(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
