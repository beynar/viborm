/**
 * Shared SQL Server provider fixtures. This file is deliberately NOT named
 * `*.test.ts`: Vitest must not collect it.
 */

import { randomBytes } from "node:crypto";
import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

export const TEST_CONNECTION_STRING = process.env.MSSQL_TEST_CONNECTION_STRING;

export const SQL_SERVER = "SQL Server";

/** The connection string carries the database; the schema is `dbo`. */
export function createMssqlDriver(): MssqlDriver {
  return new MssqlDriver({ databaseUrl: TEST_CONNECTION_STRING });
}

/**
 * The shared behavior suites assume a fresh database. SQL Server persists
 * between tests, so drop everything first: pushing an empty schema drops
 * every table of the schema (`pushMssqlSchema`).
 */
export async function dropEveryLiveTable(): Promise<void> {
  const client = createClient({ schema: {}, driver: createMssqlDriver() });
  await syncLiveSchema(client);
  await client.$disconnect();
}

/** Every foreign key, then every table, then the schema itself. */
const DROP_SCHEMA = `DECLARE @drop NVARCHAR(MAX) = N'';
SELECT @drop += N'ALTER TABLE ' + QUOTENAME(@p1) + N'.' + QUOTENAME(t.name) + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';'
  FROM sys.foreign_keys AS fk JOIN sys.tables AS t ON t.object_id = fk.parent_object_id WHERE t.schema_id = SCHEMA_ID(@p1);
SELECT @drop += N'DROP VIEW ' + QUOTENAME(@p1) + N'.' + QUOTENAME(name) + N';' FROM sys.views WHERE schema_id = SCHEMA_ID(@p1);
SELECT @drop += N'DROP TABLE ' + QUOTENAME(@p1) + N'.' + QUOTENAME(name) + N';' FROM sys.tables WHERE schema_id = SCHEMA_ID(@p1);
IF SCHEMA_ID(@p1) IS NOT NULL SET @drop += N'DROP SCHEMA ' + QUOTENAME(@p1) + N';';
EXEC sp_executesql @drop;`;

const CREATE_SCHEMA = `DECLARE @create NVARCHAR(300) = N'CREATE SCHEMA ' + QUOTENAME(@p1);
EXEC sp_executesql @create;`;

async function onAdmin(sql: string, schema: string): Promise<void> {
  const admin = createMssqlDriver();
  try {
    await admin._executeRaw(sql, [schema]);
  } finally {
    await admin.disconnect();
  }
}

/** Drops `schema` with every table and view in it; absent is fine. */
export function dropSchema(schema: string): Promise<void> {
  return onAdmin(DROP_SCHEMA, schema);
}

/** Creates `schema`, dropping a leftover of the same name first. */
export async function createSchema(schema: string): Promise<void> {
  await dropSchema(schema);
  await onAdmin(CREATE_SCHEMA, schema);
}

/** A driver on `schema` of the test database. */
export function createMssqlDriverIn(schema: string): MssqlDriver {
  return new MssqlDriver({
    databaseUrl: TEST_CONNECTION_STRING,
    namespace: schema,
  });
}

/**
 * Where MySQL gives a suite a database of its own, SQL Server gives it a
 * schema: `prepare` creates it and pushes the client's tables into it,
 * `release` drops it. One name for the suite, or a fresh one per
 * `createDriver` call with `freshPerDriver`.
 */
export function isolatedSchema(prefix: string, freshPerDriver = false) {
  const name = () => `${prefix}_${randomBytes(5).toString("hex")}`;
  let schema = name();
  return {
    createDriver: () => {
      if (freshPerDriver) schema = name();
      return createMssqlDriverIn(schema);
    },
    prepare: async (client: Parameters<typeof syncLiveSchema>[0]) => {
      await createSchema(schema);
      await syncLiveSchema(client);
    },
    release: () => dropSchema(schema),
  };
}
