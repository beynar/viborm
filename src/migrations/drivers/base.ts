/**
 * MigrationDriver Base Class
 *
 * Abstract base class for database-specific migration drivers.
 * Each driver implements DDL generation and introspection for its database.
 */

import type { Scalar, ScalarState } from "@schema/scalars";
import {
  type DecimalDialect,
  decimalDefaultText,
  decimalListDefaultText,
} from "@validation/primitives/decimal-codec";
import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type {
  ColumnDef,
  DiffOperation,
  MigrationTarget,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
} from "../types";
import type { Dialect, MigrationCapabilities } from "./types";

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
   * to call that predicate equal to anything.
   */
  canonicalizeIndexPredicates?(
    tableName: string,
    predicates: readonly string[],
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<ReadonlyArray<string | undefined>>;

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
  abstract mapScalarType(scalar: Scalar, scalarState: ScalarState): string;

  /**
   * Final pass over a serialized table before diffing/DDL generation.
   * Lets drivers apply table-aware type adjustments (e.g. MySQL rewrites
   * keyed TEXT columns to VARCHAR, since TEXT cannot be indexed without a
   * key length). Default: identity.
   */
  finalizeTable(table: TableDef): TableDef {
    return table;
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
  ): string;
  abstract generateDropTable(
    op: DropTableOperation,
    context: DDLContext
  ): string;
  abstract generateRenameTable(
    op: RenameTableOperation,
    context: DDLContext
  ): string;

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  abstract generateAddColumn(
    op: AddColumnOperation,
    context: DDLContext
  ): string;
  abstract generateDropColumn(
    op: DropColumnOperation,
    context: DDLContext
  ): string;
  abstract generateRenameColumn(
    op: RenameColumnOperation,
    context: DDLContext
  ): string;
  abstract generateAlterColumn(
    op: AlterColumnOperation,
    context: DDLContext
  ): string;

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  abstract generateCreateIndex(
    op: CreateIndexOperation,
    context: DDLContext
  ): string;
  abstract generateDropIndex(
    op: DropIndexOperation,
    context: DDLContext
  ): string;

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  abstract generateAddForeignKey(
    op: AddForeignKeyOperation,
    context: DDLContext
  ): string;
  abstract generateDropForeignKey(
    op: DropForeignKeyOperation,
    context: DDLContext
  ): string;

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  abstract generateAddUniqueConstraint(
    op: AddUniqueConstraintOperation,
    context: DDLContext
  ): string;
  abstract generateDropUniqueConstraint(
    op: DropUniqueConstraintOperation,
    context: DDLContext
  ): string;

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations
  // ===========================================================================

  abstract generateAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    context: DDLContext
  ): string;
  abstract generateDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    context: DDLContext
  ): string;

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // ===========================================================================

  abstract generateCreateEnum(
    op: CreateEnumOperation,
    context: DDLContext
  ): string;
  abstract generateDropEnum(op: DropEnumOperation, context: DDLContext): string;
  abstract generateAlterEnum(
    op: AlterEnumOperation,
    context: DDLContext
  ): string;

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

  compileCreateTable(
    op: CreateTableOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateCreateTable(op, context)]);
  }

  compileDropTable(
    op: DropTableOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateDropTable(op, context)]);
  }

  compileRenameTable(
    op: RenameTableOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateRenameTable(op, context)]);
  }

  compileAddColumn(
    op: AddColumnOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateAddColumn(op, context)]);
  }

  compileDropColumn(
    op: DropColumnOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateDropColumn(op, context)]);
  }

  compileRenameColumn(
    op: RenameColumnOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateRenameColumn(op, context)]);
  }

  compileAlterColumn(
    op: AlterColumnOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateAlterColumn(op, context)]);
  }

  compileCreateIndex(
    op: CreateIndexOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateCreateIndex(op, context)]);
  }

  compileDropIndex(
    op: DropIndexOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateDropIndex(op, context)]);
  }

  compileAddForeignKey(
    op: AddForeignKeyOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateAddForeignKey(op, context)]);
  }

  compileDropForeignKey(
    op: DropForeignKeyOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateDropForeignKey(op, context)]);
  }

  compileAddUniqueConstraint(
    op: AddUniqueConstraintOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([
      this.generateAddUniqueConstraint(op, context),
    ]);
  }

  compileDropUniqueConstraint(
    op: DropUniqueConstraintOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([
      this.generateDropUniqueConstraint(op, context),
    ]);
  }

  compileAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateAddPrimaryKey(op, context)]);
  }

  compileDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateDropPrimaryKey(op, context)]);
  }

  compileCreateEnum(
    op: CreateEnumOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateCreateEnum(op, context)]);
  }

  compileDropEnum(
    op: DropEnumOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateDropEnum(op, context)]);
  }

  compileAlterEnum(
    op: AlterEnumOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements([this.generateAlterEnum(op, context)]);
  }

  /**
   * Resolves the replacement for a removed enum value on a specific column.
   * Precedence: per-column mapping (columnValueReplacements, keyed
   * "tableName.columnName") → flat valueReplacements → defaultReplacement.
   * Returns undefined when no replacement is configured.
   */
  protected getEnumValueReplacement(
    op: AlterEnumOperation,
    tableName: string,
    columnName: string,
    removedValue: string
  ): string | null | undefined {
    const perColumn =
      op.columnValueReplacements?.[`${tableName}.${columnName}`];
    if (perColumn && removedValue in perColumn) {
      return perColumn[removedValue];
    }
    if (op.valueReplacements && removedValue in op.valueReplacements) {
      return op.valueReplacements[removedValue];
    }
    return op.defaultReplacement;
  }

  /**
   * Builds the UPDATE statements that migrate rows off removed enum values,
   * honoring per-column mappings. Dialects run these before the type change
   * (Postgres: while columns are text; MySQL: before MODIFY COLUMN; SQLite:
   * before table recreation).
   */
  protected buildEnumReplacementUpdates(op: AlterEnumOperation): string[] {
    const { removeValues, dependentColumns } = op;
    if (!(removeValues?.length && dependentColumns?.length)) {
      return [];
    }

    const statements: string[] = [];
    for (const { tableName, columnName } of dependentColumns) {
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
        statements.push(
          `UPDATE ${this.escapeIdentifier(tableName)} SET ${this.escapeIdentifier(columnName)} = ${newValue} WHERE ${this.escapeIdentifier(columnName)} = ${this.escapeValue(removedValue)}`
        );
      }
    }
    return statements;
  }

  // ===========================================================================
  // HELPER METHODS (can be overridden)
  // ===========================================================================

  /**
   * Escapes an identifier (table name, column name, etc.).
   * Default uses double quotes with proper escaping.
   */
  escapeIdentifier(name: string): string {
    if (name == null) {
      throw new MigrationError(
        "Cannot escape null or undefined identifier",
        VibORMErrorCode.INVALID_INPUT
      );
    }
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  /**
   * Escapes a string value for SQL.
   * Default uses single quotes with proper escaping.
   * Returns "NULL" for null/undefined values.
   */
  escapeValue(value: string | null | undefined): string {
    if (value == null) {
      return "NULL";
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /**
   * Formats a referential action for foreign keys.
   */
  formatReferentialAction(action: ReferentialAction): string {
    switch (action) {
      case "cascade":
        return "CASCADE";
      case "setNull":
        return "SET NULL";
      case "restrict":
        return "RESTRICT";
      case "setDefault":
        return "SET DEFAULT";
      default:
        return "NO ACTION";
    }
  }

  // ===========================================================================
  // COMMON IMPLEMENTATIONS (can be overridden for database-specific behavior)
  // ===========================================================================

  /**
   * Gets the SQL default expression for a field.
   * Common implementation that handles most cases.
   * Override for database-specific behavior (e.g., UUID generation, boolean representation).
   *
   * @param scalarState - The scalar state
   * @returns SQL default expression or undefined if no default
   */
  getDefaultExpression(scalarState: ScalarState): string | undefined {
    // Auto-generated values - check for database-level support first
    if (scalarState.autoGenerate) {
      return this.getAutoGenerateExpression(scalarState.autoGenerate);
    }

    // Check for explicit default value
    if (!scalarState.hasDefault || scalarState.default === undefined) {
      return undefined;
    }

    const defaultVal = scalarState.default;

    // Function defaults are generated at runtime
    if (typeof defaultVal === "function") {
      return undefined;
    }

    // Null default
    if (defaultVal === null) {
      return "NULL";
    }

    // A literal decimal-list default is already a trusted list of canonical
    // logical strings: the field codec normalized it at `.default()`. Render
    // its provider value through that same codec, then let the migration driver
    // own quoting and MySQL's required expression parentheses. No generic
    // array/object default enters this arm.
    if (scalarState.decimal && scalarState.array && Array.isArray(defaultVal)) {
      return this.formatDecimalListDefault(
        decimalListDefaultText(
          this.decimalDialect(),
          defaultVal,
          scalarState.decimal
        )
      );
    }

    // Primitive defaults
    if (typeof defaultVal === "string") {
      // A decimal default is canonical text by the time it reaches here
      // (`.default()` normalizes at definition time), and canonical text is the
      // WRONG DDL spelling: it strips trailing zeros, while MySQL reads a
      // `DECIMAL(p,s)` default back from `information_schema` padded to the
      // scale. Two renderings, one owner — this is the DDL one, and emitting
      // the identity one instead would make the differ see a changed default
      // on every push. It is also unquoted, because a decimal default is a
      // numeric literal and not a string on any of the three dialects.
      if (scalarState.decimal) {
        return decimalDefaultText(
          this.decimalDialect(),
          defaultVal,
          scalarState.decimal
        );
      }
      return this.escapeValue(defaultVal);
    }
    if (typeof defaultVal === "number") {
      if (!Number.isFinite(defaultVal)) {
        throw new MigrationError(
          `Invalid default value: ${defaultVal} is not a finite number`,
          VibORMErrorCode.INVALID_INPUT
        );
      }
      return String(defaultVal);
    }
    if (typeof defaultVal === "boolean") {
      return this.formatBooleanDefault(defaultVal);
    }

    // Arrays and objects are handled at application level, not as SQL defaults
    if (typeof defaultVal === "object") {
      return undefined;
    }

    return undefined;
  }

  /** Quotes one codec-rendered decimal-list value as this dialect's DDL. */
  protected formatDecimalListDefault(physicalValue: string): string {
    const literal = this.escapeValue(physicalValue);
    return this.dialect === "mysql" ? `(${literal})` : literal;
  }

  /**
   * Formats a boolean default value.
   * Override for databases that use different representations (e.g., SQLite uses 1/0).
   */
  protected formatBooleanDefault(value: boolean): string {
    return value ? "true" : "false";
  }

  /**
   * This driver's dialect in the codec's vocabulary.
   *
   * Two vocabularies exist because they name different things: `Dialect` is the
   * migration ESTATE's dialect, and `DecimalDialect` is the set of dialects
   * that spell a fixed decimal differently. They are not extended together, so
   * the translation is stated once here rather than at each of the codec's
   * call sites.
   */
  protected decimalDialect(): DecimalDialect {
    if (this.dialect === "postgresql") return "pg";
    if (this.dialect === "mysql") return "mysql";
    return "sqlite";
  }

  /**
   * Gets the SQL expression for an auto-generated value.
   * Override for databases that support specific generation functions.
   *
   * By default, returns undefined for all types (handled at application level).
   * PostgreSQL overrides this to use gen_random_uuid() for UUID.
   *
   * @param autoGenerate - The auto-generate type
   * @returns SQL expression or undefined if handled at application level
   */
  protected getAutoGenerateExpression(
    _autoGenerate: ScalarState["autoGenerate"]
  ): string | undefined {
    // By default, all auto-generate types are handled at application level
    // Databases can override to provide native support (e.g., gen_random_uuid())
    return undefined;
  }

  /**
   * Validates an index type against supported capabilities.
   * Throws MigrationError if the index type is not supported.
   *
   * @param indexType - The index type to validate (e.g., "btree", "hash", "gin")
   * @param indexName - The index name (for error messages)
   */
  protected validateIndexType(
    indexType: string | undefined,
    indexName: string
  ): void {
    if (!indexType) return; // Default index type is always supported

    const supported = this.capabilities.supportsIndexTypes;
    if (!supported.includes(indexType)) {
      throw new MigrationError(
        `Index "${indexName}" uses unsupported index type "${indexType}". ` +
          `Supported types for ${this.dialect}: ${supported.join(", ")}`,
        VibORMErrorCode.FEATURE_NOT_SUPPORTED
      );
    }
  }

  /**
   * Generates a column definition string.
   * Common implementation that can be overridden for database-specific syntax.
   *
   * @param column - The column definition
   * @returns SQL column definition string
   */
  protected generateColumnDef(column: ColumnDef, context: DDLContext): string {
    const parts: string[] = [this.escapeIdentifier(column.name)];

    // Handle type (may be overridden for auto-increment handling)
    const columnType = this.formatColumnType(column, context);
    parts.push(columnType);

    // NOT NULL constraint
    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    // DEFAULT clause (skip for auto-increment columns)
    if (column.default !== undefined && !column.autoIncrement) {
      parts.push(`DEFAULT ${column.default}`);
    }

    return parts.join(" ");
  }

  /**
   * Formats the column type, handling auto-increment and other special cases.
   * Override for database-specific type handling (e.g., PostgreSQL SERIAL).
   *
   * Takes the DDL context because a column type can name a managed enum type,
   * and a managed enum type is qualified exactly like any other persistent
   * object — which is a destination-dependent decision.
   */
  protected formatColumnType(column: ColumnDef, _context: DDLContext): string {
    return column.type;
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

  /**
   * Clears every row in a preserved control table during live reset.
   *
   * @param tableName - The control table name
   * @returns SQL DELETE statement
   */
  generateClearMigrations(tableName: string): string {
    const table = this.escapeIdentifier(tableName);
    return `DELETE FROM ${table}`;
  }

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

  /**
   * Generates SQL for dropping a table.
   *
   * There is no `CASCADE` arm. §6.1: a namespace is a containment boundary, and
   * `DROP TABLE ... CASCADE` drops dependants in OTHER namespaces even when the
   * enumeration that produced this name only ever selected one. The dependency
   * graph is materialized as explicit foreign-key drops before the table drops
   * instead, and an unknown external dependency then aborts the operation
   * through PostgreSQL's default `RESTRICT` rather than deleting collaterally.
   *
   * @param tableName - The table name
   * @returns SQL DROP TABLE statement
   */
  generateDropTableSQL(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)}`;
  }

  /**
   * Generates SQL for dropping an enum type.
   * Returns null for databases that don't support enums.
   *
   * @param enumName - The enum name
   * @returns SQL DROP TYPE statement or null
   */
  generateDropEnumSQL(_enumName: string): string | null {
    return null; // Override in PostgreSQL driver
  }

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
    switch (operation.type) {
      case "createTable":
        return this.compileCreateTable(operation, context);
      case "dropTable":
        return this.compileDropTable(operation, context);
      case "renameTable":
        return this.compileRenameTable(operation, context);
      case "addColumn":
        return this.compileAddColumn(operation, context);
      case "dropColumn":
        return this.compileDropColumn(operation, context);
      case "renameColumn":
        return this.compileRenameColumn(operation, context);
      case "alterColumn":
        return this.compileAlterColumn(operation, context);
      case "createIndex":
        return this.compileCreateIndex(operation, context);
      case "dropIndex":
        return this.compileDropIndex(operation, context);
      case "addForeignKey":
        return this.compileAddForeignKey(operation, context);
      case "dropForeignKey":
        return this.compileDropForeignKey(operation, context);
      case "addUniqueConstraint":
        return this.compileAddUniqueConstraint(operation, context);
      case "dropUniqueConstraint":
        return this.compileDropUniqueConstraint(operation, context);
      case "addPrimaryKey":
        return this.compileAddPrimaryKey(operation, context);
      case "dropPrimaryKey":
        return this.compileDropPrimaryKey(operation, context);
      case "createEnum":
        return this.compileCreateEnum(operation, context);
      case "dropEnum":
        return this.compileDropEnum(operation, context);
      case "alterEnum":
        return this.compileAlterEnum(operation, context);
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
