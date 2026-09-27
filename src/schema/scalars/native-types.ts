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
// POSTGRESQL NATIVE TYPES
// https://www.prisma.io/docs/orm/reference/prisma-schema-reference#postgresql
// =============================================================================

export const PG = {
  // String types
  STRING: {
    TEXT: { db: "pg", type: "text" } as const,
    VARCHAR: (n: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: `varchar(${n})`,
    }),
    CHAR: (n: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: `char(${n})`,
    }),
    CITEXT: { db: "pg", type: "citext" } as const,
    UUID: { db: "pg", type: "uuid" } as const,
    BIT: (n: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: `bit(${n})`,
    }),
    VARBIT: (n?: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: n ? `varbit(${n})` : "varbit",
    }),
    XML: { db: "pg", type: "xml" } as const,
    INET: { db: "pg", type: "inet" } as const,
    CIDR: { db: "pg", type: "cidr" } as const,
    MACADDR: { db: "pg", type: "macaddr" } as const,
    MACADDR8: { db: "pg", type: "macaddr8" } as const,
    TSVECTOR: { db: "pg", type: "tsvector" } as const,
    TSQUERY: { db: "pg", type: "tsquery" } as const,
  },

  // Integer types
  INT: {
    SMALLINT: { db: "pg", type: "smallint" } as const,
    INTEGER: { db: "pg", type: "integer" } as const,
    OID: { db: "pg", type: "oid" } as const,
  },

  // BigInt types
  BIGINT: {
    BIGINT: { db: "pg", type: "bigint" } as const,
  },

  // Float types
  FLOAT: {
    REAL: { db: "pg", type: "real" } as const,
    DOUBLE_PRECISION: { db: "pg", type: "double precision" } as const,
  },

  // Boolean types
  BOOLEAN: {
    BOOLEAN: { db: "pg", type: "boolean" } as const,
  },

  // DateTime types
  DATETIME: {
    TIMESTAMP: (precision?: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: precision !== undefined ? `timestamp(${precision})` : "timestamp",
    }),
    TIMESTAMPTZ: (precision?: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type:
        precision !== undefined ? `timestamptz(${precision})` : "timestamptz",
    }),
    DATE: { db: "pg", type: "date" } as const,
    TIME: (precision?: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: precision !== undefined ? `time(${precision})` : "time",
    }),
    TIMETZ: (precision?: number): DialectNativeType<"pg"> => ({
      db: "pg",
      type: precision !== undefined ? `timetz(${precision})` : "timetz",
    }),
    INTERVAL: { db: "pg", type: "interval" } as const,
  },

  // JSON types
  JSON: {
    JSON: { db: "pg", type: "json" } as const,
    JSONB: { db: "pg", type: "jsonb" } as const,
  },

  // Binary types
  BLOB: {
    BYTEA: { db: "pg", type: "bytea" } as const,
  },
} as const;

// =============================================================================
// MYSQL NATIVE TYPES
// https://www.prisma.io/docs/orm/reference/prisma-schema-reference#mysql
// =============================================================================

export const MYSQL = {
  // String types
  STRING: {
    VARCHAR: (n: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: `VARCHAR(${n})`,
    }),
    CHAR: (n: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: `CHAR(${n})`,
    }),
    TEXT: { db: "mysql", type: "TEXT" } as const,
    TINYTEXT: { db: "mysql", type: "TINYTEXT" } as const,
    MEDIUMTEXT: { db: "mysql", type: "MEDIUMTEXT" } as const,
    LONGTEXT: { db: "mysql", type: "LONGTEXT" } as const,
    BIT: (n: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: `BIT(${n})`,
    }),
  },

  // Integer types
  INT: {
    TINYINT: { db: "mysql", type: "TINYINT" } as const,
    TINYINT_UNSIGNED: { db: "mysql", type: "TINYINT UNSIGNED" } as const,
    SMALLINT: { db: "mysql", type: "SMALLINT" } as const,
    SMALLINT_UNSIGNED: { db: "mysql", type: "SMALLINT UNSIGNED" } as const,
    MEDIUMINT: { db: "mysql", type: "MEDIUMINT" } as const,
    MEDIUMINT_UNSIGNED: { db: "mysql", type: "MEDIUMINT UNSIGNED" } as const,
    INT: { db: "mysql", type: "INT" } as const,
    INT_UNSIGNED: { db: "mysql", type: "INT UNSIGNED" } as const,
    YEAR: { db: "mysql", type: "YEAR" } as const,
  },

  // BigInt types
  BIGINT: {
    BIGINT: { db: "mysql", type: "BIGINT" } as const,
    BIGINT_UNSIGNED: { db: "mysql", type: "BIGINT UNSIGNED" } as const,
  },

  // Float types
  FLOAT: {
    FLOAT: { db: "mysql", type: "FLOAT" } as const,
    DOUBLE: { db: "mysql", type: "DOUBLE" } as const,
  },

  // Boolean types (MySQL uses TINYINT(1))
  BOOLEAN: {
    TINYINT: { db: "mysql", type: "TINYINT(1)" } as const,
  },

  // DateTime types
  DATETIME: {
    DATETIME: (precision?: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: precision !== undefined ? `DATETIME(${precision})` : "DATETIME",
    }),
    TIMESTAMP: (precision?: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: precision !== undefined ? `TIMESTAMP(${precision})` : "TIMESTAMP",
    }),
    DATE: { db: "mysql", type: "DATE" } as const,
    TIME: (precision?: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: precision !== undefined ? `TIME(${precision})` : "TIME",
    }),
  },

  // JSON types
  JSON: {
    JSON: { db: "mysql", type: "JSON" } as const,
  },

  // Binary types
  BLOB: {
    BLOB: { db: "mysql", type: "BLOB" } as const,
    TINYBLOB: { db: "mysql", type: "TINYBLOB" } as const,
    MEDIUMBLOB: { db: "mysql", type: "MEDIUMBLOB" } as const,
    LONGBLOB: { db: "mysql", type: "LONGBLOB" } as const,
    BINARY: (n: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: `BINARY(${n})`,
    }),
    VARBINARY: (n: number): DialectNativeType<"mysql"> => ({
      db: "mysql",
      type: `VARBINARY(${n})`,
    }),
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
    TEXT: { db: "sqlite", type: "TEXT" } as const,
  },

  // Integer types
  INT: {
    INTEGER: { db: "sqlite", type: "INTEGER" } as const,
  },

  // BigInt types (same as INTEGER in SQLite)
  BIGINT: {
    INTEGER: { db: "sqlite", type: "INTEGER" } as const,
  },

  // Float types
  FLOAT: {
    REAL: { db: "sqlite", type: "REAL" } as const,
  },

  // Boolean types (stored as INTEGER 0/1)
  BOOLEAN: {
    INTEGER: { db: "sqlite", type: "INTEGER" } as const,
  },

  // DateTime types (stored as TEXT, REAL, or INTEGER)
  DATETIME: {
    TEXT: { db: "sqlite", type: "TEXT" } as const,
    REAL: { db: "sqlite", type: "REAL" } as const,
    INTEGER: { db: "sqlite", type: "INTEGER" } as const,
  },

  // JSON types (stored as TEXT)
  JSON: {
    TEXT: { db: "sqlite", type: "TEXT" } as const,
  },

  // Binary types
  BLOB: {
    BLOB: { db: "sqlite", type: "BLOB" } as const,
  },
} as const;
