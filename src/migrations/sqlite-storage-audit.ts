/**
 * SQLite storage that typed queries compare but never inspect: text DateTime
 * and Time (scalar or JSON list) and checked decimals.
 *
 * `auditStorage` counts what needs repair (`viborm check --db`, runtime and
 * Durable Object callers). `canonicalizeSqliteStorage` rewrites it after
 * manual SQL, inside that program's transaction. Time columns and
 * DateTime lists come from the client's models, because a schema snapshot
 * marks only scalar DateTime and decimals.
 */

import {
  sqliteCanonicalTemporalUpdate,
  sqliteNoncanonicalTemporalCount,
} from "../adapters/databases/sqlite/storage/datetime";
import {
  isSqliteDecimalStorage,
  sqliteDecimalCopyExpression,
  sqliteDecimalStorageKind,
} from "../adapters/databases/sqlite/storage/decimal";
import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import { type AnyModel, getTableName, type ModelState } from "../schema/model";
import { sqliteDateTimePhysicalForm } from "../schema/scalars/datetime/physical";
import { createIdentifierQuoter } from "../sql/identifiers";
import type { DecimalDescriptor } from "../validation/primitives/decimal-codec";
import { executeExactSql } from "./execute-dispatch";
import type { MigrationClient } from "./push/planner";
import type { ColumnDef, SchemaSnapshot } from "./types";
import type { MigrationOperationV1 } from "./v1-types";

/** One audited column; `null` counts and declarations mean the column is missing. */
export type StorageColumnAudit = {
  readonly table: string;
  readonly column: string;
} & (
  | {
      readonly type: "datetime" | "time";
      readonly list: boolean;
      readonly noncanonical: number | null;
    }
  | {
      readonly type: "decimal";
      /** The catalog's declared type. */
      readonly declared: string | null;
      readonly checked: boolean;
    }
);

type StorageColumn = {
  readonly table: string;
  readonly column: string;
  readonly list: boolean;
} & (
  | { readonly type: "datetime" | "time" }
  | { readonly type: "decimal"; readonly decimal: DecimalDescriptor }
);

interface CatalogColumn {
  readonly definition: string | null;
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

const quote = createIdentifierQuoter('"');

/** Every decimal column, and every DateTime/Time column stored as text. */
function storageColumns(models: Record<string, AnyModel>): StorageColumn[] {
  const columns: StorageColumn[] = [];
  for (const [name, model] of Object.entries(models)) {
    const table = getTableName(model, name);
    const state: ModelState = model["~"].state;
    for (const [field, scalar] of Object.entries(state.scalars)) {
      const definition = scalar["~"].state;
      const list = definition.array === true;
      const column = model["~"].getFieldName(field).sql;
      if (definition.type === "decimal") {
        columns.push({
          table,
          column,
          list,
          type: "decimal",
          decimal: definition.decimal,
        });
      } else if (
        definition.type === "time" ||
        (definition.type === "datetime" &&
          (list ||
            sqliteDateTimePhysicalForm(scalar["~"].nativeType) === "text"))
      ) {
        columns.push({ table, column, list, type: definition.type });
      }
    }
  }
  return columns;
}

/** One SQLite table's declared columns, each beside the table's stored definition. */
async function readCatalog(
  driver: AnyDriver,
  table: string
): Promise<CatalogColumn[]> {
  const { rows } = await driver._executeRaw<
    Omit<CatalogColumn, "nullable"> & { notnull: number; pk: number }
  >(
    `SELECT s.sql AS definition, p.name, p.type, p."notnull", p.pk FROM sqlite_schema AS s JOIN pragma_table_info(s.name) AS p WHERE s.type = 'table' AND s.name = ?`,
    [table]
  );
  // SQLite reports a primary key nullable; VibORM writes it NOT NULL.
  return rows.map(({ notnull, pk, ...column }) => ({
    ...column,
    nullable: Number(notnull) === 0 && Number(pk) === 0,
  }));
}

/**
 * Audit the SQLite storage of `client`'s models: one catalog read per table
 * decides which audited columns exist; each existing text DateTime/Time
 * column's noncanonical rows are counted (one scan each), and each decimal
 * column is checked against the scaled-integer storage of its descriptor.
 * Other dialects store native types and return no audit.
 */
export async function auditStorage(
  client: Pick<MigrationClient, "$driver" | "$schema">
): Promise<StorageColumnAudit[]> {
  const driver = client.$driver;
  if (driver.dialect !== "sqlite") return [];
  const catalogs = new Map<string, Promise<CatalogColumn[]>>();
  const audits: StorageColumnAudit[] = [];
  for (const target of storageColumns(client.$schema)) {
    const { table, column } = target;
    let catalog = catalogs.get(table);
    if (!catalog) {
      catalog = readCatalog(driver, table);
      catalogs.set(table, catalog);
    }
    // A missing table has no catalog rows: each audited column is missing.
    const row = (await catalog).find((entry) => entry.name === column);
    if (target.type === "decimal") {
      audits.push({
        table,
        column,
        type: "decimal",
        declared: row?.type ?? null,
        checked:
          row !== undefined &&
          isSqliteDecimalStorage(
            row.definition,
            row,
            target.decimal,
            target.list ? "list" : "scalar",
            quote
          ),
      });
      continue;
    }
    // Never scan a missing column: SQLite may read its quoted name as text.
    const scan =
      row &&
      (await driver._executeRaw<{ noncanonical: number }>(
        sqliteNoncanonicalTemporalCount(table, column, target.type, target.list)
      ));
    audits.push({
      table,
      column,
      type: target.type,
      list: target.list,
      noncanonical: scan ? Number(scan.rows[0]?.noncanonical) : null,
    });
  }
  return audits;
}

/**
 * The storage one destination column needs canonical, or `undefined`. The
 * snapshot proves scalar text DateTime and decimal lists (a decimal scalar's
 * CHECK already refuses foreign values); it does not mark Time or DateTime
 * lists, so those come from the client's models, held to the column's
 * physical type.
 */
function destinationTarget(
  table: string,
  column: ColumnDef,
  declared: StorageColumn | undefined
): StorageColumn | undefined {
  const base = { table, column: column.name };
  if (column.dateTime === "text") {
    return { ...base, list: false, type: "datetime" };
  }
  if (column.decimal) {
    return sqliteDecimalStorageKind(column) === "list"
      ? { ...base, list: true, type: "decimal", decimal: column.decimal }
      : undefined;
  }
  const temporal =
    declared?.type === "time" ||
    (declared?.type === "datetime" && declared.list);
  return temporal &&
    column.type.toUpperCase() === (declared.list ? "JSON" : "TEXT")
    ? declared
    : undefined;
}

/** Rewrites one column into canonical storage; a value outside its domain aborts the statement. */
function canonicalStatement(target: StorageColumn): string {
  if (target.type !== "decimal") {
    return sqliteCanonicalTemporalUpdate(
      target.table,
      target.column,
      target.type,
      target.list
    );
  }
  // The identity conversion routes a member outside the domain to the
  // sentinel the column's own CHECK refuses.
  const source = `${quote(target.table)}.${quote(target.column)}`;
  const checked = sqliteDecimalCopyExpression(
    source,
    target.decimal,
    target.decimal,
    "list"
  );
  return `UPDATE ${quote(target.table)} SET ${quote(target.column)} = ${checked} WHERE ${source} IS NOT ${checked}`;
}

/**
 * After manual SQL — a manual transition, its manual rollback, or the
 * `resolve` that completes one — and inside that program's transaction:
 * rewrite the destination's text DateTime/Time columns (scalar and JSON list)
 * into canonical text, reading SQLite's zone-less text as UTC, and check
 * decimal-list members. A program without a manual operation, or another
 * dialect, has nothing to rewrite. A row that cannot be rewritten stops the
 * program before its marker moves.
 */
export async function canonicalizeSqliteStorage(
  producer: AnyDriver,
  operations: readonly MigrationOperationV1[],
  models: Record<string, AnyModel>,
  destination: SchemaSnapshot
): Promise<void> {
  if (
    producer.dialect !== "sqlite" ||
    !operations.some((operation) => operation.origin === "manual")
  ) {
    return;
  }
  const declared = new Map(
    storageColumns(models).map((target) => [
      `${target.table}\0${target.column}`,
      target,
    ])
  );
  for (const table of destination.tables) {
    for (const column of table.columns) {
      const target = destinationTarget(
        table.name,
        column,
        declared.get(`${table.name}\0${column.name}`)
      );
      if (!target) continue;
      try {
        await executeExactSql(producer, canonicalStatement(target));
      } catch (error) {
        // A malformed value aborts the rewrite; so does a constraint the
        // rewrite meets, such as two spellings of one instant in a unique column.
        throw new MigrationError(
          `The manual SQL left "${target.table}"."${target.column}" holding a ${target.type}${target.list ? " list" : ""} value that cannot be rewritten into canonical storage (${error instanceof Error ? error.message : String(error)}); the marker did not move`,
          VibORMErrorCode.MIGRATION_DRIFT,
          { cause: error instanceof Error ? error : undefined }
        );
      }
    }
  }
}
