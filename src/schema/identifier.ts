import { ClientInitializationError } from "@errors";

const VALID_SCHEMA_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const OBJECT_PROTOTYPE_PROPERTY_NAMES = new Set(
  Object.getOwnPropertyNames(Object.prototype)
);
export const MAX_SCHEMA_IDENTIFIER_BYTES = 63;

export function isValidSchemaIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SCHEMA_IDENTIFIER_BYTES &&
    VALID_SCHEMA_IDENTIFIER.test(value) &&
    !OBJECT_PROTOTYPE_PROPERTY_NAMES.has(value)
  );
}

// =============================================================================
// DATABASE NAMESPACE — the public `namespace` option's one validation boundary
// =============================================================================
//
// A namespace is the SQL qualification value for one driver's persistent
// objects: a PostgreSQL schema, or the MySQL database position (which Vitess
// reads as a keyspace qualifier). The grammar above is shared with model and
// field names, so a namespace is deliberately narrower than every identifier
// either server can represent; the renderer quotes it, so keywords are legal.

/** The two dialect families that qualify persistent objects. */
export type NamespaceDialect = "postgresql" | "mysql";

/**
 * PostgreSQL stores a schema name in `NAMEDATALEN - 1` = 63 bytes; MySQL admits
 * 64 characters for a database name. Under the ASCII grammar above, one
 * character is one byte, so both limits are measured in code units here.
 */
const NAMESPACE_LENGTH_LIMIT: Record<NamespaceDialect, number> = {
  postgresql: MAX_SCHEMA_IDENTIFIER_BYTES,
  mysql: 64,
};

const NAMESPACE_DIALECT_LABEL: Record<NamespaceDialect, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
};

/** Server-owned databases. MySQL database-name case folding varies by platform. */
const MYSQL_SYSTEM_DATABASES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
  "ndbinfo",
]);

function refuseNamespace(dialect: NamespaceDialect, reason: string): never {
  throw new ClientInitializationError(
    `The "namespace" option ${reason} (${NAMESPACE_DIALECT_LABEL[dialect]}).`
  );
}

/**
 * Normalize one caller-supplied namespace, or refuse it before any provider
 * work. Case is preserved: PostgreSQL quotes make `PG_CATALOG` a different
 * schema from `pg_catalog`, and MySQL keeps the supplied spelling.
 */
export function normalizeNamespace(
  value: unknown,
  dialect: NamespaceDialect
): string {
  if (typeof value !== "string") {
    refuseNamespace(
      dialect,
      `must be a string; received type "${typeof value}"`
    );
  }
  const limit = NAMESPACE_LENGTH_LIMIT[dialect];
  if (value.length > limit) {
    refuseNamespace(
      dialect,
      `must be at most ${limit} characters; received ${value.length}`
    );
  }
  if (!VALID_SCHEMA_IDENTIFIER.test(value)) {
    refuseNamespace(
      dialect,
      `must match [A-Za-z_][A-Za-z0-9_]*; received ${JSON.stringify(value)}`
    );
  }
  if (OBJECT_PROTOTYPE_PROPERTY_NAMES.has(value)) {
    refuseNamespace(
      dialect,
      `must not be an Object.prototype property name; received ${JSON.stringify(value)}`
    );
  }
  if (dialect === "postgresql") {
    if (value === "information_schema" || value.startsWith("pg_")) {
      refuseNamespace(
        dialect,
        `must not be a system schema; "information_schema" and the "pg_" prefix are reserved`
      );
    }
    return value;
  }
  if (MYSQL_SYSTEM_DATABASES.has(value.toLowerCase())) {
    refuseNamespace(
      dialect,
      `must not be a system database; received ${JSON.stringify(value)}`
    );
  }
  return value;
}
