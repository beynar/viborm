/**
 * Where a DECLARED identifier domain is read from, and how it becomes a column.
 *
 * There is no second declaration: `ScalarState.autoGenerate` — the same record
 * `.uuid()`, `.ulid()`, `.ksuid()`, `.nanoid()` and `.cuid()` already write —
 * IS the domain. This module only projects it into the shape the codec takes,
 * and answers the one storage question the projection cannot: which physical
 * representation and which column spelling this domain has on a given dialect,
 * with a native type override taken into account.
 *
 * Storage lives HERE rather than in the codec because it is the only part of
 * the identifier language that speaks a dialect's vocabulary. The codec below
 * it stays pure — it takes a representation, never a provider — so the
 * validation schemas, which run long before any adapter exists, can use it.
 */

import {
  type IdDomain,
  type IdFormat,
  type IdRepresentation,
  idByteLength,
  isIdFormat,
} from "@validation/primitives/id-codec";
import type { AutoGenerate, ScalarState } from "../common";
import { MYSQL, type NativeType, PG, SQLITE } from "../native-types";

// =============================================================================
// THE DECLARED DOMAIN
// =============================================================================

const DOMAINS = new WeakMap<ScalarState, IdDomain>();

/**
 * The identifier domain a scalar state declares, or `undefined`.
 *
 * Only a NAMED format declares one. `.id()` installs a ULID generator without
 * naming a format (see {@link AutoGenerate.implicit}), so a `.id()` key has no
 * domain: nothing admits its values and nothing narrows its storage.
 *
 * A LIST answers `undefined` deliberately, exactly as the decimal descriptor
 * lookup does: every path that asks this question — admission, parameter
 * encoding, projection, decode, DDL — is a path a list of strings does not
 * have, and answering with the member's domain would bind a whole container as
 * one identifier.
 *
 * The projection is memoized per state so the hot write path compares and
 * encodes against one object instead of allocating a domain per value.
 */
export function idDomainOfState(
  state: ScalarState | undefined
): IdDomain | undefined {
  if (state === undefined || state.type !== "string" || state.array === true) {
    return undefined;
  }
  const existing = DOMAINS.get(state);
  if (existing) return existing;
  const generate = state.autoGenerate;
  if (generate === undefined || !isIdFormat(generate.kind)) return undefined;
  // A format the caller did not NAME is not a domain the caller asserted:
  // `.id()` declares a key and carries a generator for convenience, and its
  // values stay whatever a string column holds. `.ulid().id()` names the
  // format and gets the domain, the admission and the compact column.
  if (generate.implicit === true) return undefined;
  const domain: IdDomain = {
    format: generate.kind,
    prefix: generate.prefix,
    length: generate.length,
  };
  DOMAINS.set(state, domain);
  return domain;
}

// =============================================================================
// PHYSICAL STORAGE
// =============================================================================

/** The three dialects a column spelling is asked for. */
export type IdDialect = NativeType["db"];

/** What one domain is physically, on one dialect. */
export interface IdStorage {
  readonly representation: IdRepresentation;
  /** The column type this dialect spells it with. */
  readonly columnType: string;
}

// `char(n)` is absent deliberately. PostgreSQL BLANK-PADS `character(n)` to its
// full width, so a 36-character uuid in a `char(40)` column reads back with four
// trailing spaces and no value of the domain is ever returned — the column is
// unusable from the moment it is created, for every n wider than the format's
// own public spelling. MySQL's `CHAR(n)` pads on the way in and STRIPS on the
// way out, so it keeps its place in that dialect's list.
const PG_TEXT_FAMILY = /^(?:text|citext|varchar\(\d+\))$/;
const MYSQL_TEXT_FAMILY =
  /^(?:TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|VARCHAR\(\d+\)|CHAR\(\d+\))$/;
const SQLITE_TEXT_FAMILY = /^TEXT$/;
const MYSQL_SIZED_BINARY = /^(?:BINARY|VARBINARY)\((\d+)\)$/;

/** The default column spelling and representation, before any override. */
function defaultIdStorage(format: IdFormat, dialect: IdDialect): IdStorage {
  const width = idByteLength(format);
  if (width === undefined) {
    // `nanoid` and `cuid` keep the text column the dialect already gave them.
    switch (dialect) {
      case "pg":
        return { representation: "text", columnType: PG.STRING.TEXT.type };
      case "mysql":
        return { representation: "text", columnType: "TEXT" };
      default:
        return {
          representation: "text",
          columnType: SQLITE.STRING.TEXT.type,
        };
    }
  }
  switch (dialect) {
    case "pg":
      // A UUID gets PostgreSQL's own 16-byte type, which the wire spells as
      // canonical text. A ULID is never spelled `uuid`: its bytes are not a
      // UUID's and a database that formatted them as one would publish a
      // version nibble the value does not have.
      return format === "uuid" || format === "uuidv7"
        ? { representation: "uuid", columnType: PG.STRING.UUID.type }
        : { representation: "bytes", columnType: PG.BLOB.BYTEA.type };
    case "mysql":
      return {
        representation: "bytes",
        columnType: MYSQL.BLOB.BINARY(width).type,
      };
    default:
      return { representation: "bytes", columnType: SQLITE.BLOB.BLOB.type };
  }
}

/** Whether this dialect spells `type` as one of its text column types. */
function isTextColumnType(type: string, dialect: IdDialect): boolean {
  switch (dialect) {
    case "pg":
      return PG_TEXT_FAMILY.test(type);
    case "mysql":
      return MYSQL_TEXT_FAMILY.test(type);
    default:
      return SQLITE_TEXT_FAMILY.test(type);
  }
}

/**
 * The representation a BINARY-family override names for this format, or
 * `undefined` when the override is not a binary column this domain fits.
 *
 * A sized MySQL column must be the format's exact width: `BINARY(16)` holds a
 * KSUID's first sixteen bytes and pads a ULID that was never short, and both
 * are silent corruptions rather than storage choices. `bytea` and `BLOB` carry
 * no declared width, so the codec's exact-width encoding is the only promise
 * they need.
 */
function binaryRepresentation(
  type: string,
  format: IdFormat,
  dialect: IdDialect
): IdRepresentation | undefined {
  const width = idByteLength(format);
  if (width === undefined) return undefined;
  if (dialect === "pg") {
    if (type === PG.BLOB.BYTEA.type) return "bytes";
    return type === PG.STRING.UUID.type &&
      (format === "uuid" || format === "uuidv7")
      ? "uuid"
      : undefined;
  }
  if (dialect === "sqlite") {
    return type === SQLITE.BLOB.BLOB.type ? "bytes" : undefined;
  }
  if (type === MYSQL.BLOB.BLOB.type) return "bytes";
  const sized = MYSQL_SIZED_BINARY.exec(type);
  return sized && Number(sized[1]) === width ? "bytes" : undefined;
}

/**
 * The column spelling and representation of one domain on one dialect.
 *
 * The ONE owner of that decision: the migration type mapping, the parameter
 * encoding, the read projection and the result decode all derive from this, so
 * a column cannot be created as one thing and written as another.
 *
 * A native type for ANOTHER dialect is not this dialect's column and is ignored
 * exactly as every other scalar's mapping ignores it. An override that IS this
 * dialect's and that this domain cannot live in returns `undefined` — the
 * schema boundary refuses it by name long before a query is built, and this
 * answering `undefined` rather than guessing is what keeps that refusal the
 * only place the question is decided.
 */
export function idStorageOf(
  domain: IdDomain,
  nativeType: NativeType | undefined,
  dialect: IdDialect
): IdStorage | undefined {
  if (nativeType === undefined || nativeType.db !== dialect) {
    return defaultIdStorage(domain.format, dialect);
  }
  const type = nativeType.type;
  if (isTextColumnType(type, dialect)) {
    // The opt-out for a column that already holds text: the domain is still
    // admitted and normalized, only its storage stays as it was.
    return { representation: "text", columnType: type };
  }
  const representation = binaryRepresentation(type, domain.format, dialect);
  return representation === undefined
    ? undefined
    : { representation, columnType: type };
}

/** The overrides this domain accepts on this dialect, for a refusal message. */
export function describeIdNativeTypes(
  format: IdFormat,
  dialect: IdDialect
): string {
  const width = idByteLength(format);
  const text =
    dialect === "pg"
      ? "text, citext, varchar(n)"
      : dialect === "mysql"
        ? "TEXT, TINYTEXT, MEDIUMTEXT, LONGTEXT, VARCHAR(n), CHAR(n)"
        : "TEXT";
  if (width === undefined) return text;
  const binary =
    dialect === "pg"
      ? format === "uuid" || format === "uuidv7"
        ? "uuid, bytea"
        : "bytea"
      : dialect === "mysql"
        ? `BINARY(${width}), VARBINARY(${width}), BLOB`
        : "BLOB";
  return `${binary}, ${text}`;
}
