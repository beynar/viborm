import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { AnyDriver } from "@drivers/driver";
import { sql } from "@sql";

/**
 * What every SQL migration driver shares: how an identifier, a value and a default
 * are spelled, and the two probes `push` reads. {@link MigrationDriver} is what any
 * language answers. See `docs/architecture/query-backend-frontier.md`.
 */

import { jsonNullKindOf } from "@schema/json-null";
import type { Scalar, ScalarState } from "@schema/scalars";
import {
  type DecimalDialect,
  decimalDefaultText,
  decimalListDefaultText,
} from "@validation/primitives/decimal-codec";
import { stringifyJson } from "../../adapters/shared/standard-sql";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type { ColumnDef, ReferentialAction } from "../types";
import {
  type AlterEnumOperation,
  type DDLContext,
  MigrationDriver,
} from "./base";

export abstract class SqlMigrationDriver extends MigrationDriver {
  override async tableHoldsRows(
    producer: AnyDriver,
    table: string
  ): Promise<boolean> {
    const { identifiers } = producer.adapter as DatabaseAdapter;
    const reference = identifiers.table(table);
    const populated = await producer._executeRaw(
      `SELECT 1 AS present FROM ${reference.toStatement()} LIMIT 1`
    );
    return populated.rows.length > 0;
  }

  override async undeclaredValue(
    producer: AnyDriver,
    table: string,
    columnName: string,
    declared: readonly string[]
  ): Promise<{ readonly stored: unknown } | undefined> {
    const { identifiers, literals, operators } =
      producer.adapter as DatabaseAdapter;
    const column = identifiers.escape(columnName);
    const values = literals.list(
      declared.map((value) => literals.value(value))
    );
    const probe = producer._prepare(
      sql`SELECT ${identifiers.aliased(column, "stored")} FROM ${identifiers.table(table)} WHERE ${operators.notIn(column, values)} LIMIT 1`
    );
    const [found] = (
      await producer._executeRaw<{ stored: unknown }>(probe.sql, probe.params)
    ).rows;
    return found;
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
   * (Postgres: while columns are text; MySQL: before MODIFY COLUMN).
   */
  protected buildEnumReplacementUpdates(
    op: AlterEnumOperation,
    context: DDLContext
  ): string[] {
    return (op.dependentColumns ?? []).flatMap(({ tableName, columnName }) =>
      this.enumColumnReplacementUpdates(op, tableName, columnName, context)
    );
  }

  /** One dependent column's UPDATEs, one per removed value it replaces. */
  protected enumColumnReplacementUpdates(
    op: AlterEnumOperation,
    tableName: string,
    columnName: string,
    context: DDLContext
  ): string[] {
    const table = this.tableRef(tableName, context.destination);
    const column = this.escapeIdentifier(columnName);
    return (op.removeValues ?? []).flatMap((removedValue) => {
      const replacement = this.getEnumValueReplacement(
        op,
        tableName,
        columnName,
        removedValue
      );
      return replacement === undefined
        ? []
        : [
            `UPDATE ${table} SET ${column} = ${this.escapeValue(replacement)} WHERE ${column} = ${this.escapeValue(removedValue)}`,
          ];
    });
  }

  /** The `WHEN removed THEN replacement` arms of a column's value mapping. */
  protected enumReplacementCases(
    op: AlterEnumOperation,
    tableName: string,
    columnName: string
  ): string[] {
    return (op.removeValues ?? []).flatMap((value) => {
      const replacement = this.getEnumValueReplacement(
        op,
        tableName,
        columnName,
        value
      );
      return replacement === undefined
        ? []
        : [
            `WHEN ${this.escapeValue(value)} THEN ${this.escapeValue(replacement)}`,
          ];
    });
  }

  // ===========================================================================
  // HELPER METHODS (can be overridden)
  // ===========================================================================

  /**
   * Escapes an identifier (table name, column name, etc.).
   * Default uses double quotes with proper escaping.
   */
  override escapeIdentifier(name: string): string {
    if (name == null) {
      throw new MigrationError(
        "Cannot escape null or undefined identifier",
        VibORMErrorCode.INVALID_INPUT
      );
    }
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  /**
   * A table position. Default: one identifier. PostgreSQL qualifies it with
   * the estate schema; MySQL names the database in a live statement.
   */
  protected tableRef(
    tableName: string,
    _destination: DDLContext["destination"]
  ): string {
    return this.escapeIdentifier(tableName);
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
   * @param scalar - The scalar declaration, including its native type
   * @param scalarState - The scalar state
   * @returns SQL default expression or undefined if no default
   */
  override getDefaultExpression(
    _scalar: Scalar,
    scalarState: ScalarState
  ): string | undefined {
    // Auto-generated values - check for database-level support first
    if (scalarState.autoGenerate) {
      return this.getAutoGenerateExpression(scalarState.autoGenerate);
    }

    // Check for explicit default value
    if (!scalarState.hasDefault || scalarState.default === undefined) {
      return undefined;
    }

    const defaultVal = this.literalDefaultValue(scalarState);

    // Function defaults are generated at runtime
    if (typeof defaultVal === "function") {
      return undefined;
    }

    // A JSON null document and absent SQL value are distinct physical defaults.
    // Scalar admission already resolves bare-null ambiguity and authenticates
    // sentinels; JSON primitives must also be quoted as documents, not SQL data.
    if (scalarState.type === "json" && !scalarState.array) {
      const kind = jsonNullKindOf(defaultVal);
      if (kind === "DbNull")
        return this.dialect === "sqlite" ? "NULL" : undefined;
      if (kind === "JsonNull") return this.escapeValue("null");
      // A schema's null output is a document; only the original nullable
      // bare-null default declares an absent SQL value.
      if (defaultVal === null && scalarState.default !== null)
        return this.escapeValue("null");
      if (
        defaultVal !== null &&
        ["string", "number", "boolean"].includes(typeof defaultVal)
      )
        return this.escapeValue(stringifyJson(defaultVal));
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
      return this.escapeValue(
        decimalListDefaultText(
          this.decimalDialect(),
          defaultVal,
          scalarState.decimal
        )
      );
    }

    if (scalarState.array && Array.isArray(defaultVal))
      return this.escapeValue(stringifyJson(defaultVal));
    if (scalarState.type === "json" && typeof defaultVal === "object")
      return this.escapeValue(stringifyJson(defaultVal));
    if (typeof defaultVal === "bigint") return defaultVal.toString();

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
  override generateDropTableSQL(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.tableRef(tableName, "live")}`;
  }

  /**
   * Generates SQL for dropping an enum type.
   * Returns null for databases that don't support enums.
   *
   * @param enumName - The enum name
   * @returns SQL DROP TYPE statement or null
   */
  override generateDropEnumSQL(_enumName: string): string | null {
    return null; // Override in PostgreSQL driver
  }
}
