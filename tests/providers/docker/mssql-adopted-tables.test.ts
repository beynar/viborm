/**
 * SQL Server: tables declared in raw SQL, as an adopted database declares
 * them, read and written as Prisma and Drizzle read and write them (fifth
 * review). Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import { UnsupportedOperationError } from "@errors";
import { introspectSchema } from "@migrations/introspect";
import { s } from "@schema";
import { sql } from "@sql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NS = "viborm_adopted_tables";
const OTHER = "viborm_adopted_other";
const IDENTITY_INSERT_ADVICE = /IDENTITY_INSERT.*ALTER permission/;
const INCOMING_KEY_WARNING =
  /foreign key "child_holder_fk" of "viborm_adopted_other"\."child"/;
const t = (name: string) => `"${NS}"."${name}"`;

/** A decimal's text without the zeros its scale pads with. */
const TRAILING_ZEROS = /\.?0+$/;
const stripZeros = (text: string) =>
  text.includes(".") ? text.replace(TRAILING_ZEROS, "") : text;

const DDL = `
CREATE TABLE ${t("from_zero")} ("id" INT IDENTITY(0,1) NOT NULL PRIMARY KEY, "name" NVARCHAR(20) NOT NULL);
CREATE TABLE ${t("from_minus_two")} ("id" INT IDENTITY(-2,1) NOT NULL PRIMARY KEY, "name" NVARCHAR(20) NOT NULL);
CREATE TABLE ${t("kids_of_zero")} ("id" INT IDENTITY(1,1) NOT NULL PRIMARY KEY, "parentId" INT NOT NULL REFERENCES ${t("from_zero")} ("id"), "name" NVARCHAR(20) NOT NULL);
CREATE TABLE ${t("holders")} ("id" INT NOT NULL PRIMARY KEY);
CREATE TABLE ${t("instants")} ("id" INT NOT NULL PRIMARY KEY, "holderId" INT NOT NULL REFERENCES ${t("holders")} ("id"),
  "dt0" DATETIME2(0), "dt3" DATETIME2(3), "dt6" DATETIME2(6), "dt7" DATETIME2,
  "do0" DATETIMEOFFSET(0), "do3" DATETIMEOFFSET(3), "do6" DATETIMEOFFSET(6), "do7" DATETIMEOFFSET,
  "t0" TIME(0), "t3" TIME(3), "t6" TIME(6), "t7" TIME,
  "dt" DATETIME, "sdt" SMALLDATETIME, "rv" ROWVERSION);
INSERT INTO ${t("holders")} VALUES (1);
INSERT INTO ${t("instants")} ("id", "holderId", "dt0", "dt3", "dt6", "dt7", "do0", "do3", "do6", "do7", "t0", "t3", "t6", "t7", "dt", "sdt") VALUES
  (1, 1, '2026-03-29 01:30:00', '2026-03-29 01:30:00.123', '2026-03-29 01:30:00.123456', '2026-03-29 01:30:00.1234567',
   '2026-03-29 01:30:00 +02:00', '2026-03-29 01:30:00.123 +02:00', '2026-03-29 01:30:00.123456 +02:00', '2026-03-29 01:30:00.1234567 +02:00',
   '10:00:00', '10:00:00.123', '10:00:00.123456', '10:00:00.1234567', '2026-03-29 01:30:00.997', '2026-03-29 01:30'),
  (2, 1, '2026-12-31 23:59:59', '2026-12-31 23:59:59.999', '2026-12-31 23:59:59.999999', '2026-12-31 23:59:59.9999999',
   '2026-12-31 23:59:59 -05:00', '2026-12-31 23:59:59.999 -05:00', '2026-12-31 23:59:59.999999 -05:00', '2026-12-31 23:59:59.9999999 -05:00',
   '23:59:59', '23:59:59.999', '23:59:59.999999', '23:59:59.9999999', '2026-12-31 23:59:59.003', '2026-12-31 23:59'),
  (3, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00.5', '2026-01-01 00:00:00.0004', '2026-01-01 00:00:00.0000001',
   '2026-01-01 00:00:00 +00:00', '2026-01-01 00:00:00.5 +00:00', '2026-01-01 00:00:00.0004 +00:00', '2026-01-01 00:00:00.0000001 +00:00',
   '00:00:00', '00:00:00.5', '00:00:00.0004', '00:00:00.0000001', '2026-01-01 00:00:00.007', '2026-01-01 00:00');
CREATE TABLE ${t("wallets")} ("id" INT NOT NULL PRIMARY KEY, "m" MONEY, "sm" SMALLMONEY);
INSERT INTO ${t("wallets")} VALUES (1, 0.0001, 214748.3647), (2, 922337203685477.5807, -0.0001);
CREATE TABLE ${t("ledgers")} ("id" INT NOT NULL PRIMARY KEY, "wide" DECIMAL(38,10) NOT NULL, "narrow" DECIMAL(18,4) NOT NULL);
INSERT INTO ${t("ledgers")} VALUES (1, 1234567890123456789.1234567891, 1.0001), (2, 123456789012345678901234567.1234567891, 7.0001);
CREATE TABLE ${t("autos")} ("id" INT IDENTITY(1,1) NOT NULL PRIMARY KEY, "name" NVARCHAR(20) NOT NULL);`;

const fromZero = s
  .model({
    id: s.int().id().increment(),
    name: s.string(),
    kids: s.toMany(() => kidOfZero),
  })
  .map("from_zero");
const kidOfZero = s
  .model({
    id: s.int().id().increment(),
    parentId: s.int(),
    name: s.string(),
    parent: s
      .toOne(() => fromZero)
      .fields("parentId")
      .references("id"),
  })
  .map("kids_of_zero");
const fromMinusTwo = s
  .model({ id: s.int().id().increment(), name: s.string() })
  .map("from_minus_two");

const INSTANTS = [
  "dt0",
  "dt3",
  "dt6",
  "dt7",
  "do0",
  "do3",
  "do6",
  "do7",
  "dt",
  "sdt",
] as const;
const TIMES = ["t0", "t3", "t6", "t7"] as const;
const holder = s
  .model({ id: s.int().id(), instants: s.toMany(() => instant) })
  .map("holders");
const instant = s
  .model({
    id: s.int().id(),
    holderId: s.int(),
    holder: s
      .toOne(() => holder)
      .fields("holderId")
      .references("id"),
    dt0: s.dateTime().nullable(),
    dt3: s.dateTime().nullable(),
    dt6: s.dateTime().nullable(),
    dt7: s.dateTime().nullable(),
    do0: s.dateTime().nullable(),
    do3: s.dateTime().nullable(),
    do6: s.dateTime().nullable(),
    do7: s.dateTime().nullable(),
    dt: s.dateTime().nullable(),
    sdt: s.dateTime().nullable(),
    t0: s.time().nullable(),
    t3: s.time().nullable(),
    t6: s.time().nullable(),
    t7: s.time().nullable(),
    rv: s.blob().nullable(),
  })
  .map("instants");

const wallet = s
  .model({
    id: s.int().id(),
    m: s.decimal({ precision: 19, scale: 4 }).nullable(),
    sm: s.decimal({ precision: 10, scale: 4 }).nullable(),
  })
  .map("wallets");
const ledger = s
  .model({
    id: s.int().id(),
    wide: s.decimal({ precision: 38, scale: 10 }),
    narrow: s.decimal({ precision: 18, scale: 4 }),
  })
  .map("ledgers");
const auto = s
  .model({ id: s.int().id().increment(), name: s.string() })
  .map("autos");

const db = createClient({
  schema: {
    fromZero,
    kidOfZero,
    fromMinusTwo,
    holder,
    instant,
    wallet,
    ledger,
    auto,
  },
  driver: createMssqlDriverIn(NS),
});

describeIf("SQL Server reads and writes adopted tables", () => {
  beforeAll(async () => {
    await createSchema(NS);
    await db.$executeRaw(sql.raw(DDL));
  });
  afterAll(async () => {
    await db.$disconnect();
    // Its foreign key into this schema goes first.
    await dropSchema(OTHER);
    await dropSchema(NS);
  });

  test("an IDENTITY value of 0 or below is a generated key like any other", async () => {
    // The table's first key is 0: a parent created with its children.
    expect(
      await db.fromZero.create({
        data: {
          name: "zero",
          kids: { create: [{ name: "a" }, { name: "b" }] },
        },
        select: { id: true, name: true, kids: { select: { name: true } } },
      })
    ).toEqual({ id: 0, name: "zero", kids: [{ name: "a" }, { name: "b" }] });
    expect(
      await db.fromMinusTwo.create({ data: { name: "minus two" } })
    ).toEqual({ id: -2, name: "minus two" });
    expect(
      await db.fromMinusTwo.upsert({
        where: { id: 40 },
        create: { name: "minus one" },
        update: { name: "never" },
      })
    ).toEqual({ id: -1, name: "minus one" });
  });

  test("a date and time read through an include, or as _min and _max, equals the same value read at the root", async () => {
    const root = await db.instant.findMany({ orderBy: { id: "asc" } });
    const nested = await db.holder.findUnique({
      where: { id: 1 },
      include: { instants: { orderBy: { id: "asc" } } },
    });
    expect(nested!.instants).toEqual(root);
    const columns = [...INSTANTS, ...TIMES];
    const extremes = await db.instant.aggregate({
      _min: Object.fromEntries(columns.map((name) => [name, true])),
      _max: Object.fromEntries(columns.map((name) => [name, true])),
    });
    const rank = (value: unknown) =>
      value instanceof Date ? value.getTime() : String(value);
    const pick = (name: string, sign: 1 | -1) =>
      root
        .map((row) => (row as Record<string, unknown>)[name])
        .reduce((best, value) =>
          (rank(value) > rank(best) ? 1 : -1) === sign ? value : best
        );
    expect(extremes).toEqual({
      _min: Object.fromEntries(columns.map((name) => [name, pick(name, -1)])),
      _max: Object.fromEntries(columns.map((name) => [name, pick(name, 1)])),
    });
  });

  test("a MONEY or SMALLMONEY column declared decimal reads its four decimals", async () => {
    expect(
      (await db.wallet.findMany({ orderBy: { id: "asc" } })).map((row) => [
        String(row.m),
        String(row.sm),
      ])
    ).toEqual([
      ["0.0001", "214748.3647"],
      ["922337203685477.5807", "-0.0001"],
    ]);
    const extremes = await db.wallet.aggregate({
      _min: { m: true },
      _max: { m: true },
    });
    expect([String(extremes._min.m), String(extremes._max.m)]).toEqual([
      "0.0001",
      "922337203685477.5807",
    ]);
  });

  test("multiply and divide on a wide decimal give SQL Server's result instead of refusing it", async () => {
    const native = async (expression: string) => {
      const [row] = await db.$queryRaw<{ v: string }>(
        sql.raw(
          `SELECT CONVERT(NVARCHAR(MAX), CAST(${expression} AS DECIMAL(38,10)), 2) AS "v" FROM ${t("ledgers")} WHERE "id" = 1`
        )
      );
      return row!.v;
    };
    const expected = {
      divided: await native(`"wide" / CAST(7 AS DECIMAL(38,10))`),
      multiplied: await native(
        "CAST(123456789012345678901234567.1234567891 AS DECIMAL(38,10)) * CAST(0.5 AS DECIMAL(38,10))"
      ),
    };
    await db.ledger.update({
      where: { id: 1 },
      data: { wide: { divide: "7" } },
    });
    await db.ledger.update({
      where: { id: 2 },
      data: { wide: { multiply: "0.5" } },
    });
    const rows = await db.ledger.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => String(row.wide))).toEqual([
      stripZeros(expected.divided),
      stripZeros(expected.multiplied),
    ]);
    // A narrow decimal keeps its exact half-to-even rule.
    await db.ledger.update({
      where: { id: 1 },
      data: { narrow: { multiply: "1.0001" } },
    });
    expect(
      String((await db.ledger.findUnique({ where: { id: 1 } }))!.narrow)
    ).toBe("1.0002");
  });

  test("the server's message number reaches meta, and a request timeout is a query timeout", async () => {
    const failure = (call: Promise<unknown>) =>
      call.then(
        () => undefined,
        (error: { code?: string; meta?: { providerErrno?: number } }) => ({
          code: error.code,
          errno: error.meta?.providerErrno,
        })
      );
    expect(
      await failure(db.$queryRaw(sql`SELECT CAST(N'x' AS INT) AS "v"`))
    ).toEqual({ code: "V2001", errno: 245 });
    expect(
      await failure(db.$executeRaw(sql.raw("THROW 51000, N'mine', 1")))
    ).toEqual({ code: "V2001", errno: 51_000 });
    const impatient = createClient({
      schema: { auto },
      driver: new MssqlDriver({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: NS,
        options: { requestTimeout: 200 },
      }),
    });
    try {
      expect(
        (
          await failure(
            impatient.$executeRaw(sql.raw("WAITFOR DELAY '00:00:02'"))
          )
        )?.code
      ).toBe("V2002");
    } finally {
      await impatient.$disconnect();
    }
  });

  test("an explicit IDENTITY value under a login without ALTER is refused, naming IDENTITY_INSERT", async () => {
    const LOGIN = "viborm_adopted_app";
    const PASSWORD = "Viborm_App_Pass1";
    await db.$executeRaw(
      sql.raw(
        `IF SUSER_ID(N'${LOGIN}') IS NULL CREATE LOGIN "${LOGIN}" WITH PASSWORD = N'${PASSWORD}', CHECK_POLICY = OFF;
IF USER_ID(N'${LOGIN}') IS NULL CREATE USER "${LOGIN}" FOR LOGIN "${LOGIN}";
ALTER ROLE db_datareader ADD MEMBER "${LOGIN}"; ALTER ROLE db_datawriter ADD MEMBER "${LOGIN}";`
      )
    );
    const url = new URL(TEST_CONNECTION_STRING!);
    url.username = LOGIN;
    url.password = PASSWORD;
    const app = createClient({
      schema: { auto },
      driver: new MssqlDriver({ databaseUrl: url.toString(), namespace: NS }),
    });
    try {
      const refusal = await app.auto
        .create({ data: { id: 50, name: "explicit" } })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(UnsupportedOperationError);
      expect((refusal as Error).message).toMatch(IDENTITY_INSERT_ADVICE);
      // A generated key still works for this login.
      expect(await app.auto.create({ data: { name: "generated" } })).toEqual({
        id: 1,
        name: "generated",
      });
    } finally {
      await app.$disconnect();
      await db.$executeRaw(
        sql.raw(
          `${"DR"}OP USER IF EXISTS "${LOGIN}"; IF SUSER_ID(N'${LOGIN}') IS NOT NULL ${"DR"}OP LOGIN "${LOGIN}";`
        )
      );
    }
  });

  test("introspectSchema reads a table another schema's foreign key references, with a warning", async () => {
    await createSchema(OTHER);
    await db.$executeRaw(
      sql.raw(
        `CREATE TABLE "${OTHER}"."child" ("id" INT NOT NULL PRIMARY KEY, "holderId" INT NOT NULL CONSTRAINT "child_holder_fk" REFERENCES ${t("holders")} ("id"))`
      )
    );
    const result = await introspectSchema({
      driver: createMssqlDriverIn(NS),
      tables: ["holders"],
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        kind: "unstated",
        table: "holders",
        message: expect.stringMatching(INCOMING_KEY_WARNING),
      })
    );
  });
});
