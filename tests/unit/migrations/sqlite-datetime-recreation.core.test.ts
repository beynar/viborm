/**
 * SQLite DateTime schema evolution through table recreation.
 *
 * A DateTime native declaration names the stored vocabulary, not only the DDL
 * affinity. Altering that declaration must therefore translate every existing
 * instant while the recreation copies the old table into the new one.
 */

import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations/client";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s, TYPES } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const AT = new Date("2024-01-15T10:30:00.789Z");
const AT_EPOCH_MILLISECONDS = 1_705_314_600_789;
const AT_JULIAN_DAY = 2_460_324.937_509_132;
const PRE_EPOCH = new Date("1969-12-31T23:59:59.999Z");
const PRE_EPOCH_JULIAN_DAY = 2_440_587.499_999_988_4;

type DateTimeNativeType =
  (typeof TYPES.SQLITE.DATETIME)[keyof typeof TYPES.SQLITE.DATETIME];

interface DateTimeStorageForm {
  readonly name: keyof typeof TYPES.SQLITE.DATETIME;
  readonly native: DateTimeNativeType;
  readonly stored: string | number;
  readonly preEpochStored: string | number;
  readonly storage: "text" | "integer" | "real";
}

const FORMS: readonly DateTimeStorageForm[] = [
  {
    name: "TEXT",
    native: TYPES.SQLITE.DATETIME.TEXT,
    stored: AT.toISOString(),
    preEpochStored: PRE_EPOCH.toISOString(),
    storage: "text",
  },
  {
    name: "INTEGER",
    native: TYPES.SQLITE.DATETIME.INTEGER,
    stored: AT_EPOCH_MILLISECONDS,
    preEpochStored: -1,
    storage: "integer",
  },
  {
    name: "REAL",
    native: TYPES.SQLITE.DATETIME.REAL,
    stored: AT_JULIAN_DAY,
    preEpochStored: PRE_EPOCH_JULIAN_DAY,
    storage: "real",
  },
];

const TRANSITIONS = FORMS.flatMap((from) =>
  FORMS.filter((to) => to.name !== from.name).map((to) => ({ from, to }))
);

const ACCEPTED_TEXT_SPELLINGS = [
  "2026-08-30T12:34:56+02:00",
  "2026-08-30T12:34:56.7Z",
  "2026-08-30T12:34:56.7+12:00",
  "2026-08-30T12:34:56.7-12:00",
  "2026-08-30T12:34:56.78-04:30",
  "2026-08-30T12:34:56.789+23:59",
  "2026-08-30T12:34:56.789-23:59",
];

const REJECTED_TEXT_SPELLINGS = [
  "2026-08-30 12:34:56",
  "2026-02-30T12:34:56Z",
  "2026-08-30T24:00:00Z",
  "2026-08-30T24:01:00Z",
  "2026-08-30T24:00:00.001Z",
];

function eventSchema(nativeType: (typeof FORMS)[number]["native"]) {
  return {
    event: s
      .model({
        id: s.string().id(),
        at: s.dateTime(nativeType),
        optionalAt: s.dateTime(nativeType).nullable(),
      })
      .map("datetime_recreation_events"),
  };
}

function unmarkedTextSchema() {
  return {
    event: s
      .model({ id: s.string().id(), at: s.string().nullable() })
      .map("datetime_text_adoption"),
  };
}

function markedTextSchema() {
  return {
    event: s
      .model({
        id: s.string().id(),
        at: s.dateTime(TYPES.SQLITE.DATETIME.TEXT),
      })
      .map("datetime_text_adoption"),
  };
}

function unmarkedIntegerSchema() {
  return {
    event: s
      .model({ id: s.string().id(), at: s.int().nullable() })
      .map("datetime_integer_adoption"),
  };
}

function markedIntegerSchema() {
  return {
    event: s
      .model({
        id: s.string().id(),
        at: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER),
      })
      .map("datetime_integer_adoption"),
  };
}

describe("SQLite DateTime table recreation", () => {
  test.each(
    TRANSITIONS
  )("converts $from.name to $to.name without losing a millisecond", async ({
    from,
    to,
  }) => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: eventSchema(from.native), driver });

    await push(before, { force: true });
    await before.event.create({
      data: { id: "instant", at: AT, optionalAt: null },
    });
    await before.event.create({
      data: { id: "pre-epoch", at: PRE_EPOCH, optionalAt: null },
    });

    const after = createClient({ schema: eventSchema(to.native), driver });
    const migration = await push(after, { force: true });

    const copyStatement = migration.sql.find((statement) =>
      statement.startsWith('INSERT INTO "__new_datetime_recreation_events"')
    );
    expect(copyStatement).toContain("CASE WHEN");
    expect(copyStatement).toContain("abs(-9223372036854775808)");

    const physical = await driver._executeRaw<{
      at: unknown;
      atType: string;
      optionalAt: unknown;
    }>(
      'SELECT "at", typeof("at") AS "atType", "optionalAt" FROM "datetime_recreation_events" ORDER BY "id"'
    );
    expect(physical.rows).toEqual([
      {
        at: to.stored,
        atType: to.storage,
        optionalAt: null,
      },
      {
        at: to.preEpochStored,
        atType: to.storage,
        optionalAt: null,
      },
    ]);

    await expect(
      after.event.findMany({ where: { at: { equals: AT } } })
    ).resolves.toEqual([{ id: "instant", at: AT, optionalAt: null }]);
    await expect(
      after.event.findMany({ where: { at: { equals: PRE_EPOCH } } })
    ).resolves.toEqual([{ id: "pre-epoch", at: PRE_EPOCH, optionalAt: null }]);

    await after.$disconnect();
  });

  test("rejects an inexact Julian-day row without replacing the table", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.REAL),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      'INSERT INTO "datetime_recreation_events" ("id", "at", "optionalAt") VALUES (?, ?, NULL)',
      ["inexact", AT_JULIAN_DAY + 0.000_000_001]
    );

    const after = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.INTEGER),
      driver,
    });
    await expect(push(after, { force: true })).rejects.toThrow();

    const columns = await driver._executeRaw<{ name: string; type: string }>(
      'PRAGMA table_info("datetime_recreation_events")'
    );
    expect(columns.rows.find((column) => column.name === "at")?.type).toBe(
      "REAL"
    );
    await after.$disconnect();
  });

  test("converts every validated TEXT spelling without changing its instant", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.TEXT),
      driver,
    });
    await push(before, { force: true });

    for (const [position, at] of ACCEPTED_TEXT_SPELLINGS.entries()) {
      await before.event.create({
        data: { id: `text-${position}`, at, optionalAt: null },
      });
    }

    const after = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.INTEGER),
      driver,
    });
    await push(after, { force: true });

    const physical = await driver._executeRaw<{ id: string; at: number }>(
      'SELECT "id", "at" FROM "datetime_recreation_events" ORDER BY "id"'
    );
    expect(physical.rows).toEqual(
      ACCEPTED_TEXT_SPELLINGS.map((at, position) => ({
        id: `text-${position}`,
        at: Date.parse(at),
      }))
    );

    for (const [position, spelling] of ACCEPTED_TEXT_SPELLINGS.entries()) {
      const at = new Date(spelling);
      await expect(
        after.event.findMany({
          where: { id: { equals: `text-${position}` }, at: { equals: at } },
        })
      ).resolves.toEqual([{ id: `text-${position}`, at, optionalAt: null }]);
    }
    await after.$disconnect();
  });

  test.each(
    REJECTED_TEXT_SPELLINGS
  )("rejects SQLite-parsable text outside the public DateTime grammar: %s", async (malformed) => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.TEXT),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      'INSERT INTO "datetime_recreation_events" ("id", "at", "optionalAt") VALUES (?, ?, NULL)',
      ["malformed", malformed]
    );

    const after = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.INTEGER),
      driver,
    });
    await expect(push(after, { force: true })).rejects.toThrow();

    const columns = await driver._executeRaw<{ name: string; type: string }>(
      'PRAGMA table_info("datetime_recreation_events")'
    );
    expect(columns.rows.find((column) => column.name === "at")?.type).toBe(
      "TEXT"
    );
    await after.$disconnect();
  });

  test("refuses a TEXT target that cannot use the public four-digit year grammar", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.INTEGER),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      'INSERT INTO "datetime_recreation_events" ("id", "at", "optionalAt") VALUES (?, ?, NULL)',
      ["before-year-zero", -62_167_269_600_000]
    );

    const after = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.TEXT),
      driver,
    });
    await expect(push(after, { force: true })).rejects.toThrow();

    const columns = await driver._executeRaw<{ name: string; type: string }>(
      'PRAGMA table_info("datetime_recreation_events")'
    );
    expect(columns.rows.find((column) => column.name === "at")?.type).toBe(
      "INTEGER"
    );
    await after.$disconnect();
  });

  test("validates unmarked same-form candidates before adopting their domain", async () => {
    const textDriver = createInMemorySQLite3Driver();
    const textBefore = createClient({
      schema: unmarkedTextSchema(),
      driver: textDriver,
    });
    await push(textBefore, { force: true });
    const spelling = "2026-08-30T12:34:56.7+02:00";
    await textBefore.event.create({ data: { id: "text", at: spelling } });

    const textAfter = createClient({
      schema: markedTextSchema(),
      driver: textDriver,
    });
    const textMigration = await push(textAfter, { force: true });
    expect(textMigration.sql.join("\n")).toContain("CASE WHEN");
    await expect(
      textAfter.event.findMany({
        where: { at: { equals: spelling } },
      })
    ).resolves.toEqual([{ id: "text", at: new Date(spelling) }]);
    const storedText = await textDriver._executeRaw<{ at: string }>(
      'SELECT "at" FROM "datetime_text_adoption"'
    );
    expect(storedText.rows).toEqual([{ at: spelling }]);
    await textAfter.$disconnect();

    const integerDriver = createInMemorySQLite3Driver();
    const integerBefore = createClient({
      schema: unmarkedIntegerSchema(),
      driver: integerDriver,
    });
    await push(integerBefore, { force: true });
    await integerBefore.event.create({
      data: { id: "integer", at: AT_EPOCH_MILLISECONDS },
    });

    const integerAfter = createClient({
      schema: markedIntegerSchema(),
      driver: integerDriver,
    });
    const integerMigration = await push(integerAfter, { force: true });
    expect(integerMigration.sql.join("\n")).toContain("CASE WHEN");
    await expect(
      integerAfter.event.findMany({ where: { at: { equals: AT } } })
    ).resolves.toEqual([{ id: "integer", at: AT }]);
    await integerAfter.$disconnect();
  });

  test("rejects malformed unmarked same-form candidates atomically", async () => {
    const textDriver = createInMemorySQLite3Driver();
    const textBefore = createClient({
      schema: unmarkedTextSchema(),
      driver: textDriver,
    });
    await push(textBefore, { force: true });
    await textDriver._executeRaw(
      'INSERT INTO "datetime_text_adoption" ("id", "at") VALUES (?, ?)',
      ["bad-text", "2026-08-30 12:34:56"]
    );

    const textAfter = createClient({
      schema: markedTextSchema(),
      driver: textDriver,
    });
    await expect(push(textAfter, { force: true })).rejects.toThrow();
    const textColumns = await textDriver._executeRaw<{
      name: string;
      notnull: number;
    }>('PRAGMA table_info("datetime_text_adoption")');
    expect(
      textColumns.rows.find((column) => column.name === "at")?.notnull
    ).toBe(0);
    await textAfter.$disconnect();

    const integerDriver = createInMemorySQLite3Driver();
    const integerBefore = createClient({
      schema: unmarkedIntegerSchema(),
      driver: integerDriver,
    });
    await push(integerBefore, { force: true });
    await integerDriver._executeRaw(
      'INSERT INTO "datetime_integer_adoption" ("id", "at") VALUES (?, ?)',
      ["bad-integer", 8_640_000_000_000_001]
    );

    const integerAfter = createClient({
      schema: markedIntegerSchema(),
      driver: integerDriver,
    });
    await expect(push(integerAfter, { force: true })).rejects.toThrow();
    const integerColumns = await integerDriver._executeRaw<{
      name: string;
      notnull: number;
    }>('PRAGMA table_info("datetime_integer_adoption")');
    expect(
      integerColumns.rows.find((column) => column.name === "at")?.notnull
    ).toBe(0);
    await integerAfter.$disconnect();
  });

  test("records and applies the conversion in an authenticated V1 transition", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.TEXT),
      driver,
    });
    const beforeMigrations = createMigrationClient(before, { storage });
    const initial = await beforeMigrations.generate({ name: "text" });
    if (initial.stateId === null) throw new Error("expected initial state");

    const after = createClient({
      schema: eventSchema(TYPES.SQLITE.DATETIME.INTEGER),
      driver,
    });
    const afterMigrations = createMigrationClient(after, { storage });
    const converted = await afterMigrations.generate({ name: "integer" });
    expect(converted.sql).toContain("julianday");
    expect(converted.sql).toContain("abs(-9223372036854775808)");

    await beforeMigrations.apply({ to: { id: initial.stateId } });
    await before.event.create({
      data: { id: "estate", at: AT, optionalAt: null },
    });
    await afterMigrations.apply();

    await expect(
      after.event.findMany({ where: { at: { equals: AT } } })
    ).resolves.toEqual([{ id: "estate", at: AT, optionalAt: null }]);
    await after.$disconnect();
  });
});
