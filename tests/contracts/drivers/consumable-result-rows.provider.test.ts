/** SQLite3 integration contracts for consumable result ownership. */
import { join } from "node:path";
import { SQLite3Driver, type SQLite3Options } from "@drivers/sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, test, vi } from "vitest";
import {
  expectDirectReadMode,
  expectUnmarkedTypedAndRawResults,
} from "./consumable-result-rows-assertions";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SQLite3 consumable result producer", () => {
  test("keeps stock driver/results symbol-free and re-admits after reconnect", async () => {
    const driver = new SQLite3Driver();

    await expectUnmarkedTypedAndRawResults(driver);
    await expectDirectReadMode(driver, "consumable");
  });

  test("keeps supplied clients borrowed forever, including reconnect", async () => {
    const database = new Database(":memory:");
    const driver = new SQLite3Driver({ client: database });

    try {
      await expectDirectReadMode(driver, "borrowed");
      await expectDirectReadMode(driver, "borrowed");
    } finally {
      database.close();
    }
  });

  test("reads the actual init options and excludes a native binding", async () => {
    const options: SQLite3Options = {};
    const driver = new SQLite3Driver({ options });
    options.nativeBinding = join(
      process.cwd(),
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    );

    await expectDirectReadMode(driver, "borrowed");
  });

  test("keeps subclasses and shadowed typed runners borrowed", async () => {
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
});
