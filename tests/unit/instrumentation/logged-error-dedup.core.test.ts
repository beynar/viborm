/**
 * One failure, one error log — and nothing left behind on the caller's error.
 *
 * A failing statement is observed twice: the driver logs the statement
 * (`logQuery`) and the query engine logs the operation
 * (`observeOperationExecution`). The driver records what it has already
 * reported so the engine stays quiet, and that record lives in a module-scoped
 * `WeakSet` (`@instrumentation/logged-errors`), not in a property stamped onto
 * the error.
 *
 * Falsification (each run against a deliberately broken build):
 *  - drop `markErrorLogged(error)` in `logQuery` → "logs once" and the frozen
 *    case both fail with 2 events.
 *  - restore `Object.defineProperty(error, "logged", …)` → "no internal marker"
 *    fails, and the frozen case fails with 2 events.
 *  - mark unconditionally (e.g. also in the engine observer) → "an error the
 *    driver never reported" fails with 0 events.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import type { QueryExecutionContext, QueryResult } from "@drivers/types";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { captureLogs } from "@tests/unit/instrumentation/_capture";

class FailingDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  failWith: Error | undefined;
  /** Freeze the normalized error on its way into the log — the case the old
   *  `Object.defineProperty` stamp could not mark, and so logged twice. */
  freezeLoggedError = false;

  constructor() {
    super("sqlite", "failing");
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }
  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }
  protected execute<T>(): Promise<QueryResult<T>> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  protected executeRaw<T>(): Promise<QueryResult<T>> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn(client);
  }

  protected override logQuery(
    sql: string,
    params: unknown[],
    duration: number,
    context: QueryExecutionContext,
    error?: unknown
  ): void {
    if (this.freezeLoggedError && error instanceof Error) Object.freeze(error);
    super.logQuery(sql, params, duration, context, error);
  }
}

const user = s.model({ id: s.string().id(), name: s.string() });

function instrumentedClient(driver: FailingDriver) {
  const logs = captureLogs();
  return {
    logs,
    client: createClient({
      schema: { user },
      driver,
      instrumentation: {
        logging: { error: logs.callback },
      },
    }),
  };
}

async function failingRead(driver: FailingDriver) {
  const { logs, client } = instrumentedClient(driver);
  const error = await client.user.findMany().then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  return { error, logs };
}

describe("cross-layer error-log de-duplication", () => {
  it("hands the caller an error carrying no internal marker", async () => {
    const driver = new FailingDriver();
    driver.failWith = new Error("db exploded");

    const { error } = await failingRead(driver);

    expect(error).toBeInstanceOf(Error);
    const thrown = error as Error;
    expect(Object.getOwnPropertyNames(thrown)).not.toContain("logged");
    expect("logged" in thrown).toBe(false);
    expect(Reflect.has(thrown, "logged")).toBe(false);
  });

  it("logs one failure once, not once per observing layer", async () => {
    const driver = new FailingDriver();
    driver.failWith = new Error("db exploded");

    const { logs } = await failingRead(driver);

    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]?.level).toBe("error");
  });

  it("de-duplicates a frozen error too", async () => {
    const driver = new FailingDriver();
    driver.failWith = new Error("db exploded");
    driver.freezeLoggedError = true;

    const { error, logs } = await failingRead(driver);

    expect(Object.isFrozen(error)).toBe(true);
    expect(logs.events).toHaveLength(1);
  });

  it("de-duplicates per error, not once for the process", async () => {
    const driver = new FailingDriver();
    driver.failWith = new Error("db exploded");
    const { logs, client } = instrumentedClient(driver);

    await client.user.findMany().catch(() => undefined);
    await client.user.findMany().catch(() => undefined);

    expect(logs.events).toHaveLength(2);
  });

  it("still logs an error the driver never reported", async () => {
    const driver = new FailingDriver();
    const { logs, client } = instrumentedClient(driver);

    // Rejected before any statement runs, so `logQuery` never sees it: the
    // operation observer is the only layer that can report this one.
    const error = await client.user.findMany({ take: 1.5 }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]?.level).toBe("error");
  });
});
