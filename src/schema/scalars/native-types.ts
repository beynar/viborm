// Native Database Type Overrides
// Provides typed constants for database-specific column types

// =============================================================================
// NATIVE TYPE INTERFACE
// =============================================================================

export interface NativeType {
  readonly db: "pg" | "mysql" | "sqlite";
  readonly type: string;
}

/** The three dialects a native type can name. */
export type NativeDialect = NativeType["db"];

/**
 * A native type of ONE dialect — what every `PG` / `MYSQL` / `SQLITE` constant
 * is, parameterized ones included, so `PG.STRING.VARCHAR(80)` can fill a `pg`
 * entry of a {@link NativeTypeMap} and cannot fill a `mysql` one.
 */
export interface DialectNativeType<Dialect extends NativeDialect>
  extends NativeType {
  readonly db: Dialect;
}

/**
 * One scalar's native type on each dialect it names:
 * `s.string({ pg: PG.STRING.CITEXT, mysql: MYSQL.STRING.LONGTEXT })`.
 *
 * A dialect the map leaves out keeps that scalar's automatic column, exactly
 * as a tagged {@link NativeType} leaves every OTHER dialect's column alone.
 */
export interface NativeTypeMap {
  readonly pg?: DialectNativeType<"pg">;
  readonly mysql?: DialectNativeType<"mysql">;
  readonly sqlite?: DialectNativeType<"sqlite">;
}

/**
 * What a scalar factory's native-type argument declares: the tagged shorthand
 * (one dialect) or a {@link NativeTypeMap} (several). Scalars store the
 * declaration in the form it was written, so a schema document restates it
 * faithfully; every PHYSICAL reader asks {@link nativeTypeFor} instead of
 * inspecting the form.
 */
export type NativeTypeDeclaration = NativeType | NativeTypeMap;

/** Every dialect, in the order a per-dialect question visits them. */
export const NATIVE_DIALECTS: readonly NativeDialect[] = [
  "pg",
  "mysql",
  "sqlite",
];

/** Whether a declaration is the tagged shorthand rather than a map. */
export const isTaggedNativeType = (
  declaration: NativeTypeDeclaration
): declaration is NativeType => "db" in declaration;

/**
 * The native type a declaration selects on one dialect, or `undefined` for the
 * dialect's automatic column.
 *
 * The ONE bound-dialect resolver. A migration driver, an adapter and the
 * identifier storage owner each know which dialect they speak and ask this;
 * none of them reads the declaration's form. A tagged shorthand for another
 * dialect is that dialect's automatic column, as it always was.
 */
export function nativeTypeFor(
  declaration: NativeTypeDeclaration | undefined,
  dialect: NativeDialect
): NativeType | undefined {
  if (declaration === undefined) return undefined;
  if (isTaggedNativeType(declaration)) {
    return declaration.db === dialect ? declaration : undefined;
  }
  return declaration[dialect];
}

/**
 * A scalar factory's native-type argument: the tagged shorthand of dialect
 * `Db`, or the map `Given`, which the factory bounds by
 * {@link ExactNativeTypeMap}.
 *
 * The tagged shorthand keeps its historical shape: a `NativeType`, a union of
 * them, a generic `T extends NativeType`, a custom `type`, or one with unrelated
 * extra keys held in a variable all still compile, a fresh literal with an extra
 * key is still an excess-property error, and a value missing `db` or `type` is
 * still refused — except that a dialect key BESIDE its `db` is refused, since
 * that object would be two declarations at once.
 *
 * `Db` is inferred from a tagged value's `db` only so that TypeScript counts the
 * value as matched by this first member and keeps it out of `Given`: an
 * argument reaches `Given` only when it is not tagged, and `Given` is naked so
 * a union-typed argument (`NativeType | NativeTypeMap`) reaches it whole.
 */
export type NativeTypeArgument<Db extends NativeDialect, Given> =
  | (DialectNativeType<Db> & Partial<Record<NativeDialect, never>>)
  | Given;

/**
 * The bound of a factory's `Given`: every key a dialect, each entry a native
 * type of its own key's dialect, and at least one dialect key. `{ type: "text" }`,
 * `{ postgres: … }`, `{}` and a `Date` are refused; an unknown key is refused
 * beside a real one, fresh and held in a variable. An argument that fails the
 * bound is refused against the bound itself, which is TypeScript's fallback.
 *
 * The exactness is a homomorphic mapped type, so it judges each member of a
 * union-typed map on its own. Measured traps (TS 7.0.2) that shaped it: a
 * generic CONSTRAINED to the weak `NativeTypeMap` falls back to that weak type
 * and admitted `{ foo: 1 }` and a `Date`; a parameter spelled `Given & NoInfer<…>`
 * makes TypeScript infer one member of a union argument; and a bound that is a
 * conditional type distributing over `Given` is a circular constraint (TS2313).
 * The at-least-one test is therefore not distributive: a union of maps with no
 * dialect key in COMMON is refused — annotate such a variable `NativeTypeMap`.
 */
export type ExactNativeTypeMap<Given> = {
  [Key in keyof Given]: Key extends NativeDialect
    ? DialectNativeType<Key>
    : never;
} & ([keyof Given & NativeDialect] extends [never] ? never : unknown);

// =============================================================================
// CONSTANT BUILDERS
// =============================================================================

/** A fixed native type: its `db` and `type` keep their literal types. */
const fixed =
  <const Db extends NativeDialect>(db: Db) =>
  <const Type extends string>(type: Type) =>
    ({ db, type }) as const;

const pg = fixed("pg");
const mysql = fixed("mysql");
const sqlite = fixed("sqlite");

/** A type that takes one required size: `varchar(80)`. */
const sized =
  <Db extends NativeDialect>(db: Db, name: string) =>
  (n: number): DialectNativeType<Db> => ({ db, type: `${name}(${n})` });

/** A type whose precision is optional: `timestamp` or `timestamp(3)`. */
const opt =
  <Db extends NativeDialect>(db: Db, name: string) =>
  (precision?: number): DialectNativeType<Db> => ({
    db,
    type: precision !== undefined ? `${name}(${precision})` : name,
  });

// =============================================================================
// POSTGRESQL NATIVE TYPES
// https://www.prisma.io/docs/orm/reference/prisma-schema-reference#postgresql
// =============================================================================

export const PG = {
  // String types
  STRING: {
    TEXT: pg("text"),
    VARCHAR: sized("pg", "varchar"),
    CHAR: sized("pg", "char"),
    CITEXT: pg("citext"),
    UUID: pg("uuid"),
    BIT: sized("pg", "bit"),
    // By hand: a zero size is the bare type here, not `varbit(0)`.
    VARBIT: (n?: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: n ? `varbit(${n})` : "varbit",
    }),
    XML: pg("xml"),
    INET: pg("inet"),
    CIDR: pg("cidr"),
    MACADDR: pg("macaddr"),
    MACADDR8: pg("macaddr8"),
    TSVECTOR: pg("tsvector"),
    TSQUERY: pg("tsquery"),
  },

  // Integer types
  INT: {
    SMALLINT: pg("smallint"),
    INTEGER: pg("integer"),
    OID: pg("oid"),
  },

  // BigInt types
  BIGINT: {
    BIGINT: pg("bigint"),
  },

  // Float types
  FLOAT: {
    REAL: pg("real"),
    DOUBLE_PRECISION: pg("double precision"),
  },

  // Boolean types
  BOOLEAN: {
    BOOLEAN: pg("boolean"),
  },

  // DateTime types
  DATETIME: {
    TIMESTAMP: opt("pg", "timestamp"),
    TIMESTAMPTZ: opt("pg", "timestamptz"),
    DATE: pg("date"),
    TIME: opt("pg", "time"),
    TIMETZ: opt("pg", "timetz"),
  },

  // JSON types
  JSON: {
    JSON: pg("json"),
    JSONB: pg("jsonb"),
  },

  // Binary types
  BLOB: {
    BYTEA: pg("bytea"),
  },
} as const;

// =============================================================================
// MYSQL NATIVE TYPES
// https://www.prisma.io/docs/orm/reference/prisma-schema-reference#mysql
// =============================================================================

export const MYSQL = {
  // String types
  STRING: {
    VARCHAR: sized("mysql", "VARCHAR"),
    CHAR: sized("mysql", "CHAR"),
    TEXT: mysql("TEXT"),
    TINYTEXT: mysql("TINYTEXT"),
    MEDIUMTEXT: mysql("MEDIUMTEXT"),
    LONGTEXT: mysql("LONGTEXT"),
    BIT: sized("mysql", "BIT"),
  },

  // Integer types
  INT: {
    TINYINT: mysql("TINYINT"),
    TINYINT_UNSIGNED: mysql("TINYINT UNSIGNED"),
    SMALLINT: mysql("SMALLINT"),
    SMALLINT_UNSIGNED: mysql("SMALLINT UNSIGNED"),
    MEDIUMINT: mysql("MEDIUMINT"),
    MEDIUMINT_UNSIGNED: mysql("MEDIUMINT UNSIGNED"),
    INT: mysql("INT"),
    INT_UNSIGNED: mysql("INT UNSIGNED"),
    YEAR: mysql("YEAR"),
  },

  // BigInt types
  BIGINT: {
    BIGINT: mysql("BIGINT"),
    BIGINT_UNSIGNED: mysql("BIGINT UNSIGNED"),
  },

  // Float types
  FLOAT: {
    FLOAT: mysql("FLOAT"),
    DOUBLE: mysql("DOUBLE"),
  },

  // Boolean types (MySQL uses TINYINT(1))
  BOOLEAN: {
    TINYINT: mysql("TINYINT(1)"),
  },

  // DateTime types
  DATETIME: {
    DATETIME: opt("mysql", "DATETIME"),
    TIMESTAMP: opt("mysql", "TIMESTAMP"),
    DATE: mysql("DATE"),
    TIME: opt("mysql", "TIME"),
  },

  // JSON types
  JSON: {
    JSON: mysql("JSON"),
  },

  // Binary types
  BLOB: {
    BLOB: mysql("BLOB"),
    TINYBLOB: mysql("TINYBLOB"),
    MEDIUMBLOB: mysql("MEDIUMBLOB"),
    LONGBLOB: mysql("LONGBLOB"),
    BINARY: sized("mysql", "BINARY"),
    VARBINARY: sized("mysql", "VARBINARY"),
  },
} as const;

// =============================================================================
// SQLITE NATIVE TYPES
// https://www.prisma.io/docs/orm/reference/prisma-schema-reference#sqlite
// SQLite has limited type affinity, but we expose common mappings
// =============================================================================

export const SQLITE = {
  // String types (all map to TEXT)
  STRING: {
    TEXT: sqlite("TEXT"),
  },

  // Integer types
  INT: {
    INTEGER: sqlite("INTEGER"),
  },

  // BigInt types (same as INTEGER in SQLite)
  BIGINT: {
    INTEGER: sqlite("INTEGER"),
  },

  // Float types
  FLOAT: {
    REAL: sqlite("REAL"),
  },

  // Boolean types (stored as INTEGER 0/1)
  BOOLEAN: {
    INTEGER: sqlite("INTEGER"),
  },

  // DateTime types (stored as TEXT, REAL, or INTEGER)
  DATETIME: {
    TEXT: sqlite("TEXT"),
    REAL: sqlite("REAL"),
    INTEGER: sqlite("INTEGER"),
  },

  // JSON types (stored as TEXT)
  JSON: {
    TEXT: sqlite("TEXT"),
  },

  // Binary types
  BLOB: {
    BLOB: sqlite("BLOB"),
  },
} as const;
