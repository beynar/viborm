/**
 * PostgreSQL Migration Driver
 *
 * Implements the MigrationDriver interface for PostgreSQL databases.
 * Supports all DDL operations natively.
 */

import type { Scalar, ScalarState } from "@schema/scalars";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import { renderQualifiedIdentifier } from "../../../sql/identifiers";
import {
  decimalConversionConstraintName,
  decimalConversionRequired,
  postgresDecimalFitsCheck,
} from "../../decimal";
import type { ColumnDef, SchemaSnapshot } from "../../types";
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
import { getPostgresType } from "../type-mapping";
import type { MigrationCapabilities } from "../types";
import { canonicalizeIndexPredicates } from "./canonicalize-index-predicate";
import { introspectPostgresSchema } from "./introspect";

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
  supportsVector: ["vector"],
  supportsGeospatial: ["geometry", "geography"],
} as const;

export class PostgresMigrationDriver extends MigrationDriver {
  readonly dialect = "postgresql" as const;
  readonly driverName = "postgresql";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: true,
    supportsAddEnumValueInTransaction: false,
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
   * `createEnum` is the only operation type read, because it is the only one
   * that can add a name this set does not already hold. An `alterEnum` cannot,
   * twice over: `sortOperations` (`src/migrations/utils.ts:149`) runs it at
   * priority 17, after every arm that renders a column type (`createTable` 8,
   * `addColumn` 9, `alterColumn` 10), so it is never IN `precedingOperations`
   * when one of them asks; and both producers of an `alterEnum` — the differ
   * (`differ.ts:742`) and its inversion (`generate/down.ts:249`) — emit one
   * only for an enum the context's own snapshot already holds, which the loop
   * above contributes.
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
    if (capabilities?.supportsGeospatial) {
      for (const type of EXTENSION_TYPES_BY_CAPABILITY.supportsGeospatial) {
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
      admittedExtensionTypes: this.admittedExtensionTypes(),
    });
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

  mapScalarType(scalar: Scalar, scalarState: ScalarState): string {
    const nativeType = scalar["~"].nativeType;

    // If a native type is specified and it's for PostgreSQL, use it
    if (nativeType && nativeType.db === "pg") {
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

  // getDefaultExpression is inherited from base class
  // PostgreSQL uses "true"/"false" for booleans which is the base default

  /**
   * PostgreSQL supports native UUID generation via gen_random_uuid().
   * This is more efficient than generating UUIDs at the application level.
   */
  protected override getAutoGenerateExpression(
    autoGenerate: import("@schema/scalars").ScalarState["autoGenerate"]
  ): string | undefined {
    switch (autoGenerate?.kind) {
      case "uuid":
        // gen_random_uuid() is available in PostgreSQL 13+ (pgcrypto extension in older versions)
        return "gen_random_uuid()";
      case "now":
        // Use database-level NOW() for consistent timestamps
        return "NOW()";
      default:
        // Other types (ulid, nanoid, cuid, increment, updatedAt) handled elsewhere
        return undefined;
    }
  }

  getEnumColumnType(
    tableName: string,
    columnName: string,
    _values: string[]
  ): string {
    return `${tableName}_${columnName}_enum`;
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
      const pkName = table.primaryKey.name
        ? `CONSTRAINT ${this.escapeIdentifier(table.primaryKey.name)} `
        : "";
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
      // The new type is a column type token like any other, so a managed enum
      // is qualified here too — in BOTH positions, since the `USING` cast names
      // the same type the column is being changed to.
      const newType = this.renderTypeToken(to.type, context);
      statements.push(
        `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${newType} USING ${col}::${newType}`
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

    if (from.default !== to.default) {
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

    // Validate index type against capabilities
    this.validateIndexType(index.type, index.name);

    const unique = index.unique ? "UNIQUE " : "";
    const indexType = index.type ? `USING ${index.type} ` : "";
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
    const name = primaryKey.name
      ? this.escapeIdentifier(primaryKey.name)
      : this.escapeIdentifier(`${tableName}_pkey`);
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
    return `SELECT pg_advisory_lock(${lockId}) AS acquired`;
  }

  generateReleaseLock(lockId: number): string | null {
    return `SELECT pg_advisory_unlock(${lockId}) AS released`;
  }

  /**
   * `pg_advisory_lock` returns `void` and BLOCKS until the lock is held, so the
   * proof is that the statement answered at all — exactly one row, produced
   * after the wait. There is no truthy value to read: a `void` column arrives
   * as an empty string or null on every admitted transport, which is why the
   * arm tests the row's presence rather than its content.
   */
  override provesLockAcquired(rows: readonly unknown[]): boolean {
    return rows.length === 1;
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
      sql: "SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
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
    _context: DDLContext
  ): readonly string[] {
    const { enumName, addValues, removeValues, newValues, dependentColumns } =
      op;
    const statements: string[] = [];
    const enumType = this.qualify(enumName);

    // Simple case: only adding values
    if (addValues && (!removeValues || removeValues.length === 0)) {
      for (const value of addValues) {
        statements.push(
          `ALTER TYPE ${enumType} ADD VALUE ${this.escapeValue(value)}`
        );
      }
      return this.filterStatements(statements);
    }

    // Complex case: removing values requires enum recreation
    if (removeValues && removeValues.length > 0) {
      if (!newValues || newValues.length === 0) {
        throw new Error(
          `Cannot alter enum "${enumName}": newValues required when removing values`
        );
      }

      // Step 1: Convert dependent columns to text
      if (dependentColumns && dependentColumns.length > 0) {
        for (const { tableName, columnName } of dependentColumns) {
          statements.push(
            `ALTER TABLE ${this.qualify(tableName)} ALTER COLUMN ${this.escapeIdentifier(columnName)} TYPE text`
          );
        }
      }

      // Step 2: Migrate data for removed values (per-column mappings from
      // interactive resolution take precedence over the flat map/default)
      statements.push(...this.buildEnumReplacementUpdates(op));

      // Step 3: Drop old enum
      statements.push(`DROP TYPE ${enumType}`);

      // Step 4: Create new enum
      const values = newValues.map((v) => this.escapeValue(v)).join(", ");
      statements.push(`CREATE TYPE ${enumType} AS ENUM (${values})`);

      // Step 5: Convert columns back to enum
      const unreplacedValues = removeValues.filter((v) =>
        (dependentColumns ?? []).some(
          ({ tableName, columnName }) =>
            this.getEnumValueReplacement(op, tableName, columnName, v) ===
            undefined
        )
      );

      if (unreplacedValues.length > 0 && dependentColumns?.length) {
        const valuesList = unreplacedValues.map((v) => `'${v}'`).join(", ");
        statements.push(
          `-- WARNING: The following removed values have no replacement: ${valuesList}\n` +
            "-- If rows exist with these values, the migration will fail.\n" +
            "-- To fix this, do one of the following:\n" +
            `--   1. Add valueReplacements: { "${unreplacedValues[0]}": "newValue" }\n` +
            "--   2. Set defaultReplacement to your column's default value"
        );
      }

      if (dependentColumns && dependentColumns.length > 0) {
        for (const { tableName, columnName } of dependentColumns) {
          const column = this.escapeIdentifier(columnName);
          statements.push(
            `ALTER TABLE ${this.qualify(tableName)} ALTER COLUMN ${column} TYPE ${enumType} USING ${column}::${enumType}`
          );
        }
      }
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
    op: AlterEnumOperation
  ): string[] {
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
