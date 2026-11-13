/**
 * SQL Server: VibORM sends a text comparison as written, as Prisma and
 * Drizzle do, and the column's type and collation decide. The tables are
 * created in raw SQL, as an adopted database declares them: `CHAR`,
 * `NCHAR` and `UNIQUEIDENTIFIER` keys, relations between columns of
 * different types, the server's default collation (case-insensitive) and a
 * binary one. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { ordering, orderingKey } from "@src/ordering";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NS = "viborm_string_comparison";
const ROWS = 20_000;

/** A parent keyed by `type` and its children, joined on a column of `type`. */
const keyedTables = (name: string, type: string) => `
CREATE TABLE "${NS}"."${name}" ("id" ${type} NOT NULL PRIMARY KEY, "label" NVARCHAR(20) NOT NULL);
CREATE TABLE "${NS}"."${name}_kids" ("id" INT NOT NULL PRIMARY KEY, "parentId" ${type} NOT NULL REFERENCES "${NS}"."${name}" ("id"));`;

const DDL = `${keyedTables("chars", "CHAR(10)")}
${keyedTables("nchars", "NCHAR(10)")}
${keyedTables("guids", "UNIQUEIDENTIFIER")}
CREATE TABLE "${NS}"."accounts" ("id" NVARCHAR(20) NOT NULL PRIMARY KEY);
CREATE TABLE "${NS}"."orders" ("id" INT NOT NULL PRIMARY KEY, "accountId" CHAR(20) NOT NULL);
CREATE TABLE "${NS}"."devices" ("id" UNIQUEIDENTIFIER NOT NULL PRIMARY KEY);
CREATE TABLE "${NS}"."events" ("id" INT NOT NULL PRIMARY KEY, "deviceId" NVARCHAR(36) NOT NULL);
CREATE TABLE "${NS}"."people" ("email" NVARCHAR(100) COLLATE SQL_Latin1_General_CP1_CI_AS NOT NULL PRIMARY KEY);
CREATE TABLE "${NS}"."codes" ("code" NVARCHAR(20) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY);
CREATE TABLE "${NS}"."cards" ("id" INT NOT NULL PRIMARY KEY, "columnId" NVARCHAR(20) NOT NULL, "rank" NVARCHAR(100) COLLATE Latin1_General_100_BIN2 NOT NULL);
CREATE TABLE "${NS}"."parents" ("id" NVARCHAR(450) NOT NULL PRIMARY KEY, "name" NVARCHAR(40) NOT NULL);
CREATE INDEX "parents_name" ON "${NS}"."parents" ("name");
CREATE TABLE "${NS}"."children" ("id" INT NOT NULL PRIMARY KEY, "parentId" NVARCHAR(450) NOT NULL REFERENCES "${NS}"."parents" ("id"));
CREATE INDEX "children_parentId" ON "${NS}"."children" ("parentId");`;

const FILL = `WITH n AS (SELECT TOP (${ROWS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b)
INSERT INTO "${NS}"."parents" ("id", "name") SELECT CONCAT('id', i), CONCAT('name', i) FROM n;
INSERT INTO "${NS}"."children" ("id", "parentId") SELECT ROW_NUMBER() OVER (ORDER BY "id"), "id" FROM "${NS}"."parents";
INSERT INTO "${NS}"."accounts" VALUES (N'ab');
INSERT INTO "${NS}"."orders" VALUES (1, 'ab');
INSERT INTO "${NS}"."devices" VALUES ('6F9619FF-8B86-D011-B42D-00C04FC964FF');
INSERT INTO "${NS}"."events" VALUES (1, N'6f9619ff-8b86-d011-b42d-00c04fc964ff');
UPDATE STATISTICS "${NS}"."parents" WITH FULLSCAN;
UPDATE STATISTICS "${NS}"."children" WITH FULLSCAN;`;

const keyed = (name: string) => {
  const parent = s
    .model({
      id: s.string().id(),
      label: s.string(),
      kids: s.toMany(() => kid),
    })
    .map(name);
  const kid = s
    .model({
      id: s.int().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id"),
    })
    .map(`${name}_kids`);
  return { parent, kid };
};
const chars = keyed("chars");
const nchars = keyed("nchars");
const guids = keyed("guids");

const account = s
  .model({ id: s.string().id(), orders: s.toMany(() => order) })
  .map("accounts");
const order = s
  .model({
    id: s.int().id(),
    accountId: s.string(),
    account: s
      .toOne(() => account)
      .fields("accountId")
      .references("id"),
  })
  .map("orders");
const device = s
  .model({ id: s.string().id(), events: s.toMany(() => event) })
  .map("devices");
const event = s
  .model({
    id: s.int().id(),
    deviceId: s.string(),
    device: s
      .toOne(() => device)
      .fields("deviceId")
      .references("id"),
  })
  .map("events");
const person = s.model({ email: s.string().id() }).map("people");
const code = s.model({ code: s.string().id() }).map("codes");
const card = s
  .model({
    id: s.int().id(),
    columnId: s.string(),
    rank: s.string().schema(orderingKey),
  })
  .map("cards");
const parent = s
  .model({
    id: s.string().id(),
    name: s.string(),
    children: s.toMany(() => child),
  })
  .map("parents");
const child = s
  .model({
    id: s.int().id(),
    parentId: s.string(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  })
  .map("children");

const db = createClient({
  schema: {
    charParent: chars.parent,
    charKid: chars.kid,
    ncharParent: nchars.parent,
    ncharKid: nchars.kid,
    guidParent: guids.parent,
    guidKid: guids.kid,
    account,
    order,
    device,
    event,
    person,
    code,
    card,
    parent,
    child,
  },
  driver: createMssqlDriverIn(NS),
});

type Keyed = "char" | "nchar" | "guid";
const GUID = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
const KEYS: [Keyed, string][] = [
  ["char", "ab"],
  ["nchar", "ab"],
  ["guid", GUID],
];

/** The physical operators of the last plan cached for a statement on `parents`/`children`. */
const lastPlan = async (): Promise<string[]> => {
  const [row] = await db.$queryRaw<{ plan: string }>(
    sql`SELECT TOP (1) CAST(p.query_plan AS NVARCHAR(MAX)) AS "plan" FROM sys.dm_exec_query_stats AS q CROSS APPLY sys.dm_exec_sql_text(q.sql_handle) AS t CROSS APPLY sys.dm_exec_query_plan(q.plan_handle) AS p WHERE t.text LIKE ${`%${NS}"."parents%`} AND t.text NOT LIKE N'%dm_exec_query_stats%' ORDER BY q.last_execution_time DESC`
  );
  return [...(row?.plan ?? "").matchAll(/PhysicalOp="([^"]+)"/g)].map(
    (match) => match[1]!
  );
};

const seeks = (ops: string[]) => ({
  seek: ops.some((op) => op.endsWith("Index Seek")),
  scan: ops.filter((op) => op.endsWith("Index Scan") || op === "Table Scan"),
});

describeIf("SQL Server compares text as the column does", () => {
  beforeAll(async () => {
    await createSchema(NS);
    await db.$executeRaw(sql.raw(DDL));
    await db.$executeRaw(sql.raw(FILL));
  }, 120_000);
  afterAll(async () => {
    await db.$disconnect();
    await dropSchema(NS);
  });

  test.each(
    KEYS
  )("a %s key is found by the value written to it, and joins its children", async (kind, key) => {
    const parents = db[`${kind}Parent`] as typeof db.charParent;
    const kids = db[`${kind}Kid`] as typeof db.charKid;
    await parents.create({ data: { id: key, label: "created" } });
    expect(
      await parents.findUnique({ where: { id: key }, select: { label: true } })
    ).toEqual({ label: "created" });
    expect(
      await parents.findFirst({
        where: { id: { equals: key } },
        select: { label: true },
      })
    ).toEqual({ label: "created" });
    await parents.update({ where: { id: key }, data: { label: "updated" } });
    expect(
      await parents.upsert({
        where: { id: key },
        create: { id: key, label: "not created" },
        update: { label: "upserted" },
        select: { label: true },
      })
    ).toEqual({ label: "upserted" });
    await kids.create({
      data: { id: 1, parent: { connect: { id: key } } },
    });
    expect(
      await kids.findUnique({
        where: { id: 1 },
        select: { parent: { select: { label: true } } },
      })
    ).toEqual({ parent: { label: "upserted" } });
    expect(
      await parents.findUnique({
        where: { id: key },
        select: { kids: { select: { id: true } } },
      })
    ).toEqual({ kids: [{ id: 1 }] });
    await kids.delete({ where: { id: 1 } });
    await parents.delete({ where: { id: key } });
    expect(await parents.count()).toBe(0);
  });

  test("a relation joins columns of different types as the database converts them", async () => {
    expect(
      await db.order.findUnique({
        where: { id: 1 },
        select: { account: { select: { id: true } } },
      })
    ).toEqual({ account: { id: "ab" } });
    expect(
      await db.account.findUnique({
        where: { id: "ab" },
        select: { orders: { select: { id: true } } },
      })
    ).toEqual({ orders: [{ id: 1 }] });
    expect(
      await db.event.findUnique({
        where: { id: 1 },
        select: { device: { select: { id: true } } },
      })
    ).toEqual({ device: { id: GUID.toUpperCase() } });
    expect(
      await db.device.findUnique({
        where: { id: GUID },
        select: { events: { select: { id: true } } },
      })
    ).toEqual({ events: [{ id: 1 }] });
  });

  test("under the server's default collation, case and trailing spaces are ignored", async () => {
    await db.person.createMany({
      data: [{ email: "Ada@Example.com" }, { email: "ab " }],
    });
    expect(
      await db.person.findUnique({ where: { email: "ada@example.com" } })
    ).toEqual({ email: "Ada@Example.com" });
    expect(
      await db.person.findMany({
        where: { email: { equals: "ADA@example.COM" } },
      })
    ).toEqual([{ email: "Ada@Example.com" }]);
    expect(await db.person.findUnique({ where: { email: "ab" } })).toEqual({
      email: "ab ",
    });
    expect(
      await db.person.findMany({ where: { email: { contains: "EXAMPLE" } } })
    ).toEqual([{ email: "Ada@Example.com" }]);
  });

  test("under a binary collation, case counts and trailing spaces do not", async () => {
    await db.code.createMany({ data: [{ code: "AB" }, { code: "cd " }] });
    expect(await db.code.findUnique({ where: { code: "ab" } })).toBeNull();
    expect(await db.code.findUnique({ where: { code: "AB" } })).toEqual({
      code: "AB",
    });
    expect(await db.code.findUnique({ where: { code: "cd" } })).toEqual({
      code: "cd ",
    });
    expect(
      await db.code.findMany({ where: { code: { contains: "b" } } })
    ).toEqual([]);
    expect(
      await db.code.findMany({
        where: { code: { equals: "ab", mode: "insensitive" } },
      })
    ).toEqual([{ code: "AB" }]);
  });

  test("viborm/ordering keeps lists the database holds as one as one", async () => {
    const ordered = ordering({
      models: { card: { key: "rank", within: ["columnId"] } },
    })(db);
    for (const [id, columnId] of [
      [1, "k"],
      [2, "k "],
      [3, "k"],
      [4, "k "],
    ] as const)
      await ordered.card.create({ data: { id, columnId } });
    const ranks = (
      await db.card.findMany({ orderBy: { id: "asc" }, select: { rank: true } })
    ).map((row) => row.rank);
    // Appended to one list: each key after the one before, across both (two
    // lists would each start again from the same first key).
    expect(new Set(ranks).size).toBe(4);
    expect([...ranks].sort()).toEqual(ranks);
  });

  test("lookups by key, includes, equality, a list, a prefix and a range seek the index", async () => {
    const plans: Record<string, ReturnType<typeof seeks>> = {};
    const plan = async (name: string, call: () => Promise<unknown>) => {
      await call();
      plans[name] = seeks(await lastPlan());
    };
    await plan("findUnique", () =>
      db.parent.findUnique({ where: { id: "id12345" } })
    );
    await plan("include children", () =>
      db.parent.findUnique({
        where: { id: "id12345" },
        include: { children: true },
      })
    );
    await plan("equals", () =>
      db.parent.findMany({ where: { name: "name777" } })
    );
    await plan("in", () =>
      db.parent.findMany({
        where: {
          id: { in: Array.from({ length: 10 }, (_, n) => `id${n * 7 + 1}`) },
        },
      })
    );
    await plan("startsWith", () =>
      db.parent.findMany({ where: { name: { startsWith: "name1234" } } })
    );
    await plan("range", () =>
      db.parent.findMany({ where: { name: { gte: "name500", lt: "name501" } } })
    );
    for (const [name, found] of Object.entries(plans))
      expect({ name, ...found }).toEqual({ name, seek: true, scan: [] });
    // The child's side of a to-one include.
    await db.child.findUnique({
      where: { id: 12_345 },
      include: { parent: true },
    });
    const [row] = await db.$queryRaw<{ plan: string }>(
      sql`SELECT TOP (1) CAST(p.query_plan AS NVARCHAR(MAX)) AS "plan" FROM sys.dm_exec_query_stats AS q CROSS APPLY sys.dm_exec_sql_text(q.sql_handle) AS t CROSS APPLY sys.dm_exec_query_plan(q.plan_handle) AS p WHERE t.text LIKE ${`%${NS}"."children%`} AND t.text NOT LIKE N'%dm_exec_query_stats%' ORDER BY q.last_execution_time DESC`
    );
    const ops = [...(row?.plan ?? "").matchAll(/PhysicalOp="([^"]+)"/g)].map(
      (match) => match[1]!
    );
    expect(seeks(ops)).toEqual({ seek: true, scan: [] });
  });

  test("a text `in` binds each member once: 2,000 members run on 20,000 rows, 2,099 are refused", async () => {
    const members = (n: number) =>
      Array.from({ length: n }, (_, i) => `id${i * 9 + 1}`);
    expect(
      await db.parent.count({ where: { id: { in: members(2000) } } })
    ).toBe(2000);
    expect(
      await db.parent.count({ where: { id: { in: members(2098) } } })
    ).toBe(2098);
    await expect(
      db.parent.count({ where: { id: { in: members(2099) } } })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});
