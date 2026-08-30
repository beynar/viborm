/**
 * SQLite's declared datetime storage, end to end.
 *
 * SQLite has no temporal type, so `s.dateTime(SQLITE.DATETIME.…)` is not
 * decoration: it names what the column physically holds — timestamp TEXT, an
 * INTEGER count of epoch milliseconds, or a REAL Julian day — and the DDL
 * already builds the column that way. Before this contract the DDL was the ONLY
 * layer that read the declaration: writes always bound ISO text, so an INTEGER
 * column silently held text, an exactly-seeded native row failed the typed read
 * with V9001, and an equality filter compared a string against a number.
 *
 * The matrix below is the whole promise: three declared forms × create, read,
 * equality and update, plus the range/cursor/null/boundary edges the numeric
 * forms introduce. The TEXT and undeclared legs are the regression half — they
 * must stay byte-identical to what shipped before the numeric forms existed.
 *
 * `sqlite3` reads INTEGER columns in BigInt mode on the typed path, so the
 * epoch-millisecond leg also pins the bigint transport; `_executeRaw` stays
 * provider-native, which is what makes `typeof()` an honest physical witness.
 */

import { createClient } from "@client/client";
import type { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { s, TYPES } from "@schema";
import { validateSchema } from "@schema/validation";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const TABLE = "native_datetime_events";
const FOREIGN_KEY_REFUSAL = /foreign key constraint (failed|violation)/i;

const AT = new Date("2024-01-15T10:30:00.000Z");
/** The same instant in each numeric vocabulary, written out rather than derived. */
const AT_EPOCH_MS = 1_705_314_600_000;
const AT_JULIAN_DAY = 2_460_324.9375;

const event = s
  .model({
    id: s.string().id(),
    atText: s.dateTime(TYPES.SQLITE.DATETIME.TEXT),
    atInt: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER).unique(),
    atReal: s.dateTime(TYPES.SQLITE.DATETIME.REAL).nullable(),
    atPlain: s.dateTime(),
  })
  .map(TABLE);

const FIXED = new Date("2020-02-29T12:00:00.000Z");

const entry = s
  .model({
    id: s.string().id(),
    seenAt: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER).now(),
    fixedAt: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER).default(FIXED),
    realFixed: s.dateTime(TYPES.SQLITE.DATETIME.REAL).default(FIXED),
  })
  .map("native_datetime_defaults");

const sqlDefaultEntry = s
  .model({
    id: s.string().id(),
    textFixed: s
      .dateTime(TYPES.SQLITE.DATETIME.TEXT)
      .default(FIXED.toISOString()),
    intFixed: s
      .dateTime(TYPES.SQLITE.DATETIME.INTEGER)
      .default(FIXED.toISOString()),
    realFixed: s
      .dateTime(TYPES.SQLITE.DATETIME.REAL)
      .default(FIXED.toISOString()),
  })
  .map("native_datetime_sql_defaults");

const owner = s.model({
  id: s.string().id(),
  readings: s.toMany(() => reading),
});

const reading = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
  atInt: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER),
  atReal: s.dateTime(TYPES.SQLITE.DATETIME.REAL).nullable(),
});

interface PhysicalRow {
  atText: unknown;
  tText: string;
  atInt: unknown;
  tInt: string;
  atReal: unknown;
  tReal: string;
  atPlain: unknown;
  tPlain: string;
}

async function setup() {
  const driver = createInMemorySQLite3Driver();
  const client = createClient({ schema: { event }, driver });
  await syncLiveSchema(client);
  return { client, driver };
}

/** The stored bytes, read outside the ORM so nothing decodes them first. */
async function physicalRow(
  driver: SQLite3Driver,
  id: string
): Promise<PhysicalRow | undefined> {
  const result = await driver._executeRaw<PhysicalRow>(
    `SELECT "atText", typeof("atText") AS "tText",
            "atInt", typeof("atInt") AS "tInt",
            "atReal", typeof("atReal") AS "tReal",
            "atPlain", typeof("atPlain") AS "tPlain"
       FROM "${TABLE}" WHERE "id" = ?`,
    [id]
  );
  return result.rows[0];
}

describe("SQLite declared datetime storage", () => {
  test("equal INTEGER forms enforce a live DateTime foreign key", async () => {
    const parent = s.model({
      at: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER).id(),
      children: s.toMany(() => child),
    });
    const child = s.model({
      id: s.string().id(),
      parentAt: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER),
      parent: s
        .toOne(() => parent)
        .fields("parentAt")
        .references("at"),
    });
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { parent, child }, driver });

    try {
      expect(validateSchema({ parent, child }).valid).toBe(true);
      await syncLiveSchema(client);
      await client.parent.create({
        data: { at: AT, children: { create: { id: "child" } } },
      });

      const stored = await driver._executeRaw<{
        parentAt: unknown;
        storage: string;
      }>(`SELECT "parentAt", typeof("parentAt") AS "storage" FROM "child"`);
      expect(stored.rows[0]).toEqual({
        parentAt: AT_EPOCH_MS,
        storage: "integer",
      });
    } finally {
      await client.$disconnect();
    }
  });

  test("SQLite itself refuses one instant encoded in different FK vocabularies", async () => {
    const driver = createInMemorySQLite3Driver();

    try {
      await driver._executeRaw(
        `CREATE TABLE "physical_parent" ("at" INTEGER PRIMARY KEY)`
      );
      await driver._executeRaw(
        `CREATE TABLE "physical_child" ("at" REAL REFERENCES "physical_parent" ("at"))`
      );
      await driver._executeRaw(
        `INSERT INTO "physical_parent" ("at") VALUES (?)`,
        [AT_EPOCH_MS]
      );

      await expect(
        driver._executeRaw(`INSERT INTO "physical_child" ("at") VALUES (?)`, [
          AT_JULIAN_DAY,
        ])
      ).rejects.toThrow(FOREIGN_KEY_REFUSAL);
      await expect(
        driver._executeRaw(`INSERT INTO "physical_child" ("at") VALUES (?)`, [
          AT_EPOCH_MS,
        ])
      ).resolves.toBeDefined();
    } finally {
      await driver.disconnect();
    }
  });

  test("each declaration builds the column type it names", async () => {
    const { client, driver } = await setup();

    try {
      const columns = await driver._executeRaw<{ name: string; type: string }>(
        `PRAGMA table_info("${TABLE}")`
      );
      const declared: Record<string, string> = {};
      for (const column of columns.rows) {
        declared[column.name] = column.type;
      }

      expect(declared).toMatchObject({
        atText: "TEXT",
        atInt: "INTEGER",
        atReal: "REAL",
        // An undeclared datetime keeps the dialect's own default column.
        atPlain: "TEXT",
      });
    } finally {
      await client.$disconnect();
    }
  });

  test("a create stores each column in the form it declared", async () => {
    const { client, driver } = await setup();

    try {
      await client.event.create({
        data: {
          id: "created",
          atText: AT,
          atInt: AT,
          atReal: AT,
          atPlain: AT,
        },
      });

      const stored = await physicalRow(driver, "created");

      // The physical values, not merely their types: an INTEGER column holding
      // "1705314600000" as TEXT would still report a plausible-looking row.
      expect(stored).toMatchObject({
        atText: AT.toISOString(),
        tText: "text",
        atInt: AT_EPOCH_MS,
        tInt: "integer",
        atReal: AT_JULIAN_DAY,
        tReal: "real",
        atPlain: AT.toISOString(),
        tPlain: "text",
      });
    } finally {
      await client.$disconnect();
    }
  });

  test("a typed read decodes exactly-seeded native rows", async () => {
    const { client, driver } = await setup();

    try {
      // Seeded through raw SQL, which stays physical: these are the bytes a
      // pre-existing database or another writer would hold.
      await driver._executeRaw(
        `INSERT INTO "${TABLE}" ("id", "atText", "atInt", "atReal", "atPlain")
         VALUES (?, ?, ?, ?, ?)`,
        [
          "native",
          AT.toISOString(),
          AT_EPOCH_MS,
          AT_JULIAN_DAY,
          AT.toISOString(),
        ]
      );

      const row = await client.event.findUnique({ where: { id: "native" } });

      expect(row?.atText).toEqual(AT);
      expect(row?.atInt).toEqual(AT);
      expect(row?.atReal).toEqual(AT);
      expect(row?.atPlain).toEqual(AT);
    } finally {
      await client.$disconnect();
    }
  });

  test("equality and range filters match the physical rows", async () => {
    const { client } = await setup();
    const earlier = new Date("2024-01-15T10:29:59.999Z");
    const later = new Date("2024-01-15T10:30:00.001Z");

    try {
      await client.event.create({
        data: { id: "a", atText: AT, atInt: AT, atReal: AT, atPlain: AT },
      });
      await client.event.create({
        data: {
          id: "b",
          atText: later,
          atInt: later,
          atReal: later,
          atPlain: later,
        },
      });

      const byInt = await client.event.findMany({ where: { atInt: AT } });
      const byReal = await client.event.findMany({ where: { atReal: AT } });
      const byText = await client.event.findMany({ where: { atText: AT } });
      const inRange = await client.event.findMany({
        where: { atInt: { gte: earlier, lte: later } },
        orderBy: { atInt: "asc" },
      });
      const afterRange = await client.event.findMany({
        where: { atReal: { gt: later } },
      });

      expect(byInt.map((row) => row.id)).toEqual(["a"]);
      expect(byReal.map((row) => row.id)).toEqual(["a"]);
      expect(byText.map((row) => row.id)).toEqual(["a"]);
      expect(inRange.map((row) => row.id)).toEqual(["a", "b"]);
      expect(afterRange).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  test("a cursor addresses a row by its native column", async () => {
    const { client } = await setup();
    const cursorInstant = new Date(Date.UTC(2024, 0, 2, 10, 30));
    const instants = [
      new Date(Date.UTC(2024, 0, 1, 10, 30)),
      cursorInstant,
      new Date(Date.UTC(2024, 0, 3, 10, 30)),
    ];

    try {
      for (const [index, instant] of instants.entries()) {
        await client.event.create({
          data: {
            id: `c${index}`,
            atText: instant,
            atInt: instant,
            atReal: instant,
            atPlain: instant,
          },
        });
      }

      const page = await client.event.findMany({
        orderBy: { atInt: "asc" },
        cursor: { atInt: cursorInstant },
        take: 5,
      });

      expect(page.map((row) => row.id)).toEqual(["c1", "c2"]);
    } finally {
      await client.$disconnect();
    }
  });

  test("an update rewrites the physical value in place", async () => {
    const { client, driver } = await setup();
    const moved = new Date("2025-06-30T23:59:59.123Z");

    try {
      await client.event.create({
        data: { id: "u", atText: AT, atInt: AT, atReal: AT, atPlain: AT },
      });
      await client.event.update({
        where: { id: "u" },
        data: { atText: moved, atInt: moved, atReal: moved, atPlain: moved },
      });

      const stored = await physicalRow(driver, "u");
      const row = await client.event.findUnique({ where: { id: "u" } });

      expect(stored).toMatchObject({
        tText: "text",
        atInt: moved.getTime(),
        tInt: "integer",
        tReal: "real",
        tPlain: "text",
      });
      expect(row?.atInt).toEqual(moved);
      expect(row?.atReal).toEqual(moved);
      expect(row?.atText).toEqual(moved);
      expect(row?.atPlain).toEqual(moved);
    } finally {
      await client.$disconnect();
    }
  });

  test("literal and generated defaults reach the declared form", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { entry }, driver });

    try {
      await syncLiveSchema(client);
      await client.entry.create({ data: { id: "d" } });

      const stored = await driver._executeRaw<{
        seenAt: unknown;
        tSeen: string;
        fixedAt: unknown;
        tFixed: string;
        realFixed: unknown;
        tReal: string;
      }>(
        `SELECT "seenAt", typeof("seenAt") AS "tSeen",
                "fixedAt", typeof("fixedAt") AS "tFixed",
                "realFixed", typeof("realFixed") AS "tReal"
           FROM "native_datetime_defaults" WHERE "id" = 'd'`
      );
      const row = await client.entry.findUnique({ where: { id: "d" } });

      expect(stored.rows[0]).toMatchObject({
        tSeen: "integer",
        fixedAt: FIXED.getTime(),
        tFixed: "integer",
        tReal: "real",
      });
      expect(row?.fixedAt).toEqual(FIXED);
      expect(row?.realFixed).toEqual(FIXED);
      expect(row?.seenAt).toBeInstanceOf(Date);
    } finally {
      await client.$disconnect();
    }
  });

  test("SQL literal defaults store each declared form for external inserts", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { sqlDefaultEntry }, driver });

    try {
      await syncLiveSchema(client);
      await driver._executeRaw(
        `INSERT INTO "native_datetime_sql_defaults" ("id") VALUES ('raw')`
      );

      const stored = await driver._executeRaw<{
        textFixed: unknown;
        tText: string;
        intFixed: unknown;
        tInt: string;
        realFixed: unknown;
        tReal: string;
      }>(
        `SELECT "textFixed", typeof("textFixed") AS "tText",
                "intFixed", typeof("intFixed") AS "tInt",
                "realFixed", typeof("realFixed") AS "tReal"
           FROM "native_datetime_sql_defaults" WHERE "id" = 'raw'`
      );
      const row = await client.sqlDefaultEntry.findUnique({
        where: { id: "raw" },
      });

      expect(stored.rows[0]).toEqual({
        textFixed: FIXED.toISOString(),
        tText: "text",
        intFixed: FIXED.getTime(),
        tInt: "integer",
        realFixed: 2_458_909,
        tReal: "real",
      });
      expect(row?.textFixed).toEqual(FIXED);
      expect(row?.intFixed).toEqual(FIXED);
      expect(row?.realFixed).toEqual(FIXED);
    } finally {
      await client.$disconnect();
    }
  });

  test("an omitted nullable native column stays SQL NULL both ways", async () => {
    const { client, driver } = await setup();

    try {
      await client.event.create({
        data: { id: "empty", atText: AT, atInt: AT, atPlain: AT },
      });

      const stored = await physicalRow(driver, "empty");
      const row = await client.event.findUnique({ where: { id: "empty" } });
      const matched = await client.event.findMany({
        where: { atReal: null },
      });

      expect(stored?.tReal).toBe("null");
      expect(row?.atReal).toBeNull();
      expect(matched.map((each) => each.id)).toEqual(["empty"]);
    } finally {
      await client.$disconnect();
    }
  });

  test("boundary instants survive both numeric forms exactly", async () => {
    const { client } = await setup();
    // The epoch itself (0 in one form, a half-day fraction in the other), a
    // pre-epoch instant (negative milliseconds), and a far-future one whose
    // Julian day has the least millisecond resolution of any real date.
    const boundaries = [
      new Date("1970-01-01T00:00:00.000Z"),
      new Date("1899-12-31T12:00:00.500Z"),
      new Date("0000-01-01T00:00:00.000Z"),
      new Date("9999-12-31T23:59:59.999Z"),
    ];

    try {
      for (const [index, instant] of boundaries.entries()) {
        await client.event.create({
          data: {
            id: `edge-${index}`,
            atText: instant,
            atInt: instant,
            atReal: instant,
            atPlain: instant,
          },
        });
      }

      for (const [index, instant] of boundaries.entries()) {
        const row = await client.event.findUnique({
          where: { id: `edge-${index}` },
        });
        expect(row?.atInt).toEqual(instant);
        expect(row?.atReal).toEqual(instant);
      }
    } finally {
      await client.$disconnect();
    }
  });

  test("numeric values outside the public DateTime domain are refused", async () => {
    const { client, driver } = await setup();
    const outsideRows: [string, number][] = [
      ["too-early", -62_167_219_200_001],
      ["too-late", 253_402_300_800_000],
    ];

    try {
      for (const [id, physical] of outsideRows) {
        await driver._executeRaw(
          `INSERT INTO "${TABLE}" ("id", "atText", "atInt", "atPlain")
           VALUES (?, ?, ?, ?)`,
          [id, AT.toISOString(), physical, AT.toISOString()]
        );
        await expect(
          client.event.findUnique({ where: { id } })
        ).rejects.toBeInstanceOf(QueryEngineError);
      }
    } finally {
      await client.$disconnect();
    }
  });

  test("a nested include decodes native columns through the JSON carrier", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { owner, reading }, driver });

    try {
      await syncLiveSchema(client);
      await client.owner.create({
        data: {
          id: "o",
          readings: { create: [{ id: "r", atInt: AT, atReal: AT }] },
        },
      });

      const included = await client.owner.findUnique({
        where: { id: "o" },
        include: { readings: true },
      });
      const aggregated = await client.reading.aggregate({
        _min: { atInt: true },
        _max: { atReal: true },
      });

      expect(included?.readings[0]?.atInt).toEqual(AT);
      expect(included?.readings[0]?.atReal).toEqual(AT);
      expect(aggregated._min?.atInt).toEqual(AT);
      expect(aggregated._max?.atReal).toEqual(AT);
    } finally {
      await client.$disconnect();
    }
  });
});
