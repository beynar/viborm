// Native Database Type Overrides
// Provides typed constants for database-specific column types

// =============================================================================
// NATIVE TYPE INTERFACE
// =============================================================================

export interface NativeType {
  readonly db: "pg" | "mysql" | "sqlite";
  readonly type: string;
}

// =============================================================================
// POSTGRESQL NATIVE TYPES
// https://www.prisma.io/docs/orm/reference/prisma-schema-reference#postgresql
// =============================================================================

export const PG = {
  // String types
  STRING: {
    TEXT: { db: "pg", type: "text" } as const,
    VARCHAR: (n: number): NativeType => ({ db: "pg", type: `varchar(${n})` }),
    CHAR: (n: number): NativeType => ({ db: "pg", type: `char(${n})` }),
    CITEXT: { db: "pg", type: "citext" } as const,
    UUID: { db: "pg", type: "uuid" } as const,
    BIT: (n: number): NativeType => ({ db: "pg", type: `bit(${n})` }),
    VARBIT: (n?: number): NativeType => ({
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

  // Decimal types
  DECIMAL: {
    DECIMAL: (precision?: number, scale?: number): NativeType => ({
      db: "pg",
      type:
        precision !== undefined
          ? scale !== undefined
            ? `decimal(${precision},${scale})`
            : `decimal(${precision})`
          : "decimal",
    }),
    NUMERIC: (precision?: number, scale?: number): NativeType => ({
      db: "pg",
      type:
        precision !== undefined
          ? scale !== undefined
            ? `numeric(${precision},${scale})`
            : `numeric(${precision})`
          : "numeric",
    }),
    MONEY: { db: "pg", type: "money" } as const,
  },

  // Boolean types
  BOOLEAN: {
    BOOLEAN: { db: "pg", type: "boolean" } as const,
  },

  // DateTime types
  DATETIME: {
    TIMESTAMP: (precision?: number): NativeType => ({
      db: "pg",
      type: precision !== undefined ? `timestamp(${precision})` : "timestamp",
    }),
    TIMESTAMPTZ: (precision?: number): NativeType => ({
      db: "pg",
      type:
        precision !== undefined ? `timestamptz(${precision})` : "timestamptz",
    }),
    DATE: { db: "pg", type: "date" } as const,
    TIME: (precision?: number): NativeType => ({
      db: "pg",
      type: precision !== undefined ? `time(${precision})` : "time",
    }),
    TIMETZ: (precision?: number): NativeType => ({
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
    VARCHAR: (n: number): NativeType => ({
      db: "mysql",
      type: `VARCHAR(${n})`,
    }),
    CHAR: (n: number): NativeType => ({ db: "mysql", type: `CHAR(${n})` }),
    TEXT: { db: "mysql", type: "TEXT" } as const,
    TINYTEXT: { db: "mysql", type: "TINYTEXT" } as const,
    MEDIUMTEXT: { db: "mysql", type: "MEDIUMTEXT" } as const,
    LONGTEXT: { db: "mysql", type: "LONGTEXT" } as const,
    BIT: (n: number): NativeType => ({ db: "mysql", type: `BIT(${n})` }),
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

  // Decimal types
  DECIMAL: {
    DECIMAL: (precision?: number, scale?: number): NativeType => ({
      db: "mysql",
      type:
        precision !== undefined
          ? scale !== undefined
            ? `DECIMAL(${precision},${scale})`
            : `DECIMAL(${precision})`
          : "DECIMAL",
    }),
    NUMERIC: (precision?: number, scale?: number): NativeType => ({
      db: "mysql",
      type:
        precision !== undefined
          ? scale !== undefined
            ? `NUMERIC(${precision},${scale})`
            : `NUMERIC(${precision})`
          : "NUMERIC",
    }),
  },

  // Boolean types (MySQL uses TINYINT(1))
  BOOLEAN: {
    TINYINT: { db: "mysql", type: "TINYINT(1)" } as const,
  },

  // DateTime types
  DATETIME: {
    DATETIME: (precision?: number): NativeType => ({
      db: "mysql",
      type: precision !== undefined ? `DATETIME(${precision})` : "DATETIME",
    }),
    TIMESTAMP: (precision?: number): NativeType => ({
      db: "mysql",
      type: precision !== undefined ? `TIMESTAMP(${precision})` : "TIMESTAMP",
    }),
    DATE: { db: "mysql", type: "DATE" } as const,
    TIME: (precision?: number): NativeType => ({
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
    BINARY: (n: number): NativeType => ({ db: "mysql", type: `BINARY(${n})` }),
    VARBINARY: (n: number): NativeType => ({
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

  // Decimal types (stored as REAL or TEXT)
  DECIMAL: {
    REAL: { db: "sqlite", type: "REAL" } as const,
    NUMERIC: { db: "sqlite", type: "NUMERIC" } as const,
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
