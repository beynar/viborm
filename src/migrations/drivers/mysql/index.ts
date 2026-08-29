/**
 * MySQL Migration Driver
 *
 * Implements the MigrationDriver interface for MySQL databases.
 * Supports all DDL operations natively with MySQL-specific syntax.
 */

import type { Scalar, ScalarState } from "@schema/scalars";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import { renderQualifiedIdentifier } from "../../../sql/identifiers";
import {
  decimalConversionConstraintName,
  decimalConversionRequired,
  describeDecimalDomain,
  describeDecimalStorageKind,
  mysqlDecimalFitsCheck,
  mysqlDecimalListFitsCheck,
  mysqlDecimalListMarker,
  mysqlDecimalStorageKind,
} from "../../decimal";
import type {
  ColumnDef,
  DiffOperation,
  SchemaSnapshot,
  TableDef,
} from "../../types";

// Regex patterns for spatial type detection
const SPATIAL_TYPE_PATTERNS = [
  /^GEOMETRY\b/,
  /^POINT\b/,
  /^LINESTRING\b/,
  /^POLYGON\b/,
  /^MULTIPOINT\b/,
  /^MULTILINESTRING\b/,
  /^MULTIPOLYGON\b/,
  /^GEOMETRYCOLLECTION\b/,
] as const;

// Regex pattern for extracting base type from column type string
// e.g., "INT UNSIGNED" -> "int", "BIGINT(20)" -> "bigint"
const BASE_TYPE_PATTERN = /[\s(]/;

function classifyDecimalListDescriptorChange(
  source: NonNullable<ColumnDef["decimal"]>,
  target: NonNullable<ColumnDef["decimal"]>
): "same" | "widening" | "narrowing" | "rescaling" {
  if (source.scale !== target.scale) return "rescaling";
  if (source.precision < target.precision) return "widening";
  if (source.precision > target.precision) return "narrowing";
  return "same";
}

import type { CatalogRead, CommandNamespaceResolver } from "../../target";
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
import { getMySQLType, MYSQL_TYPE_DEFAULTS } from "../type-mapping";
import type { MigrationCapabilities } from "../types";
import { type CatalogReader, resolveCatalogNamespace } from "./catalog";
import { introspect as introspectMySQL } from "./introspect";
import {
  mysqlAcquireLockStatement,
  mysqlLockAnswer,
  mysqlReleaseLockStatement,
  mysqlSelectTargetStatement,
} from "./pinned-session";

const MYSQL_POINT_ATTRIBUTE_START = MYSQL_TYPE_DEFAULTS.point.indexOf(" ");
const MYSQL_POINT_BASE_TYPE = MYSQL_TYPE_DEFAULTS.point.slice(
  0,
  MYSQL_POINT_ATTRIBUTE_START
);
const MYSQL_POINT_SRID_ATTRIBUTE = MYSQL_TYPE_DEFAULTS.point.slice(
  MYSQL_POINT_ATTRIBUTE_START + 1
);

/**
 * `GET_LOCK`'s wait bound. A migration command that cannot take the lock within
 * this window reports `MIGRATION_LOCK_FAILED` instead of waiting forever;
 * PostgreSQL's `pg_advisory_lock` blocks by contrast, which is its own
 * documented behaviour.
 */
const MIGRATION_LOCK_TIMEOUT_SECONDS = 30;

/** Exact integer storage that can be adopted without inventing a source scale. */
function isMySQLExactIntegerType(type: string): boolean {
  const base = type.trim().toUpperCase().split(BASE_TYPE_PATTERN, 1)[0];
  return base === "INT" || base === "INTEGER" || base === "BIGINT";
}
export class MySQLMigrationDriver
  extends MigrationDriver
  implements CommandNamespaceResolver
{
  readonly dialect = "mysql" as const;
  readonly driverName = "mysql";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: true, // MySQL has inline ENUM type
    supportsAddEnumValueInTransaction: false, // MODIFY COLUMN is DDL and causes implicit commit
    supportsIndexTypes: ["btree", "fulltext", "spatial"], // InnoDB does not support user-defined HASH indexes
    supportsNativeArrays: false, // Use JSON instead
    supportsAddForeignKeyViaAlter: true, // ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY
    // `information_schema` reports the declared `CONSTRAINT_NAME`.
    introspectionReadsConstraintNames: true,
  };

  override getIrreversibleRollbackReason(
    operation: DiffOperation
  ): string | undefined {
    if (operation.type !== "alterColumn") return undefined;
    const source = operation.from.decimal;
    const target = operation.to.decimal;
    if (
      source === undefined ||
      target === undefined ||
      mysqlDecimalStorageKind(operation.from) !== "list" ||
      mysqlDecimalStorageKind(operation.to) !== "list" ||
      classifyDecimalListDescriptorChange(source, target) !== "narrowing"
    ) {
      return undefined;
    }
    return (
      "MySQL cannot automatically roll back the decimal-list widening of " +
      `"${operation.tableName}"."${operation.columnName}": the inverse narrows ` +
      `${describeDecimalDomain(source)} to ${describeDecimalDomain(target)}, and ` +
      "its implicit DDL commits cannot make the stricter proof, descriptor-marker change, and cleanup indivisible."
    );
  }

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  /**
   * Reads the live catalog for the database THIS driver is bound to.
   *
   * The namespace travels as an argument rather than being read from the
   * connection, so an ambient default database — a pooled session, a proxy, a
   * URL path nobody re-read — can never decide which estate is introspected.
   */
  introspect(executeRaw: CatalogReader): Promise<SchemaSnapshot> {
    return introspectMySQL(executeRaw, this.namespace);
  }

  // ===========================================================================
  // IDENTIFIER ESCAPING (MySQL uses backticks)
  // ===========================================================================

  override escapeIdentifier(name: string): string {
    if (name == null) {
      throw new MigrationError(
        "Cannot escape null or undefined identifier",
        VibORMErrorCode.INVALID_INPUT
      );
    }
    return `\`${String(name).replace(/`/g, "``")}\``;
  }

  /**
   * THE table-position renderer (§5.1).
   *
   * A `"live"` statement names `` `database`.`table` `` so it reaches the bound
   * database whatever the connection's own default is; an `"artifact"`
   * statement names the table relative so ONE generated MySQL estate deploys to
   * `app_dev`, `app_test` and `app_prod` unchanged (§13 rejects embedded
   * database names in stored artifacts).
   *
   * An unbound driver has no database to name, so both destinations render the
   * bare table and unbound MySQL output stays byte-identical (§12.21). The
   * database and the object are quoted SEPARATELY, through the one
   * qualification primitive: handing `database.table` to `escapeIdentifier`
   * would silently produce one identifier naming a table with a dot in it.
   */
  private tableRef(
    tableName: string,
    destination: DDLContext["destination"]
  ): string {
    return renderQualifiedIdentifier(
      (name) => this.escapeIdentifier(name),
      destination === "live" ? this.namespace : undefined,
      tableName
    );
  }

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  mapScalarType(scalar: Scalar, scalarState: ScalarState): string {
    const nativeType = scalar["~"].nativeType;

    // If a native type is specified and it's for MySQL, use it
    if (nativeType && nativeType.db === "mysql") {
      return nativeType.type;
    }

    // Use centralized type mapping
    return getMySQLType({
      type: scalarState.type,
      array: scalarState.array,
      decimal: scalarState.decimal,
    });
  }

  override getDefaultExpression(scalarState: ScalarState): string | undefined {
    // information_schema.COLUMNS reports both an omitted default and an
    // explicit DEFAULT NULL as catalog NULL. They have the same behavior for a
    // nullable column, so serialize the one representation MySQL can read back
    // instead of manufacturing an alterColumn on every later push.
    if (scalarState.hasDefault && scalarState.default === null) {
      return undefined;
    }
    return super.getDefaultExpression(scalarState);
  }

  /**
   * TWO canonicalizations, both required before the differ compares anything.
   *
   * 1. MySQL cannot index TEXT columns without an explicit key length.
   *    Rewrite TEXT columns that participate in the primary key, a unique
   *    constraint, an index, or a foreign key to VARCHAR(191) (Prisma's
   *    default: 191 * 4 bytes fits the 767-byte InnoDB key limit).
   *
   * 2. MySQL HAS ONE UNIQUE NAMESPACE. A `UNIQUE` constraint and a unique
   *    index are the same object: `information_schema.TABLE_CONSTRAINTS`
   *    reports it as a UNIQUE constraint and `information_schema.STATISTICS`
   *    reports its backing index, so introspection sees ONE database object
   *    under TWO buckets. Whichever bucket the desired schema did not use then
   *    looks like a stray object and the differ plans a drop for it — measured
   *    on docker MySQL 8 as a spurious `dropIndex` for every declared unique
   *    CONSTRAINT and a spurious `dropUniqueConstraint` for every declared
   *    unique INDEX, on every push, forever.
   *
   *    So MySQL picks ONE bucket and both sides speak it: every unique becomes
   *    a unique INDEX here, and introspection (`introspect.ts`) files uniques
   *    only under `indexes` to match. Indexes are the right survivor because
   *    they carry the strictly larger vocabulary — a unique index can express
   *    a unique constraint, not the reverse.
   *
   *    Existing databases need no migration: the object already exists under
   *    the name the desired side now spells as an index, so the two sides
   *    simply agree. `generateCreateTable` emits nothing for the (now empty)
   *    unique-constraint bucket and the index bucket is created as usual.
   */
  override finalizeTable(table: TableDef): TableDef {
    const keyedColumns = new Set<string>([
      ...(table.primaryKey?.columns ?? []),
      ...table.uniqueConstraints.flatMap((uq) => uq.columns),
      ...table.indexes.flatMap((index) => index.columns),
      ...table.foreignKeys.flatMap((fk) => fk.columns),
    ]);

    const declaredIndexNames = new Set(
      table.indexes.map((index) => index.name)
    );
    const uniquesAsIndexes = table.uniqueConstraints
      // A name already spelled as an index is the SAME object; keeping both
      // would put two entries under one name into the snapshot.
      .filter((unique) => !declaredIndexNames.has(unique.name))
      .map((unique) => ({
        name: unique.name,
        columns: unique.columns,
        unique: true,
      }));

    return {
      ...table,
      columns: table.columns.map((column) =>
        column.type.toUpperCase() === "TEXT" && keyedColumns.has(column.name)
          ? { ...column, type: "VARCHAR(191)" }
          : column
      ),
      indexes: [...table.indexes, ...uniquesAsIndexes],
      uniqueConstraints: [],
    };
  }

  /**
   * MySQL uses 1/0 for boolean values (TINYINT(1)).
   */
  protected override formatBooleanDefault(value: boolean): string {
    return value ? "1" : "0";
  }

  /**
   * MySQL supports native auto-generation for certain values.
   */
  protected override getAutoGenerateExpression(
    autoGenerate: ScalarState["autoGenerate"]
  ): string | undefined {
    switch (autoGenerate?.kind) {
      case "now":
        return "CURRENT_TIMESTAMP";
      case "uuid":
        // MySQL 8.0+ has UUID() function, but it's not suitable for DEFAULT
        // Use application-level generation instead
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * MySQL enum values are part of the column definition.
   * Returns ENUM('val1', 'val2', ...) syntax.
   */
  getEnumColumnType(
    _tableName: string,
    _columnName: string,
    values: string[]
  ): string {
    const escapedValues = values
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    return `ENUM(${escapedValues})`;
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * MySQL integer types that support AUTO_INCREMENT.
   * Includes variations with UNSIGNED modifier.
   */
  private static readonly AUTO_INCREMENT_TYPES = new Set([
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
  ]);

  /**
   * Validates that a column type is compatible with AUTO_INCREMENT.
   * Returns true if valid, throws MigrationError if invalid.
   */
  private validateAutoIncrementType(column: ColumnDef): void {
    // Extract base type (e.g., "INT UNSIGNED" -> "int", "BIGINT(20)" -> "bigint")
    const baseType =
      column.type.toLowerCase().split(BASE_TYPE_PATTERN)[0] ?? "";

    if (!MySQLMigrationDriver.AUTO_INCREMENT_TYPES.has(baseType)) {
      throw new MigrationError(
        "MySQL AUTO_INCREMENT requires an integer type (TINYINT, SMALLINT, MEDIUMINT, INT, INTEGER, BIGINT). " +
          `Column "${column.name}" has type "${column.type}" which is not compatible with AUTO_INCREMENT.`,
        VibORMErrorCode.INVALID_INPUT,
        {
          meta: { column: column.name, type: column.type, autoIncrement: true },
        }
      );
    }
  }

  /**
   * Generates a column definition string for MySQL.
   */
  protected override generateColumnDef(
    column: ColumnDef,
    _context: DDLContext
  ): string {
    const parts: string[] = [this.escapeIdentifier(column.name)];
    const isGeoPoint = column.type.toUpperCase() === MYSQL_TYPE_DEFAULTS.point;

    // Handle auto-increment (MySQL uses AUTO_INCREMENT keyword)
    if (column.autoIncrement) {
      // Validate that the column type supports AUTO_INCREMENT
      this.validateAutoIncrementType(column);
      // Preserve the original type (including modifiers like UNSIGNED)
      parts.push(column.type);
      parts.push("AUTO_INCREMENT");
    } else {
      parts.push(isGeoPoint ? MYSQL_POINT_BASE_TYPE : column.type);
    }

    // NOT NULL constraint
    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    // MySQL's grammar places the SRID attribute after nullability:
    // `POINT NOT NULL SRID 4326`, not `POINT SRID 4326 NOT NULL`.
    if (isGeoPoint) {
      parts.push(MYSQL_POINT_SRID_ATTRIBUTE);
    }

    // DEFAULT clause (skip for auto-increment columns and types that do not
    // support a simple default). JSON stays suppressed except for the exact
    // decimal-list expression the serializer owns below.
    if (column.default !== undefined && !column.autoIncrement) {
      const upperType = column.type.toUpperCase();
      const isTextOrBlob =
        upperType.includes("TEXT") ||
        upperType.includes("BLOB") ||
        upperType === "TINYTEXT" ||
        upperType === "MEDIUMTEXT" ||
        upperType === "LONGTEXT" ||
        upperType === "TINYBLOB" ||
        upperType === "MEDIUMBLOB" ||
        upperType === "LONGBLOB";
      const isJson = upperType.includes("JSON");
      const isDecimalList =
        column.decimal !== undefined &&
        mysqlDecimalStorageKind(column) === "list";
      const isSpatial = SPATIAL_TYPE_PATTERNS.some((pattern) =>
        pattern.test(upperType)
      );

      if (!(isTextOrBlob || (isJson && !isDecimalList) || isSpatial)) {
        parts.push(`DEFAULT ${column.default}`);
      }
    }

    // The descriptor marker for a JSON-backed decimal LIST. A scalar needs
    // none — `DECIMAL(p,s)` spells its own domain — but JSON carries nothing,
    // so the comment is the only place a list's precision and scale survive
    // (§6.2). It is emitted from `generateColumnDef`, which is also what
    // `MODIFY COLUMN` renders, because MODIFY rewrites the WHOLE definition:
    // a comment this method did not re-emit would be dropped by the very
    // statement that changed the column.
    if (column.decimal && mysqlDecimalStorageKind(column) === "list") {
      parts.push(
        `COMMENT ${this.escapeValue(mysqlDecimalListMarker(column.decimal))}`
      );
    }

    return parts.join(" ");
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

    // Primary key
    if (table.primaryKey) {
      const pkCols = table.primaryKey.columns
        .map((c) => this.escapeIdentifier(c))
        .join(", ");
      columnDefs.push(`PRIMARY KEY (${pkCols})`);
    }

    // Unique constraints
    for (const uq of table.uniqueConstraints) {
      const uqCols = uq.columns.map((c) => this.escapeIdentifier(c)).join(", ");
      columnDefs.push(
        `CONSTRAINT ${this.escapeIdentifier(uq.name)} UNIQUE (${uqCols})`
      );
    }

    // Foreign keys (inline in CREATE TABLE for MySQL)
    for (const fk of table.foreignKeys) {
      const fkCols = fk.columns.map((c) => this.escapeIdentifier(c)).join(", ");
      const refCols = fk.referencedColumns
        .map((c) => this.escapeIdentifier(c))
        .join(", ");
      let fkDef = `CONSTRAINT ${this.escapeIdentifier(fk.name)} `;
      fkDef += `FOREIGN KEY (${fkCols}) `;
      fkDef += `REFERENCES ${this.tableRef(fk.referencedTable, context.destination)} (${refCols})`;
      if (fk.onDelete && fk.onDelete !== "noAction") {
        fkDef += ` ON DELETE ${this.formatReferentialAction(fk.onDelete)}`;
      }
      if (fk.onUpdate && fk.onUpdate !== "noAction") {
        fkDef += ` ON UPDATE ${this.formatReferentialAction(fk.onUpdate)}`;
      }
      columnDefs.push(fkDef);
    }

    const sql = `CREATE TABLE ${this.tableRef(table.name, context.destination)} (\n  ${columnDefs.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`;

    const statements = [sql];

    // Indexes are created separately
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

    return this.filterStatements(statements);
  }

  generateDropTable(op: DropTableOperation, context: DDLContext): string {
    // MySQL doesn't have CASCADE for DROP TABLE in the same way
    // Foreign key checks need to be disabled or FKs dropped first
    return `DROP TABLE IF EXISTS ${this.tableRef(op.tableName, context.destination)}`;
  }

  generateRenameTable(op: RenameTableOperation, context: DDLContext): string {
    // BOTH sides carry the database (§5.1): `RENAME TABLE a TO b` names two
    // independent tables, and an unqualified destination would move the table
    // into the connection's default database instead of renaming it in place.
    return `RENAME TABLE ${this.tableRef(op.from, context.destination)} TO ${this.tableRef(op.to, context.destination)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Column Operations
  // ===========================================================================

  generateAddColumn(op: AddColumnOperation, context: DDLContext): string {
    const colDef = this.generateColumnDef(op.column, context);
    return `ALTER TABLE ${this.tableRef(op.tableName, context.destination)} ADD COLUMN ${colDef}`;
  }

  generateDropColumn(op: DropColumnOperation, context: DDLContext): string {
    return `ALTER TABLE ${this.tableRef(op.tableName, context.destination)} DROP COLUMN ${this.escapeIdentifier(op.columnName)}`;
  }

  generateRenameColumn(op: RenameColumnOperation, context: DDLContext): string {
    // MySQL 8.0+ supports RENAME COLUMN. Column names stay ONE identifier —
    // only the table position carries the database (§5.1).
    return `ALTER TABLE ${this.tableRef(op.tableName, context.destination)} RENAME COLUMN ${this.escapeIdentifier(op.from)} TO ${this.escapeIdentifier(op.to)}`;
  }

  generateAlterColumn(op: AlterColumnOperation, context: DDLContext): string {
    return this.alterColumnStatements(op, context).join(";\n");
  }

  override compileAlterColumn(
    op: AlterColumnOperation,
    context: DDLContext
  ): readonly string[] {
    return this.filterStatements(this.alterColumnStatements(op, context));
  }

  private alterColumnStatements(
    op: AlterColumnOperation,
    context: DDLContext
  ): string[] {
    const { tableName, columnName, to } = op;
    const table = this.tableRef(tableName, context.destination);

    // Build the new column definition
    const colDef = this.generateColumnDef(to, context);

    const alter =
      // If column name changed, use CHANGE COLUMN (which handles rename + alter)
      columnName === to.name
        ? `ALTER TABLE ${table} MODIFY COLUMN ${colDef}`
        : `ALTER TABLE ${table} CHANGE COLUMN ${this.escapeIdentifier(columnName)} ${colDef}`;

    const bracket = this.decimalConversionBracket(op, table, context);
    return bracket === null
      ? [alter]
      : [bracket.validate, alter, bracket.release];
  }

  /**
   * The proof a decimal conversion runs inside, or `null` when the alteration
   * moves no stored decimal value.
   *
   * MySQL commits each DDL statement as it runs, so there is no transaction to
   * take a bad conversion back — the refusal has to happen BEFORE the column
   * moves. The CHECK constraint is that proof: adding it fails the ALTER when
   * any existing row would not survive the target domain, and it does so
   * whatever `sql_mode` is set to, which a bare `MODIFY COLUMN` does not — in a
   * non-strict mode MySQL answers an out-of-range or over-scaled conversion
   * with a warning and a truncated value, silently rewriting stored data.
   * That mode-independence is the constraint's whole reason to exist beside the
   * MODIFY that would also refuse in strict mode.
   *
   * It is DROPPED only after the alteration, not before it: while it stands, no
   * concurrent write can land a value the target domain would have to round.
   * That is how §7.4's "while writes are excluded" is spelled here, because the
   * obvious spelling — `LOCK TABLES` — is a transaction leader the artifact
   * classifier refuses, and growing that enumeration is forbidden.
   */
  private decimalConversionBracket(
    op: AlterColumnOperation,
    table: string,
    context: DDLContext
  ): { validate: string; release: string } | null {
    const { from, to } = op;
    const source = from.decimal;
    const target = to.decimal;
    if (target === undefined) return null;
    if (!decimalConversionRequired(from, to)) return null;
    if (op.columnName !== to.name) {
      throw new MigrationError(
        `The MySQL decimal conversion for "${op.tableName}"."${op.columnName}" also renames the column to "${to.name}". ` +
          "Run the rename as a separate migration step before changing the decimal descriptor; an interrupted CHECK proof must keep one stable column identity across MySQL's implicit DDL commits.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        {
          meta: {
            dialect: "mysql",
            table: op.tableName,
            column: op.columnName,
            type: "decimal-conversion-with-rename",
          },
        }
      );
    }

    const targetKind = mysqlDecimalStorageKind(to);
    if (source === undefined) {
      // An unmarked JSON container has no proven descriptor and therefore no
      // proven member scale. A scalar INT/BIGINT is different: its exact
      // logical meaning is an integer at scale zero, and the transient CHECK
      // can prove that every one survives the target domain unchanged.
      if (targetKind !== "scalar" || !isMySQLExactIntegerType(from.type)) {
        this.refuseDecimalAdoption(op, context, targetKind);
      }
      return this.decimalScalarConversionBracket(op, table, to.type, target);
    }

    const sourceKind = mysqlDecimalStorageKind(from);
    if (targetKind === undefined || sourceKind !== targetKind) {
      this.refuseDecimalConversion(
        op,
        context,
        `moves it from ${describeDecimalStorageKind(sourceKind)} to ${describeDecimalStorageKind(targetKind)} storage, which`
      );
    }
    if (targetKind === "list") {
      // The coefficient spelling stays exact only while scale stands still.
      // Widening then moves no member, but it still needs a live proof that
      // malformed or out-of-source-domain storage cannot acquire a wider
      // descriptor marker. Narrowing is deliberately refused: MySQL's
      // implicit DDL commits cannot make its stricter proof, marker change,
      // and cleanup one indivisible operation.
      const change = classifyDecimalListDescriptorChange(source, target);
      if (change === "rescaling") {
        this.refuseDecimalConversion(
          op,
          context,
          `moves its JSON list from ${describeDecimalDomain(source)} to ${describeDecimalDomain(target)}, which rescales every member and so`
        );
      }
      if (change === "narrowing") {
        this.refuseDecimalConversion(
          op,
          context,
          `narrows its JSON list from ${describeDecimalDomain(source)} to ${describeDecimalDomain(target)}, which`
        );
      }
      return this.decimalListConversionBracket(op, table, source);
    }
    return this.decimalScalarConversionBracket(op, table, to.type, target);
  }

  private decimalListConversionBracket(
    op: AlterColumnOperation,
    table: string,
    narrower: NonNullable<ColumnDef["decimal"]>
  ): { validate: string; release: string } {
    const constraint = this.escapeIdentifier(
      decimalConversionConstraintName("list", narrower)
    );
    const col = this.escapeIdentifier(op.columnName);
    return {
      validate: `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${mysqlDecimalListFitsCheck(col, narrower)})`,
      release: `ALTER TABLE ${table} DROP CHECK ${constraint}`,
    };
  }

  private decimalScalarConversionBracket(
    op: AlterColumnOperation,
    table: string,
    targetType: string,
    target: NonNullable<ColumnDef["decimal"]>
  ): { validate: string; release: string } {
    const constraint = this.escapeIdentifier(
      decimalConversionConstraintName("scalar", target)
    );
    const col = this.escapeIdentifier(op.columnName);
    return {
      validate: `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${mysqlDecimalFitsCheck(col, targetType)})`,
      release: `ALTER TABLE ${table} DROP CHECK ${constraint}`,
    };
  }

  /** Refuse an adoption whose source has no exact, descriptor-free meaning. */
  private refuseDecimalAdoption(
    op: AlterColumnOperation,
    context: DDLContext,
    targetKind: ReturnType<typeof mysqlDecimalStorageKind>
  ): never {
    throw new MigrationError(
      `The declared change to "${op.tableName}"."${op.columnName}" would adopt unmarked ${op.from.type} storage as a fixed-decimal ${describeDecimalStorageKind(targetKind)}. ` +
        "Only INT and BIGINT have one exact descriptor-free meaning that a transient target-domain CHECK can prove. Approximate, text, native-decimal-without-descriptor, and unmarked JSON storage could already contain rounded values or members at an unknown scale. " +
        "The change is refused before any statement runs, so MySQL cannot implicitly round or reinterpret the stored data. Use an explicit migration that validates and rewrites the source values.",
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      {
        meta: {
          table: op.tableName,
          column: op.columnName,
          feature: "decimal storage adoption",
          dialect: "mysql",
          target: context.destination,
        },
      }
    );
  }

  /**
   * Refuses a decimal conversion MySQL cannot perform without either rounding
   * stored values or leaving them half-converted.
   *
   * The unsafe case is always a REWRITE of stored bytes: a JSON list whose
   * members must be rescaled, or a column moving between the scalar and list
   * shapes. Same-scale precision widening needs only a proof and uses the
   * normalized-container CHECK above. Narrowing or changing scale cannot make
   * its stricter proof or member rewrite plus descriptor-marker DDL
   * indivisible across MySQL's implicit commits. It therefore refuses before
   * any statement runs; PostgreSQL and the SQLite family convert the same
   * change inside their atomic provider boundary.
   */
  private refuseDecimalConversion(
    op: AlterColumnOperation,
    context: DDLContext,
    reason: string
  ): never {
    throw new MigrationError(
      `The declared change to "${op.tableName}"."${op.columnName}" ${reason} would rewrite every stored value, and MySQL commits each DDL statement implicitly. ` +
        "There is no boundary that could make the member rewrite and its descriptor-marker change indivisible. " +
        "The change is refused before any statement runs, so the schema and its data are unchanged. Only same-scale precision widening is applied automatically; narrowing or a scale change needs an explicit migration that validates and moves the values itself.",
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      {
        meta: {
          table: op.tableName,
          column: op.columnName,
          feature: "decimal descriptor conversion",
          dialect: "mysql",
          target: context.destination,
        },
      }
    );
  }

  // ===========================================================================
  // DDL GENERATION - Index Operations
  // ===========================================================================

  generateCreateIndex(op: CreateIndexOperation, context: DDLContext): string {
    const { tableName, index } = op;

    // Validate index type
    this.validateIndexType(index.type, index.name);

    // MySQL has no partial index. Emitting the index without its predicate
    // would build a different index from the declared one and would index rows
    // the schema excluded, so refuse the declaration instead of dropping it.
    if (index.where) {
      throw new MigrationError(
        `Index "${index.name}" declares a partial index predicate (where: "${index.where}"). ` +
          "MySQL does not support partial indexes. " +
          "Either remove 'where' from the index definition, or move the predicate into a generated column and index that.",
        VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        { meta: { indexName: index.name, indexWhere: index.where } }
      );
    }

    const cols = index.columns.map((c) => this.escapeIdentifier(c)).join(", ");

    // MySQL index type syntax varies by type:
    // - FULLTEXT and SPATIAL are prefixes: CREATE FULLTEXT INDEX ...
    // - BTREE is default, no clause needed
    // Note: HASH indexes are not supported by InnoDB (only MEMORY engine supports them)
    let indexPrefix = "";

    if (index.type === "fulltext") {
      indexPrefix = "FULLTEXT ";
    } else if (index.type === "spatial") {
      indexPrefix = "SPATIAL ";
    }
    // btree is default, no prefix needed

    // UNIQUE cannot be combined with FULLTEXT or SPATIAL in MySQL
    if (index.unique && indexPrefix) {
      throw new MigrationError(
        `Cannot combine UNIQUE with ${index.type?.toUpperCase()} index "${index.name}". ` +
          `MySQL does not support UNIQUE ${index.type?.toUpperCase()} indexes. ` +
          `Either remove 'unique: true' from the index definition, or create a separate unique index.`,
        VibORMErrorCode.MIGRATION_FAILED,
        { meta: { indexName: index.name, indexType: index.type } }
      );
    }
    const unique = index.unique ? "UNIQUE " : "";

    // The index NAME stays one identifier; the table it is built on carries the
    // database (§5.1).
    return `CREATE ${unique}${indexPrefix}INDEX ${this.escapeIdentifier(index.name)} ON ${this.tableRef(tableName, context.destination)} (${cols})`;
  }

  generateDropIndex(op: DropIndexOperation, context: DDLContext): string {
    // MySQL DROP INDEX requires ON tableName syntax, and that table position is
    // the one that carries the database — the index name stays bare (§5.1).
    return `DROP INDEX ${this.escapeIdentifier(op.indexName)} ON ${this.tableRef(op.tableName, context.destination)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Foreign Key Operations
  // ===========================================================================

  generateAddForeignKey(
    op: AddForeignKeyOperation,
    context: DDLContext
  ): string {
    const { tableName, fk } = op;
    const cols = fk.columns.map((c) => this.escapeIdentifier(c)).join(", ");
    const refCols = fk.referencedColumns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");

    let sql = `ALTER TABLE ${this.tableRef(tableName, context.destination)} `;
    sql += `ADD CONSTRAINT ${this.escapeIdentifier(fk.name)} `;
    sql += `FOREIGN KEY (${cols}) `;
    sql += `REFERENCES ${this.tableRef(fk.referencedTable, context.destination)} (${refCols})`;

    if (fk.onDelete && fk.onDelete !== "noAction") {
      sql += ` ON DELETE ${this.formatReferentialAction(fk.onDelete)}`;
    }
    if (fk.onUpdate && fk.onUpdate !== "noAction") {
      sql += ` ON UPDATE ${this.formatReferentialAction(fk.onUpdate)}`;
    }

    return sql;
  }

  generateDropForeignKey(
    op: DropForeignKeyOperation,
    context: DDLContext
  ): string {
    return `ALTER TABLE ${this.tableRef(op.tableName, context.destination)} DROP FOREIGN KEY ${this.escapeIdentifier(op.fkName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Unique Constraint Operations
  // ===========================================================================

  generateAddUniqueConstraint(
    op: AddUniqueConstraintOperation,
    context: DDLContext
  ): string {
    const { tableName, constraint } = op;
    const cols = constraint.columns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    return `ALTER TABLE ${this.tableRef(tableName, context.destination)} ADD CONSTRAINT ${this.escapeIdentifier(constraint.name)} UNIQUE (${cols})`;
  }

  generateDropUniqueConstraint(
    op: DropUniqueConstraintOperation,
    context: DDLContext
  ): string {
    // MySQL uses DROP INDEX for unique constraints
    return `ALTER TABLE ${this.tableRef(op.tableName, context.destination)} DROP INDEX ${this.escapeIdentifier(op.constraintName)}`;
  }

  // ===========================================================================
  // DDL GENERATION - Primary Key Operations
  // ===========================================================================

  generateAddPrimaryKey(
    op: AddPrimaryKeyOperation,
    context: DDLContext
  ): string {
    const { tableName, primaryKey } = op;
    const cols = primaryKey.columns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    return `ALTER TABLE ${this.tableRef(tableName, context.destination)} ADD PRIMARY KEY (${cols})`;
  }

  generateDropPrimaryKey(
    op: DropPrimaryKeyOperation,
    context: DDLContext
  ): string {
    // MySQL doesn't name primary keys in DROP
    return `ALTER TABLE ${this.tableRef(op.tableName, context.destination)} DROP PRIMARY KEY`;
  }

  // ===========================================================================
  // DDL GENERATION - Enum Operations
  // MySQL doesn't have standalone enum types - they're part of column defs
  // ===========================================================================

  generateCreateEnum(_op: CreateEnumOperation, _context: DDLContext): string {
    // MySQL enums are inline with column definitions
    return "-- MySQL: ENUM type is part of column definition";
  }

  generateDropEnum(_op: DropEnumOperation, _context: DDLContext): string {
    // No standalone enum to drop
    return "-- MySQL: ENUM type is part of column definition";
  }

  generateAlterEnum(op: AlterEnumOperation, context: DDLContext): string {
    return this.compileAlterEnum(op, context).join(";\n");
  }

  override compileAlterEnum(
    op: AlterEnumOperation,
    context: DDLContext
  ): readonly string[] {
    // To alter an enum in MySQL, we need to MODIFY COLUMN for each dependent column
    const { enumName, newValues, dependentColumns } = op;

    if (!newValues || newValues.length === 0) {
      return this.filterStatements([
        `-- MySQL: no new values provided for enum "${enumName}"`,
      ]);
    }

    if (!dependentColumns || dependentColumns.length === 0) {
      return this.filterStatements([
        `-- MySQL: no dependent columns found for enum "${enumName}"`,
      ]);
    }

    const statements: string[] = [];
    const enumType = this.getEnumColumnType("", "", newValues);

    // Migrate rows off removed values before MODIFY COLUMN — with rows still
    // holding a removed value, MODIFY errors in strict mode. Replacement
    // targets must already exist in the old enum (surviving values or NULL);
    // mapping to a value added in the same alter is not supported.
    statements.push(...this.buildMySQLEnumReplacementUpdates(op, context));

    for (const dep of dependentColumns) {
      const currentTable = context.currentSchema?.tables.find(
        (t) => t.name === dep.tableName
      );
      const column = currentTable?.columns.find(
        (c) => c.name === dep.columnName
      );

      if (!column) {
        statements.push(
          `-- MySQL: column "${dep.columnName}" not found in table "${dep.tableName}"`
        );
        continue;
      }

      const table = this.tableRef(dep.tableName, context.destination);
      const col = this.escapeIdentifier(dep.columnName);
      const nullable = column.nullable ? "" : " NOT NULL";
      const defaultVal =
        column.default !== undefined ? ` DEFAULT ${column.default}` : "";

      statements.push(
        `ALTER TABLE ${table} MODIFY COLUMN ${col} ${enumType}${nullable}${defaultVal}`
      );
    }

    return this.filterStatements(statements);
  }

  /**
   * The enum-replacement UPDATEs, with their table position qualified (§5.1).
   *
   * `MigrationDriver.buildEnumReplacementUpdates` renders the same statements
   * database-relative and takes no `DDLContext`, so it cannot express a live
   * table position; `base.ts` is shared with the PostgreSQL and SQLite dialects
   * and is owned by no unit of this change, so MySQL renders its own text here
   * and keeps the SHARED decision — which surviving value (or NULL) replaces a
   * removed one — in `getEnumValueReplacement`.
   *
   * With no namespace or an artifact destination this produces the base
   * builder's exact bytes.
   */
  private buildMySQLEnumReplacementUpdates(
    op: AlterEnumOperation,
    context: DDLContext
  ): string[] {
    const { removeValues, dependentColumns } = op;
    if (!(removeValues?.length && dependentColumns?.length)) {
      return [];
    }

    const statements: string[] = [];
    for (const { tableName, columnName } of dependentColumns) {
      const table = this.tableRef(tableName, context.destination);
      const column = this.escapeIdentifier(columnName);
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
          `UPDATE ${table} SET ${column} = ${newValue} WHERE ${column} = ${this.escapeValue(removedValue)}`
        );
      }
    }
    return statements;
  }

  /**
   * Proves the configured database exists (§5.2).
   *
   * The proof IS the resolution ({@link resolveCommandNamespace}), and no
   * migration command reaches this arm: the shared owner asks a dialect that
   * answers a spelling for that spelling instead, so `status()`, `log()`
   * and a dry push all keep the answer rather than discarding it here. The
   * override remains because the base class's proof is part of the dialect
   * contract and its default answers "nothing to prove", which is false for a
   * dialect whose estates are database-relative — an unlocked caller that only
   * wants the fact must not get a silent yes.
   */
  override async proveNamespaceExists(
    executeRaw: CatalogReader
  ): Promise<void> {
    await this.resolveCommandNamespace(executeRaw);
  }

  /**
   * Proves the configured database exists and answers the SERVER's spelling of
   * it, for the length of one command (§5.2).
   *
   * ONE `information_schema.SCHEMATA` read, with the configured name BOUND as
   * data. `DATABASE()` would answer with the connection's ambient default, and
   * an inference is exactly what this proof exists to remove: it would report
   * an existing sibling database as proof that the configured one is there.
   *
   * The answer matters because the read is deliberately case-insensitive:
   * `lower_case_table_names` can make a differently cased configured value name
   * the same physical database, so one case-folded candidate is accepted (see
   * `catalog.ts`). Under that acceptance the configured spelling is NOT what
   * the server has — `USE` fails on it, `TABLE_SCHEMA = ?` matches nothing, and
   * a reset inventory that binds it reports an existing database as empty. The
   * command-driver owner therefore binds this spelling onto the command's
   * driver view — for locked and read-only commands alike — and every statement
   * below renders from it.
   */
  async resolveCommandNamespace(read: CatalogRead): Promise<string> {
    return await resolveCatalogNamespace(read, this.namespace);
  }

  override generateClearMigrations(tableName: string): string {
    return `DELETE FROM ${this.tableRef(tableName, "live")}`;
  }

  override generateDropTableSQL(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.tableRef(tableName, "live")}`;
  }

  // ===========================================================================
  // MIGRATION LOCKING
  // ===========================================================================

  /**
   * MySQL named locks are per-SERVER, not per-database, so a single global name
   * would serialize every database on the instance and a per-connection name
   * would serialize none. The name is derived from the configured database
   * (`mysqlMigrationLockName`), which is also why an unbound driver has no lock
   * to take: there is no scope to name.
   *
   * `lockId` is deliberately unused. It was the whole identity before; keeping
   * it in the name would only add a constant, and the scope that matters is the
   * database.
   */
  generateAcquireLock(_lockId: number): string | null {
    return mysqlAcquireLockStatement(
      this.requireLockScope(),
      MIGRATION_LOCK_TIMEOUT_SECONDS,
      (value) => this.escapeValue(value)
    );
  }

  generateReleaseLock(_lockId: number): string | null {
    return mysqlReleaseLockStatement(this.requireLockScope(), (value) =>
      this.escapeValue(value)
    );
  }

  override provesLockAcquired(rows: readonly unknown[]): boolean {
    return mysqlLockAnswer(rows, "acquired");
  }

  override provesLockReleased(rows: readonly unknown[]): boolean {
    return mysqlLockAnswer(rows, "released");
  }

  /**
   * The one admitted `USE`, spelled by the pinned-session owner (§13). It is
   * reachable only from a pinned migration session, which destroys its
   * connection afterwards, so the selection cannot leak into pooled traffic.
   *
   * On the command's own driver view `this.namespace` is the spelling the
   * SERVER answered with, which is the only one `USE` is guaranteed to accept:
   * on a case-sensitive server the configured `ProbeCase` is not the existing
   * `probecase`, and selecting it is a raw `Unknown database` error after a
   * proof that just admitted the database.
   */
  override generateSelectTarget(): string | null {
    if (this.namespace === undefined) {
      return null;
    }
    return mysqlSelectTargetStatement(this.namespace, (name) =>
      this.escapeIdentifier(name)
    );
  }

  /**
   * The database whose migrations this lock serializes.
   *
   * An unbound driver is refused rather than falling back to a server-wide
   * name: a lock that covers every database on the instance is not this
   * estate's lock, and one that covers none protects nothing. No admitted path
   * reaches here unbound — the admission owner gates every locking command on
   * the resolved namespace first.
   */
  private requireLockScope(): string {
    if (this.namespace === undefined) {
      throw new MigrationError(
        "This MySQL migration driver is not bound to a database, so there is no lock scope to name. " +
          "A MySQL named lock is server-wide, and VibORM will not take one that covers every database on the instance. Supply the live destination explicitly, in the connection URL, or through the driver's database option.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { dialect: "mysql", type: "unbound-database" } }
      );
    }
    return this.namespace;
  }

  // ===========================================================================
  // SCHEMA INTROSPECTION HELPERS
  // ===========================================================================

  /**
   * The reset inventory, filtered on the bound database.
   *
   * `DATABASE()` had to go: with a connection whose default database is not the
   * configured one, it inventories — and therefore drops — a database this
   * client never targeted.
   *
   * The bound name is the command's own spelling (§5.2): `information_schema`
   * rows carry the server's, so binding a case-folded configured spelling here
   * matches nothing and reports an existing database as empty — an inventory
   * that decides what a reset DROPS cannot be answered by the wrong catalog.
   *
   * An unbound driver REFUSES rather than rendering a statement (plan §14,
   * 2026-08-27 — the one declared exception to §12.21's unbound byte-freeze).
   * There is no third option worth having: the baseline `DATABASE()` form is
   * the ambient target this feature exists to remove, and `= NULL` matches
   * nothing, so `reset` would inventory nothing, drop nothing, and report
   * success over a database it never looked at. No admitted command path
   * reaches here unbound — every caller is an effectful command the admission
   * owner has already gated — so this is what an unreachable arm does when it
   * is reached anyway.
   */
  generateInventoryTables(): { sql: string; params: unknown[] } {
    if (this.namespace === undefined) {
      throw new MigrationError(
        "This MySQL migration driver is not bound to a database, so there is no table inventory to read. " +
          "VibORM will not fall back to the connection's ambient default database here: a reset inventory decides what gets DROPPED. Supply the live destination explicitly, in the connection URL, or through the driver's database option.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { dialect: "mysql", type: "unbound-database" } }
      );
    }
    return {
      sql: "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      params: [this.namespace],
    };
  }

  generateInventoryEnums(): { sql: string; params: unknown[] } | null {
    // MySQL doesn't have standalone enum types
    return null;
  }
}

// Export singleton instance
export const mysqlMigrationDriver = new MySQLMigrationDriver();
