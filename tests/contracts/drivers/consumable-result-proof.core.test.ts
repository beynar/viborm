import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  activateConsumableResultProducer,
  deactivateConsumableResultProducer,
  executeConsumableResultCandidate,
  registerConsumableResultCandidate,
  resolveConsumableResultCandidate,
} from "@drivers/consumable-result-candidate";
import {
  type AnyDriver,
  Driver,
  type DriverResultParser,
} from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import { sqliteResultParser } from "@drivers/shared";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

class CandidateDriver extends Driver<object, object> {
  readonly adapter = new SQLiteAdapter();
  readonly transport = {};
  readonly rows: never[] = [];
  beforeResult: (() => void) | undefined;

  constructor() {
    super("sqlite", "candidate-fixture");
    this.client = this.transport;
  }

  protected initClient(): Promise<object> {
    return Promise.resolve(this.transport);
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    this.beforeResult?.();
    return Promise.resolve({
      rows: this.rows,
      rowCount: this.rows.length,
    });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return callback(client);
  }
}

function registerCandidate(
  driver: CandidateDriver,
  state: { candidate: boolean; producer: boolean }
) {
  registerConsumableResultCandidate(
    driver,
    driver._execute,
    () => state.candidate,
    (_candidateDriver, client) => state.producer && client === driver.transport
  );
  const candidate = resolveConsumableResultCandidate(driver);
  if (!candidate) throw new Error("Expected an eligible result candidate");
  return candidate;
}

/** The same driver with `surface` installed where its `result` was. */
function installResult(
  driver: AnyDriver,
  surface: DriverResultParser
): AnyDriver {
  Object.defineProperty(driver, "result", {
    configurable: true,
    value: surface,
  });
  return driver;
}

/**
 * A family that can claim a consumable result, with the surface it SHIPS at
 * `result` and the two middlewares a caller could put there instead.
 */
interface ConsumableFamily {
  /** A freshly constructed, unmodified driver of this family. */
  readonly stock: () => AnyDriver;
  /** A middleware that wraps the RESULT — the hazard D-35 pinned. */
  readonly resultMiddleware: DriverResultParser;
  /** A middleware that only touches row VALUES — the case D-39 adds. */
  readonly fieldMiddleware: DriverResultParser;
}

/** `sqlite3` ships the parser object `shared/sqlite-utils.ts` owns. */
const SQLITE3_FAMILY: ConsumableFamily = {
  stock: () => new SQLite3Driver(),
  resultMiddleware: {
    ...sqliteResultParser,
    parseResult: (raw, operation, next) => next(raw, operation),
  },
  fieldMiddleware: { parseField: sqliteResultParser.parseField },
};

/** `pglite` ships none, so its stock surface is the ABSENCE of a parser. */
const PGLITE_FAMILY: ConsumableFamily = {
  stock: () => new PGliteDriver(),
  resultMiddleware: {
    parseResult: (raw, operation, next) => next(raw, operation),
  },
  fieldMiddleware: {
    parseField: (value, scalarType, next) => next(value, scalarType),
  },
};

/**
 * Whether each witness of one family still resolves as a consumable candidate
 * (Arnaud's D-39). The rule itself is one rule, stated at each family's own
 * `hasCanonicalProducerSurface`; this asks it of that family's witnesses.
 *
 * Root `AGENTS.md` rule 5: consumable rows are the provider's own objects, so
 * only a driver whose execution AND parser surfaces are exactly the shipped
 * ones may claim them. The check therefore compares the `result` OBJECT — a
 * middleware is handed those rows whichever hook it spells, and D-35 left the
 * shipped SQLite parser with no result hook of its own, so comparing that ONE
 * hook admitted every object that merely lacked it.
 */
function consumableAnswers(family: ConsumableFamily) {
  const isCandidate = (driver: AnyDriver) =>
    resolveConsumableResultCandidate(driver) !== undefined;
  // The adapter leg is the other question, unchanged by D-39: whether anything
  // re-entered the adapter this driver built at construction.
  const reentered = family.stock();
  const shipped = reentered.adapter.result.parseResult;
  reentered.adapter.result.parseResult = (raw, operation, next) =>
    shipped(raw, operation, next);
  return {
    stock: isCandidate(family.stock()),
    withResultMiddleware: isCandidate(
      installResult(family.stock(), family.resultMiddleware)
    ),
    // Same behaviour as the shipped surface, different object — and it still
    // sees the provider's rows.
    withFieldMiddleware: isCandidate(
      installResult(family.stock(), family.fieldMiddleware)
    ),
    withReenteredAdapter: isCandidate(reentered),
  };
}

/** Stock, and nothing else. */
const STOCK_ONLY = {
  stock: true,
  withResultMiddleware: false,
  withFieldMiddleware: false,
  withReenteredAdapter: false,
};

describe("consumable provider result proof", () => {
  test("publishes rows only while the registered producer identity stays eligible", async () => {
    const driver = new CandidateDriver();
    const state = { candidate: true, producer: true };
    const candidate = registerCandidate(driver, state);
    activateConsumableResultProducer(driver, driver.transport);
    const continuation = vi.fn(
      (
        result: QueryResult<unknown>,
        consumableRows: unknown[] | undefined
      ) => ({
        result,
        consumableRows,
      })
    );

    const outcome = await executeConsumableResultCandidate(
      candidate,
      sql`SELECT ${1}`,
      { model: "entry", operation: "findMany" },
      continuation
    );

    expect(outcome.result.rows).toBe(driver.rows);
    expect(outcome.consumableRows).toBe(driver.rows);
    expect(continuation).toHaveBeenCalledOnce();

    deactivateConsumableResultProducer(driver, {});
    await expect(
      executeConsumableResultCandidate(
        candidate,
        sql`SELECT ${2}`,
        { model: "entry", operation: "findMany" },
        (_result, consumableRows) => consumableRows
      )
    ).resolves.toBe(driver.rows);

    deactivateConsumableResultProducer(driver, driver.transport);
    await expect(
      executeConsumableResultCandidate(
        candidate,
        sql`SELECT ${3}`,
        { model: "entry", operation: "findMany" },
        (_result, consumableRows) => consumableRows
      )
    ).resolves.toBeUndefined();
  });

  test("does not activate or resolve a driver after candidate eligibility is revoked", async () => {
    const driver = new CandidateDriver();
    const state = { candidate: true, producer: true };
    const candidate = registerCandidate(driver, state);

    state.candidate = false;
    activateConsumableResultProducer(driver, driver.transport);
    expect(resolveConsumableResultCandidate(driver)).toBeUndefined();
    await expect(
      executeConsumableResultCandidate(
        candidate,
        sql`SELECT ${1}`,
        { operation: "findMany" },
        (_result, consumableRows) => consumableRows
      )
    ).resolves.toBeUndefined();
  });

  test("withdraws proof when the typed entry changes during execution", async () => {
    const driver = new CandidateDriver();
    const state = { candidate: true, producer: true };
    const candidate = registerCandidate(driver, state);
    activateConsumableResultProducer(driver, driver.transport);
    const originalEntry = driver._execute;
    driver.beforeResult = () => {
      Object.defineProperty(driver, "_execute", {
        configurable: true,
        value: originalEntry.bind(driver),
      });
    };

    await expect(
      executeConsumableResultCandidate(
        candidate,
        sql`SELECT ${1}`,
        { operation: "findMany" },
        (_result, consumableRows) => consumableRows
      )
    ).resolves.toBeUndefined();
  });

  test("withdraws proof when the producer changes during execution", async () => {
    const driver = new CandidateDriver();
    const state = { candidate: true, producer: true };
    const candidate = registerCandidate(driver, state);
    activateConsumableResultProducer(driver, driver.transport);
    driver.beforeResult = () => {
      deactivateConsumableResultProducer(driver, driver.transport);
      activateConsumableResultProducer(driver, driver.transport);
    };

    await expect(
      executeConsumableResultCandidate(
        candidate,
        sql`SELECT ${1}`,
        { operation: "findMany" },
        (_result, consumableRows) => consumableRows
      )
    ).resolves.toBeUndefined();
  });

  test("sqlite3: stock only while its result surface IS the shipped one", () => {
    expect(consumableAnswers(SQLITE3_FAMILY)).toEqual(STOCK_ONLY);
  });

  test("pglite: stock only while its result surface IS the shipped one", () => {
    expect(consumableAnswers(PGLITE_FAMILY)).toEqual(STOCK_ONLY);
  });

  test("withdraws proof when the active transport stops being eligible", async () => {
    const driver = new CandidateDriver();
    const state = { candidate: true, producer: true };
    const candidate = registerCandidate(driver, state);
    activateConsumableResultProducer(driver, driver.transport);
    driver.beforeResult = () => {
      state.producer = false;
    };

    await expect(
      executeConsumableResultCandidate(
        candidate,
        sql`SELECT ${1}`,
        { operation: "findMany" },
        (_result, consumableRows) => consumableRows
      )
    ).resolves.toBeUndefined();
  });
});
