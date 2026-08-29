/**
 * PostgreSQL Schema Introspection
 *
 * Reads the current database schema from PostgreSQL's information_schema
 * and system catalogs, returning a normalized SchemaSnapshot.
 *
 * Every catalog query is NAMESPACE-RELATIVE: the selected schema arrives as a
 * bound parameter (`$1`), never as a literal in a predicate and never as a
 * `public` fallback. The snapshot it produces stays namespace-RELATIVE in the
 * other direction — table, enum and type names are bare, exactly as the
 * serializer spells them — so one estate's snapshot never carries the schema
 * its DDL renderer qualifies with.
 */

import {
  canonicalizeDecimal,
  type DecimalDescriptor,
  decimalDefaultText,
} from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import { readStoredDecimalDescriptor } from "../../decimal";
import type {
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../types";
import { groupBy, groupByNested } from "../utils";
import type {
  PgColumn,
  PgCrossSchemaForeignKey,
  PgEnum,
  PgForeignKey,
  PgIndex,
  PgPrimaryKey,
  PgTable,
  PgUniqueConstraint,
} from "./types";

// Regex for cleaning up PostgreSQL type casting (e.g., 'value'::text -> 'value')
const TYPE_CAST_REGEX = /::\w+(\[\])?$/;

/** The schemas PostgreSQL's own types live in; never estate-owned. */
const BUILT_IN_TYPE_SCHEMAS = new Set(["pg_catalog", "information_schema"]);

/**
 * What one introspection run is bound to.
 *
 * `namespace` is the estate's schema, and `admittedExtensionTypes` is the set
 * of extension-owned base type names the CONCRETE adapter declares typmods
 * for (pgvector's `vector`, PostGIS's `geometry`/`geography`). An extension
 * type outside that set is still read — through `udt_name`, the way every
 * snapshot written before `format_type` was consulted holds it.
 */
export interface PostgresIntrospectionScope {
  readonly namespace: string;
  readonly admittedExtensionTypes: ReadonlySet<string>;
}

type RawExecutor = <T>(
  sql: string,
  params?: unknown[]
) => Promise<{ rows: T[] }>;

// =============================================================================
// SQL QUERIES
// =============================================================================

const TABLES_QUERY = `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = $1
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
`;

/**
 * Columns, with the type identity the snapshot cannot be built without.
 *
 * The catalog join beside `information_schema.columns` exists for two facts
 * that view cannot give: the server's formatted type (modifiers and array
 * structure) and the extension provenance that proves a non-estate type is a
 * provider object rather than an unknown external one. For an ARRAY column the
 * dependency is looked up on the ELEMENT type (`typcategory = 'A'`), because
 * the array type's own dependency is on its element, not on the extension.
 */
const COLUMNS_QUERY = `
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
  ext.extname AS type_extension,
  ext_ns.nspname AS type_extension_schema
FROM information_schema.columns c
JOIN information_schema.tables t
  ON c.table_name = t.table_name
  AND c.table_schema = t.table_schema
JOIN pg_catalog.pg_class cls
  ON cls.relname = c.table_name
JOIN pg_catalog.pg_namespace cls_ns
  ON cls_ns.oid = cls.relnamespace
  AND cls_ns.nspname = c.table_schema
JOIN pg_catalog.pg_attribute a
  ON a.attrelid = cls.oid
  AND a.attname = c.column_name
JOIN pg_catalog.pg_type col_type
  ON col_type.oid = a.atttypid
LEFT JOIN pg_catalog.pg_depend dep
  ON dep.classid = 'pg_catalog.pg_type'::regclass
  AND dep.objid = CASE
    WHEN col_type.typcategory = 'A' THEN col_type.typelem
    ELSE col_type.oid
  END
  AND dep.deptype = 'e'
LEFT JOIN pg_catalog.pg_extension ext
  ON ext.oid = dep.refobjid
LEFT JOIN pg_catalog.pg_namespace ext_ns
  ON ext_ns.oid = ext.extnamespace
WHERE c.table_schema = $1
  AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name, c.ordinal_position;
`;

const PRIMARY_KEYS_QUERY = `
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = $1
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY tc.table_name, kcu.ordinal_position;
`;

/**
 * Standalone indexes. `conindid` names the index a UNIQUE or PRIMARY KEY
 * constraint owns — those stay in `uniqueConstraints` / `primaryKey`. A
 * foreign key also points `conindid` at the unique index it targets, so the
 * join must not treat that as ownership or a unique-index FK target vanishes
 * from both lists.
 */
const INDEXES_QUERY = `
SELECT
  t.relname AS table_name,
  i.relname AS index_name,
  a.attname AS column_name,
  ix.indisunique AS is_unique,
  am.amname AS index_type,
  pg_get_expr(ix.indpred, ix.indrelid) AS filter_condition,
  array_position(ix.indkey, a.attnum) AS ordinal_position
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_am am ON am.oid = i.relam
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
LEFT JOIN pg_constraint c
  ON c.conindid = ix.indexrelid
 AND c.contype IN ('u', 'p')
WHERE n.nspname = $1
  AND NOT ix.indisprimary
  AND c.oid IS NULL
  AND t.relkind = 'r'
ORDER BY t.relname, i.relname, array_position(ix.indkey, a.attnum);
`;

/**
 * Foreign keys OWNED by the selected schema.
 *
 * Read from `pg_constraint`, not `information_schema.referential_constraints`.
 * A foreign key may target a unique INDEX rather than a unique constraint;
 * that catalog view then leaves `unique_constraint_name` null and the join
 * drops the constraint. `pg_constraint.confrelid`/`confkey` still name the
 * referenced columns. Both sides stay in this schema so `referencedTable` is
 * a bare estate-relative name. A constraint that leaves the schema is not
 * silently dropped — `CROSS_SCHEMA_FOREIGN_KEYS_QUERY` inventories both
 * directions and refuses the whole run before this snapshot is published.
 */
const FOREIGN_KEYS_QUERY = `
SELECT
  owner.relname AS table_name,
  con.conname AS constraint_name,
  local_att.attname AS column_name,
  referenced.relname AS foreign_table_name,
  referenced_att.attname AS foreign_column_name,
  CASE con.confdeltype
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'd' THEN 'SET DEFAULT'
    ELSE 'NO ACTION'
  END AS delete_rule,
  CASE con.confupdtype
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'd' THEN 'SET DEFAULT'
    ELSE 'NO ACTION'
  END AS update_rule,
  local.ordinality AS ordinal_position
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class owner ON owner.oid = con.conrelid
JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid = owner.relnamespace
JOIN pg_catalog.pg_class referenced ON referenced.oid = con.confrelid
JOIN pg_catalog.pg_namespace referenced_ns ON referenced_ns.oid = referenced.relnamespace
JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS local(attnum, ordinality) ON TRUE
JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS referenced_col(attnum, ordinality)
  ON referenced_col.ordinality = local.ordinality
JOIN pg_catalog.pg_attribute local_att
  ON local_att.attrelid = owner.oid AND local_att.attnum = local.attnum
JOIN pg_catalog.pg_attribute referenced_att
  ON referenced_att.attrelid = referenced.oid
  AND referenced_att.attnum = referenced_col.attnum
WHERE con.contype = 'f'
  AND owner_ns.nspname = $1
  AND referenced_ns.nspname = $1
ORDER BY owner.relname, con.conname, local.ordinality;
`;

/**
 * Every foreign key with exactly ONE side in the selected schema.
 *
 * `pg_constraint` is joined to its owning and referenced relations through both
 * `pg_class`/`pg_namespace` pairs, so an INBOUND key — owned by a foreign
 * schema, pointing at an estate table — is found as readily as an outbound one.
 * The exclusive-or in the predicate is the whole test: a key with both sides in
 * the schema is ordinary, a key with neither belongs to somebody else.
 */
const CROSS_SCHEMA_FOREIGN_KEYS_QUERY = `
SELECT
  con.conname AS constraint_name,
  owner_ns.nspname AS owning_schema,
  owner.relname AS owning_table,
  referenced_ns.nspname AS referenced_schema,
  referenced.relname AS referenced_table
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class owner ON owner.oid = con.conrelid
JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid = owner.relnamespace
JOIN pg_catalog.pg_class referenced ON referenced.oid = con.confrelid
JOIN pg_catalog.pg_namespace referenced_ns ON referenced_ns.oid = referenced.relnamespace
WHERE con.contype = 'f'
  AND (owner_ns.nspname = $1) <> (referenced_ns.nspname = $1)
ORDER BY owner_ns.nspname, owner.relname, con.conname;
`;

const UNIQUE_CONSTRAINTS_QUERY = `
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = $1
  AND tc.constraint_type = 'UNIQUE'
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
`;

const ENUMS_QUERY = `
SELECT
  t.typname AS enum_name,
  e.enumlabel AS enum_value,
  e.enumsortorder AS sort_order
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1
ORDER BY t.typname, e.enumsortorder;
`;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function mapReferentialAction(rule: string): ReferentialAction {
  switch (rule) {
    case "CASCADE":
      return "cascade";
    case "SET NULL":
      return "setNull";
    case "RESTRICT":
      return "restrict";
    case "SET DEFAULT":
      return "setDefault";
    default:
      return "noAction";
  }
}

/** The element type's name for an array type, else the name itself. */
function baseTypeName(udtName: string): string {
  return udtName.startsWith("_") ? udtName.slice(1) : udtName;
}

/**
 * The extension-owned type spelled the way this estate's DDL spells it.
 *
 * `format_type` qualifies the type when the extension's schema is not on the
 * session's `search_path` and leaves it bare when it is, so the same column
 * reads back two ways on two sessions. Removing exactly the PROVEN extension
 * schema — never a general prefix strip — makes the answer one, and keeps every
 * modifier and the array suffix the catalog supplied.
 */
function stripExtensionSchema(formattedType: string, schema: string): string {
  for (const prefix of [`${schema}.`, `"${schema.replaceAll('"', '""')}".`]) {
    if (formattedType.startsWith(prefix)) {
      return formattedType.slice(prefix.length);
    }
  }
  return formattedType;
}

/**
 * The one unrepresentable class: a type of another schema that no installed
 * extension owns (§4.2's external enum, domain, composite or UDT).
 *
 * The refusal names both schemas in its MESSAGE. `meta` carries only keys the
 * error metadata allowlist admits (`src/errors/diagnostics.ts`), which has no
 * namespace key today, so the schema travels in the message rather than being
 * silently dropped from a metadata object that claims to carry it.
 */
function refuseUnrepresentableType(
  col: PgColumn,
  scope: PostgresIntrospectionScope
): never {
  throw new MigrationError(
    `Column "${col.table_name}"."${col.column_name}" has type "${col.udt_schema}"."${baseTypeName(col.udt_name)}", which lives in another schema and no installed extension owns it. ` +
      `VibORM manages one schema ("${scope.namespace}") and cannot represent that type in a snapshot or regenerate it as DDL.`,
    VibORMErrorCode.FEATURE_NOT_SUPPORTED,
    {
      meta: {
        table: col.table_name,
        column: col.column_name,
        type: baseTypeName(col.udt_name),
        feature: "external-type",
      },
    }
  );
}

/**
 * The snapshot spelling of one column's type.
 *
 * Two readings, and a refusal for what neither can spell:
 *
 * 1. A provider object owned by an extension this adapter DECLARES keeps the
 *    server's own formatted spelling, so its modifiers and array structure
 *    survive the round trip (`vector(3)`, `geometry(Point,4326)`).
 * 2. Everything else keeps the `udt_name` reading every existing snapshot was
 *    written with — built-ins, estate-owned types, AND an extension type
 *    outside the two admitted capabilities. The capability decides which
 *    SPELLING is read, never whether a type is representable: `citext` is a
 *    shipped VibORM native type (`src/schema/scalars/native-types.ts`) that no
 *    capability can admit, and `udt_name` spells it exactly as the desired
 *    side does, so it round-trips. Refusing it would brick `introspect` and
 *    `push` for an estate that used it.
 * 3. A type of ANOTHER schema that no extension owns is refused, because
 *    nothing here can spell it: a snapshot carries bare names relative to the
 *    estate, and re-rendering that name would create a same-named object in
 *    the estate rather than reach the one the column actually has.
 */
function formatColumnType(
  col: PgColumn,
  scope: PostgresIntrospectionScope
): string {
  if (
    col.type_extension !== null &&
    col.type_extension_schema !== null &&
    scope.admittedExtensionTypes.has(baseTypeName(col.udt_name))
  ) {
    return stripExtensionSchema(col.formatted_type, col.type_extension_schema);
  }

  // `type_extension === null` is what keeps an extension type installed
  // OUTSIDE the estate (the ordinary `CREATE EXTENSION citext` into `public`)
  // out of this refusal: the extension owns it, PostgreSQL resolves it for the
  // unqualified type token the renderer emits, and `udt_name` spells it.
  if (
    col.type_extension === null &&
    col.udt_schema !== scope.namespace &&
    !BUILT_IN_TYPE_SCHEMAS.has(col.udt_schema)
  ) {
    refuseUnrepresentableType(col, scope);
  }

  const elementType = baseTypeName(col.udt_name);
  const snapshotType = col.udt_name.startsWith("_")
    ? `${elementType}[]`
    : elementType;

  // Handle special types with precision
  if (col.data_type === "character varying" && col.character_maximum_length) {
    return `varchar(${col.character_maximum_length})`;
  }
  if (col.data_type === "character" && col.character_maximum_length) {
    return `char(${col.character_maximum_length})`;
  }
  if (col.data_type === "numeric" && col.numeric_precision) {
    if (col.numeric_scale !== null && col.numeric_scale !== undefined) {
      return `numeric(${col.numeric_precision},${col.numeric_scale})`;
    }
    return `numeric(${col.numeric_precision})`;
  }

  // An ARRAY of numeric is the one type whose modifier `information_schema`
  // does not report: `data_type` is `ARRAY`, `udt_name` is `_numeric`, and both
  // `numeric_precision` and `numeric_scale` are NULL — so the arm above is
  // never reached and the snapshot would say `numeric[]` against a desired
  // `NUMERIC(10,5)[]`, planning an alterColumn on every push forever.
  // `format_type` carries the element typmod, which is where PostgreSQL keeps
  // a decimal LIST's declared domain (§6.2).
  //
  // A separate, NARROW arm rather than a widening of the extension-type gate
  // above: that gate strips a proven extension schema from the formatted type,
  // and `numeric` is a `pg_catalog` built-in that is never schema-qualified, so
  // it needs none of those assumptions — and reusing them would change how
  // `citext` and `vector` read back.
  if (col.udt_name === NUMERIC_ARRAY_UDT) {
    return col.formatted_type;
  }

  return snapshotType;
}

/** `numeric[]`'s `udt_name`; PostgreSQL prefixes an array type with `_`. */
const NUMERIC_ARRAY_UDT = "_numeric";

/**
 * The declared decimal domain of a PostgreSQL column, or `undefined`.
 *
 * PostgreSQL is the one dialect that needs no reserved carrier: the typmod IS
 * the descriptor, so it is read from the catalog rather than from anything
 * VibORM wrote. A scalar reports it through `information_schema`; an array
 * reports it only inside `format_type`, so the two are recovered from the two
 * places the server keeps them.
 *
 * An unconstrained `numeric` has no typmod and therefore no domain — which is
 * correct, and is what makes the differ plan the conversion to a declared one.
 */
function readDecimalDomain(col: PgColumn): DecimalDescriptor | undefined {
  if (col.data_type === "numeric" && col.numeric_precision !== null) {
    return requireDecimalDomain(
      col,
      col.numeric_precision,
      col.numeric_scale ?? 0
    );
  }
  if (col.udt_name !== NUMERIC_ARRAY_UDT) return undefined;
  const match = NUMERIC_ARRAY_TYPMOD.exec(col.formatted_type);
  if (!match) return undefined;
  return requireDecimalDomain(col, match[1], match[2]);
}

const NUMERIC_ARRAY_TYPMOD = /^numeric\((-?\d+),(-?\d+)\)\[\]$/;

function requireDecimalDomain(
  col: PgColumn,
  precision: unknown,
  scale: unknown
): DecimalDescriptor {
  const descriptor = readStoredDecimalDescriptor(precision, scale, "pg");
  if (descriptor !== undefined) return descriptor;
  throw new MigrationError(
    `PostgreSQL reported column "${col.table_name}"."${col.column_name}" as NUMERIC(${String(precision)},${String(scale)}), outside VibORM's fixed-decimal domain. Migration introspection is refused rather than publishing an invalid descriptor.`,
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    {
      meta: {
        dialect: "postgresql",
        table: col.table_name,
        column: col.column_name,
        type: "invalid-catalog-decimal-domain",
      },
    }
  );
}

function isAutoIncrement(columnDefault: string | null): boolean {
  if (!columnDefault) return false;
  return (
    columnDefault.includes("nextval(") ||
    columnDefault.includes("_seq'::regclass)")
  );
}

/**
 * Every spelling PostgreSQL can give the terminal cast onto ONE named type.
 *
 * The server renders a default expression through `pg_get_expr`, which
 * qualifies the type only when the type's schema is off the session's
 * `search_path` and quotes an identifier only when the identifier needs it.
 * Both facts are session state, so the same column reads back as
 * `'active'::billing.state` on one connection and `'active'::state` on another,
 * and either half may be quoted. The set is enumerated rather than matched by
 * pattern because it must name THIS column's type exactly: a regex loose enough
 * to cover the spellings is also loose enough to eat an unrelated cast.
 */
function terminalCastSpellings(schema: string, typeName: string): string[] {
  const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const qualifiers = ["", `${schema}.`, `${quoted(schema)}.`];
  const names = [typeName, quoted(typeName)];
  const spellings: string[] = [];
  for (const qualifier of qualifiers) {
    for (const name of names) {
      for (const array of ["", "[]"]) {
        spellings.push(`::${qualifier}${name}${array}`);
      }
    }
  }
  // Longest first: `::billing.state[]` must not be half-stripped by `::state`.
  return spellings.sort((left, right) => right.length - left.length);
}

/**
 * Removes the cast that names this column's own managed enum type, if the
 * default ends with one.
 *
 * §4.3: the strip is keyed on the column's catalog-proven `udt_schema` /
 * `udt_name` and on that name being an enum this estate manages — never on the
 * text alone. A default casting to a built-in, an extension type, a domain or a
 * composite therefore reaches the generic strip below unchanged, which is what
 * keeps every already-converged column byte-identical.
 */
function stripManagedEnumCast(
  columnDefault: string,
  col: PgColumn,
  scope: PostgresIntrospectionScope,
  managedEnums: ReadonlySet<string>
): string {
  const enumName = baseTypeName(col.udt_name);
  if (col.udt_schema !== scope.namespace || !managedEnums.has(enumName)) {
    return columnDefault;
  }
  for (const cast of terminalCastSpellings(col.udt_schema, enumName)) {
    if (columnDefault.endsWith(cast)) {
      return columnDefault.slice(0, -cast.length);
    }
  }
  return columnDefault;
}

function cleanDefault(
  col: PgColumn,
  scope: PostgresIntrospectionScope,
  managedEnums: ReadonlySet<string>
): string | undefined {
  const columnDefault = col.column_default;
  if (!columnDefault) return undefined;

  // Skip auto-increment defaults
  if (isAutoIncrement(columnDefault)) return undefined;

  // Clean up type casting (e.g., 'value'::text -> 'value')
  const withoutEnumCast = stripManagedEnumCast(
    columnDefault,
    col,
    scope,
    managedEnums
  );
  const cleaned = withoutEnumCast.replace(TYPE_CAST_REGEX, "").trim();
  return renderDecimalDefault(cleaned, readDecimalDomain(col));
}

/**
 * Re-renders a decimal column's default through the codec, so both snapshot
 * sides hold the SAME of the two renderings.
 *
 * PostgreSQL deparses a decimal default in two spellings and the difference is
 * the sign: `DEFAULT 12.34000` comes back as the bare literal, while
 * `DEFAULT -12.34000` comes back as `'-12.34000'::numeric`, because the minus
 * is a unary operator over a constant and the folded result is spelled as a
 * cast literal. (Measured on PGlite 0.3.) Stripping the cast leaves the quotes
 * behind, so the negative default would never equal the one the serializer
 * emits and the estate would churn forever.
 *
 * Sending it back through `decimalDefaultText` settles both spellings at once:
 * the quotes are dropped by the grammar and the fraction is padded to the
 * scale, which is exactly what the serializer emitted. Anything that is not a
 * decimal literal — a function call, `NULL`, an array literal — is not a value
 * this rendering describes and passes through untouched.
 */
function renderDecimalDefault(
  cleaned: string,
  descriptor: DecimalDescriptor | undefined
): string {
  if (descriptor === undefined) return cleaned;
  const unquoted =
    cleaned.startsWith("'") && cleaned.endsWith("'") && cleaned.length > 1
      ? cleaned.slice(1, -1)
      : cleaned;
  const canonical = canonicalizeDecimal(unquoted);
  if (canonical === undefined) return cleaned;
  return decimalDefaultText("pg", canonical, descriptor);
}

/**
 * Refuses a foreign key that crosses the estate boundary, in either direction.
 *
 * This runs BEFORE the snapshot is returned, so push, public introspection and
 * every reset path that inventories objects refuse before planning a single
 * operation — an outbound reference would otherwise be silently dropped from
 * the snapshot (the owned-key query only sees same-schema pairs) and an inbound
 * one would turn a later table drop into somebody else's broken constraint.
 */
function assertNoCrossSchemaForeignKeys(
  crossing: readonly PgCrossSchemaForeignKey[],
  scope: PostgresIntrospectionScope
): void {
  const first = crossing[0];
  if (!first) return;

  const direction = first.owning_schema === scope.namespace ? "out of" : "into";
  throw new MigrationError(
    `Foreign key "${first.constraint_name}" points ${direction} the migration estate: ` +
      `"${first.owning_schema}"."${first.owning_table}" references "${first.referenced_schema}"."${first.referenced_table}". ` +
      `VibORM manages one schema ("${scope.namespace}") per estate, so a constraint with one side outside it is an unsupported migration topology` +
      (crossing.length > 1 ? ` (${crossing.length} such constraints).` : "."),
    VibORMErrorCode.FEATURE_NOT_SUPPORTED,
    {
      // Both schemas are in the message: the metadata allowlist admits no
      // namespace key, and a refusal that cannot say which boundary was
      // crossed is not actionable.
      meta: {
        constraint: first.constraint_name,
        table: first.owning_table,
        relation: first.referenced_table,
        feature: "cross-schema-foreign-key",
      },
    }
  );
}

// =============================================================================
// INTROSPECTION
// =============================================================================

export async function introspectPostgresSchema(
  executeRaw: RawExecutor,
  scope: PostgresIntrospectionScope
): Promise<SchemaSnapshot> {
  const namespace = [scope.namespace];

  // Execute all queries in parallel
  const [
    tablesResult,
    columnsResult,
    primaryKeysResult,
    indexesResult,
    foreignKeysResult,
    crossSchemaForeignKeysResult,
    uniqueConstraintsResult,
    enumsResult,
  ] = await Promise.all([
    executeRaw<PgTable>(TABLES_QUERY, namespace),
    executeRaw<PgColumn>(COLUMNS_QUERY, namespace),
    executeRaw<PgPrimaryKey>(PRIMARY_KEYS_QUERY, namespace),
    executeRaw<PgIndex>(INDEXES_QUERY, namespace),
    executeRaw<PgForeignKey>(FOREIGN_KEYS_QUERY, namespace),
    executeRaw<PgCrossSchemaForeignKey>(
      CROSS_SCHEMA_FOREIGN_KEYS_QUERY,
      namespace
    ),
    executeRaw<PgUniqueConstraint>(UNIQUE_CONSTRAINTS_QUERY, namespace),
    executeRaw<PgEnum>(ENUMS_QUERY, namespace),
  ]);

  assertNoCrossSchemaForeignKeys(crossSchemaForeignKeysResult.rows, scope);

  // Group results using helper functions
  const columnsByTable = groupBy(columnsResult.rows, (col) => col.table_name);
  const pkByTable = groupBy(primaryKeysResult.rows, (pk) => pk.table_name);
  const indexesByTable = groupByNested(
    indexesResult.rows,
    (idx) => idx.table_name,
    (idx) => idx.index_name
  );
  const fkByTable = groupByNested(
    foreignKeysResult.rows,
    (fk) => fk.table_name,
    (fk) => fk.constraint_name
  );
  const uniqueByTable = groupByNested(
    uniqueConstraintsResult.rows,
    (uq) => uq.table_name,
    (uq) => uq.constraint_name
  );
  const enumsByName = groupBy(enumsResult.rows, (e) => e.enum_name);
  const managedEnums = new Set(enumsByName.keys());

  // Build tables
  const tables: TableDef[] = [];

  for (const table of tablesResult.rows) {
    const tableName = table.table_name;

    // Build columns
    const columns = (columnsByTable.get(tableName) || []).map((col) => ({
      name: col.column_name,
      type: formatColumnType(col, scope),
      nullable: col.is_nullable === "YES",
      default: cleanDefault(col, scope, managedEnums),
      autoIncrement: isAutoIncrement(col.column_default),
      decimal: readDecimalDomain(col),
    }));

    // Build primary key
    let primaryKey: PrimaryKeyDef | undefined;
    const pkCols = pkByTable.get(tableName);
    if (pkCols && pkCols.length > 0) {
      pkCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
      const firstPk = pkCols[0];
      if (firstPk) {
        primaryKey = {
          columns: pkCols.map((pk) => pk.column_name),
          name: firstPk.constraint_name,
        };
      }
    }

    // Build indexes
    const indexes: IndexDef[] = [];
    const tableIndexes = indexesByTable.get(tableName);
    if (tableIndexes) {
      for (const [indexName, indexCols] of tableIndexes) {
        indexCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        const firstCol = indexCols[0];
        if (firstCol) {
          indexes.push({
            name: indexName,
            columns: indexCols.map((idx) => idx.column_name),
            unique: firstCol.is_unique,
            type: firstCol.index_type as "btree" | "hash" | "gin" | "gist",
            where: firstCol.filter_condition || undefined,
          });
        }
      }
    }

    // Build foreign keys
    const foreignKeys: ForeignKeyDef[] = [];
    const tableFks = fkByTable.get(tableName);
    if (tableFks) {
      for (const [constraintName, fkCols] of tableFks) {
        fkCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        const firstFk = fkCols[0];
        if (firstFk) {
          foreignKeys.push({
            name: constraintName,
            columns: fkCols.map((fk) => fk.column_name),
            referencedTable: firstFk.foreign_table_name,
            referencedColumns: fkCols.map((fk) => fk.foreign_column_name),
            onDelete: mapReferentialAction(firstFk.delete_rule),
            onUpdate: mapReferentialAction(firstFk.update_rule),
          });
        }
      }
    }

    // Build unique constraints
    const uniqueConstraints: UniqueConstraintDef[] = [];
    const tableUniques = uniqueByTable.get(tableName);
    if (tableUniques) {
      for (const [constraintName, uqCols] of tableUniques) {
        uqCols.sort((a, b) => a.ordinal_position - b.ordinal_position);
        uniqueConstraints.push({
          name: constraintName,
          columns: uqCols.map((uq) => uq.column_name),
        });
      }
    }

    tables.push({
      name: tableName,
      columns,
      primaryKey,
      indexes,
      foreignKeys,
      uniqueConstraints,
    });
  }

  // Build enums
  const enums: EnumDef[] = [];
  for (const [enumName, enumVals] of enumsByName) {
    enumVals.sort((a, b) => a.sort_order - b.sort_order);
    enums.push({
      name: enumName,
      values: enumVals.map((e) => e.enum_value),
    });
  }

  return {
    tables,
    enums: enums.length > 0 ? enums : undefined,
  };
}
