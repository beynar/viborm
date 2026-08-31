/** PGlite integration contracts for consumable result ownership. */
import { PGliteDriver, type PGliteOptions } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, test, vi } from "vitest";
import {
  expectDirectReadMode,
  expectUnmarkedTypedAndRawResults,
} from "./behaviors/consumable-result-rows-behavior";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PGlite consumable result producer", () => {
  test("keeps stock driver/results symbol-free and admits scalar overrides", async () => {
    await expectUnmarkedTypedAndRawResults(new PGliteDriver());
    await expectDirectReadMode(
      new PGliteDriver({
        options: { parsers: { 23: (value: string) => Number(value) } },
      }),
      "consumable"
    );
  });

  test("keeps supplied clients borrowed forever, including reconnect", async () => {
    const database = new PGlite();
    const driver = new PGliteDriver({ client: database });

    try {
      await expectDirectReadMode(driver, "borrowed");
      await expectDirectReadMode(driver, "borrowed");
    } finally {
      await database.close();
    }
  });

  test("reads the actual init options and excludes custom substrate", async () => {
    const options: PGliteOptions = {};
    const driver = new PGliteDriver({ options });
    options.extensions = {
      inert: {
        name: "inert",
        setup: () => Promise.resolve({}),
      },
    };

    await expectDirectReadMode(driver, "borrowed");
  });

  test("keeps subclasses and async typed wrappers borrowed", async () => {
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
