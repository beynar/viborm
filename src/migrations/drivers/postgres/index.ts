import { isGeneratorDefault } from "@schema/scalars/common";
import { nativeTypeFor } from "@schema/scalars/native-types";
import { idDomainOfState, idStorageOf } from "@schema/scalars/string/id-domain";
import type { IdDomain } from "@validation/primitives/id-codec";
import {
  arrayLiteralText,
  readArrayLiteralText,
} from "../../../adapters/databases/postgres/array-literal";
/**
 * PostgreSQL Migration Driver
 *
 * Implements the MigrationDriver interface for PostgreSQL databases.
 * Supports all DDL operations natively.
 */

import type { Scalar, ScalarState } from "@schema/scalars";
import { encodePostgresTemporal } from "@validation/primitives/datetime-physical-codec";
import { hasIdPrefix } from "@validation/primitives/id-formats";
import type { AnyDriver } from "../../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import { errorCause } from "../../../errors/diagnostic-safety";
import { renderQualifiedIdentifier } from "../../../sql/identifiers";
import { type LowLockContext, tableRewrites } from "../../compile";
import {
  decimalConversionConstraintName,
  decimalConversionRequired,
  postgresDecimalFitsCheck,
} from "../../decimal";
import { providerFacts } from "../../execute-dispatch";
import {
  isPostgresTextToUuid,
  postgresTextToUuidGuard,
} from "../../identifier-conversion";
import type { Sha256 } from "../../identity";
import { DEFAULT_MIGRATION_LIMITS } from "../../limits";
import {
  type CatalogHazard,
  catalogCommitBoundaries,
} from "../../statement-safety";
import type {
  ColumnDef,
  DiffOperation,
  IndexDef,
  SchemaSnapshot,
  TableDef,
} from "../../types";
import { derivedMigrationName } from "../../utils";
import type { BoundMigrationDriver } from "..";
import {
  type AddColumnOperation,
  type AddForeignKeyOperation,
  type AddPrimaryKeyOperation,
  type AddUniqueConstraintOperation,
  type AlterColumnOperation,
  type AlterEnumOperation,
  type ControlTableNames,
  type CreateEnumOperation,
  type CreateIndexOperation,
  type CreateTableOperation,
  type DDLContext,
  type DerivedRename,
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
import {
  type BatchExecutor,
  canonicalizeIndexPredicates,
} from "./canonicalize-index-predicate";
import {
  postgresCatalogDigest,
  postgresCatalogDigestQuery,
} from "./catalog-digest";
import {
  admittedExtensionTypes,
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
/** The planner's row estimate in the first line of an EXPLAIN. */
const PLAN_ROWS = /\brows=(\d+)/;

const NAMESPACE_EXISTS_QUERY =
  "SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname = $1";

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

/** The Neki fact a bound migration driver's lock protocol already read. */
const NEKI = new WeakMap<object, boolean>();

/**
 * Whether the server is PlanetScale's Neki (its `version()` names it): the
 * one read of that fact, asked once per command by the lock protocol
 * ({@link PostgresMigrationDriver.holdsSessionLock}), whose answer the
 * preflight of a program that would need a commit there reuses; a command
 * outside the lock protocol asks it there.
 */
async function serverIsNeki(
  driver: object,
  executeRaw: RawExecutor
): Promise<boolean> {
  const known = NEKI.get(driver);
  if (known !== undefined) return known;
  const { rows } = await executeRaw<{ neki: boolean }>(
    "SELECT pg_catalog.version() LIKE '%(Neki)%' AS neki"
  );
  const neki = rows[0]?.neki === true;
  NEKI.set(driver, neki);
  return neki;
}

/**
 * The refusal of a program PlanetScale's Neki cannot run (V11021), before any
 * effect: one entry whose own statements need a commit between them
 * (`inside`), where no commit can be placed, or, for a command that runs its
 * program in one transaction, the first statement that needs one.
 */
function nekiRefusal(
  dialect: string,
  { kind, change, statement }: CatalogHazard,
  inside: boolean
): MigrationError {
  const reason =
    kind === "rows"
      ? "a statement does not see a schema change made earlier in its own transaction"
      : "a statement cannot retype, rename or drop a column of a table created or renamed earlier in its own transaction (NK316)";
  const where = inside
    ? `statement ${statement.position + 1} of this migration runs ${statement.words} after ${change.words} in one dispatch, which no commit can divide. Nothing ran. Put them in separate statements of the migration (one sql fragment each), or in states of their own.`
    : `this migration runs statement ${statement.position + 1} (${statement.words}) after statement ${change.position + 1} (${change.words}). Nothing ran. apply() commits between them; this command runs them in one transaction. Put the later statement in a state of its own after the earlier one, and apply up to the earlier one first (apply({ to })).`;
  return new MigrationError(
    `On PlanetScale's Neki, ${reason}, and ${where}`,
    VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
    {
      meta: {
        dialect,
        feature: inside
          ? "dependent statements in one dispatch"
          : kind === "rows"
            ? "data after schema change in one transaction"
            : "column change of a new relation in one transaction",
      },
    }
  );
}

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

const IDENTIFIER_PART = /[\w$]/;

/**
 * Whether SQL text may name `identifier`: bare in any case, or double-quoted.
 * Matches inside literals and comments count too; they only cost a type
 * recreation that was not needed.
 */
function mayName(sql: string, identifier: string): boolean {
  const text = sql.toLowerCase();
  const name = identifier.replaceAll('"', '""').toLowerCase();
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1))
    if (
      !(
        IDENTIFIER_PART.test(text[at - 1] ?? "") ||
        IDENTIFIER_PART.test(text[at + name.length] ?? "")
      )
    )
      return true;
  return false;
}

/**
 * Whether an operation after `ALTER TYPE … ADD VALUE` in the same transaction
 * may read an added label, which PostgreSQL refuses until commit (55P04): a
 * default naming one, a cast of stored data into the enum, or a partial-index
 * predicate naming the type or a column of it. No literal spelling is
 * trusted: `$$archived$$`, `E'archived'` and a function result compare the
 * same.
 */
function readsAddedValue(
  enumName: string,
  added: readonly string[],
  tables: readonly TableDef[],
  following: readonly DiffOperation[]
): boolean {
  const defaultNamesAdded = (column: ColumnDef) => {
    const labels = enumDefaultLabels(column, enumName);
    return added.some((value) => labels.includes(value));
  };
  // The type and every name the batch gives a column of it, on any table.
  const names = new Set([enumName]);
  const addEnumColumns = (columns: readonly ColumnDef[]) => {
    for (const column of columns)
      if (storesEnum(column, enumName)) names.add(column.name);
  };
  for (const table of tables) addEnumColumns(table.columns);
  const predicateNamesEnum = ({ where }: IndexDef) =>
    where !== undefined && [...names].some((name) => mayName(where, name));
  for (const operation of following) {
    switch (operation.type) {
      case "createTable":
        addEnumColumns(operation.table.columns);
        if (
          operation.table.columns.some(defaultNamesAdded) ||
          operation.table.indexes.some(predicateNamesEnum)
        )
          return true;
        break;
      case "addColumn":
        if (defaultNamesAdded(operation.column)) return true;
        addEnumColumns([operation.column]);
        break;
      // A column already of the enum is known; one cast into it may hold a label.
      case "alterColumn":
        if (
          defaultNamesAdded(operation.to) ||
          (storesEnum(operation.to, enumName) &&
            !storesEnum(operation.from, enumName))
        )
          return true;
        break;
      case "renameColumn":
        if (names.has(operation.from)) names.add(operation.to);
        break;
      case "createIndex":
        if (predicateNamesEnum(operation.index)) return true;
        break;
      default:
        break;
    }
  }
  return false;
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

  /** A table position is qualified like any object, whatever the destination. */
  protected override tableRef(tableName: string): string {
    return this.qualify(tableName);
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
      admittedExtensionTypes: admittedExtensionTypes(this.executionDriver),
    });
  }

  override catalogDigestQuery(
    this: BoundMigrationDriver,
    control: ControlTableNames,
    deparsedPredicates = false
  ) {
    return postgresCatalogDigestQuery(this, control, deparsedPredicates);
  }

  override catalogDigest(
    this: BoundMigrationDriver,
    producer: AnyDriver,
    control: ControlTableNames
  ): Promise<Sha256 | undefined> {
    return postgresCatalogDigest(producer, this, control);
  }

  override async preflightSchemaRequirements(
    snapshots: readonly SchemaSnapshot[],
    executeRaw: RawExecutor,
    program: readonly string[],
    splits = false
  ): Promise<boolean> {
    try {
      // PlanetScale's Neki plans a statement against the schema committed
      // before its transaction (`catalogCommitBoundaries`). Asked of the
      // server only for a program that would need a commit there.
      const { boundaries, first, inside } = catalogCommitBoundaries(program);
      const neki =
        boundaries.length > 0 && (await serverIsNeki(this, executeRaw));
      const refused = neki
        ? (inside ?? (splits ? undefined : first))
        : undefined;
      if (refused) throw nekiRefusal(this.dialect, refused, refused === inside);
      // T5a: a statement that rewrites or scans a table holds a lock that
      // blocks it for as long as that takes, so above `largeTableRows` (the
      // planner's estimate, as EXPLAIN reports it) it is refused here, before
      // any effect. A table the program creates is not there yet: it is empty.
      const { largeTableRows } = this.limits ?? DEFAULT_MIGRATION_LIMITS;
      const rewrites = largeTableRows > 0 ? tableRewrites(program) : [];
      const tables = [...new Set(rewrites.map(({ table }) => table))];
      const relations =
        tables.length === 0
          ? []
          : (
              await executeRaw<{ relation: string | null }>(
                "SELECT pg_catalog.to_regclass(name)::text AS relation FROM unnest($1::text[]) WITH ORDINALITY AS input(name, position) ORDER BY position",
                [arrayLiteralText(tables)]
              )
            ).rows;
      for (const [index, { relation }] of relations.entries()) {
        if (relation === null) continue;
        const explain = `EXPLAIN SELECT 1 FROM ${relation}`;
        const plan = await executeRaw<Record<string, string>>(explain);
        const line = Object.values(plan.rows[0] ?? {})[0] ?? "";
        const estimate = PLAN_ROWS.exec(line)?.[1];
        // A plan without an estimate is not admitted: it was not measured.
        if (estimate !== undefined && Number(estimate) <= largeTableRows) {
          continue;
        }
        const table = tables[index]!;
        const operations = [
          ...new Set(
            rewrites.flatMap((item) =>
              item.table === table ? [item.operation] : []
            )
          ),
        ];
        const operation = operations.join(" and ");
        // T5b: a validation alone has a step form that blocks no write.
        const steps = operations.every((name) => name.endsWith(" validation"))
          ? " Or add the constraint NOT VALID and validate it (VALIDATE CONSTRAINT) in a later migration: neither step blocks writes. generate({ lowLock: true }) does this for foreign keys."
          : "";
        const size =
          estimate === undefined
            ? `whose row estimate ${explain} did not report (${JSON.stringify(line)}), so limits.largeTableRows (${largeTableRows}) cannot admit it`
            : `which the planner estimates at ${estimate} rows, above limits.largeTableRows (${largeTableRows})`;
        throw new MigrationError(
          `This migration runs a ${operation} on ${table}, ${size}. It rewrites or scans the whole table while holding a lock that blocks it, longer than a request should wait. Nothing ran: the schema and data are unchanged. Run it outside the request with a client whose largeTableRows is higher, or 0 for no limit.${steps}`,
          VibORMErrorCode.MIGRATION_INVALID_STATE,
          {
            meta: { table, operation, feature: "large table rewrite" },
          }
        );
      }
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
      if (!snapshots.some(snapshotUsesGeoPoint)) return neki;
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
            meta: {
              dialect: this.dialect,
              feature: "GeoPoint",
              ...providerFacts(failure),
            },
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
      return neki;
    } catch (failure) {
      if (failure instanceof MigrationError) throw failure;
      throw new MigrationError(
        "PostgreSQL schema preflight could not prove the required catalog facts before migration effects.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        {
          cause: errorCause(failure),
          meta: {
            dialect: this.dialect,
            feature: "schema catalog",
            ...providerFacts(failure),
          },
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
    executeRaw: RawExecutor,
    executeBatch?: BatchExecutor
  ): Promise<ReadonlyArray<string | undefined>> {
    return canonicalizeIndexPredicates(
      this.requireEstateNamespace(),
      this.qualify(tableName),
      predicates,
      executeRaw,
      executeBatch
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
      // A JSON field has no list form: members are scalars or temporals.
      const members = literal.map((value) =>
        (scalarState.type === "datetime" || scalarState.type === "date") &&
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
    // DDL follows the scalar's own generator rule (string/scalar.ts
    // `withIdentifier`): only a uuid generator the scalar INSTALLED becomes
    // `gen_random_uuid()`. A non-key `.uuid()` and a `generate: false` key are
    // caller-supplied, and a later `.default(...)` replaces the generator.
    if (
      scalarState.autoGenerate?.kind === "uuid" &&
      !isGeneratorDefault(scalarState.default)
    )
      return undefined;
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

  generateCreateTable(
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

    return statements;
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

  protected override renameDerivedNames(
    owner: string,
    renames: ReadonlyMap<string, DerivedRename>
  ): string[] {
    return [...renames].map(([from, { kind, to }]) =>
      kind === "constraint"
        ? `ALTER TABLE ${this.qualify(owner)} RENAME CONSTRAINT ${this.escapeIdentifier(from)} TO ${this.escapeIdentifier(to)}`
        : `ALTER ${kind === "type" ? "TYPE" : "INDEX"} ${this.qualify(from)} RENAME TO ${this.escapeIdentifier(to)}`
    );
  }

  /** Generated keys have an explicit bounded name; catalog omissions stay unknown. */
  override generatedPrimaryKeyName(tableName: string, name?: string): string {
    return name || derivedMigrationName(`${tableName}_pkey`);
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

  generateAlterColumn(
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

    return statements;
  }

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  // A low-lock build (T5b) runs CONCURRENTLY: writes keep flowing while it
  // reads the table, and an interrupted one leaves the index INVALID for
  // `resolve` to repair.
  generateCreateIndex(
    op: CreateIndexOperation,
    context: LowLockContext
  ): string {
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
    const concurrently = context.lowLock === "add" ? " CONCURRENTLY" : "";
    return `CREATE ${unique}INDEX${concurrently} ${this.escapeIdentifier(index.name)} ON ${this.qualify(tableName)} ${indexType}(${cols})${where}`;
  }

  // DROP INDEX names the index itself, which lives in a schema and takes one
  // (§4.1) — the mirror of CREATE INDEX above.
  generateDropIndex(op: DropIndexOperation, _context: DDLContext): string {
    return `DROP INDEX ${this.qualify(op.indexName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  // A low-lock key (T5b) is added NOT VALID, which checks new rows only and
  // scans nothing, and validated by a later commit, whose scan blocks no write.
  generateAddForeignKey(
    op: AddForeignKeyOperation,
    context: LowLockContext
  ): string {
    const { tableName, fk } = op;
    if (context.lowLock === "validate") {
      return `ALTER TABLE ${this.qualify(tableName)} VALIDATE CONSTRAINT ${this.escapeIdentifier(fk.name)}`;
    }
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
    const notValid = context.lowLock === "add" ? " NOT VALID" : "";
    return `ALTER TABLE ${this.qualify(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${this.qualify(fk.referencedTable)} (${refCols})${onDelete}${onUpdate}${notValid}`;
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

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  /**
   * The TRANSACTION lock a batch request takes after its limits (plans D1,
   * D7): it ends with the transaction, so nothing outlives the request. One
   * request cannot loop across requests, so it retries on the server until
   * the command's `lockWait` (default 10 s) passes, holding its snapshot that
   * long; the transaction's `statement_timeout` is longer by construction
   * (`resolveMigrationLimits`), so the loop is never cut short. A session
   * waits instead with one {@link generateLockFree} try per transaction,
   * holding no snapshot between them (`pinned-session.ts`). Stepwise work
   * adds the session lock on top ({@link generateSessionLock}), and releases
   * that one with {@link generateReleaseLock}.
   */
  generateAcquireLock(lockId: number): string | null {
    const { lockWait } = this.limits ?? DEFAULT_MIGRATION_LIMITS;
    return `WITH RECURSIVE lock_attempt AS (
      SELECT pg_try_advisory_xact_lock(${lockId}) AS acquired, clock_timestamp() + interval '${lockWait / 1000} seconds' AS deadline
      UNION ALL
      SELECT pg_try_advisory_xact_lock(${lockId}), previous.deadline
      FROM lock_attempt previous
      CROSS JOIN LATERAL (SELECT pg_sleep(CASE WHEN previous.acquired THEN 0 ELSE 0.05 END)) waiting
      WHERE NOT previous.acquired AND clock_timestamp() < previous.deadline
    ) SELECT acquired FROM lock_attempt ORDER BY acquired DESC LIMIT 1`;
  }

  generateReleaseLock(lockId: number): string | null {
    return `SELECT pg_advisory_unlock(${lockId}) AS released`;
  }

  /**
   * PlanetScale's Neki refuses a session advisory lock and a transaction one
   * in the same session (`NK013`, "Mixing session and transaction advisory
   * locks is unavailable"), so a command there holds only the session lock.
   */
  override holdsSessionLock(read: RawExecutor): Promise<boolean> {
    // Read afresh for each command: its answer is then the command's.
    NEKI.delete(this);
    return serverIsNeki(this, read);
  }

  /**
   * Neki's router plans every statement against the schema committed before
   * its transaction, and on some of its cells refuses any relation once the
   * transaction changed the schema: the answer the lock protocol read for
   * this command (or the command it views).
   */
  override commitsSchemaChangesAlone(): boolean {
    for (
      let owner: object | null = this;
      owner !== null;
      owner = Object.getPrototypeOf(owner)
    ) {
      const neki = NEKI.get(owner);
      if (neki !== undefined) return neki;
    }
    return false;
  }

  override generateSessionLock(lockId: number): string {
    return `SELECT pg_try_advisory_lock(${lockId}) AS acquired`;
  }

  /**
   * Takes the transaction lock: outside a transaction, it releases with the
   * statement that asks; inside one, it is that transaction's lock try.
   */
  override generateLockFree(lockId: number): string {
    return `pg_try_advisory_xact_lock(${lockId})`;
  }

  /** A lock try, or the batch's loop: only boolean true proves ownership. */
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

  // No CASCADE here or on the inherited table drop (§6.1). PostgreSQL's
  // default RESTRICT is the containment boundary: a dependant this estate does
  // not own aborts the operation instead of being deleted with it.
  override generateDropEnumSQL(enumName: string): string | null {
    return `DROP TYPE IF EXISTS ${this.qualify(enumName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  generateAlterEnum(
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
    // ADD VALUE only touches the catalog; a recreated type admits a later
    // read of an added value in the same transaction.
    const usesAddedValue = readsAddedValue(
      enumName,
      addValues,
      physicalContext.currentSchema?.tables ?? [],
      context.followingOperations ?? []
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
      return statements;
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
        !enumDefaultLabels(column, enumName).some(
          (label) => label !== null && removeValues?.includes(label)
        )
      )
        statements.push(
          `ALTER TABLE ${reference} SET DEFAULT ${column.default}`
        );
    }
    return statements;
  }

  /**
   * An array column's members move in one UPDATE that keeps their order; a
   * scalar column takes the shared per-value UPDATEs.
   */
  protected override enumColumnReplacementUpdates(
    op: AlterEnumOperation,
    tableName: string,
    columnName: string,
    context: DDLContext
  ): string[] {
    const columnType = context.currentSchema?.tables
      .find((table) => table.name === tableName)
      ?.columns.find((column) => column.name === columnName)?.type;
    if (!columnType?.endsWith("[]")) {
      return super.enumColumnReplacementUpdates(
        op,
        tableName,
        columnName,
        context
      );
    }
    const cases = this.enumReplacementCases(op, tableName, columnName);
    if (cases.length === 0) return [];
    const column = this.escapeIdentifier(columnName);
    return [
      `UPDATE ${this.qualify(tableName)} SET ${column} = ARRAY(SELECT CASE value ${cases.join(" ")} ELSE value END FROM unnest(${column}) WITH ORDINALITY AS member(value, position) ORDER BY position) WHERE ${column} IS NOT NULL`,
    ];
  }
}

// Export singleton instance
export const postgresMigrationDriver = new PostgresMigrationDriver();
