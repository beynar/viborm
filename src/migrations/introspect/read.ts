/**
 * The live catalog `introspectSchema` translates: the snapshot the dialect's
 * own migration introspection reads, plus the few facts a snapshot does not
 * model and a document needs (identity columns) or must report (views, CHECK
 * constraints).
 *
 * Migration introspection REFUSES a table it cannot represent — a generated
 * column, a partitioned table, an index it cannot spell — because `push` must
 * not plan around what it does not understand. Here such a table is a skipped
 * object, not a failure: the refused table leaves the scope and the read runs
 * again, so one exotic table never hides the rest of the database.
 */

import type { AnyDriver } from "../../drivers/driver";
import { isVibORMError } from "../../errors";
import { CONTROL_TABLES } from "../control";
import { type BoundMigrationDriver, getMigrationDriver } from "../drivers";
import type { AdoptionHazard, MigrationDriver } from "../drivers/base";
import type { SchemaSnapshot } from "../types";
import type { IntrospectionDialect, SkippedObject } from "./types";

export interface LiveCatalog {
  readonly snapshot: SchemaSnapshot;
  readonly skipped: SkippedObject[];
  /** PostgreSQL identity columns, keyed `table\0column`. */
  readonly identityColumns: ReadonlySet<string>;
  /**
   * What each kept table carries that changes how it behaves and that no
   * snapshot describes — the dialect's own `adoptionHazards`: a collation,
   * SQLite's `STRICT` and `ON CONFLICT`, a trigger, row security... A
   * document cannot carry it either.
   */
  readonly hazards: readonly AdoptionHazard[];
  /** The migration driver bound to the whole estate. */
  readonly migrationDriver: BoundMigrationDriver;
}

const CONTROL = new Set([CONTROL_TABLES.state, CONTROL_TABLES.log]);

/** The table a migration introspection refusal names, when it names one. */
function refusedTable(error: unknown): string | undefined {
  if (!isVibORMError(error)) return;
  const table: unknown = error.meta?.table;
  return typeof table === "string" ? table : undefined;
}

/** The dialect's own introspection, without the managed-table boundary check. */
async function introspectScope(
  driver: AnyDriver,
  scope: readonly string[] | undefined
): Promise<SchemaSnapshot> {
  const bound = getMigrationDriver(driver, scope);
  // The bound view wraps the implementation's `introspect` in the managed-table
  // selection, which REFUSES a foreign key crossing the scope. A refused table
  // can be the target of a foreign key this document still reports (as a
  // skipped foreign key), so the implementation itself is read, under the same
  // bound `this`, and the tables are selected below.
  const implementation: MigrationDriver = Object.getPrototypeOf(bound);
  return await implementation.introspect.call(bound, (sql, params) =>
    driver._executeRaw(sql, params)
  );
}

async function rows<T>(
  driver: AnyDriver,
  sql: string,
  params: unknown[]
): Promise<T[]> {
  return (await driver._executeRaw<T>(sql, params)).rows;
}

export async function readCatalog(
  driver: AnyDriver,
  dialect: IntrospectionDialect,
  tables: readonly string[] | undefined
): Promise<LiveCatalog> {
  const migrationDriver = getMigrationDriver(driver);
  const skipped: SkippedObject[] = [];
  const refused = new Map<string, string>();
  let inventory: string[] | undefined;
  let snapshot: SchemaSnapshot;
  for (;;) {
    // A caller's `tables` is the first scope: a table outside it is read
    // without the refusals that would only protect a push of it.
    const scope =
      refused.size === 0
        ? tables
        : (tables ?? inventory ?? []).filter((name) => !refused.has(name));
    try {
      snapshot = await introspectScope(driver, scope);
      break;
    } catch (error) {
      const table = refusedTable(error);
      if (table === undefined || refused.has(table)) throw error;
      refused.set(
        table,
        error instanceof Error ? error.message : "introspection refused it"
      );
      if (tables === undefined && inventory === undefined) {
        const query = migrationDriver.generateInventoryTables();
        inventory = (
          await rows<{ name: string }>(driver, query.sql, query.params)
        ).map((row) => row.name);
      }
    }
  }
  for (const [table, reason] of refused)
    skipped.push({ kind: "table", name: table, reason });

  const selected = (name: string) =>
    !(refused.has(name) || CONTROL.has(name)) &&
    (tables === undefined || tables.includes(name));
  for (const table of snapshot.tables)
    if (CONTROL.has(table.name))
      skipped.push({
        kind: "table",
        name: table.name,
        reason: "it is VibORM's migration control table",
      });

  const identityColumns = new Set<string>();
  if (dialect === "postgresql") {
    // Binding proved the estate's namespace for PostgreSQL.
    const namespace = migrationDriver.namespace;
    for (const row of await rows<{ table_name: string; column_name: string }>(
      driver,
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND is_identity = 'YES'",
      [namespace]
    ))
      identityColumns.add(`${row.table_name}\0${row.column_name}`);
    for (const row of await rows<{ name: string; kind: string }>(
      driver,
      "SELECT table_name AS name, 'view' AS kind FROM information_schema.views WHERE table_schema = $1 UNION ALL SELECT matviewname AS name, 'materialized view' AS kind FROM pg_catalog.pg_matviews WHERE schemaname = $1 ORDER BY 1",
      [namespace]
    ))
      skipped.push({
        kind: "view",
        name: row.name,
        reason: `it is a ${row.kind}, and a document declares tables only`,
      });
    for (const row of await rows<{
      table_name: string;
      name: string;
      definition: string;
    }>(
      driver,
      "SELECT rel.relname AS table_name, con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS definition FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace WHERE ns.nspname = $1 AND con.contype = 'c' ORDER BY 1, 2",
      [namespace]
    ))
      if (selected(row.table_name))
        skipped.push({
          kind: "check",
          table: row.table_name,
          name: row.name,
          reason: `a document has no CHECK constraint (${row.definition}); the database keeps enforcing it`,
        });
  } else if (dialect === "mysql") {
    // Binding proved the estate's database for MySQL.
    const database = migrationDriver.namespace;
    for (const row of await rows<{ name: string }>(
      driver,
      "SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [database]
    ))
      skipped.push({
        kind: "view",
        name: row.name,
        reason: "it is a view, and a document declares tables only",
      });
    for (const row of await rows<{
      table_name: string;
      name: string;
      definition: string;
    }>(
      driver,
      "SELECT tc.TABLE_NAME AS table_name, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS definition FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY 1, 2",
      [database]
    ))
      if (selected(row.table_name))
        skipped.push({
          kind: "check",
          table: row.table_name,
          name: row.name,
          reason: `a document has no CHECK constraint (${row.definition}); the database keeps enforcing it`,
        });
  } else if (dialect === "snowflake") {
    const schema = migrationDriver.namespace;
    for (const row of await rows<{ name: string }>(
      driver,
      schema === undefined
        ? 'SELECT TABLE_NAME AS "name" FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = CURRENT_SCHEMA() ORDER BY TABLE_NAME'
        : 'SELECT TABLE_NAME AS "name" FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      schema === undefined ? [] : [schema]
    ))
      skipped.push({
        kind: "view",
        name: row.name,
        reason: "it is a view, and a document declares tables only",
      });
  } else {
    for (const row of await rows<{ name: string }>(
      driver,
      "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name",
      []
    ))
      skipped.push({
        kind: "view",
        name: row.name,
        reason: "it is a view, and a document declares tables only",
      });
  }

  const kept = snapshot.tables.filter((table) => selected(table.name));
  return {
    snapshot: { ...snapshot, tables: kept },
    skipped,
    identityColumns,
    hazards: await migrationDriver.adoptionHazards(
      kept.map((table) => table.name),
      async <T>(sql: string, params?: unknown[]) => ({
        rows: await rows<T>(driver, sql, params ?? []),
      })
    ),
    migrationDriver,
  };
}
