import { sqliteGeoPointEncoding } from "../adapters/databases/sqlite/storage/geo-point";
import { decodeProviderTimestamp } from "../validation/primitives/datetime-physical-codec";
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
  const tables = canonicalUniqueEntities(snapshot)
    .tables.map((table) => ({
      name: table.name,
      columns: table.columns
        .map((column) => ({
          name: column.name,
          type: normalizeType(column.type),
          nullable: column.nullable,
          default: normalizeDefault(column.default, column.type) ?? null,
          autoIncrement: column.autoIncrement ?? false,
          ...(sqliteGeoPointEncoding(column)
            ? { geoPointEncoding: sqliteGeoPointEncoding(column) }
            : {}),
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

/** A total btree unique index and a unique constraint enforce the same key. */
export function canonicalUniqueEntities(
  snapshot: SchemaSnapshot
): SchemaSnapshot {
  return {
    ...snapshot,
    tables: snapshot.tables.map((table) => ({
      ...table,
      uniqueConstraints: [
        ...table.uniqueConstraints,
        ...table.indexes
          .filter(
            (index) =>
              index.unique &&
              !index.where &&
              (!index.type || index.type === "btree")
          )
          .map((index) => ({ name: index.name, columns: index.columns })),
      ],
      indexes: table.indexes.filter(
        (index) =>
          !(
            index.unique &&
            !index.where &&
            (!index.type || index.type === "btree")
          )
      ),
    })),
  };
}

export function normalizeType(type: string): string {
  const tokens =
    type.trim().match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|[^'"]+/g) ?? [];
  return tokens
    .map((token) => {
      if (token.startsWith("'") || token.startsWith('"')) return token;
      return token
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ",")
        .replace(/\s+\[\]/g, "[]")
        .replace(/\bcharacter varying\b/g, "varchar")
        .replace(/\bcharacter\b/g, "char")
        .replace(/\bbit varying\b/g, "varbit")
        .replace(/\btimestamptz(\(\d+\))?/g, "timestamp$1 with time zone")
        .replace(/\btimetz(\(\d+\))?/g, "time$1 with time zone")
        .replace(/\b(timestamp|time)(\(\d+\))? without time zone/g, "$1$2")
        .replace(/\bint4\b/g, "integer")
        .replace(/\bint8\b/g, "bigint")
        .replace(/\bint2\b/g, "smallint")
        .replace(/\bfloat4\b/g, "real")
        .replace(/\bfloat8\b/g, "double precision")
        .replace(/\bbool\b/g, "boolean");
    })
    .join("");
}

const UTC_NOW_DEFAULT =
  /^(?:now\(\) at time zone 'utc'|timezone\(\s*'utc'\s*,\s*now\(\)\s*\))$/;
const MILLISECOND_NOW_DEFAULT =
  /^date_trunc\(\s*'milliseconds'\s*,([\s\S]+)\)$/;
const UTC_CURRENT_TIME_DEFAULT = /^timezone\(\s*'utc'\s*,\s*current_time\s*\)$/;
const NUMERIC_PHYSICAL_TYPE =
  /^(integer|bigint|smallint|real|double precision|float|int|tinyint)/;
const INTEGER_LITERAL = /^[-+]?\d+$/;
const TEMPORAL_PHYSICAL_TYPE = /^(timestamp|time|date)/;
const ISO_UTC_SUFFIX = /Z$/;
const TEMPORAL_UTC_SUFFIX = /(?:Z|[+]00(?::00)?)$/;
const MINUTE_CLOCK_SUFFIX = /(^| )(\d{2}:\d{2})(?=$|[+-])/;
const TRAILING_FRACTION_ZEROES = /(\.\d*?)0+(?=$|[+-])/;
const EMPTY_FRACTION = /\.(?=$|[+-])/;
const BARE_FUNCTION_DEFAULT = /^[a-z_][a-z0-9_]*\(\)$/;
const NUMBER_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function stripDefaultParentheses(value: string): string {
  let text = value.trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    const structural = text.replace(
      /'(?:[^']|'')*'|"(?:[^"]|"")*"/g,
      (literal) => " ".repeat(literal.length)
    );
    let depth = 0;
    let whole = true;
    for (let index = 0; index < structural.length; index++) {
      if (structural[index] === "(") depth++;
      else if (structural[index] === ")") depth--;
      if (depth === 0 && index < structural.length - 1) {
        whole = false;
        break;
      }
    }
    if (!whole || depth !== 0) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

export function normalizeDefault(
  value: string | undefined,
  type?: string
): string | undefined {
  if (value === undefined) return;
  const spelling = stripDefaultParentheses(value);
  const normalized = spelling.toLowerCase();
  if (normalized === "null") return;
  const utcNow = normalized
    .replaceAll("::text", "")
    .replaceAll("current_timestamp", "now()");
  if (UTC_NOW_DEFAULT.test(utcNow)) return "now() at time zone 'utc'";
  const truncated = MILLISECOND_NOW_DEFAULT.exec(utcNow);
  if (truncated?.[1]) {
    const clock = normalizeDefault(truncated[1], type);
    if (clock === "now()" || clock === "now() at time zone 'utc'")
      return `date_trunc('milliseconds',${clock})`;
  }
  if (UTC_CURRENT_TIME_DEFAULT.test(utcNow))
    return "timezone('utc',current_time)";
  if (normalized === "current_timestamp" || normalized === "now()")
    return "now()";
  const boolean = type === undefined || normalizeType(type) === "boolean";
  if (
    boolean &&
    (normalized === "true" || normalized === "'t'" || normalized === "1")
  )
    return "true";
  if (
    boolean &&
    (normalized === "false" || normalized === "'f'" || normalized === "0")
  )
    return "false";
  if (BARE_FUNCTION_DEFAULT.test(normalized)) return normalized;
  const unquoted =
    normalized.startsWith("'") && normalized.endsWith("'")
      ? normalized.slice(1, -1)
      : normalized;
  const physical = type === undefined ? "" : normalizeType(type);
  if (NUMERIC_PHYSICAL_TYPE.test(physical) && NUMBER_LITERAL.test(unquoted)) {
    return INTEGER_LITERAL.test(unquoted)
      ? BigInt(unquoted).toString()
      : String(Number(unquoted));
  }
  if (
    TEMPORAL_PHYSICAL_TYPE.test(physical) &&
    spelling.startsWith("'") &&
    spelling.endsWith("'")
  ) {
    let temporal = spelling
      .slice(1, -1)
      .replace("T", " ")
      .replace(ISO_UTC_SUFFIX, "+00:00");
    const era = temporal.endsWith(" BC") ? " BC" : "";
    if (era) temporal = temporal.slice(0, -3);
    if (
      physical.includes("with time zone") &&
      physical.startsWith("timestamp")
    ) {
      const instant = decodeProviderTimestamp(`${temporal}${era}`);
      if (instant) return instant.toISOString();
    }
    temporal = temporal
      .replace(TEMPORAL_UTC_SUFFIX, "")
      .replace(MINUTE_CLOCK_SUFFIX, "$1$2:00")
      .replace(TRAILING_FRACTION_ZEROES, "$1")
      .replace(EMPTY_FRACTION, "");
    return `${temporal}${era}`;
  }
  return spelling;
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
