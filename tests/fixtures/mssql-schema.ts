/**
 * TEST-ONLY SQL Server schema push.
 *
 * `syncLiveSchema` pushes through `createMigrationClient`, which refuses SQL
 * Server: VibORM writes no DDL for it. The driver contract suites still need
 * their tables, so this stand-in derives them from the same snapshot the
 * serializer produces for SQL Server (`MssqlMigrationDriver`) and writes plain
 * T-SQL. It is not a migration engine: when the live schema differs from the
 * desired one it drops every managed table and creates the desired ones, so
 * a changed schema keeps no rows.
 *
 * Two shapes differ from what PostgreSQL would hold, both because SQL Server
 * refuses the PostgreSQL one:
 *
 * - a unique key over a nullable column is a filtered unique index
 *   (`WHERE col IS NOT NULL`), since a SQL Server UNIQUE constraint admits ONE
 *   null where PostgreSQL admits any number;
 * - a foreign key whose actions SQL Server refuses ("may cause cycles or
 *   multiple cascade paths": a self-reference, a self many-to-many, two
 *   cascading paths into one table) is created with NO ACTION on both, so the
 *   constraint exists but the database neither cascades nor nulls through it.
 */

import { diff } from "@migrations/differ";
import {
  getMigrationDriver,
  registerMigrationDriver,
} from "@migrations/drivers";
import { mssqlMigrationDriver } from "@migrations/drivers/mssql";
import type { MigrationClient } from "@migrations/push/planner";
import { serializeModels } from "@migrations/serializer";
import type {
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
} from "@migrations/types";

registerMigrationDriver(mssqlMigrationDriver);

export interface PushMssqlSchemaOptions {
  readonly tables?: readonly string[];
  readonly dryRun?: boolean;
  readonly forceReset?: boolean;
}

const ACTIONS: Record<ReferentialAction, string> = {
  cascade: "CASCADE",
  setNull: "SET NULL",
  setDefault: "SET DEFAULT",
  noAction: "NO ACTION",
  // `finalizeTable` already spells RESTRICT as NO ACTION.
  restrict: "NO ACTION",
};

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const columnList = (columns: readonly string[]) =>
  columns.map(quote).join(", ");

/** CREATE TABLE, then the unique indexes and indexes it carries. */
function createTable(schema: string, table: TableDef): string[] {
  const ref = `${quote(schema)}.${quote(table.name)}`;
  const nullable = new Set(
    table.columns.filter((column) => column.nullable).map(({ name }) => name)
  );
  const nullFilter = (columns: readonly string[]) =>
    columns
      .filter((column) => nullable.has(column))
      .map((column) => `${quote(column)} IS NOT NULL`)
      .join(" AND ");
  const parts = table.columns.map((column) => {
    const identity = column.autoIncrement ? " IDENTITY(1,1)" : "";
    const fallback =
      column.default === undefined || column.autoIncrement
        ? ""
        : ` DEFAULT ${column.default}`;
    // Text compares and sorts by code point, as on the tables VibORM creates
    // elsewhere (MySQL's `utf8mb4_0900_bin`): the binary collation.
    const collation = column.type.startsWith("NVARCHAR")
      ? " COLLATE Latin1_General_100_BIN2"
      : "";
    return `${quote(column.name)} ${column.type}${collation}${identity} ${column.nullable ? "NULL" : "NOT NULL"}${fallback}`;
  });
  if (table.primaryKey)
    parts.push(
      `CONSTRAINT ${quote(mssqlMigrationDriver.generatedPrimaryKeyName(table.name, table.primaryKey.name))} PRIMARY KEY (${columnList(table.primaryKey.columns)})`
    );
  const after: string[] = [];
  for (const unique of table.uniqueConstraints) {
    const filter = nullFilter(unique.columns);
    if (filter === "")
      parts.push(
        `CONSTRAINT ${quote(unique.name)} UNIQUE (${columnList(unique.columns)})`
      );
    else
      after.push(
        `CREATE UNIQUE INDEX ${quote(unique.name)} ON ${ref} (${columnList(unique.columns)}) WHERE ${filter}`
      );
  }
  for (const index of table.indexes) {
    const where =
      index.where ?? (index.unique ? nullFilter(index.columns) : "");
    after.push(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${ref} (${columnList(index.columns)})${where ? ` WHERE ${where}` : ""}`
    );
  }
  return [`CREATE TABLE ${ref} (${parts.join(", ")})`, ...after];
}

/**
 * The live snapshot read back in the desired one's terms where this fixture
 * chose a different shape (see the module comment): a filtered unique index
 * standing for a unique key, a NO ACTION fallback standing for the declared
 * actions, a predicate SQL Server reprinted, and the decimal descriptor of a
 * list, which JSON text does not carry.
 */
function asCreated(
  live: SchemaSnapshot,
  desired: SchemaSnapshot
): SchemaSnapshot {
  const wanted = new Map(desired.tables.map((table) => [table.name, table]));
  return {
    ...live,
    tables: live.tables.map((table) => {
      const target = wanted.get(table.name);
      if (!target) return table;
      const uniqueNames = new Set(target.uniqueConstraints.map((u) => u.name));
      const declaredIndexes = new Map(target.indexes.map((i) => [i.name, i]));
      const declaredKeys = new Map(target.foreignKeys.map((k) => [k.name, k]));
      const declaredColumns = new Map(target.columns.map((c) => [c.name, c]));
      return {
        ...table,
        columns: table.columns.map((column) => {
          const declared = declaredColumns.get(column.name);
          return column.decimal === undefined && declared?.type === column.type
            ? { ...column, decimal: declared.decimal }
            : column;
        }),
        uniqueConstraints: [
          ...table.uniqueConstraints,
          ...table.indexes
            .filter((index) => index.unique && uniqueNames.has(index.name))
            .map(({ name, columns }) => ({ name, columns })),
        ],
        indexes: table.indexes
          .filter((index) => !(index.unique && uniqueNames.has(index.name)))
          .map((index) => ({
            ...index,
            where: index.where && declaredIndexes.get(index.name)?.where,
          })),
        foreignKeys: table.foreignKeys.map((key) => {
          const declared = declaredKeys.get(key.name);
          return declared &&
            key.onDelete === "noAction" &&
            key.onUpdate === "noAction"
            ? {
                ...key,
                onDelete: declared.onDelete,
                onUpdate: declared.onUpdate,
              }
            : key;
        }),
      };
    }),
  };
}

export async function pushMssqlSchema(
  client: MigrationClient,
  options: PushMssqlSchemaOptions = {}
) {
  const driver = client.$driver;
  const migrationDriver = getMigrationDriver(driver, options.tables);
  const schema = migrationDriver.namespace ?? "dbo";
  const run = <T>(sql: string, params?: unknown[]) =>
    driver._executeRaw<T>(sql, params);
  const desired = serializeModels(client.$schema, { migrationDriver });
  const live = await migrationDriver.introspect(run);
  const { operations, ambiguousChanges } = await diff(
    asCreated(live, desired),
    desired
  );
  const reset =
    options.forceReset === true ||
    operations.length > 0 ||
    ambiguousChanges.length > 0;

  const sql: string[] = [];
  if (reset) {
    const managed = new Set(live.tables.map((table) => table.name));
    const keys = await run<{ name: string; owner: string; target: string }>(
      "SELECT fk.name AS name, t.name AS owner, r.name AS target FROM sys.foreign_keys AS fk JOIN sys.tables AS t ON t.object_id = fk.parent_object_id JOIN sys.tables AS r ON r.object_id = fk.referenced_object_id WHERE t.schema_id = SCHEMA_ID(@p1)",
      [schema]
    );
    for (const key of keys.rows)
      if (managed.has(key.owner) || managed.has(key.target))
        sql.push(
          `ALTER TABLE ${quote(schema)}.${quote(key.owner)} DROP CONSTRAINT ${quote(key.name)}`
        );
    for (const name of managed)
      sql.push(`DROP TABLE ${quote(schema)}.${quote(name)}`);
    for (const table of desired.tables) sql.push(...createTable(schema, table));
  }
  // After every table exists, so a key may point at a table created later.
  const foreignKeys = desired.tables.flatMap((table) =>
    table.foreignKeys.map((key) => {
      const add = (onDelete: string, onUpdate: string) =>
        `ALTER TABLE ${quote(schema)}.${quote(table.name)} ADD CONSTRAINT ${quote(key.name)} FOREIGN KEY (${columnList(key.columns)}) REFERENCES ${quote(schema)}.${quote(key.referencedTable)} (${columnList(key.referencedColumns)}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
      return {
        declared: add(
          ACTIONS[key.onDelete ?? "noAction"],
          ACTIONS[key.onUpdate ?? "noAction"]
        ),
        fallback: add("NO ACTION", "NO ACTION"),
      };
    })
  );

  if (options.dryRun) {
    if (reset) sql.push(...foreignKeys.map(({ declared }) => declared));
  } else if (reset) {
    for (const statement of sql) await run(statement);
    for (const { declared, fallback } of foreignKeys) {
      // The driver redacts the server's message, so any refusal retries:
      // a key SQL Server refuses for another reason fails the retry too.
      const statement = await run(declared).then(
        () => declared,
        async () => {
          await run(fallback);
          return fallback;
        }
      );
      sql.push(statement);
    }
  }

  const applied = reset && !options.dryRun;
  return {
    outcome: applied ? "applied" : "planned",
    applied,
    operations,
    sql,
    statements: sql.map((statement) => ({ sql: statement })),
    warnings: [],
  };
}
