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
import { MSSQL, s } from "@schema";
import { Sql, sql } from "@sql";
import { ordering, orderingKey } from "@src/ordering";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const WRITE_STATEMENT = /^\s*(?:INSERT|UPDATE)\b/;
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
CREATE INDEX "children_parentId" ON "${NS}"."children" ("parentId");
CREATE TABLE "${NS}"."vk_ci" ("code" VARCHAR(40) COLLATE SQL_Latin1_General_CP1_CI_AS NOT NULL PRIMARY KEY, "label" NVARCHAR(20) NOT NULL);
CREATE TABLE "${NS}"."vk_cs" ("code" VARCHAR(40) COLLATE SQL_Latin1_General_CP1_CS_AS NOT NULL PRIMARY KEY, "label" NVARCHAR(20) NOT NULL);
CREATE TABLE "${NS}"."stamps" ("id" INT NOT NULL PRIMARY KEY, "at" DATETIME NOT NULL);
CREATE TABLE "${NS}"."cyr" ("code" VARCHAR(40) COLLATE Cyrillic_General_CI_AS NOT NULL PRIMARY KEY, "label" VARCHAR(40) COLLATE Cyrillic_General_CI_AS NOT NULL);
CREATE TABLE "${NS}"."utf8" ("code" VARCHAR(40) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL PRIMARY KEY, "label" VARCHAR(40) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL);
CREATE TABLE "${NS}"."latin" ("code" VARCHAR(40) NOT NULL PRIMARY KEY);
INSERT INTO "${NS}"."latin" VALUES ('O'), ('Ab'), ('??');`;

const FILL = `WITH n AS (SELECT TOP (${ROWS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b)
INSERT INTO "${NS}"."parents" ("id", "name") SELECT CONCAT('id', i), CONCAT('name', i) FROM n;
INSERT INTO "${NS}"."children" ("id", "parentId") SELECT ROW_NUMBER() OVER (ORDER BY "id"), "id" FROM "${NS}"."parents";
INSERT INTO "${NS}"."accounts" VALUES (N'ab');
INSERT INTO "${NS}"."orders" VALUES (1, 'ab');
INSERT INTO "${NS}"."devices" VALUES ('6F9619FF-8B86-D011-B42D-00C04FC964FF');
INSERT INTO "${NS}"."events" VALUES (1, N'6f9619ff-8b86-d011-b42d-00c04fc964ff');
WITH n AS (SELECT TOP (${ROWS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b)
INSERT INTO "${NS}"."vk_ci" ("code", "label") SELECT CONCAT('code', i), N'filler' FROM n;
INSERT INTO "${NS}"."vk_ci" VALUES ('ss', N'ss'), (CHAR(223), N'eszett'), ('ab', N'ab'), ('abc', N'abc'), ('abd', N'abd'), ('ab-', N'ab-'), ('AbC0', N'AbC0');
INSERT INTO "${NS}"."vk_cs" ("code", "label") SELECT "code", "label" FROM "${NS}"."vk_ci";
INSERT INTO "${NS}"."vk_cs" VALUES ('AB', N'AB');
INSERT INTO "${NS}"."stamps" VALUES (1, '2026-03-29 01:30:00.003'), (2, '2026-03-29 01:30:00.007'), (3, '2026-12-31 23:59:59.997');
UPDATE STATISTICS "${NS}"."vk_ci" WITH FULLSCAN;
UPDATE STATISTICS "${NS}"."vk_cs" WITH FULLSCAN;
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

const varcharKeyed = (table: string) =>
  s
    .model({
      code: s.string(MSSQL.STRING.VARCHAR(40)).id(),
      label: s.string(),
    })
    .map(table);
const vkCi = varcharKeyed("vk_ci");
const codePaged = (table: string) =>
  s
    .model({
      code: s.string(MSSQL.STRING.VARCHAR(40)).id(),
      label: s.string(MSSQL.STRING.VARCHAR(40)),
    })
    .map(table);
const cyr = codePaged("cyr");
const utf8 = codePaged("utf8");
const latin = s
  .model({ code: s.string(MSSQL.STRING.VARCHAR(40)).id() })
  .map("latin");
const vkCs = varcharKeyed("vk_cs");
const stamp = s
  .model({ id: s.int().id(), at: s.dateTime(MSSQL.DATETIME.DATETIME) })
  .map("stamps");

const db = createClient({
  schema: {
    cyr,
    utf8,
    latin,
    vkCi,
    vkCs,
    stamp,
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

/** The physical operators of the last plan cached for a statement on `table`. */
const lastPlan = async (table = "parents"): Promise<string[]> => {
  const [row] = await db.$queryRaw<{ plan: string }>(
    sql`SELECT TOP (1) CAST(p.query_plan AS NVARCHAR(MAX)) AS "plan" FROM sys.dm_exec_query_stats AS q CROSS APPLY sys.dm_exec_sql_text(q.sql_handle) AS t CROSS APPLY sys.dm_exec_query_plan(q.plan_handle) AS p WHERE t.text LIKE ${`%${NS}"."${table}%`} AND t.text NOT LIKE N'%dm_exec_query_stats%' ORDER BY q.last_execution_time DESC`
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

  test.each([
    ["vk_ci", "CI"],
    ["vk_cs", "CS"],
  ] as const)("a VARCHAR(40) key declared MSSQL.STRING.VARCHAR (%s, collation %s) is sought, and compares as the column does", async (table, _collation) => {
    const model = (table === "vk_ci" ? db.vkCi : db.vkCs) as typeof db.vkCi;
    // The rows a non-Unicode literal finds: the column's own rules.
    const native = async (where: string) =>
      (
        await db.$queryRaw<{ code: string }>(
          sql.raw(
            `SELECT "code" FROM "${NS}"."${table}" WHERE ${where} ORDER BY "code"`
          )
        )
      ).map((row) => row.code);
    const codes = async (where: object) =>
      (
        await model.findMany({
          where,
          select: { code: true },
          orderBy: { code: "asc" },
        })
      ).map((row) => row.code);
    expect(await codes({ code: "ss" })).toEqual(await native(`"code" = 'ss'`));
    expect(await codes({ code: "ss" })).toEqual(["ss"]);
    expect(await codes({ code: { gte: "ab", lte: "abc" } })).toEqual(
      await native(`"code" >= 'ab' AND "code" <= 'abc'`)
    );
    expect(await codes({ code: { in: ["ss", "abd", "AB"] } })).toEqual(
      await native(`"code" IN ('ss', 'abd', 'AB')`)
    );

    const plans: Record<string, ReturnType<typeof seeks>> = {};
    const plan = async (name: string, call: () => Promise<unknown>) => {
      await call();
      plans[name] = seeks(await lastPlan(table));
    };
    await plan("findUnique", () =>
      model.findUnique({ where: { code: "code12345" } })
    );
    await plan("equals", () =>
      model.findMany({ where: { code: { equals: "code777" } } })
    );
    await plan("in", () =>
      model.findMany({ where: { code: { in: ["code1", "code2", "code3"] } } })
    );
    await plan("range", () =>
      model.findMany({ where: { code: { gte: "code500", lt: "code501" } } })
    );
    await plan("update", () =>
      model.update({ where: { code: "code42" }, data: { label: "updated" } })
    );
    await plan("upsert", () =>
      model.upsert({
        where: { code: "code43" },
        create: { code: "code43", label: "never" },
        update: { label: "upserted" },
      })
    );
    await plan("delete", () => model.delete({ where: { code: "code44" } }));
    for (const [name, found] of Object.entries(plans))
      expect({ name, ...found }).toEqual({ name, seek: true, scan: [] });
  });

  test("a DATETIME value read back finds its own row", async () => {
    for (const row of await db.stamp.findMany({ orderBy: { id: "asc" } }))
      expect(
        (
          await db.stamp.findMany({
            where: { at: row.at },
            select: { id: true },
          })
        ).map((found) => found.id)
      ).toEqual([row.id]);
  });

  test.each([
    ["cyr", ["Мир", "Привет", "Дом"]],
    ["utf8", ["東京", "日本語", "x😀"]],
  ] as const)("a VARCHAR native type in a %s column writes and finds text outside the database's code page", async (table, words) => {
    const model = (table === "cyr" ? db.cyr : db.utf8) as typeof db.cyr;
    const [first, second, third] = words;
    await model.create({ data: { code: first, label: second } });
    await model.createMany({ data: [{ code: third, label: first }] });
    await model.update({ where: { code: first }, data: { label: third } });
    await model.upsert({
      where: { code: second },
      create: { code: second, label: second },
      update: { label: "never" },
    });
    await model.upsert({
      where: { code: second },
      create: { code: second, label: "never" },
      update: { label: first },
    });
    // What the server stored, read back as Unicode.
    const stored = await db.$queryRaw<{ code: string; label: string }>(
      sql.raw(
        `SELECT CAST("code" AS NVARCHAR(40)) AS "code", CAST("label" AS NVARCHAR(40)) AS "label" FROM "${NS}"."${table}"`
      )
    );
    expect(
      Object.fromEntries(stored.map((row) => [row.code, row.label]))
    ).toEqual({ [first]: third, [second]: first, [third]: first });
    expect(await model.findUnique({ where: { code: first } })).toEqual({
      code: first,
      label: third,
    });
    expect(
      (await model.findMany({ where: { code: { equals: third } } })).length
    ).toBe(1);
    expect(
      (await model.findMany({ where: { code: { in: [first, second] } } }))
        .length
    ).toBe(2);
  });

  test("a VARCHAR native type converts no written value, ASCII included; a compared ASCII one only", async () => {
    const statements: string[] = [];
    const captured = db.$extends({
      name: "capture",
      statement: ({ statement }: { statement: Sql }) => {
        statements.push(Sql.peek(statement).strings.join("?"));
        return statement;
      },
    });
    await captured.cyr.create({ data: { code: "ascii", label: "plain" } });
    await captured.cyr.update({
      where: { code: "ascii" },
      data: { label: "still plain" },
    });
    const writes = statements.filter((text) => WRITE_STATEMENT.test(text));
    expect(writes.length).toBeGreaterThan(0);
    for (const text of writes)
      expect(text.split(" WHERE ")[0]).not.toContain("VARCHAR(MAX)");
    // The update's WHERE compares the ASCII key in the column's family.
    expect(statements.some((text) => text.includes("AS VARCHAR(MAX)"))).toBe(
      true
    );
  });

  test("a VARCHAR native type compares a non-ASCII operand without converting it", async () => {
    for (const operand of ["Ω", "Āb", "日本"])
      expect(await db.latin.findMany({ where: { code: operand } })).toEqual([]);
    expect(
      await db.latin.findMany({ where: { code: { in: ["Ω", "Āb", "日本"] } } })
    ).toEqual([]);
    // An ASCII operand still finds its row.
    expect(await db.latin.findUnique({ where: { code: "Ab" } })).toEqual({
      code: "Ab",
    });
  });
});
