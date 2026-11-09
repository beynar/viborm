/**
 * SQL Server Migration Driver
 *
 * Reads, never writes: VibORM queries SQL Server and introspects one schema of
 * it, and generates no DDL. `createMigrationClient` refuses the dialect, so no
 * command reaches the generators below; each still refuses through one helper
 * rather than render a statement nothing has proven.
 *
 * What it does own is the physical type of each scalar — the storage the
 * runtime adapter reads and writes — so a snapshot serialized for SQL Server
 * and one introspected from it speak one vocabulary:
 *
 * - a string is `NVARCHAR(MAX)`, and `NVARCHAR(450)` once a primary key,
 *   unique constraint, index or foreign key names it ({@link finalizeTable}):
 *   an index key holds at most 900 bytes, 450 UTF-16 code units. Every
 *   identifier is text, so an id or a key referencing one is `NVARCHAR(450)`;
 * - every list and JSON document is `NVARCHAR(MAX)` JSON text (a decimal list
 *   holds coefficient strings), an enum `NVARCHAR(255)`;
 * - an `increment()` column is `INT`/`BIGINT IDENTITY(1,1)`;
 * - GeoPoint and vector have no SQL Server storage, and are refused.
 */

import type { Scalar, ScalarState } from "@schema/scalars";
import {
  FeatureNotSupportedError,
  MigrationError,
  VibORMErrorCode,
} from "../../../errors";
import type { ReferentialAction, SchemaSnapshot, TableDef } from "../../types";
import { SqlMigrationDriver } from "../sql";
import { getMssqlType } from "../type-mapping";
import type { MigrationCapabilities } from "../types";
import {
  type CatalogReader,
  catalogParams,
  introspectMssql,
  MSSQL_TABLES_QUERY,
} from "./introspect";

const KEYED_STRING = "NVARCHAR(450)";

/** Every DDL generator's answer: the one statement of what this driver is. */
function refuseDdl(): never {
  throw new FeatureNotSupportedError(
    "mssql",
    "migrations",
    "VibORM queries SQL Server and introspects its schema, but generates and applies no DDL for it."
  );
}

export class MssqlMigrationDriver extends SqlMigrationDriver {
  readonly dialect = "mssql" as const;
  readonly driverName = "mssql";

  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: false, // NVARCHAR(255)
    supportsAddEnumValueInTransaction: false,
    supportsIndexTypes: ["btree"], // rowstore indexes; the rest is refused
    supportsNativeArrays: false, // JSON text
    supportsAddForeignKeyViaAlter: true, // ALTER TABLE ... ADD CONSTRAINT
    // `sys.foreign_keys` and `sys.key_constraints` carry the declared names.
    introspectionReadsConstraintNames: true,
  };

  /** The bound schema; the adapter's own default where none is bound. */
  private get schema(): string {
    return this.namespace ?? "dbo";
  }

  // ===========================================================================
  // INTROSPECTION
  // ===========================================================================

  override async proveNamespaceExists(
    executeRaw: CatalogReader
  ): Promise<void> {
    const { rows } = await executeRaw<{ id: number | null }>(
      "SELECT SCHEMA_ID(@p1) AS id",
      [this.schema]
    );
    if (rows[0]?.id == null)
      throw new MigrationError(
        `SQL Server schema "${this.schema}" does not exist, so it has no tables to read.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { dialect: "mssql", namespace: this.schema } }
      );
  }

  /** An absent schema is refused, never read as an empty one. */
  async introspect(executeRaw: CatalogReader): Promise<SchemaSnapshot> {
    await this.proveNamespaceExists(executeRaw);
    return introspectMssql(executeRaw, this.schema, this.target?.tables);
  }

  generateInventoryTables(): { sql: string; params: unknown[] } {
    return { sql: MSSQL_TABLES_QUERY, params: catalogParams(this.schema) };
  }

  generateInventoryEnums(): null {
    return null; // No standalone enum types.
  }

  // ===========================================================================
  // TYPE MAPPING
  // ===========================================================================

  mapScalarType(_scalar: Scalar, scalarState: ScalarState): string {
    if (scalarState.type === "point" || scalarState.type === "vector")
      throw new FeatureNotSupportedError(
        "mssql",
        scalarState.type,
        "SQL Server has no GeoPoint or vector storage in VibORM."
      );
    return getMssqlType({
      type: scalarState.type,
      array: scalarState.array,
      decimal: scalarState.decimal,
    });
  }

  getEnumColumnType(): string {
    return getMssqlType({ type: "enum" });
  }

  /**
   * Two canonicalizations, both facts of SQL Server:
   *
   * 1. A keyed `NVARCHAR(MAX)` column is `NVARCHAR(450)`: SQL Server indexes
   *    no `MAX` column.
   * 2. `RESTRICT` is `NO ACTION`: SQL Server has no deferred constraint, so
   *    its NO ACTION already refuses at the statement, and the catalog has no
   *    other word for it.
   */
  override finalizeTable(table: TableDef): TableDef {
    const keyed = new Set([
      ...(table.primaryKey?.columns ?? []),
      ...table.uniqueConstraints.flatMap((unique) => unique.columns),
      ...table.indexes.flatMap((index) => index.columns),
      ...table.foreignKeys.flatMap((key) => key.columns),
    ]);
    const unrestricted = (action: ReferentialAction | undefined) =>
      action === "restrict" ? "noAction" : action;
    return {
      ...table,
      columns: table.columns.map((column) =>
        keyed.has(column.name) &&
        column.type === getMssqlType({ type: "string" })
          ? { ...column, type: KEYED_STRING }
          : column
      ),
      foreignKeys: table.foreignKeys.map((key) => ({
        ...key,
        onDelete: unrestricted(key.onDelete),
        onUpdate: unrestricted(key.onUpdate),
      })),
    };
  }

  // ===========================================================================
  // DEFAULTS
  // ===========================================================================

  /** A Unicode literal: every text column is `NVARCHAR`. */
  override escapeValue(value: string | null | undefined): string {
    return value == null ? "NULL" : `N${super.escapeValue(value)}`;
  }

  protected override formatBooleanDefault(value: boolean): string {
    return value ? "1" : "0";
  }

  /** A datetime default is naive UTC, the `DATETIME2` the adapter writes. */
  override getDefaultExpression(
    scalar: Scalar,
    scalarState: ScalarState
  ): string | undefined {
    const literal =
      scalarState.type === "datetime" &&
      !scalarState.array &&
      scalarState.hasDefault &&
      !scalarState.autoGenerate
        ? this.literalDefaultValue(scalarState)
        : undefined;
    return typeof literal === "string"
      ? this.escapeValue(new Date(literal).toISOString().slice(0, 23))
      : super.getDefaultExpression(scalar, scalarState);
  }

  // ===========================================================================
  // DDL, PUSH PROBES AND LOCKING: none
  // ===========================================================================

  generateCreateTable(): never {
    return refuseDdl();
  }
  generateDropTable(): never {
    return refuseDdl();
  }
  generateRenameTable(): never {
    return refuseDdl();
  }
  generateAddColumn(): never {
    return refuseDdl();
  }
  generateDropColumn(): never {
    return refuseDdl();
  }
  generateRenameColumn(): never {
    return refuseDdl();
  }
  generateAlterColumn(): never {
    return refuseDdl();
  }
  generateCreateIndex(): never {
    return refuseDdl();
  }
  generateDropIndex(): never {
    return refuseDdl();
  }
  generateAddForeignKey(): never {
    return refuseDdl();
  }
  generateDropForeignKey(): never {
    return refuseDdl();
  }
  generateAddUniqueConstraint(): never {
    return refuseDdl();
  }
  generateDropUniqueConstraint(): never {
    return refuseDdl();
  }
  generateAddPrimaryKey(): never {
    return refuseDdl();
  }
  generateDropPrimaryKey(): never {
    return refuseDdl();
  }
  generateCreateEnum(): never {
    return refuseDdl();
  }
  generateDropEnum(): never {
    return refuseDdl();
  }
  generateAlterEnum(): never {
    return refuseDdl();
  }
  override generateDropTableSQL(): never {
    return refuseDdl();
  }
  override generateDropEnumSQL(): never {
    return refuseDdl();
  }
  generateAcquireLock(): never {
    return refuseDdl();
  }
  generateReleaseLock(): never {
    return refuseDdl();
  }
  override tableHoldsRows(): never {
    return refuseDdl();
  }
  override undeclaredValue(): never {
    return refuseDdl();
  }
}

export const mssqlMigrationDriver = new MssqlMigrationDriver();
