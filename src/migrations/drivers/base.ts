/**
 * MigrationDriver Base Class
 *
 * Abstract base class for database-specific migration drivers.
 * Each driver implements DDL generation and introspection for its database.
 */

import { jsonNullKindOf } from "@schema/json-null";
import type { Scalar, ScalarState } from "@schema/scalars";
import { refinedStringDefault } from "@schema/validation/rules/model";
import type { IdDomain } from "@validation/primitives/id-codec";
import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import { refuseBinaryReencoding } from "../binary-conversion";
import type { Sha256 } from "../identity";
import type { ResolvedMigrationLimits } from "../limits";
import {
  applyNativeRename,
  type NativeRenameOperation,
} from "../native-rename";
import type {
  DiffOperation,
  EnumDependentCheck,
  IndexDef,
  MigrationTarget,
  SchemaSnapshot,
  TableDef,
} from "../types";
import { defaultGeneratedPrimaryKeyName, derivedMigrationName } from "../utils";
import type { PushTargetIdentity } from "../v1-types";
import type { BoundMigrationDriver } from ".";
import type { Dialect, MigrationCapabilities } from "./types";

const ARRAY_TYPE = /\[\]$/;

/** How the serializer ends an index, unique or foreign key name it derives. */
const DERIVED_TAIL = /_(?:idx|f?key)$/;

/** A name a native rename carries along, and the statement kind that does. */
export interface DerivedRename {
  readonly kind: "constraint" | "index" | "type";
  readonly to: string;
}

/** The two control tables the fingerprint leaves out. */
export interface ControlTableNames {
  readonly state: string;
  readonly log: string;
}

/**
 * Context passed to DDL generation methods.
 * Contains information needed for operations that require knowledge of the current schema.
 */
export interface DDLContext {
  /**
   * Where the rendered statement is going.
   *
   * REQUIRED, and deliberately not defaulted anywhere: an artifact is durable
   * and a live statement is not, and the two differ for MySQL (relative
   * artifacts, qualified live SQL). A dispatcher default would reintroduce
   * exactly the implicit mode this fact replaces, so every caller states it.
   * Generation and generated rollback pass `"artifact"`; push, live reset and
   * every immediate DDL path pass `"live"`. SQLite ignores the distinction.
   */
  readonly destination: "artifact" | "live";

  /**
   * Current database schema snapshot.
   * Required for SQLite table recreation operations.
   */
  currentSchema?: SchemaSnapshot;

  /**
   * The operations of this batch that run *before* the one being generated.
   *
   * `currentSchema` is introspected once, before the batch starts, so on its
   * own it describes the database as it was — not as the statements already
   * emitted have left it. A SQLite table recreation has to name the indexes the
   * table holds at the moment it runs, because `DROP TABLE` takes them with it;
   * see `SQLite3MigrationDriver.getCurrentTable`.
   */
  precedingOperations?: DiffOperation[];
  /** Remaining intent in this same compilation batch, for physical coalescing. */
  followingOperations?: readonly DiffOperation[];
}

// Extract individual operation types from the DiffOperation union
export type CreateTableOperation = Extract<
  DiffOperation,
  { type: "createTable" }
>;
export type DropTableOperation = Extract<DiffOperation, { type: "dropTable" }>;
export type RenameTableOperation = Extract<
  DiffOperation,
  { type: "renameTable" }
>;
export type AddColumnOperation = Extract<DiffOperation, { type: "addColumn" }>;
export type DropColumnOperation = Extract<
  DiffOperation,
  { type: "dropColumn" }
>;
export type RenameColumnOperation = Extract<
  DiffOperation,
  { type: "renameColumn" }
>;
export type AlterColumnOperation = Extract<
  DiffOperation,
  { type: "alterColumn" }
>;
export type CreateIndexOperation = Extract<
  DiffOperation,
  { type: "createIndex" }
>;
export type DropIndexOperation = Extract<DiffOperation, { type: "dropIndex" }>;
export type AddForeignKeyOperation = Extract<
  DiffOperation,
  { type: "addForeignKey" }
>;
export type DropForeignKeyOperation = Extract<
  DiffOperation,
  { type: "dropForeignKey" }
>;
export type AddUniqueConstraintOperation = Extract<
  DiffOperation,
  { type: "addUniqueConstraint" }
>;
export type DropUniqueConstraintOperation = Extract<
  DiffOperation,
  { type: "dropUniqueConstraint" }
>;
export type AddPrimaryKeyOperation = Extract<
  DiffOperation,
  { type: "addPrimaryKey" }
>;
export type DropPrimaryKeyOperation = Extract<
  DiffOperation,
  { type: "dropPrimaryKey" }
>;
export type CreateEnumOperation = Extract<
  DiffOperation,
  { type: "createEnum" }
>;
export type DropEnumOperation = Extract<DiffOperation, { type: "dropEnum" }>;
export type AlterEnumOperation = Extract<DiffOperation, { type: "alterEnum" }>;

/**
 * What a dialect states one operation compiles to: one statement, or the
 * ordered statements it needs. {@link MigrationDriver.compileStatements}
 * filters blanks once for every operation.
 */
type GeneratedStatements = string | readonly string[];

/**
 * Abstract base class for migration drivers.
 *
 * Each database (PostgreSQL, SQLite, LibSQL, etc.) extends this class
 * to provide database-specific DDL generation and schema introspection.
 */
export abstract class MigrationDriver {
  /**
   * The SQL dialect this driver targets.
   */
  abstract readonly dialect: Dialect;

  /**
   * The specific driver name (e.g., "pg", "postgres", "pglite", "sqlite3", "libsql").
   * Used for driver-specific registration and lookup.
   */
  abstract readonly driverName: string;

  /**
   * Capabilities supported by this driver.
   */
  abstract readonly capabilities: MigrationCapabilities;

  // ===========================================================================
  // ESTATE BINDING (installed by the registry, never mutated on a singleton)
  // ===========================================================================

  // All three are `declare`: the class DECLARES the shape a bound view has and
  // emits no field for it. Under `useDefineForClassFields` (tsconfig target
  // es2022) an ordinary optional field would install a writable, enumerable own
  // property valued `undefined` on the REGISTERED SINGLETON — module-level
  // state that `Reflect.set` could then fill in, which §3.1 forbids. With
  // `declare`, `"namespace" in postgresMigrationDriver` is false, and the only
  // instances carrying these facts are the frozen views the registry defines
  // them on.

  /**
   * The estate target this instance is bound to.
   *
   * Absent on the REGISTERED singleton, which stays stateless: binding happens
   * at lookup and produces a separate frozen view whose prototype is the
   * singleton. Renderers that need the estate must handle the unbound case
   * rather than assume one, because a singleton reached by name renders
   * artifact SQL with no estate behind it.
   */
  declare readonly target?: MigrationTarget;

  /**
   * The exact concrete execution driver this instance was bound to, retained
   * for live admission (its immutable attestation) and for the adapter's
   * capabilities. Absent on the unbound singleton.
   */
  declare readonly executionDriver?: AnyDriver;

  /**
   * The live execution namespace read once from the bound adapter.
   *
   * Present for PostgreSQL (its target proved it) and for a bound MySQL
   * adapter; absent for an unbound MySQL adapter used for artifact-only work
   * and for SQLite, which has no namespace.
   */
  declare readonly namespace?: string;

  /**
   * The limits of the command this instance is bound for (plans S1, T5a).
   * Absent on the unbound singleton, which renders under the defaults.
   */
  declare readonly limits?: ResolvedMigrationLimits;

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  /**
   * Introspects the current database schema.
   *
   * @param executeRaw - Function to execute raw SQL queries
   * @returns The current schema snapshot
   */
  abstract introspect(
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<SchemaSnapshot>;

  /**
   * Proves external physical requirements encoded by authenticated snapshots.
   * Dialects with no such requirement keep the no-op owner here.
   *
   * `program` is the statement list the command is about to run (empty when
   * it runs none), so a dialect can refuse what that program would destroy
   * (SQLite: a recreation's dependent triggers and views). Required: a caller
   * cannot skip these refusals by leaving it out.
   *
   * Answers whether the program must commit where `catalogCommitBoundaries`
   * names (PlanetScale's Neki). A caller that `splits` commits there itself
   * and is told so; any other is refused such a program before effects.
   */
  async preflightSchemaRequirements(
    _snapshots: readonly SchemaSnapshot[],
    _executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>,
    _program: readonly string[],
    _splits?: boolean
  ): Promise<boolean> {
    // Most dialects have no external schema requirement to prove.
    return false;
  }

  /**
   * Returns this database's own spelling of each declared partial-index
   * predicate, so the differ can compare a declaration against what the catalog
   * gave back (Decision 7.4).
   *
   * Optional, and implemented only where the two spellings can differ.
   * PostgreSQL deparses through `pg_get_expr`, so a declared `active = true`
   * reads back as `(active = true)` and every push re-creates the index;
   * SQLite stores the CREATE INDEX statement verbatim and has nothing to
   * reconcile; MySQL refuses a partial index outright.
   *
   * `executeRaw` runs on ONE pinned connection for the whole call — the
   * canonicalization may need session-local scratch objects, which a pooled
   * connection per statement would scatter. Positional result; `undefined` at
   * a position means the database did not answer, and the differ then refuses
   * to call that predicate equal to anything. `executeBatch` is given where
   * no connection can be pinned (Neon HTTP): each request may be a new
   * session, so session-local work goes out as one request.
   */
  canonicalizeIndexPredicates?(
    tableName: string,
    predicates: readonly string[],
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>,
    executeBatch?: <T>(
      statements: readonly string[]
    ) => Promise<ReadonlyArray<{ rows: T[] }>>
  ): Promise<ReadonlyArray<string | undefined>>;

  /**
   * The CHECK constraints on the columns of each named enum, read from the
   * live catalog for `push`: a schema snapshot models none, and an enum
   * recreation must drop and re-add them around its text conversion. Optional,
   * and implemented only by PostgreSQL, the one dialect that recreates a type
   * under its columns.
   */
  readEnumDependentChecks?(
    enumNames: readonly string[],
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<ReadonlyArray<EnumDependentCheck & { readonly enumName: string }>>;

  /**
   * The live managed schema's fingerprint in one statement, where this
   * dialect can compute it (PostgreSQL, `postgres/catalog-digest.ts`): the
   * statement for a caller that embeds it, and the digest read, `undefined`
   * where it abstains. Absent elsewhere, and the caller introspects. The bound
   * driver owns it, so another dialect's bundle never carries it.
   */
  catalogDigestQuery?(
    this: BoundMigrationDriver,
    control: ControlTableNames,
    deparsedPredicates?: boolean
  ): { readonly sql: string; readonly parameters: unknown[] };
  catalogDigest?(
    this: BoundMigrationDriver,
    producer: AnyDriver,
    control: ControlTableNames
  ): Promise<Sha256 | undefined>;

  /**
   * Explains why one inverted operation cannot be rendered as an automatic
   * rollback on this dialect. Generation owns the persisted rollback policy;
   * the driver owns the physical boundary that makes an inverse unsafe.
   */
  getIrreversibleRollbackReason(_operation: DiffOperation): string | undefined {
    return undefined;
  }

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  /**
   * Maps a VibORM scalar type to the native database column type.
   *
   * @param scalar - The scalar definition
   * @param scalarState - The scalar state with type info
   * @returns The native column type string
   */
  /**
   * `idDomain` is the identifier domain this column holds, which a foreign key
   * DERIVES from the key it references and therefore cannot be read off the
   * scalar. The physical type comes from the one storage owner
   * ({@link idStorageOf}), so the column this creates and the parameter the
   * engine binds into it are one decision.
   */
  abstract mapScalarType(
    scalar: Scalar,
    scalarState: ScalarState,
    idDomain?: IdDomain
  ): string;

  /**
   * Final pass over a serialized table before diffing/DDL generation.
   * Lets drivers apply table-aware type adjustments (e.g. MySQL rewrites
   * keyed TEXT columns to VARCHAR, since TEXT cannot be indexed without a
   * key length). Default: identity.
   */
  finalizeTable(table: TableDef): TableDef {
    return table;
  }

  /** A generated junction, before {@link finalizeTable}. */
  markJunction?(table: TableDef): TableDef;

  /** Whether these operations, after a reset or not, cannot share a transaction. */
  buildsApart?(operations: readonly DiffOperation[], reset?: boolean): boolean;

  /** A driver's own answer to what a push targets, where it has one. */
  pushTarget?(
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<PushTargetIdentity>;

  /**
   * What a committed program of `statements` left running, waited for before
   * the command goes on (SurrealDB's indexes built in the background).
   */
  awaitIndexBuilds?(
    producer: AnyDriver,
    statements: readonly string[]
  ): Promise<void>;

  /** A driver's own hold on a command, where no pinned session can take one. */
  holdLock?<T>(
    driver: AnyDriver,
    lockWait: number,
    run: () => Promise<T>
  ): Promise<T>;

  /** The exact generated PK name used by this driver's DDL and its inverse. */
  generatedPrimaryKeyName(tableName: string, name?: string): string {
    return defaultGeneratedPrimaryKeyName(tableName, name);
  }

  /** Project exactly this driver's compiled rename before diffing or inversion. */
  projectNativeRename(
    snapshot: SchemaSnapshot,
    operation: NativeRenameOperation
  ): SchemaSnapshot {
    const projected = applyNativeRename(snapshot, operation);
    const renames = this.derivedRenames(operation, snapshot);
    if (renames.size === 0) return projected;
    const name = (from: string) => renames.get(from)?.to ?? from;
    const renamed = <T extends { readonly name: string }>(
      items: readonly T[]
    ) => items.map((item) => ({ ...item, name: name(item.name) }));
    const owner =
      operation.type === "renameTable" ? operation.to : operation.tableName;
    return {
      ...projected,
      ...(projected.enums ? { enums: renamed(projected.enums) } : {}),
      tables: projected.tables.map((table) => {
        if (table.name !== owner) return table;
        const { primaryKey } = table;
        return {
          ...table,
          columns: table.columns.map((column) => {
            const element = column.type.replace(ARRAY_TYPE, "");
            const type = name(element) + column.type.slice(element.length);
            return { ...column, type };
          }),
          ...(primaryKey?.name
            ? { primaryKey: { ...primaryKey, name: name(primaryKey.name) } }
            : {}),
          indexes: renamed(table.indexes),
          uniqueConstraints: renamed(table.uniqueConstraints),
          foreignKeys: renamed(table.foreignKeys),
        };
      }),
    };
  }

  /**
   * The statements that move `renames`, the names a native rename of `owner`
   * carries along, on a dialect whose renames carry them (PostgreSQL,
   * MySQL). `table` is the owner as the rename leaves it, still holding the
   * old names. Absent where a rename leaves every name as it is (SQLite).
   */
  protected renameDerivedNames?(
    owner: string,
    renames: ReadonlyMap<string, DerivedRename>,
    table: TableDef,
    context: DDLContext
  ): string[];

  /**
   * The names a native rename carries along, each derived from what it
   * renames: the default primary key's (`<table>_pkey`), a per-column enum
   * type (`<table>_<column>_enum`), and an index, unique or foreign key named
   * after its own columns (`<table>_<columns>_idx`, `_key`, `_fkey`). A table
   * rename also moves an index, unique or foreign key named `<table>_<rest>`
   * that ends as the serializer ends them (`_idx`, `_key`, `_fkey`), whatever
   * the rest is: field names, a compound key's name. Both spellings must fit
   * unbounded (63 bytes) so the inverse rename reads the rest back. Any other
   * name is custom, and stays; a self-set index name of that derived shape
   * cannot be told apart, and moves.
   */
  private derivedRenames(
    operation: NativeRenameOperation,
    snapshot: SchemaSnapshot | undefined
  ): Map<string, DerivedRename> {
    const [from, to] =
      operation.type === "renameTable"
        ? [operation.from, operation.to]
        : [operation.tableName, operation.tableName];
    const renamed = (column: string) =>
      operation.type === "renameColumn" && column === operation.from
        ? operation.to
        : column;
    const renames = new Map<string, DerivedRename>();
    const follow = (
      kind: DerivedRename["kind"],
      name: string | undefined,
      derive: (table: string, column: (name: string) => string) => string,
      tailed = false
    ) => {
      if (name === undefined) return;
      const tail = name.slice(from.length);
      const next =
        name === derive(from, (column) => column)
          ? derive(to, renamed)
          : tailed &&
              name.startsWith(`${from}_`) &&
              DERIVED_TAIL.test(tail) &&
              derivedMigrationName(to + tail) === to + tail
            ? to + tail
            : name;
      if (next !== name) renames.set(name, { kind, to: next });
    };
    const named =
      (columns: readonly string[], suffix: string) =>
      (owner: string, column: (name: string) => string) =>
        derivedMigrationName(
          `${owner}_${columns.map(column).join("_")}_${suffix}`
        );
    const table = snapshot?.tables.find((item) => item.name === from);
    if (!(table && this.renameDerivedNames)) return renames;
    follow("constraint", table.primaryKey?.name, (owner) =>
      this.generatedPrimaryKeyName(owner)
    );
    for (const column of table.columns) {
      follow("type", column.type.replace(ARRAY_TYPE, ""), (owner, renamedTo) =>
        this.getEnumColumnType(owner, renamedTo(column.name), [])
      );
    }
    // A raw index's name is the one its declaration gives, whatever it reads like.
    for (const index of table.indexes) {
      if (index.raw) continue;
      follow("index", index.name, named(index.columns, "idx"), true);
    }
    // A unique constraint's index carries its name: renaming it renames both.
    for (const unique of table.uniqueConstraints) {
      follow("index", unique.name, named(unique.columns, "key"), true);
    }
    for (const key of table.foreignKeys) {
      follow("constraint", key.name, named(key.columns, "fkey"), true);
    }
    return renames;
  }

  private compileDerivedRenames(
    operation: NativeRenameOperation,
    context: DDLContext
  ): string[] {
    const snapshot = this.schemaAtOperation(context);
    const renames = this.derivedRenames(operation, snapshot);
    if (renames.size === 0) return [];
    const owner =
      operation.type === "renameTable" ? operation.to : operation.tableName;
    const table = applyNativeRename(snapshot!, operation).tables.find(
      (item) => item.name === owner
    )!;
    return this.renameDerivedNames!(owner, renames, table, context);
  }

  /**
   * The raw indexes a column rename leaves with a stale marker, as the rename
   * leaves them: the database's index follows the column, but the marker
   * beside it still names the old one, so each driver writes it again (a
   * comment, or the index re-created). One the program drops anyway is left
   * to that drop.
   */
  protected rawIndexesRenamedBy(
    op: RenameColumnOperation,
    context: DDLContext
  ): IndexDef[] {
    let indexes =
      this.schemaAtOperation(context)?.tables.find(
        ({ name }) => name === op.tableName
      )?.indexes ?? [];
    // The indexes the program already dropped or created on the table (a
    // rollback restores the old index before it renames its column back).
    for (const operation of context.precedingOperations ?? []) {
      if (
        operation.type === "dropIndex" &&
        operation.tableName === op.tableName
      )
        indexes = indexes.filter(({ name }) => name !== operation.indexName);
      if (
        operation.type === "createIndex" &&
        operation.tableName === op.tableName
      )
        indexes = [...indexes, operation.index];
    }
    const dropped = new Set(
      (context.followingOperations ?? []).flatMap((operation) =>
        operation.type === "dropIndex" && operation.tableName === op.tableName
          ? [operation.indexName]
          : []
      )
    );
    return indexes.flatMap((index) =>
      index.raw && index.columns.includes(op.from) && !dropped.has(index.name)
        ? [
            {
              ...index,
              columns: index.columns.map((column) =>
                column === op.from ? op.to : column
              ),
            },
          ]
        : []
    );
  }

  /** Native identity and PK effects needed by rename and enum DDL at this prefix. */
  protected schemaAtOperation(context: DDLContext): SchemaSnapshot | undefined {
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

  // Note: getDefaultExpression is implemented below as a common method
  // Override it in subclasses only if database-specific behavior is needed

  /**
   * Gets the column type for an enum field.
   *
   * @param tableName - The table name
   * @param columnName - The column name
   * @param values - The enum values
   * @returns The column type (e.g., "users_status_enum" for PG, "TEXT" for SQLite)
   */
  abstract getEnumColumnType(
    tableName: string,
    columnName: string,
    values: string[]
  ): string;

  // ===========================================================================
  // DDL GENERATION - Table Operations
  // ===========================================================================

  abstract generateCreateTable(
    op: CreateTableOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateDropTable(
    op: DropTableOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateRenameTable(
    op: RenameTableOperation,
    context: DDLContext
  ): GeneratedStatements;

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  abstract generateAddColumn(
    op: AddColumnOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateDropColumn(
    op: DropColumnOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateRenameColumn(
    op: RenameColumnOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateAlterColumn(
    op: AlterColumnOperation,
    context: DDLContext
  ): GeneratedStatements;

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  abstract generateCreateIndex(
    op: CreateIndexOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateDropIndex(
    op: DropIndexOperation,
    context: DDLContext
  ): GeneratedStatements;

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  abstract generateAddForeignKey(
    op: AddForeignKeyOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateDropForeignKey(
    op: DropForeignKeyOperation,
    context: DDLContext
  ): GeneratedStatements;

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  abstract generateAddUniqueConstraint(
    op: AddUniqueConstraintOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateDropUniqueConstraint(
    op: DropUniqueConstraintOperation,
    context: DDLContext
  ): GeneratedStatements;

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations
  // ===========================================================================

  abstract generateAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    context: DDLContext
  ): GeneratedStatements;

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  abstract generateCreateEnum(
    op: CreateEnumOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateDropEnum(
    op: DropEnumOperation,
    context: DDLContext
  ): GeneratedStatements;
  abstract generateAlterEnum(
    op: AlterEnumOperation,
    context: DDLContext
  ): GeneratedStatements;

  // ===========================================================================
  // DDL COMPILATION
  // ===========================================================================

  protected filterStatements(
    statements: readonly (string | null | undefined)[]
  ): string[] {
    return statements.filter(
      (statement): statement is string =>
        statement !== null &&
        statement !== undefined &&
        statement.trim().length > 0
    );
  }
  abstract escapeIdentifier(name: string): string;
  abstract getDefaultExpression(
    _scalar: Scalar,
    scalarState: ScalarState
  ): string | undefined;

  /** Literal defaults cross the scalar's authoritative write admission once. */
  protected literalDefaultValue(state: ScalarState): unknown {
    const value = state.default;
    if (
      value == null ||
      typeof value === "function" ||
      state.autoGenerate ||
      jsonNullKindOf(value) ||
      state.decimal !== undefined
    )
      return value;
    if (typeof value === "number" && !Number.isFinite(value))
      throw new MigrationError(
        `Invalid default value: ${value} is not a finite number`,
        VibORMErrorCode.INVALID_INPUT
      );
    const result = state.base["~standard"].validate(value);
    // A string's own validator judges its default where a create takes it;
    // the column still holds one it refuses (`refinedStringDefault`).
    if (!("value" in result) && refinedStringDefault(state)) return value;
    if (!("value" in result))
      throw new MigrationError(
        `Invalid ${state.type} literal default; the declared scalar schema refused it before DDL.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    return result.value;
  }

  // ===========================================================================
  // LIVE CONTROL AND NAMESPACE
  // ===========================================================================

  /**
   * Proves the configured namespace exists before an empty inventory or an
   * empty applied set may be published.
   *
   * A catalog-driven read cannot otherwise tell a configured-but-absent
   * namespace from an existing namespace holding zero managed objects, and
   * PostgreSQL reports a missing schema and a missing table with the same
   * SQLSTATE. Default: nothing to prove — SQLite has no namespace, and this
   * is not a SQLite namespace feature. PostgreSQL (`pg_namespace`) and MySQL
   * (`information_schema.SCHEMATA`) install their proofs in their own units.
   */
  proveNamespaceExists(
    _executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<void> {
    return Promise.resolve();
  }

  // ===========================================================================
  // PUSH PROBES
  // ===========================================================================

  /** Whether a table holds any row, which `push` reads before adding a required field. */
  abstract tableHoldsRows(producer: AnyDriver, table: string): Promise<boolean>;
  /** A stored value of `column` that `declared` does not hold, if a row has one. */
  abstract undeclaredValue(
    producer: AnyDriver,
    table: string,
    column: string,
    declared: readonly string[]
  ): Promise<{ readonly stored: unknown } | undefined>;

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  /**
   * Generates SQL for acquiring a migration lock, with a stable `acquired`
   * alias so the caller reads one known column rather than a provider-shaped
   * name derived from the expression text.
   *
   * Returns null when this dialect takes no session lock (SQLite/LibSQL, which
   * keep their own single-connection queue).
   *
   * @param lockId - A numeric lock identifier
   * @returns SQL statement or null
   */
  abstract generateAcquireLock(lockId: number): string | null;

  /**
   * Generates SQL for releasing a migration lock, with a stable `released`
   * alias. Returns null on the dialects that take no lock.
   *
   * @param lockId - A numeric lock identifier
   * @returns SQL statement or null
   */
  abstract generateReleaseLock(lockId: number): string | null;

  /**
   * Whether the provider's answer to {@link generateAcquireLock} PROVES the
   * lock is held.
   *
   * Asked only when a lock statement was emitted, so the dialects that emit
   * none never reach it. The default is `false` because a lock nobody proved is
   * a lock nobody holds: MySQL's `GET_LOCK` returns `0` on timeout and `NULL`
   * on error, and the previous owner discarded that answer entirely and ran the
   * "protected" work anyway.
   */
  provesLockAcquired(_rows: readonly unknown[]): boolean {
    return false;
  }

  /**
   * Whether the provider's answer to {@link generateReleaseLock} PROVES the
   * lock was released. A false answer condemns the session: it is holding a
   * lock nobody will release, and returning it to a pool would strand it.
   */
  provesLockReleased(_rows: readonly unknown[]): boolean {
    return false;
  }

  /**
   * Selects the live migration target on a pinned session, or null when this
   * dialect has nothing to select.
   *
   * MySQL is the only arm: its generated artifacts are database-relative, so
   * the target has to be selected on the connection that executes them. Every
   * other dialect qualifies its statements and must never touch session state
   * (§13).
   */
  generateSelectTarget(): string | null {
    return null;
  }

  /**
   * Whether this server holds one command's migration lock as the session
   * lock alone, taken once before its first transaction and never mixed with
   * the transaction lock (PlanetScale's Neki). Asked once per command, on its
   * pinned session, before any lock. Default: no.
   */
  holdsSessionLock(
    _read: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Whether this command's server refuses to plan a statement against any
   * relation in a transaction that changed the schema (PlanetScale's Neki,
   * `NK013` "[817] … earlier DDL in this transaction is not reflected in the
   * router's schema view"), VibORM's own ledger and marker writes included:
   * its work then runs stepwise, each statement committed alone, its control
   * writes in their own. Known once {@link holdsSessionLock} answered for the
   * command. Default: no.
   */
  commitsSchemaChangesAlone(): boolean {
    return false;
  }

  /**
   * The session lock PostgreSQL stepwise work keeps (plan D1), taken while
   * the session holds the transaction lock on the same key (or alone, where
   * {@link holdsSessionLock}); null elsewhere.
   */
  generateSessionLock(_lockId: number): string | null {
    return null;
  }

  /**
   * A condition true while no command holds the migration lock (plan D5).
   * The default never proves it: only PostgreSQL can ask.
   */
  generateLockFree(_lockId: number): string {
    return "false";
  }

  /**
   * Proves a locked session may run this command's work, once, after its
   * target is selected, and returns the driver the command renders from.
   * Default: nothing to prove.
   */
  proveSession(
    _read: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<this> {
    return Promise.resolve(this);
  }

  /** The statements a sequential program runs first, on its producer. */
  programPreamble(_producer: AnyDriver): Promise<readonly string[]> {
    return Promise.resolve([]);
  }

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  /**
   * The live-namespace table inventory: the exact set of tables a reset may
   * drop, as a BOUND read.
   *
   * `{ sql, params }` rather than a bare string because §4.2/§5.2 require the
   * namespace to reach a catalog predicate through the parameter channel: a
   * bare-string seam has nothing to bind through, so it can only splice the
   * name into the statement as an escaped literal.
   *
   * @returns Bound SELECT returning rows with a `name` column
   */
  abstract generateInventoryTables(): { sql: string; params: unknown[] };

  /**
   * The live-namespace enum inventory, or null for dialects with no standalone
   * enum types.
   */
  abstract generateInventoryEnums(): {
    sql: string;
    params: unknown[];
  } | null;
  abstract generateDropTableSQL(tableName: string): string;
  abstract generateDropEnumSQL(enumName: string): string | null;

  // ===========================================================================
  // DISPATCH (final - not meant to be overridden)
  // ===========================================================================

  /**
   * The one owner of provider statement boundaries for generated DDL.
   */
  compileStatements(
    operation: DiffOperation,
    context: DDLContext
  ): readonly string[] {
    const generated = this.generateOperation(operation, context);
    const statements = typeof generated === "string" ? [generated] : generated;
    return this.filterStatements(
      operation.type === "renameTable" || operation.type === "renameColumn"
        ? [...statements, ...this.compileDerivedRenames(operation, context)]
        : statements
    );
  }

  private generateOperation(
    operation: DiffOperation,
    context: DDLContext
  ): GeneratedStatements {
    switch (operation.type) {
      case "createTable":
        return this.generateCreateTable(operation, context);
      case "dropTable":
        return this.generateDropTable(operation, context);
      case "renameTable":
        return this.generateRenameTable(operation, context);
      case "addColumn":
        return this.generateAddColumn(operation, context);
      case "dropColumn":
        return this.generateDropColumn(operation, context);
      case "renameColumn":
        return this.generateRenameColumn(operation, context);
      case "alterColumn":
        // Asked HERE rather than in each driver's `generateAlterColumn`: the
        // question is one — "can this dialect re-read the stored bytes as the
        // new type?" — and three copies of it would drift the way the three
        // conversion routes already did (PostgreSQL cast, SQLite rebuild,
        // MySQL MODIFY, each silently wrong in its own way).
        refuseBinaryReencoding(
          operation.tableName,
          operation.columnName,
          operation.from.type,
          operation.to.type,
          this.dialect
        );
        return this.generateAlterColumn(operation, context);
      case "createIndex":
        return this.generateCreateIndex(operation, context);
      case "dropIndex":
        return this.generateDropIndex(operation, context);
      case "addForeignKey":
        return this.generateAddForeignKey(operation, context);
      case "dropForeignKey":
        return this.generateDropForeignKey(operation, context);
      case "addUniqueConstraint":
        return this.generateAddUniqueConstraint(operation, context);
      case "dropUniqueConstraint":
        return this.generateDropUniqueConstraint(operation, context);
      case "addPrimaryKey":
        return this.generateAddPrimaryKey(operation, context);
      case "dropPrimaryKey":
        return this.generateDropPrimaryKey(operation, context);
      case "createEnum":
        return this.generateCreateEnum(operation, context);
      case "dropEnum":
        return this.generateDropEnum(operation, context);
      case "alterEnum":
        return this.generateAlterEnum(operation, context);
      default:
        throw new MigrationError(
          `Unknown operation type: ${(operation as any).type}`,
          VibORMErrorCode.INTERNAL_ERROR
        );
    }
  }

  /**
   * Generates display DDL for a diff operation.
   */
  generateDDL(operation: DiffOperation, context: DDLContext): string {
    return this.compileStatements(operation, context).join(";\n");
  }
}
