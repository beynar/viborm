import { nativeTypeFor } from "@schema/scalars/native-types";
import { idDomainOfState, idStorageOf } from "@schema/scalars/string/id-domain";
import type { IdDomain } from "@validation/primitives/id-codec";
import {
  arrayLiteralText,
  readArrayLiteralText,
} from "../../../adapters/databases/postgres/array-literal";
import { stringifyJson } from "../../../adapters/shared/standard-sql";
/**
 * PostgreSQL Migration Driver
 *
 * Implements the MigrationDriver interface for PostgreSQL databases.
 * Supports all DDL operations natively.
 */

import type { Scalar, ScalarState } from "@schema/scalars";
import { encodePostgresTemporal } from "@validation/primitives/datetime-physical-codec";
import { hasIdPrefix } from "@validation/primitives/id-formats";
import { errorCause } from "../../../drivers/shared/driver-options";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import { renderQualifiedIdentifier } from "../../../sql/identifiers";
import {
  decimalConversionConstraintName,
  decimalConversionRequired,
  postgresDecimalFitsCheck,
} from "../../decimal";
import {
  isPostgresTextToUuid,
  postgresTextToUuidGuard,
} from "../../identifier-conversion";
import type { NativeRenameOperation } from "../../native-rename";
import type {
  ColumnDef,
  IndexDef,
  SchemaSnapshot,
  TableDef,
} from "../../types";
import { derivedMigrationName } from "../../utils";
import {
  type AddColumnOperation,
  type AddForeignKeyOperation,
  type AddPrimaryKeyOperation,
  type AddUniqueConstraintOperation,
  type AlterColumnOperation,
  type AlterEnumOperation,
  type CreateEnumOperation,
  type CreateIndexOperation,
  type CreateTableOperation,
  type DDLContext,
  type DropColumnOperation,
  type DropEnumOperation,
  type DropForeignKeyOperation,
  type DropIndexOperation,
  type DropPrimaryKeyOperation,
  type DropTableOperation,
  type DropUniqueConstraintOperation,
  MigrationDriver,
  type RenameColumnOperation,
  type RenameTableOperation,
} from "../base";
import { getPostgresType, PG_TYPE_DEFAULTS } from "../type-mapping";
import type { MigrationCapabilities } from "../types";
import { canonicalizeIndexPredicates } from "./canonicalize-index-predicate";
import {
  introspectPostgresSchema,
  POSTGRES_MANAGED_TABLE_NAMES_QUERY,
} from "./introspect";

type RawExecutor = <T>(
  sql: string,
  params?: unknown[]
) => Promise<{ rows: T[] }>;

/**
 * One catalog existence proof for the estate's schema.
 *
 * Bound, never interpolated, and asking `pg_namespace` exactly one question:
 * does this schema exist. Privilege failures are deliberately NOT folded in —
 * a schema this role cannot use is a different fact with a different fix, and
 * it surfaces as the provider's own error from the statement that needed the
 * privilege.
 */
const VECTOR_TYPE_TOKEN = /^(vector|halfvec|sparsevec)(?:\(\d+\))?(?:\[\])?$/i;
const TEMPORAL_PRECISION_TOKEN = /\((\d+)\)/;

const NAMESPACE_EXISTS_QUERY =
  "SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname = $1";

/**
 * Extension-owned base types whose SERVER-FORMATTED spelling introspection
 * reads, keyed by the adapter capability that declares them.
 *
 * These are the types whose modifiers a snapshot cannot be written without
 * (`vector(3)`, `geometry(Point,4326)`), so introspection reads
 * `format_type` for them instead of `udt_name`. The set admits a SPELLING,
 * never a type: an extension type outside it — `citext`, and anything else a
 * database has installed — reads back through `udt_name` like every built-in,
 * which is the spelling this driver's own renderer emits for it.
 */
const EXTENSION_TYPES_BY_CAPABILITY = {
  supportsVector: ["vector", "halfvec", "sparsevec"],
  geoPoint: ["geometry", "geography"],
} as const;

const POSTGIS_PREFLIGHT_QUERY = `
WITH postgis AS (
  SELECT oid
  FROM pg_catalog.pg_extension
  WHERE extname = 'postgis'
), required_objects(classid, objid) AS (
  VALUES
    ('pg_catalog.pg_type'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regtype('geometry')::pg_catalog.oid),
    ('pg_catalog.pg_type'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regtype('geography')::pg_catalog.oid),
    ('pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regprocedure('st_makepoint(double precision,double precision)')::pg_catalog.oid),
    ('pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regprocedure('st_setsrid(geometry,integer)')::pg_catalog.oid),
    ('pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regprocedure('st_x(geometry)')::pg_catalog.oid),
    ('pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regprocedure('st_y(geometry)')::pg_catalog.oid),
    ('pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regprocedure('st_geomfromgeojson(text)')::pg_catalog.oid),
    ('pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regprocedure('st_intersects(geography,geography)')::pg_catalog.oid),
    ('pg_catalog.pg_operator'::pg_catalog.regclass::pg_catalog.oid, pg_catalog.to_regoperator('&&(geography,geography)')::pg_catalog.oid)
)
SELECT (
  EXISTS (SELECT 1 FROM postgis)
  AND NOT EXISTS (
    SELECT 1
    FROM required_objects required
    WHERE required.objid IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        CROSS JOIN postgis
        WHERE dependency.classid = required.classid
          AND dependency.objid = required.objid
          AND dependency.objsubid = 0
          AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
          AND dependency.refobjid = postgis.oid
          AND dependency.deptype = 'e'
      )
  )
) AS ready
`;

function snapshotUsesGeoPoint(snapshot: SchemaSnapshot): boolean {
  const physicalType = PG_TYPE_DEFAULTS.point.toLowerCase().replace(/\s+/g, "");
  return snapshot.tables.some((table) =>
    table.columns.some(
      (column) => column.type.toLowerCase().replace(/\s+/g, "") === physicalType
    )
  );
}

const QUOTED_LITERAL = /^'(.*)'$/s;

const storesEnum = (column: ColumnDef, enumName: string) =>
  column.type === enumName || column.type === `${enumName}[]`;

/** The labels a default of `enumName`, or of its array, spells. */
function enumDefaultLabels(
  column: ColumnDef,
  enumName: string
): readonly (string | null)[] {
  if (!storesEnum(column, enumName)) return [];
  const literal = column.default
    ?.match(QUOTED_LITERAL)?.[1]
    ?.replaceAll("''", "'");
  if (literal === undefined) return [];
  return column.type === enumName
    ? [literal]
    : (readArrayLiteralText(literal) ?? []);
}

export class PostgresMigrationDriver extends MigrationDriver {
  readonly dialect = "postgresql" as const;
  readonly driverName = "postgresql";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: true,
    supportsAddEnumValueInTransaction: true,
    supportsIndexTypes: ["btree", "hash", "gin", "gist"],
    supportsNativeArrays: true,
    supportsAddForeignKeyViaAlter: true,
    // `pg_constraint.conname` is the name the DDL gave the constraint.
    introspectionReadsConstraintNames: true,
  };

  // ===========================================================================
  // ESTATE QUALIFICATION
  // ===========================================================================

  /**
   * The schema this estate's persistent objects are named with, or undefined
   * on the REGISTERED singleton, which is bound to no estate.
   *
   * ONE source: the estate target. `this.namespace` holds the same string for
   * a PostgreSQL estate — `getMigrationDriver` reads both from the same
   * adapter, and the estate gate refuses a schema that is not this
   * one — so reading exactly one of them is what keeps the two from ever being
   * asked to disagree.
   *
   * `DDLContext.destination` does not enter: §3.4 binds GENERATED PostgreSQL
   * SQL to the configured schema for the same reason live SQL is bound, so an
   * artifact and a live statement in one estate name one schema. That is the
   * dialect difference from MySQL, whose artifacts stay database-relative.
   *
   * The dialect comparison is the union narrowing `MigrationTarget` requires
   * before `namespace` is readable at all, not a second check on top of the
   * registry's: a PostgreSQL implementation is only ever bound to a PostgreSQL
   * target.
   */
  private estateNamespace(): string | undefined {
    const target = this.target;
    return target?.dialect === "postgresql" ? target.namespace : undefined;
  }

  /**
   * The estate schema where a statement cannot be written without one.
   *
   * A catalog predicate and a schema-scoped inventory have no unqualified
   * reading: with no schema operand they answer for every schema in the
   * database, and any default answers for a schema nothing proved. DDL text is
   * the opposite case and renders unqualified off an unbound singleton (see
   * {@link qualify}).
   */
  private requireEstateNamespace(): string {
    const namespace = this.estateNamespace();
    if (namespace === undefined) {
      throw new MigrationError(
        "This PostgreSQL migration driver is not bound to an estate, so it has no schema to read the catalog for. " +
          "Reach the driver through `getMigrationDriver(driver)`, which binds the adapter's namespace, instead of the registered singleton.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { dialect: this.dialect } }
      );
    }
    return namespace;
  }

  /**
   * `"schema"."object"` — the one qualified spelling, through the one shared
   * primitive, with this driver's own quoter (§2.2, N11).
   *
   * An unbound singleton renders `"object"`: it is the dialect's renderer with
   * no estate behind it, and every shipped path reaches a bound view because
   * `getMigrationDriver` refuses a PostgreSQL adapter that declares no
   * namespace. Qualification is never composed by hand anywhere in this file.
   */
  private qualify(objectName: string): string {
    return renderQualifiedIdentifier(
      (name) => this.escapeIdentifier(name),
      this.estateNamespace(),
      objectName
    );
  }

  /**
   * The enum types this DDL batch may name as a column type.
   *
   * Membership is the ONLY thing that qualifies a column's type token, which is
   * what replaced the `_enum` suffix guess: an explicitly named enum such as
   * `state` is no less managed, and an arbitrary type token cannot prove enum
   * ownership. The set is the introspected schema's enums plus the enums the
   * operations already emitted in this batch have created — a table created
   * beside its own new enum must qualify that enum's name.
   *
   * A `dropEnum` earlier in the batch is deliberately not subtracted: a column
   * type naming a type this batch already dropped is a broken batch either way,
   * and the subtraction would silently UNqualify the very statements that run
   * before the drop.
   *
   * A createEnum introduces a name; alterEnum keeps an existing name from the
   * snapshot. Enum replacement runs before dependent columns, so its full
   * ordered value set and defaults are ready for those subsequent changes.
   */
  private managedEnumNames(context: DDLContext): ReadonlySet<string> {
    const names = new Set<string>();
    for (const enumDef of context.currentSchema?.enums ?? []) {
      names.add(enumDef.name);
    }
    for (const operation of context.precedingOperations ?? []) {
      if (operation.type === "createEnum") {
        names.add(operation.enumDef.name);
      }
    }
    return names;
  }

  /**
   * A column type token, qualified when it names a managed enum.
   *
   * Built-in types and the adapter-supported extension spellings (`vector(3)`,
   * `geometry(Point,4326)`) pass through untouched: they are provider objects
   * resolved through `search_path`, not estate objects, and prefixing every
   * type token would break them.
   */
  private renderTypeToken(type: string, context: DDLContext): string {
    const isArray = type.endsWith("[]");
    const baseType = isArray ? type.slice(0, -2) : type;
    if (!this.managedEnumNames(context).has(baseType)) {
      return type;
    }
    const qualified = this.qualify(baseType);
    return isArray ? `${qualified}[]` : qualified;
  }

  /**
   * The extension-owned base types this driver's adapter declares, and whose
   * `format_type` spelling introspection therefore reads.
   */
  private admittedExtensionTypes(): ReadonlySet<string> {
    const capabilities = this.executionDriver?.adapter.capabilities;
    const admitted = new Set<string>();
    if (capabilities?.supportsVector) {
      for (const type of EXTENSION_TYPES_BY_CAPABILITY.supportsVector) {
        admitted.add(type);
      }
    }
    if (this.executionDriver?.adapter.geoPoint) {
      for (const type of EXTENSION_TYPES_BY_CAPABILITY.geoPoint) {
        admitted.add(type);
      }
    }
    return admitted;
  }

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  /**
   * Reads the estate's schema, and nothing else's.
   *
   * The namespace proof runs FIRST and here rather than at every caller: this
   * is the one inventory every catalog-driven path goes through (public
   * `introspect`, push including dry-run, and force-reset), and a configured
   * but absent schema must not be published as an empty database.
   */
  async introspect(executeRaw: RawExecutor): Promise<SchemaSnapshot> {
    await this.proveNamespaceExists(executeRaw);
    return await introspectPostgresSchema(executeRaw, {
      namespace: this.requireEstateNamespace(),
      tables: this.target?.tables,
      admittedExtensionTypes: this.admittedExtensionTypes(),
    });
  }

  override async preflightSchemaRequirements(
    snapshots: readonly SchemaSnapshot[],
    executeRaw: RawExecutor
  ): Promise<void> {
    try {
      const vectors = new Set(
        snapshots.flatMap((snapshot) =>
          snapshot.tables.flatMap((table) =>
            table.columns.flatMap(
              (column) =>
                VECTOR_TYPE_TOKEN.exec(column.type)?.[1]?.toLowerCase() ?? []
            )
          )
        )
      );
      if (
        vectors.size > 0 &&
        !this.executionDriver?.adapter.capabilities.supportsVector
      )
        throw new MigrationError(
          "This migration requires pgvector support. Construct the PostgreSQL driver with pgvector: true and install the vector extension before applying it. VibORM never installs it.",
          VibORMErrorCode.DRIVER_NOT_SUPPORTED,
          { meta: { dialect: this.dialect, feature: "vector" } }
        );
      if (
        snapshots.some(snapshotUsesGeoPoint) &&
        !this.executionDriver?.adapter.geoPoint
      ) {
        throw new MigrationError(
          "This migration requires PostGIS GeoPoint support, but the bound PostgreSQL adapter has no GeoPoint protocol. Construct the driver with `postgis: true` and ensure PostGIS is installed before applying it.",
          VibORMErrorCode.DRIVER_NOT_SUPPORTED,
          { meta: { dialect: this.dialect, feature: "GeoPoint" } }
        );
      }
      const desiredNames = [
        ...new Set(
          snapshots.flatMap((snapshot) =>
            snapshot.tables.map((table) => table.name)
          )
        ),
      ];
      if (desiredNames.length > 0) {
        const views = await executeRaw<{ name: string }>(
          `SELECT relation.relname AS name FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname=$1 AND relation.relkind IN ('v','m') AND relation.relname=ANY($2::text[])`,
          [this.requireEstateNamespace(), arrayLiteralText(desiredNames)]
        );
        const collision = views.rows.find((row) =>
          desiredNames.includes(row.name)
        );
        if (collision)
          throw new MigrationError(
            `PostgreSQL relation "${collision.name}" is a view or materialized view, but this schema declares a table. Synchronization refuses before effects and preserves the view.`,
            VibORMErrorCode.MIGRATION_INVALID_STATE,
            { meta: { table: collision.name, feature: "view" } }
          );
      }
      if (vectors.size > 0) {
        const proof = await executeRaw<{ ready: boolean }>(
          `SELECT NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS required(name) WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension AS e JOIN pg_catalog.pg_depend AS d ON d.refobjid=e.oid AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e' JOIN pg_catalog.pg_type AS t ON t.oid=d.objid AND d.classid='pg_catalog.pg_type'::regclass WHERE e.extname='vector' AND t.typname=required.name AND pg_catalog.pg_type_is_visible(t.oid))) AS ready`,
          [arrayLiteralText([...vectors])]
        );
        if (proof.rows.length !== 1 || proof.rows[0]?.ready !== true)
          throw new MigrationError(
            "pgvector preflight did not prove every required visible extension-owned vector type. Install the vector extension before migration effects; VibORM never installs it.",
            VibORMErrorCode.MIGRATION_INVALID_STATE,
            { meta: { dialect: this.dialect, feature: "vector" } }
          );
      }
      if (snapshots.some((snapshot) => (snapshot.enums?.length ?? 0) > 0)) {
        const version = await executeRaw<{ version: string }>(
          "SELECT current_setting('server_version_num') AS version"
        );
        const number = Number(version.rows[0]?.version);
        if (!Number.isInteger(number) || number < 120_000)
          throw new MigrationError(
            "PostgreSQL enum migrations require server_version_num >= 120000 for transactional enum safety",
            VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
          );
      }
      if (!snapshots.some(snapshotUsesGeoPoint)) return;
      let rows: readonly { ready?: unknown }[];
      try {
        rows = (await executeRaw<{ ready?: unknown }>(POSTGIS_PREFLIGHT_QUERY))
          .rows;
      } catch (failure) {
        throw new MigrationError(
          "PostGIS GeoPoint preflight could not prove the required extension, types, and functions before migration effects.",
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          {
            cause: errorCause(failure),
            meta: { dialect: this.dialect, feature: "GeoPoint" },
          }
        );
      }
      if (rows.length !== 1 || rows[0]?.ready !== true) {
        throw new MigrationError(
          "PostGIS GeoPoint preflight did not prove the required extension, visible types, and exact function signatures. VibORM never installs PostGIS.",
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          { meta: { dialect: this.dialect, feature: "GeoPoint" } }
        );
      }
    } catch (failure) {
      if (failure instanceof MigrationError) throw failure;
      throw new MigrationError(
        "PostgreSQL schema preflight could not prove the required catalog facts before migration effects.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        {
          cause: errorCause(failure),
          meta: { dialect: this.dialect, feature: "schema catalog" },
        }
      );
    }
  }

  /**
   * PostgreSQL reports a missing schema as SQLSTATE `3F000` only where the
   * statement names one; a catalog read filtered on a schema name that does not
   * exist just returns nothing. This proof is what makes that silence
   * impossible, and it runs before any missing-tracking-table translation can
   * be consulted, because PostgreSQL reports a missing schema and a missing
   * relation alike as `42P01`.
   */
  override async proveNamespaceExists(executeRaw: RawExecutor): Promise<void> {
    const namespace = this.requireEstateNamespace();
    const { rows } = await executeRaw<{ present: number }>(
      NAMESPACE_EXISTS_QUERY,
      [namespace]
    );
    if (rows.length === 0) {
      // The schema is named in the message AND on the allowlist's `namespace`
      // key (`src/errors/diagnostics.ts`), so a caller can read which estate
      // was missing without parsing prose.
      throw new MigrationError(
        `The configured PostgreSQL schema "${namespace}" does not exist. ` +
          "VibORM never creates or drops a schema: create it (or fix the configured `namespace`) before running migrations.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { dialect: this.dialect, driver: this.driverName, namespace } }
      );
    }
  }

  // PostgreSQL deparses an index predicate rather than storing the statement,
  // so the declared spelling and the introspected one never match on their own
  // (Decision 7.4). The other dialects have no such gap and leave this unset.
  override canonicalizeIndexPredicates(
    tableName: string,
    predicates: readonly string[],
    executeRaw: RawExecutor
  ): Promise<ReadonlyArray<string | undefined>> {
    return canonicalizeIndexPredicates(
      this.qualify(tableName),
      predicates,
      executeRaw
    );
  }

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  mapScalarType(
    scalar: Scalar,
    scalarState: ScalarState,
    idDomain?: IdDomain
  ): string {
    const declaration = scalar["~"].nativeType;

    // An identifier column's type is the ONE storage owner's answer, override
    // included — which is also why the override is not read separately here: a
    // spelling this domain cannot live in was refused at the schema boundary,
    // and a text-family one keeps text storage with the domain still admitted.
    const idStorage =
      idDomain === undefined
        ? undefined
        : idStorageOf(idDomain, declaration, "pg");
    if (idStorage) return idStorage.columnType;

    // The declaration's PostgreSQL choice, if it makes one
    const nativeType = nativeTypeFor(declaration, "pg");
    if (nativeType) {
      return scalarState.array ? `${nativeType.type}[]` : nativeType.type;
    }

    // Use centralized type mapping
    return getPostgresType({
      type: scalarState.type,
      array: scalarState.array,
      withTimezone: scalarState.withTimezone,
      dimension: scalarState.dimension,
      decimal: scalarState.decimal,
    });
  }

  override finalizeTable(table: TableDef): TableDef {
    return {
      ...table,
      ...(table.primaryKey?.name
        ? {
            primaryKey: {
              ...table.primaryKey,
              name: derivedMigrationName(table.primaryKey.name),
            },
          }
        : {}),
      uniqueConstraints: table.uniqueConstraints.map((item) => ({
        ...item,
        name: derivedMigrationName(item.name),
      })),
      foreignKeys: table.foreignKeys.map((item) => ({
        ...item,
        name: derivedMigrationName(item.name),
      })),
      indexes: table.indexes.map((index) => ({
        ...index,
        name: derivedMigrationName(index.name),
        ...(index.type === "spatial" ? { type: "gist" as const } : {}),
      })),
    };
  }

  /**
   * The only generator PostgreSQL can run itself.
   *
   * `gen_random_uuid()` (PostgreSQL 13+) produces exactly what `.uuid()`
   * produces — but ONLY when no prefix is declared: a prefixed field's public
   * value is `prefix-payload`, and a column default that wrote the bare payload
   * would disagree with every row the application inserts. No other format has
   * a server-side equivalent: `uuidv7()` arrives in PostgreSQL 18, and ULID,
   * KSUID, NanoID and CUID2 have none at all, so those fields carry no DDL
   * default and the application's own generator remains their single owner.
   */
  override getDefaultExpression(
    scalar: Scalar,
    scalarState: ScalarState
  ): string | undefined {
    const literal =
      scalarState.hasDefault &&
      !scalarState.autoGenerate &&
      !scalarState.decimal &&
      (scalarState.array ||
        scalarState.type === "datetime" ||
        scalarState.type === "date")
        ? this.literalDefaultValue(scalarState)
        : undefined;
    if (
      scalarState.hasDefault &&
      !scalarState.autoGenerate &&
      scalarState.array &&
      Array.isArray(literal)
    ) {
      if (scalarState.decimal)
        return super.getDefaultExpression(scalar, scalarState);
      const members = literal.map((value) =>
        scalarState.type === "json"
          ? stringifyJson(value)
          : (scalarState.type === "datetime" || scalarState.type === "date") &&
              typeof value === "string"
            ? encodePostgresTemporal(value)
            : value
      );
      return this.escapeValue(arrayLiteralText(members));
    }
    // `gen_random_uuid()` produces a `uuid`, so a column that does not hold one
    // cannot take it as a default. A `.uuid()` field whose native type override
    // makes it `bytea` is exactly that column: the value would be a type error
    // at DDL time, and the application generator is already its single owner.
    if (scalarState.hasDefault && scalarState.default === null)
      return undefined;
    if (
      scalarState.type === "datetime" &&
      scalarState.autoGenerate?.kind === "now"
    ) {
      const physical = this.mapScalarType(scalar, scalarState).toLowerCase();
      const clock =
        physical.includes("timestamptz") || physical.includes("with time zone")
          ? "CURRENT_TIMESTAMP"
          : "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')";
      // PostgreSQL's omitted precision is six. Our generated logical DateTime
      // must remain a millisecond value even when native storage is wider.
      const precision = Number(
        TEMPORAL_PRECISION_TOKEN.exec(physical)?.[1] ?? 6
      );
      return precision > 3 ? `date_trunc('milliseconds', ${clock})` : clock;
    }
    if (
      (scalarState.type === "datetime" || scalarState.type === "date") &&
      scalarState.autoGenerate === undefined &&
      scalarState.hasDefault &&
      typeof literal === "string"
    )
      return this.escapeValue(encodePostgresTemporal(literal));
    if (scalarState.autoGenerate?.kind === "now") {
      if (scalarState.type === "date")
        return "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')";
      if (scalarState.type === "time") {
        const physical = this.mapScalarType(scalar, scalarState).toLowerCase();
        if (Number(TEMPORAL_PRECISION_TOKEN.exec(physical)?.[1] ?? 6) > 3)
          return "timezone('UTC', CURRENT_TIME(3))";
        return physical.includes("timetz") ||
          physical.includes("with time zone")
          ? "timezone('UTC', CURRENT_TIME)"
          : "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')";
      }
    }
    const idDomain = idDomainOfState(scalarState);
    if (
      idDomain !== undefined &&
      idStorageOf(idDomain, scalar["~"].nativeType, "pg")?.representation ===
        "bytes"
    ) {
      return undefined;
    }
    return super.getDefaultExpression(scalar, scalarState);
  }

  protected override getAutoGenerateExpression(
    autoGenerate: import("@schema/scalars").ScalarState["autoGenerate"]
  ): string | undefined {
    switch (autoGenerate?.kind) {
      case "uuid":
        // `.id()`'s implicit ULID never reaches here (its kind is `ulid`), and
        // a NAMED `.uuid()` gets the database default only unprefixed.
        return hasIdPrefix(autoGenerate.prefix)
          ? undefined
          : "gen_random_uuid()";
      case "now":
        // Use database-level NOW() for consistent timestamps
        return "NOW()";
      default:
        return undefined;
    }
  }

  getEnumColumnType(
    tableName: string,
    columnName: string,
    _values: string[]
  ): string {
    return derivedMigrationName(`${tableName}_${columnName}_enum`);
  }

  // ===========================================================================
  // OVERRIDES: Column Definition Helpers
  // ===========================================================================

  /**
   * PostgreSQL integer types that support SERIAL auto-increment.
   */
  private static readonly SERIAL_TYPE_MAP: Record<string, string> = {
    integer: "SERIAL",
    int4: "SERIAL",
    int: "SERIAL",
    bigint: "BIGSERIAL",
    int8: "BIGSERIAL",
    smallint: "SMALLSERIAL",
    int2: "SMALLSERIAL",
  };

  /**
   * Formats the column type for PostgreSQL.
   * Handles SERIAL types for auto-increment and managed-enum qualification.
   */
  protected override formatColumnType(
    column: ColumnDef,
    context: DDLContext
  ): string {
    // Handle auto-increment with SERIAL types
    if (column.autoIncrement) {
      const normalizedType = column.type.toLowerCase();
      const serialType =
        PostgresMigrationDriver.SERIAL_TYPE_MAP[normalizedType];

      if (!serialType) {
        throw new MigrationError(
          "PostgreSQL auto-increment (SERIAL) requires an integer type (INTEGER, BIGINT, SMALLINT). " +
            `Column "${column.name}" has type "${column.type}" which is not compatible with auto-increment.`,
          VibORMErrorCode.INVALID_INPUT,
          {
            meta: {
              column: column.name,
              type: column.type,
              autoIncrement: true,
            },
          }
        );
      }

      return serialType;
    }

    // A managed enum is a persistent object of this estate and is qualified
    // exactly like a table; its array form takes the same prefix. Everything
    // else — built-ins and the adapter-supported extension spellings — is a
    // provider object and passes through.
    return this.renderTypeToken(column.type, context);
  }

  // ===========================================================================
  // DDL GENERATION - Table Operations
  // ===========================================================================

  generateCreateTable(op: CreateTableOperation, context: DDLContext): string {
    return this.compileCreateTable(op, context).join(";\n");
  }

  override compileCreateTable(
    op: CreateTableOperation,
    context: DDLContext
  ): readonly string[] {
    const { table } = op;
    const columnDefs = table.columns.map((col) =>
      this.generateColumnDef(col, context)
    );

    if (table.primaryKey) {
      const pkCols = table.primaryKey.columns
        .map((c) => this.escapeIdentifier(c))
        .join(", ");
      const pkName = `CONSTRAINT ${this.escapeIdentifier(this.generatedPrimaryKeyName(table.name, table.primaryKey.name))} `;
      columnDefs.push(`${pkName}PRIMARY KEY (${pkCols})`);
    }

    for (const uq of table.uniqueConstraints) {
      const uqCols = uq.columns.map((c) => this.escapeIdentifier(c)).join(", ");
      columnDefs.push(
        `CONSTRAINT ${this.escapeIdentifier(uq.name)} UNIQUE (${uqCols})`
      );
    }

    const sql = `CREATE TABLE ${this.qualify(table.name)} (\n  ${columnDefs.join(",\n  ")}\n)`;

    const statements = [sql];

    for (const idx of table.indexes) {
      statements.push(
        this.generateCreateIndex(
          {
            type: "createIndex",
            tableName: table.name,
            index: idx,
          },
          context
        )
      );
    }

    for (const fk of table.foreignKeys) {
      statements.push(
        this.generateAddForeignKey(
          {
            type: "addForeignKey",
            tableName: table.name,
            fk,
          },
          context
        )
      );
    }

    return this.filterStatements(statements);
  }

  /**
   * No `CASCADE` (§6.1). It dropped views, foreign keys and dependants in OTHER
   * schemas even though the enumeration behind this operation only ever
   * selected one, which made the namespace a filter instead of a boundary. The
   * foreign keys inside the program are materialized as explicit
   * `dropForeignKey` operations that sort ahead of every table drop
   * (`materializeDroppedTableForeignKeys`), and anything left is a dependency
   * this estate does not own: PostgreSQL's default `RESTRICT` then aborts the
   * transaction instead of deleting it.
   */
  generateDropTable(op: DropTableOperation, _context: DDLContext): string {
    return `DROP TABLE ${this.qualify(op.tableName)}`;
  }

  // `RENAME TO` takes ONE unqualified identifier: PostgreSQL renames the table
  // inside its own schema, and a qualified new name is a syntax error, not a
  // move (§4.1).
  generateRenameTable(op: RenameTableOperation, _context: DDLContext): string {
    return `ALTER TABLE ${this.qualify(op.from)} RENAME TO ${this.escapeIdentifier(op.to)}`;
  }

  override compileRenameTable(
    op: RenameTableOperation,
    context: DDLContext
  ): readonly string[] {
    const statements = [this.generateRenameTable(op, context)];
    const rename = this.defaultPrimaryKeyRename(
      op,
      this.schemaAtOperation(context)
    );
    if (rename) {
      statements.push(
        `ALTER TABLE ${this.qualify(op.to)} RENAME CONSTRAINT ${this.escapeIdentifier(rename.from)} TO ${this.escapeIdentifier(rename.to)}`
      );
    }
    return this.filterStatements(statements);
  }

  override projectNativeRename(
    snapshot: SchemaSnapshot,
    operation: NativeRenameOperation
  ): SchemaSnapshot {
    const projected = super.projectNativeRename(snapshot, operation);
    const rename =
      operation.type === "renameTable"
        ? this.defaultPrimaryKeyRename(operation, snapshot)
        : undefined;
    if (!rename) return projected;
    return {
      ...projected,
      tables: projected.tables.map((table) =>
        table.name === operation.to && table.primaryKey
          ? { ...table, primaryKey: { ...table.primaryKey, name: rename.to } }
          : table
      ),
    };
  }

  private defaultPrimaryKeyRename(
    operation: RenameTableOperation,
    snapshot: SchemaSnapshot | undefined
  ): { from: string; to: string } | undefined {
    const name = snapshot?.tables.find((table) => table.name === operation.from)
      ?.primaryKey?.name;
    return name === this.generatedPrimaryKeyName(operation.from)
      ? { from: name, to: this.generatedPrimaryKeyName(operation.to) }
      : undefined;
  }

  /** Generated keys have an explicit bounded name; catalog omissions stay unknown. */
  override generatedPrimaryKeyName(tableName: string, name?: string): string {
    return name || derivedMigrationName(`${tableName}_pkey`);
  }

  /** Native identity and PK effects needed by rename and enum DDL at this prefix. */
  private schemaAtOperation(context: DDLContext): SchemaSnapshot | undefined {
    let snapshot = context.currentSchema;
    if (!snapshot) return undefined;
    for (const operation of context.precedingOperations ?? []) {
      if (
        operation.type === "renameTable" ||
        operation.type === "renameColumn"
      ) {
        snapshot = this.projectNativeRename(snapshot, operation);
      } else if (operation.type === "createTable") {
        const table = operation.table;
        snapshot = {
          ...snapshot,
          tables: [
            ...snapshot.tables,
            table.primaryKey
              ? {
                  ...table,
                  primaryKey: {
                    ...table.primaryKey,
                    name: this.generatedPrimaryKeyName(
                      table.name,
                      table.primaryKey.name
                    ),
                  },
                }
              : table,
          ],
        };
      } else if (operation.type === "dropTable") {
        snapshot = {
          ...snapshot,
          tables: snapshot.tables.filter(
            (table) => table.name !== operation.tableName
          ),
        };
      } else if (
        operation.type === "addPrimaryKey" ||
        operation.type === "dropPrimaryKey"
      ) {
        snapshot = {
          ...snapshot,
          tables: snapshot.tables.map((table) =>
            table.name === operation.tableName
              ? {
                  ...table,
                  primaryKey:
                    operation.type === "addPrimaryKey"
                      ? {
                          ...operation.primaryKey,
                          name: this.generatedPrimaryKeyName(
                            operation.tableName,
                            operation.primaryKey.name
                          ),
                        }
                      : undefined,
                }
              : table
          ),
        };
      }
    }
    return snapshot;
  }

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  generateAddColumn(op: AddColumnOperation, context: DDLContext): string {
    const colDef = this.generateColumnDef(op.column, context);
    return `ALTER TABLE ${this.qualify(op.tableName)} ADD COLUMN ${colDef}`;
  }

  generateDropColumn(op: DropColumnOperation, _context: DDLContext): string {
    return `ALTER TABLE ${this.qualify(op.tableName)} DROP COLUMN ${this.escapeIdentifier(op.columnName)}`;
  }

  generateRenameColumn(
    op: RenameColumnOperation,
    _context: DDLContext
  ): string {
    return `ALTER TABLE ${this.qualify(op.tableName)} RENAME COLUMN ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`;
  }

  generateAlterColumn(op: AlterColumnOperation, context: DDLContext): string {
    return this.compileAlterColumn(op, context).join(";\n");
  }

  override compileAlterColumn(
    op: AlterColumnOperation,
    context: DDLContext
  ): readonly string[] {
    const { tableName, columnName, from, to } = op;
    const statements: string[] = [];
    const table = this.qualify(tableName);
    const col = this.escapeIdentifier(columnName);

    // A decimal descriptor change is VALIDATED BEFORE the type moves, and the
    // proof stays live across it. `ALTER TYPE numeric(p,s) USING c::numeric(p,s)`
    // on its own ROUNDS a value with too many fractional digits — silently
    // rewriting stored data, which §7.3 forbids outright ("No descriptor change
    // rounds existing data"). The constraint refuses those rows instead, before
    // any DDL runs, and because it is only dropped afterwards no concurrent
    // write can land an unrepresentable value while the conversion is in
    // flight. The whole sequence is one transaction on PostgreSQL, so a
    // refusal takes the validation, the DDL and the metadata back together.
    //
    // The TARGET domain alone is the whole predicate — `c = c::numeric(p,s)`
    // says "this value survives the conversion unchanged" without consulting
    // where it came from. So an unconstrained `numeric` adopted by a declared
    // descriptor is validated exactly like a descriptor-to-descriptor change;
    // skipping it there was the one path on which the `USING` cast still
    // rounded.
    const conversion = decimalConversionRequired(from, to);
    if (conversion && to.decimal) {
      const targetType = this.renderTypeToken(to.type, context);
      const constraint = this.escapeIdentifier(
        decimalConversionConstraintName(
          targetType.endsWith("[]") ? "list" : "scalar",
          to.decimal
        )
      );
      // The migration owner's table lock, taken inside the transaction the
      // executor already opened (§7.4): it makes the validation and the type
      // change one lock acquisition rather than two, so nothing interleaves
      // between the row the constraint proved and the row the cast reads.
      statements.push(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      statements.push(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${postgresDecimalFitsCheck(col, targetType)})`
      );
    }

    if (from.type !== to.type) {
      if (from.default !== undefined) {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`
        );
      }
      // The new type is a column type token like any other, so a managed enum
      // is qualified here too — in BOTH positions, since the `USING` cast names
      // the same type the column is being changed to.
      const newType = this.renderTypeToken(to.type, context);
      // text → uuid is the ONE identifier conversion a dialect performs on its
      // own, and the only one whose failure is per-row rather than structural.
      // The guard changes no outcome — the cast below refuses the same estate —
      // it replaces "invalid input syntax for type uuid" with the count and the
      // two routes, before the transaction is spent.
      if (isPostgresTextToUuid(from.type, newType)) {
        statements.push(postgresTextToUuidGuard(table, col));
      }
      const fromBase = from.type.endsWith("[]")
        ? from.type.slice(0, -2)
        : from.type;
      const throughText = this.managedEnumNames(context).has(fromBase)
        ? `::text${from.type.endsWith("[]") ? "[]" : ""}`
        : "";
      statements.push(
        `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${newType} USING ${col}${throughText}::${newType}`
      );
    }

    if (from.nullable !== to.nullable) {
      if (to.nullable) {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`
        );
      } else {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`
        );
      }
    }

    if (
      from.default !== to.default ||
      (from.type !== to.type && from.default !== undefined)
    ) {
      if (to.default === undefined) {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`
        );
      } else {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${to.default}`
        );
      }
    }

    if (conversion && to.decimal) {
      const targetType = this.renderTypeToken(to.type, context);
      statements.push(
        `ALTER TABLE ${table} DROP CONSTRAINT ${this.escapeIdentifier(decimalConversionConstraintName(targetType.endsWith("[]") ? "list" : "scalar", to.decimal))}`
      );
    }

    return this.filterStatements(statements);
  }

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  generateCreateIndex(op: CreateIndexOperation, _context: DDLContext): string {
    const { tableName, index } = op;
    const physicalType = index.type === "spatial" ? "gist" : index.type;

    // Validate index type against capabilities
    this.validateIndexType(physicalType, index.name);

    const unique = index.unique ? "UNIQUE " : "";
    const indexType = physicalType ? `USING ${physicalType} ` : "";
    const cols = index.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    const where = index.where ? ` WHERE ${index.where}` : "";
    // PostgreSQL does not allow a schema on the index name in CREATE INDEX —
    // the index is created in the target table's schema, which is why the
    // TABLE carries the qualification and the index name is one identifier.
    return `CREATE ${unique}INDEX ${this.escapeIdentifier(index.name)} ON ${this.qualify(tableName)} ${indexType}(${cols})${where}`;
  }

  // DROP INDEX names the index itself, which lives in a schema and takes one
  // (§4.1) — the mirror of CREATE INDEX above.
  generateDropIndex(op: DropIndexOperation, _context: DDLContext): string {
    return `DROP INDEX ${this.qualify(op.indexName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  generateAddForeignKey(
    op: AddForeignKeyOperation,
    _context: DDLContext
  ): string {
    const { tableName, fk } = op;
    const cols = fk.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    const refCols = fk.referencedColumns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    const onDelete = fk.onDelete
      ? ` ON DELETE ${this.formatReferentialAction(fk.onDelete)}`
      : "";
    const onUpdate = fk.onUpdate
      ? ` ON UPDATE ${this.formatReferentialAction(fk.onUpdate)}`
      : "";
    // Both TABLE positions are qualified — the owner and the reference target.
    // A bare `REFERENCES` target resolves through `search_path` and would let
    // one estate's constraint point at another schema's table.
    return `ALTER TABLE ${this.qualify(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${this.qualify(fk.referencedTable)} (${refCols})${onDelete}${onUpdate}`;
  }

  generateDropForeignKey(
    op: DropForeignKeyOperation,
    _context: DDLContext
  ): string {
    return `ALTER TABLE ${this.qualify(op.tableName)} DROP CONSTRAINT ${this.escapeIdentifier(op.fkName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  generateAddUniqueConstraint(
    op: AddUniqueConstraintOperation,
    _context: DDLContext
  ): string {
    const { tableName, constraint } = op;
    const cols = constraint.columns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    return `ALTER TABLE ${this.qualify(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(constraint.name)} UNIQUE (${cols})`;
  }

  generateDropUniqueConstraint(
    op: DropUniqueConstraintOperation,
    _context: DDLContext
  ): string {
    return `ALTER TABLE ${this.qualify(op.tableName)} DROP CONSTRAINT ${this.escapeIdentifier(op.constraintName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations
  // ===========================================================================

  generateAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    _context: DDLContext
  ): string {
    const { tableName, primaryKey } = op;
    const cols = primaryKey.columns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    const name = this.escapeIdentifier(
      this.generatedPrimaryKeyName(tableName, primaryKey.name)
    );
    return `ALTER TABLE ${this.qualify(tableName)} ADD CONSTRAINT ${name} PRIMARY KEY (${cols})`;
  }

  generateDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    _context: DDLContext
  ): string {
    return `ALTER TABLE ${this.qualify(op.tableName)} DROP CONSTRAINT ${this.escapeIdentifier(op.constraintName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  // An enum OPERATION names an ORM-managed enum by construction, so its type
  // name is qualified unconditionally — the managed-enum SET exists only to
  // decide whether a COLUMN's type token happens to name one.
  generateCreateEnum(op: CreateEnumOperation, _context: DDLContext): string {
    const { enumDef } = op;
    const values = enumDef.values.map((v) => this.escapeValue(v)).join(", ");
    return `CREATE TYPE ${this.qualify(enumDef.name)} AS ENUM (${values})`;
  }

  generateDropEnum(op: DropEnumOperation, _context: DDLContext): string {
    return `DROP TYPE ${this.qualify(op.enumName)}`;
  }

  override generateClearMigrations(tableName: string): string {
    return `DELETE FROM ${this.qualify(tableName)}`;
  }

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  generateAcquireLock(lockId: number): string | null {
    return `WITH RECURSIVE lock_attempt AS (
      SELECT pg_try_advisory_lock(${lockId}) AS acquired, clock_timestamp() + interval '10 seconds' AS deadline
      UNION ALL
      SELECT pg_try_advisory_lock(${lockId}), previous.deadline
      FROM lock_attempt previous
      CROSS JOIN LATERAL (SELECT pg_sleep(CASE WHEN previous.acquired THEN 0 ELSE 0.05 END)) waiting
      WHERE NOT previous.acquired AND clock_timestamp() < previous.deadline
    ) SELECT acquired FROM lock_attempt ORDER BY acquired DESC LIMIT 1`;
  }

  generateReleaseLock(lockId: number): string | null {
    return `SELECT pg_advisory_unlock(${lockId}) AS released`;
  }

  /** One bounded provider-side retry loop; only boolean true proves ownership. */
  override provesLockAcquired(rows: readonly unknown[]): boolean {
    const row = rows[0];
    return (
      rows.length === 1 &&
      typeof row === "object" &&
      row !== null &&
      Reflect.get(row, "acquired") === true
    );
  }

  /**
   * `pg_advisory_unlock` returns a real boolean: `true` when this session held
   * the lock and released it, `false` when it never held it. Only one boolean
   * `true` proves the release; `false`, a missing row, extra rows, or anything
   * that is not a boolean leaves the session holding a lock nobody will free.
   */
  override provesLockReleased(rows: readonly unknown[]): boolean {
    if (rows.length !== 1) {
      return false;
    }
    const row = rows[0];
    if (typeof row !== "object" || row === null) {
      return false;
    }
    return Reflect.get(row, "released") === true;
  }

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  // Both inventories BIND the schema: they are the reads that decide what a
  // reset drops, and §4.2 admits no interpolated catalog operand.
  generateInventoryTables(): { sql: string; params: unknown[] } {
    return {
      sql: POSTGRES_MANAGED_TABLE_NAMES_QUERY,
      params: [this.requireEstateNamespace()],
    };
  }

  generateInventoryEnums(): { sql: string; params: unknown[] } | null {
    return {
      sql: `SELECT t.typname AS name
      FROM pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = $1
      ORDER BY t.typname`,
      params: [this.requireEstateNamespace()],
    };
  }

  // No CASCADE on either drop (§6.1). PostgreSQL's default RESTRICT is the
  // containment boundary: a dependant this estate does not own aborts the
  // operation instead of being deleted with it.
  override generateDropTableSQL(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.qualify(tableName)}`;
  }

  override generateDropEnumSQL(enumName: string): string | null {
    return `DROP TYPE IF EXISTS ${this.qualify(enumName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  generateAlterEnum(op: AlterEnumOperation, _context: DDLContext): string {
    return this.compileAlterEnum(op, _context).join(";\n");
  }

  override compileAlterEnum(
    op: AlterEnumOperation,
    context: DDLContext
  ): readonly string[] {
    const physicalContext = {
      ...context,
      currentSchema: this.schemaAtOperation(context),
    };
    const {
      enumName,
      addValues = [],
      removeValues,
      newValues,
      dependentColumns,
    } = op;
    const statements: string[] = [];
    const enumType = this.qualify(enumName);
    const before =
      physicalContext.currentSchema?.enums?.find(
        (item) => item.name === enumName
      )?.values ?? [];
    const reordered =
      newValues !== undefined &&
      before.filter((value) => newValues.includes(value)).join("\0") !==
        newValues.filter((value) => before.includes(value)).join("\0");
    // ADD VALUE only touches the catalog, but PostgreSQL refuses the new value
    // to every later statement of its transaction (55P04). A later operation
    // of this batch reads one through a default or a partial-index predicate
    // naming it, or by casting stored data, which may hold it, into the enum.
    // A recreated type admits all three.
    const literals = addValues.map((value) => this.escapeValue(value));
    const defaultNamesAdded = (column: ColumnDef) => {
      const labels = enumDefaultLabels(column, enumName);
      return addValues.some((value) => labels.includes(value));
    };
    const predicateNamesAdded = ({ where }: IndexDef) =>
      literals.some((literal) => where?.includes(literal));
    const usesAddedValue = (context.followingOperations ?? []).some(
      (operation) => {
        switch (operation.type) {
          case "createTable":
            return (
              operation.table.columns.some(defaultNamesAdded) ||
              operation.table.indexes.some(predicateNamesAdded)
            );
          case "addColumn":
            return defaultNamesAdded(operation.column);
          case "alterColumn":
            return (
              defaultNamesAdded(operation.to) ||
              (storesEnum(operation.to, enumName) &&
                !storesEnum(operation.from, enumName))
            );
          case "createIndex":
            return predicateNamesAdded(operation.index);
          default:
            return false;
        }
      }
    );
    if (!(removeValues?.length || reordered || usesAddedValue)) {
      const available = new Set(before);
      for (const value of addValues) {
        const following = newValues
          ?.slice(newValues.indexOf(value) + 1)
          .find((candidate) => available.has(candidate));
        statements.push(
          `ALTER TYPE ${enumType} ADD VALUE ${this.escapeValue(value)}${following === undefined ? "" : ` BEFORE ${this.escapeValue(following)}`}`
        );
        available.add(value);
      }
      return this.filterStatements(statements);
    }
    if (!newValues?.length)
      throw new MigrationError(
        `Cannot alter enum "${enumName}" without its full destination values`,
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    for (const { tableName, columnName } of dependentColumns ?? []) {
      const column = physicalContext.currentSchema?.tables
        .find((table) => table.name === tableName)
        ?.columns.find((item) => item.name === columnName);
      const reference = `${this.qualify(tableName)} ALTER COLUMN ${this.escapeIdentifier(columnName)}`;
      if (column?.default !== undefined)
        statements.push(`ALTER TABLE ${reference} DROP DEFAULT`);
      const carrier = column?.type.endsWith("[]") ? "text[]" : "text";
      statements.push(
        `ALTER TABLE ${reference} TYPE ${carrier} USING ${this.escapeIdentifier(columnName)}::${carrier}`
      );
    }
    statements.push(...this.buildEnumReplacementUpdates(op, physicalContext));
    statements.push(`DROP TYPE ${enumType}`);
    statements.push(
      `CREATE TYPE ${enumType} AS ENUM (${newValues.map((value) => this.escapeValue(value)).join(", ")})`
    );
    for (const { tableName, columnName } of dependentColumns ?? []) {
      const column = physicalContext.currentSchema?.tables
        .find((table) => table.name === tableName)
        ?.columns.find((item) => item.name === columnName);
      const reference = `${this.qualify(tableName)} ALTER COLUMN ${this.escapeIdentifier(columnName)}`;
      const target = column?.type.endsWith("[]") ? `${enumType}[]` : enumType;
      statements.push(
        `ALTER TABLE ${reference} TYPE ${target} USING ${this.escapeIdentifier(columnName)}::${target}`
      );
      if (
        column?.default !== undefined &&
        !(removeValues ?? []).some(
          (value) => column.default === this.escapeValue(value)
        )
      )
        statements.push(
          `ALTER TABLE ${reference} SET DEFAULT ${column.default}`
        );
    }
    return this.filterStatements(statements);
  }

  /**
   * The data migration off removed enum values, with its table qualified.
   *
   * The shared base implementation names the table with one identifier, which
   * is right for a dialect whose statements are namespace-relative. These
   * UPDATEs run in the middle of an enum recreation on THIS estate's tables, so
   * PostgreSQL owns the statement rather than inheriting a spelling that
   * `search_path` resolves.
   */
  protected override buildEnumReplacementUpdates(
    op: AlterEnumOperation,
    context?: DDLContext
  ): string[] {
    const { removeValues, dependentColumns } = op;
    if (!(removeValues?.length && dependentColumns?.length)) {
      return [];
    }

    const statements: string[] = [];
    for (const { tableName, columnName } of dependentColumns) {
      const columnType = context?.currentSchema?.tables
        .find((table) => table.name === tableName)
        ?.columns.find((column) => column.name === columnName)?.type;
      if (columnType?.endsWith("[]")) {
        const cases = removeValues.flatMap((value) => {
          const replacement = this.getEnumValueReplacement(
            op,
            tableName,
            columnName,
            value
          );
          return replacement === undefined
            ? []
            : [
                `WHEN ${this.escapeValue(value)} THEN ${replacement === null ? "NULL" : this.escapeValue(replacement)}`,
              ];
        });
        if (cases.length > 0) {
          const column = this.escapeIdentifier(columnName);
          statements.push(
            `UPDATE ${this.qualify(tableName)} SET ${column} = ARRAY(SELECT CASE value ${cases.join(" ")} ELSE value END FROM unnest(${column}) WITH ORDINALITY AS member(value, position) ORDER BY position) WHERE ${column} IS NOT NULL`
          );
        }
        continue;
      }
      for (const removedValue of removeValues) {
        const replacement = this.getEnumValueReplacement(
          op,
          tableName,
          columnName,
          removedValue
        );
        if (replacement === undefined) {
          continue;
        }
        const newValue =
          replacement === null ? "NULL" : this.escapeValue(replacement);
        const column = this.escapeIdentifier(columnName);
        statements.push(
          `UPDATE ${this.qualify(tableName)} SET ${column} = ${newValue} WHERE ${column} = ${this.escapeValue(removedValue)}`
        );
      }
    }
    return statements;
  }
}

// Export singleton instance
export const postgresMigrationDriver = new PostgresMigrationDriver();
