/**
 * SQL Server: what a statement answers is the statement's own. A trigger's
 * statements add to the server's row counts and may return rows; an `in`
 * list past the bind budget is never sent as an empty statement; a whole
 * number past 2^53 binds and filters; an integer `_sum` does not overflow
 * the column's type. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { QueryEngineError, UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

/** What a refused create under an INSTEAD OF INSERT trigger says to do. */
const INSTEAD_OF_INSERT_ADVICE =
  /INSTEAD OF INSERT trigger: use createMany without select/;

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_write_results";
const table = (name: string) => `"${NAMESPACE}"."${name}"`;

const counter = s
  .model({
    id: s.int().id().increment(),
    key: s.string().unique(),
    team: s.string().default("t"),
    value: s.int(),
    big: s.bigInt().nullable(),
    ratio: s.number().nullable(),
  })
  .map("counters");
const note = s
  .model({ id: s.int().id().increment(), text: s.string() })
  .map("notes");

const client = createClient({
  schema: { counter, note },
  driver: createMssqlDriverIn(NAMESPACE),
});

/** A trigger without NOCOUNT: three rows written elsewhere per statement. */
const afterTrigger = (returnsRows: boolean) =>
  sql.raw(`CREATE TRIGGER ${table("counters_touch")} ON ${table("counters")} AFTER INSERT, UPDATE, DELETE AS BEGIN
  INSERT INTO ${table("notes")} ("text") VALUES (N'a'), (N'b'), (N'c');${returnsRows ? ' SELECT 1 AS "noise";' : ""}
END`);

describeIf("SQL Server answers for the statement it ran", () => {
  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await syncLiveSchema(client);
  });
  beforeEach(async () => {
    await client.counter.deleteMany({});
    await client.note.deleteMany({});
  });
  afterAll(async () => {
    await client.$disconnect();
    await dropSchema(NAMESPACE);
  });

  describe.each([
    false,
    true,
  ])("under an AFTER trigger (returning rows: %s)", (returnsRows) => {
    beforeEach(async () => {
      await client.$executeRaw(afterTrigger(returnsRows));
    });
    afterEach(async () => {
      await client.$executeRaw(
        sql.raw(`DROP TRIGGER ${table("counters_touch")}`)
      );
    });

    test("counts and rows are the statement's", async () => {
      expect(
        await client.counter.createMany({
          data: [
            { key: "a", value: 1 },
            { key: "b", value: 1 },
          ],
        })
      ).toEqual({ count: 2 });
      expect(
        await client.counter.createMany({
          data: [{ key: "c", value: 1 }],
          select: { key: true },
        })
      ).toEqual([{ key: "c" }]);
      // An explicit identity: the IDENTITY_INSERT form, counted the same.
      expect(
        (await client.counter.create({ data: { id: 900, key: "d", value: 1 } }))
          .id
      ).toBe(900);
      expect(await client.counter.updateMany({ data: { value: 2 } })).toEqual({
        count: 4,
      });
      for (const key of ["a", "e"])
        expect(
          (
            await client.counter.upsert({
              where: { key },
              create: { key, value: 3 },
              update: { value: 3 },
            })
          ).value
        ).toBe(3);
      expect((await client.counter.delete({ where: { key: "a" } })).key).toBe(
        "a"
      );
      expect(await client.counter.deleteMany({})).toEqual({ count: 4 });
      expect(await client.counter.count()).toBe(0);
    });
  });

  test("under an INSTEAD OF trigger that writes the row itself, the count is the trigger's write", async () => {
    await client.$executeRaw(
      sql.raw(`CREATE TRIGGER ${table("counters_instead")} ON ${table("counters")} INSTEAD OF UPDATE AS BEGIN
  INSERT INTO ${table("notes")} ("text") VALUES (N'x');
  UPDATE c SET "value" = i."value" FROM ${table("counters")} AS c JOIN inserted AS i ON i."id" = c."id";
END`)
    );
    try {
      await client.counter.createMany({
        data: [
          { key: "a", value: 1 },
          { key: "b", value: 1 },
        ],
      });
      expect(await client.counter.updateMany({ data: { value: 5 } })).toEqual({
        count: 2,
      });
      expect(
        (await client.counter.findMany({ select: { value: true } })).map(
          (row) => row.value
        )
      ).toEqual([5, 5]);
    } finally {
      await client.$executeRaw(
        sql.raw(`DROP TRIGGER ${table("counters_instead")}`)
      );
    }
  });

  test("under an INSTEAD OF INSERT trigger, a create that reads its row back is refused, typed; a count is not", async () => {
    // The trigger inserts the row in its own scope: SCOPE_IDENTITY() is NULL
    // in the statement's, and the generated key cannot be read.
    await client.$executeRaw(
      sql.raw(`CREATE TRIGGER ${table("counters_insert")} ON ${table("counters")} INSTEAD OF INSERT AS BEGIN
  INSERT INTO ${table("counters")} ("key", "team", "value", "big", "ratio") SELECT "key", "team", "value", "big", "ratio" FROM inserted;
END`)
    );
    try {
      // The refusal names the trigger and what works under it.
      const refusal = await client.counter
        .create({ data: { key: "a", value: 1 } })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(QueryEngineError);
      expect((refusal as Error).message).toMatch(INSTEAD_OF_INSERT_ADVICE);
      expect(
        await client.counter.createMany({
          data: [
            { key: "b", value: 1 },
            { key: "c", value: 1 },
          ],
        })
      ).toEqual({ count: 2 });
    } finally {
      await client.$executeRaw(
        sql.raw(`DROP TRIGGER ${table("counters_insert")}`)
      );
    }
  });

  test("an `in` list past the bind budget is refused, its values repeated or not", async () => {
    await client.counter.createMany({
      data: [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ],
    });
    const repeated = Array.from({ length: 3000 }, (_, n) => (n % 2) + 1);
    const distinct = Array.from({ length: 3000 }, (_, n) => n + 1);
    for (const values of [repeated, distinct])
      await expect(
        client.counter.findMany({ where: { value: { in: values } } })
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  test("a statement binds 2,098 values at most: 2,098 run, 2,099 are refused", async () => {
    // 2,100 per request, of which sp_executesql's text and declaration take
    // two (Msg 8003 past it).
    const ids = (count: number) => Array.from({ length: count }, (_, n) => n);
    expect(
      await client.counter.findMany({
        where: { id: { in: ids(2098) } },
        select: { id: true },
      })
    ).toEqual([]);
    await expect(
      client.counter.findMany({
        where: { id: { in: ids(2099) } },
        select: { id: true },
      })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  test("a whole number past 2^53 is written and filtered", async () => {
    for (const ratio of [1e19, 1e308, -1e19]) {
      await client.counter.create({
        data: { key: String(ratio), value: 0, ratio },
      });
      const found = await client.counter.findMany({
        where: { ratio: { equals: ratio } },
        select: { ratio: true },
      });
      expect(found).toEqual([{ ratio }]);
    }
  });

  test("an INT and a BIGINT _sum past their type, compared and sorted", async () => {
    const top = 2_147_483_647;
    const huge = 9_223_372_036_854_775_807n;
    await client.counter.createMany({
      data: [
        { key: "x1", team: "x", value: top, big: huge },
        { key: "x2", team: "x", value: top, big: huge },
        { key: "y1", team: "y", value: top, big: 1n },
        { key: "y2", team: "y", value: -5, big: -3n },
        { key: "z1", team: "z", value: 7, big: 7n },
      ],
    });
    const { _sum } = await client.counter.aggregate({
      _sum: { value: true, big: true },
    });
    expect(_sum.value).toBe(2 * top + top - 5 + 7);
    expect(_sum.big).toBe(2n * huge + 1n - 3n + 7n);
    const teams = await client.counter.groupBy({
      by: ["team"],
      _sum: { value: true, big: true },
      having: { value: { _sum: { gt: 100 } } },
      orderBy: { _sum: { value: "desc" } },
    });
    expect(
      teams.map((group) => [group.team, group._sum.value, group._sum.big])
    ).toEqual([
      ["x", 2 * top, 2n * huge],
      ["y", top - 5, -2n],
    ]);
    // Past BIGINT itself, as one exact DECIMAL(38, 0).
    const byBig = await client.counter.groupBy({
      by: ["team"],
      _sum: { big: true },
      having: { big: { _sum: { gt: 1e19 } } },
      orderBy: { _sum: { big: "asc" } },
    });
    expect(byBig.map((group) => group.team)).toEqual(["x"]);
  });
});
