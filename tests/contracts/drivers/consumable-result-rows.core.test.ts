// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion fixtures are invoked only from registered tests.
import { join } from "node:path";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers/driver";
import { PGliteDriver, type PGliteOptions } from "@drivers/pglite";
import { SQLite3Driver, type SQLite3Options } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import { ReadOperation } from "@query-engine/write-engine/ReadOperation";
import { s } from "@schema";
import { sql } from "@sql";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const schema = {
  entry: s.model({
    id: s.string().id(),
    enabled: s.boolean(),
    recordedAt: s.dateTime(),
  }),
};

const RECORDED_AT = "2026-08-24T10:00:00.000Z";

async function expectDirectReadMode(
  driver: AnyDriver,
  expected: "borrowed" | "consumable"
): Promise<void> {
  const client = createClient({ schema, driver });
  try {
    await syncLiveSchema(client);
    // A supplied client survives this driver's `$disconnect()` and is
    // reinstalled by identity, so a second round runs against the SAME database
    // with the first round's row still in it. The read mode is what these
    // rounds are about, and one row is what they read.
    await client.entry.deleteMany();
    await client.entry.create({
      data: { id: "entry-1", enabled: true, recordedAt: RECORDED_AT },
    });
    const consumableParse = vi.spyOn(
      ReadOperation.prototype,
      "parseResultWithProgram"
    );
    consumableParse.mockClear();

    const result = await client.entry.findMany();

    expect(result).toEqual([
      {
        id: "entry-1",
        enabled: true,
        recordedAt: new Date(RECORDED_AT),
      },
    ]);
    if (expected === "consumable") {
      expect(consumableParse).toHaveBeenCalledTimes(1);
      const rows = consumableParse.mock.calls[0]?.[4];
      expect(rows).toBeDefined();
      expect(result).not.toBe(rows);
      expect(result[0]).toBe(rows?.[0]);
      return;
    }
    expect(consumableParse).not.toHaveBeenCalled();
  } finally {
    await client.$disconnect();
  }
}

async function expectUnmarkedTypedAndRawResults(
  driver: SQLite3Driver | PGliteDriver
): Promise<void> {
  const context = { operation: "findMany" };
  try {
    const typed = await driver._execute<{ value: number }>(
      sql`SELECT 1 AS "value"`,
      context
    );
    const raw = await driver._executeRaw<{ value: number }>(
      'SELECT 1 AS "value"'
    );

    expect(Reflect.ownKeys(typed)).toEqual(["rows", "rowCount"]);
    expect(Object.getOwnPropertySymbols(typed)).toEqual([]);
    expect(Object.getOwnPropertySymbols(raw)).toEqual([]);
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
    expect(Reflect.ownKeys(context)).toEqual(["operation"]);
    expect(Object.getOwnPropertySymbols(driver)).toEqual([]);
    expect(Object.getOwnPropertySymbols(Object.getPrototypeOf(driver))).toEqual(
      []
    );
  } finally {
    await driver.disconnect();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumable result producers", () => {
  test("keeps stock SQLite3 driver/results symbol-free and re-admits after reconnect", async () => {
    const driver = new SQLite3Driver();

    await expectUnmarkedTypedAndRawResults(driver);
    await expectDirectReadMode(driver, "consumable");
  });

  test("keeps supplied SQLite3 clients borrowed forever, including reconnect", async () => {
    const driver = new SQLite3Driver({ client: new Database(":memory:") });

    await expectDirectReadMode(driver, "borrowed");
    await expectDirectReadMode(driver, "borrowed");
  });

  test("reads the actual SQLite3 init options and excludes a native binding", async () => {
    const options: SQLite3Options = {};
    const driver = new SQLite3Driver({ options });
    options.nativeBinding = join(
      process.cwd(),
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    );

    await expectDirectReadMode(driver, "borrowed");
  });

  test("keeps SQLite3 subclasses and shadowed typed runners borrowed", async () => {
    class DerivedSQLite3Driver extends SQLite3Driver {}
    const derived = new DerivedSQLite3Driver();
    const executeShadowed = new SQLite3Driver();
    const runShadowed = new SQLite3Driver();
    const canonicalExecute = Reflect.get(executeShadowed, "execute");
    const canonicalRun = Reflect.get(runShadowed, "runStatement");
    if (
      typeof canonicalExecute !== "function" ||
      typeof canonicalRun !== "function"
    ) {
      throw new Error("SQLite3 typed execution methods are absent.");
    }
    Object.defineProperty(executeShadowed, "execute", {
      configurable: true,
      value(this: unknown, ...args: unknown[]) {
        return Reflect.apply(canonicalExecute, this, args);
      },
    });
    Object.defineProperty(runShadowed, "runStatement", {
      configurable: true,
      value(this: unknown, ...args: unknown[]) {
        return Reflect.apply(canonicalRun, this, args);
      },
    });

    await expectDirectReadMode(derived, "borrowed");
    await expectDirectReadMode(executeShadowed, "borrowed");
    await expectDirectReadMode(runShadowed, "borrowed");
  });

  test("keeps stock PGlite driver/results symbol-free and admits scalar overrides", async () => {
    await expectUnmarkedTypedAndRawResults(new PGliteDriver());
    await expectDirectReadMode(
      new PGliteDriver({
        options: { parsers: { 23: (value: string) => Number(value) } },
      }),
      "consumable"
    );
  });

  test("keeps supplied PGlite clients borrowed forever, including reconnect", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });

    await expectDirectReadMode(driver, "borrowed");
    await expectDirectReadMode(driver, "borrowed");
  });

  test("reads the actual PGlite init options and excludes custom substrate", async () => {
    const options: PGliteOptions = {};
    const driver = new PGliteDriver({ options });
    options.extensions = { vector };

    await expectDirectReadMode(driver, "borrowed");
  });

  test("keeps PGlite subclasses and async typed wrappers borrowed", async () => {
    class DerivedPGliteDriver extends PGliteDriver {}
    const derived = new DerivedPGliteDriver();
    const wrapped = new PGliteDriver();
    const canonicalExecute = wrapped._execute;
    Object.defineProperty(wrapped, "_execute", {
      configurable: true,
      async value(...args: Parameters<typeof canonicalExecute>) {
        return canonicalExecute.apply(this, args);
      },
    });

    await expectDirectReadMode(derived, "borrowed");
    await expectDirectReadMode(wrapped, "borrowed");
  });
});
