import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  activateConsumableResultProducer,
  deactivateConsumableResultProducer,
  executeConsumableResultCandidate,
  registerConsumableResultCandidate,
  resolveConsumableResultCandidate,
} from "@drivers/consumable-result-candidate";
import { Driver, type DriverResultParser } from "@drivers/driver";
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

  test("a shipped SQLite3 driver carrying a result middleware is borrowed", () => {
    // Root `AGENTS.md` rule 5: consumable rows are the provider's own objects,
    // so only a driver whose execution AND parser surfaces are exactly the
    // shipped ones may claim them — a `parseResult` middleware is handed those
    // rows. D-35 left the shipped SQLite parser with nothing of its own to say
    // about a RESULT, and `SQLite3Driver` still reads its canonical identity
    // from that parser, so the question the surface check asks is unchanged.
    expect(resolveConsumableResultCandidate(new SQLite3Driver())).toBeDefined();

    const wrapped = new SQLite3Driver();
    const middleware: DriverResultParser = {
      ...sqliteResultParser,
      parseResult: (raw, operation, next) => next(raw, operation),
    };
    Object.defineProperty(wrapped, "result", {
      configurable: true,
      value: middleware,
    });
    expect(resolveConsumableResultCandidate(wrapped)).toBeUndefined();
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
