/**
 * SQL Server: a database restored or upgraded onto SQL Server 2022 keeps its
 * compatibility level. Every text filter runs at level 150, the level of
 * SQL Server 2019: none needs a construct of level 160. The suite creates
 * its own database at that level and drops it. Set
 * MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import { UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createMssqlDriver, TEST_CONNECTION_STRING } from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const DATABASE = "viborm_compat_150";

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    doc: s.json().nullable(),
  })
  .map("notes");

/** The test connection string, on `database`. */
const on = (database: string): string => {
  const url = new URL(TEST_CONNECTION_STRING!);
  url.pathname = `/${database}`;
  return url.toString();
};

const admin = async (statement: string): Promise<void> => {
  const driver = createMssqlDriver();
  try {
    await driver._executeRaw(statement, []);
  } finally {
    await driver.disconnect();
  }
};

const remove = () =>
  admin(
    `IF DB_ID(N'${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE "${DATABASE}" SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ${"DR"}OP DATABASE "${DATABASE}"; END`
  );

const db = createClient({
  schema: { note },
  driver: new MssqlDriver({ databaseUrl: on(DATABASE) }),
});

const ids = (where: object) =>
  db.note
    .findMany({ where, select: { id: true }, orderBy: { id: "asc" } })
    .then((rows) => rows.map((row) => row.id));

describeIf("SQL Server text filters at compatibility level 150", () => {
  beforeAll(async () => {
    await remove();
    await admin(`CREATE DATABASE "${DATABASE}"`);
    await admin(`ALTER DATABASE "${DATABASE}" SET COMPATIBILITY_LEVEL = 150`);
    await syncLiveSchema(db);
    await db.note.createMany({
      data: [
        { id: 1, body: "hello world", doc: { s: "hello world" } },
        { id: 2, body: "goodbye", doc: { s: "goodbye" } },
        { id: 3, body: "50% off_now", doc: { s: "50%" } },
      ],
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    await remove();
  });

  test("contains, startsWith and endsWith run, negated and insensitive too", async () => {
    expect(await ids({ body: { contains: "wor" } })).toEqual([1]);
    expect(await ids({ NOT: { body: { contains: "wor" } } })).toEqual([2, 3]);
    expect(
      await ids({ body: { contains: "WOR", mode: "insensitive" } })
    ).toEqual([1]);
    expect(await ids({ body: { startsWith: "good" } })).toEqual([2]);
    expect(await ids({ body: { endsWith: "bye" } })).toEqual([2]);
    expect(await ids({ doc: { path: ["s"], string_contains: "wor" } })).toEqual(
      [1]
    );
  });

  test("a needle's LIKE wildcards are matched as written", async () => {
    expect(await ids({ body: { contains: "0% o" } })).toEqual([3]);
    expect(await ids({ body: { contains: "f_n" } })).toEqual([3]);
    expect(await ids({ body: { contains: "o_w" } })).toEqual([]);
  });

  test("a needle up to the pattern limit runs; one past it is refused before it is sent", async () => {
    expect(await ids({ body: { contains: "x".repeat(3998) } })).toEqual([]);
    expect(await ids({ body: { startsWith: "x".repeat(3999) } })).toEqual([]);
    await expect(
      ids({ body: { contains: "x".repeat(3999) } })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(
      ids({ body: { startsWith: "x".repeat(4000) } })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});
