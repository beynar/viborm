/**
 * `await using` — the Scope pillar, standard-library edition (plan Phase T6).
 *
 * The contract these probes pin:
 *  - leaving an `await using` block runs the driver's close path, including
 *    when the block is left by a throw;
 *  - disposal and an explicit `$disconnect()` are the SAME close path, so
 *    combining them closes once and throws nothing;
 *  - the root client and the driver base are disposable; the interactive `tx`
 *    client and its transaction-bound driver deliberately are NOT, because
 *    `$transaction` owns that lifetime.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient, type TransactionClient } from "@client/client";
import { ASYNC_DISPOSE } from "@drivers/async-dispose";
import { Driver } from "@drivers/driver";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { QueryResult } from "@drivers/types";
import { s } from "@schema";
import { describe, expect, expectTypeOf, test } from "vitest";

const record = s.model({ id: s.string().id() });
const schema = { record };

class CountingDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  closeCount = 0;

  constructor() {
    super("sqlite", "async-dispose-probe");
    this.client = {};
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    this.closeCount++;
    return Promise.resolve();
  }

  protected execute<T>(
    client: object,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.executeRaw(client, sql, params);
  }

  protected executeRaw<T>(
    _client: object,
    _sql: string,
    _params?: unknown[]
  ): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => undefined,
      callback: () => fn(client),
      commit: () => undefined,
      rollback: () => undefined,
    });
  }
}

describe("await using — the driver base", () => {
  test("leaving the block runs the close path", async () => {
    const observed = new CountingDriver();
    {
      await using driver = observed;
      expect(driver.closeCount).toBe(0);
    }
    expect(observed.closeCount).toBe(1);
  });

  test("a throw inside the block still closes, and still throws", async () => {
    const observed = new CountingDriver();
    const boom = new Error("inside the block");

    await expect(
      (async () => {
        await using driver = observed;
        expect(driver.closeCount).toBe(0);
        throw boom;
      })()
    ).rejects.toBe(boom);

    expect(observed.closeCount).toBe(1);
  });

  test("disposal after an explicit disconnect() closes exactly once", async () => {
    const observed = new CountingDriver();
    {
      await using driver = observed;
      await driver.disconnect();
      expect(driver.closeCount).toBe(1);
    }
    expect(observed.closeCount).toBe(1);
  });

  test("an explicit disconnect() after disposal is still a no-op, not a throw", async () => {
    const observed = new CountingDriver();
    {
      await using driver = observed;
      expect(driver.closeCount).toBe(0);
    }
    await expect(observed.disconnect()).resolves.toBeUndefined();
    expect(observed.closeCount).toBe(1);
  });
});

describe("await using — the root client", () => {
  test("leaving the block closes the client's driver", async () => {
    const driver = new CountingDriver();
    {
      await using client = createClient({ schema, driver });
      expect(client.$schema).toBe(schema);
      expect(driver.closeCount).toBe(0);
    }
    expect(driver.closeCount).toBe(1);
  });

  test("a throw inside the block still closes the driver", async () => {
    const driver = new CountingDriver();
    const boom = new Error("inside the client block");

    await expect(
      (async () => {
        await using client = createClient({ schema, driver });
        expect(client.$schema).toBe(schema);
        throw boom;
      })()
    ).rejects.toBe(boom);

    expect(driver.closeCount).toBe(1);
  });

  test("disposal and $disconnect() are one close path, combinable in either order", async () => {
    const driver = new CountingDriver();
    {
      await using client = createClient({ schema, driver });
      await client.$disconnect();
      expect(driver.closeCount).toBe(1);
    }
    expect(driver.closeCount).toBe(1);

    const second = new CountingDriver();
    const client = createClient({ schema, driver: second });
    {
      await using disposable = client;
      expect(second.closeCount).toBe(0);
      expect(disposable.$schema).toBe(schema);
    }
    await expect(client.$disconnect()).resolves.toBeUndefined();
    expect(second.closeCount).toBe(1);
  });

  test("the disposal member IS the $disconnect function, not a second path", () => {
    if (ASYNC_DISPOSE === undefined) {
      throw new Error("this runtime has no Symbol.asyncDispose to probe");
    }
    const driver = new CountingDriver();
    const client = createClient({ schema, driver });
    expect(client[ASYNC_DISPOSE]).toBe(client.$disconnect);
  });
});

describe("await using — the boundary the scope decision drew", () => {
  test("the interactive tx client is NOT disposable", async () => {
    const disposeKey = ASYNC_DISPOSE;
    if (disposeKey === undefined) {
      throw new Error("this runtime has no Symbol.asyncDispose to probe");
    }
    const driver = new CountingDriver();
    const client = createClient({ schema, driver });

    const disposalMember = await client.$transaction((tx) =>
      Promise.resolve(Reflect.get(tx, disposeKey))
    );

    expect(disposalMember).toBeUndefined();
    expect(driver.closeCount).toBe(0);
  });

  test("a transaction-bound driver inherits the member but disposal is inert", async () => {
    const driver = new CountingDriver();

    await driver.withTransaction(async (tx) => {
      const txDriver: unknown = tx;
      if (!(txDriver instanceof Driver)) {
        throw new Error("expected a transaction-bound Driver");
      }
      {
        await using disposable = txDriver;
        expect(disposable).toBe(txDriver);
      }
      return Promise.resolve();
    });

    // The base connection is untouched: `$transaction` owns the tx driver's
    // lifetime, so disposing one must not close the connection underneath it.
    expect(driver.closeCount).toBe(0);
    await driver.disconnect();
    expect(driver.closeCount).toBe(1);
  });
});

describe("await using — the type surface", () => {
  type Extends<A, B> = A extends B ? true : false;
  type RootClient = ReturnType<
    typeof createClient<
      typeof schema,
      { schema: typeof schema; driver: CountingDriver }
    >
  >;

  test("the root client and the driver are AsyncDisposable; the tx client is not", () => {
    expectTypeOf<Extends<RootClient, AsyncDisposable>>().toEqualTypeOf<true>();
    expectTypeOf<
      Extends<CountingDriver, AsyncDisposable>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Extends<
        TransactionClient<{ schema: typeof schema; driver: CountingDriver }>,
        AsyncDisposable
      >
    >().toEqualTypeOf<false>();
  });
});
