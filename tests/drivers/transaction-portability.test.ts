/**
 * The transaction-option contract, one pinned cell per driver per option.
 *
 * This file replaces the previous "every driver rejects every option" pins.
 * Decision D-2 reversed that doctrine: `$transaction` now accepts Prisma's
 * `{ isolationLevel, timeout, maxWait }` and each driver either honors an
 * option or refuses it with a typed, reasoned error. Nothing is ignored, so
 * every cell below is either "honored, and here is the mechanism" or "refused,
 * and here is the message".
 *
 * Behavioral proof of the honored cells lives next door: mechanism-level proof
 * (statement placement, queue bound, timeout rollback) in
 * `transaction-options-behavior.test.ts`, and live-database proof (PostgreSQL
 * serialization conflicts, the MySQL dirty-read probe) in
 * `transaction-options-live.test.ts` behind the Docker gates.
 */

import { BunSQLDriver } from "@drivers/bun-sql";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { LibSQLDriver } from "@drivers/libsql";
import { MySQL2Driver } from "@drivers/mysql2";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { PostgresDriver } from "@drivers/postgres";
import type {
  IsolationLevelPlacement,
  MaxWaitSupport,
  TransactionIsolationLevel,
  TransactionOptionSupport,
} from "@drivers/shared/transaction-options";
import { SQLite3Driver } from "@drivers/sqlite3";
import { describe, expect, test, vi } from "vitest";

interface DriverContract {
  readonly name: string;
  readonly create: () => object;
  /** Where this driver emits the isolation level, if it can emit one. */
  readonly isolationLevel: IsolationLevelPlacement;
  /** Whether the interactive callback can be raced out and rolled back. */
  readonly timeout: boolean;
  /** Which wait, if any, this driver can bound before the body starts. */
  readonly maxWait: MaxWaitSupport;
}

/**
 * THE MATRIX. Every advertised driver, every option, no silent cells.
 *
 * libSQL appears twice on purpose: its `maxWait` mechanism is decided by the
 * database URL (in-memory serializes through the connection queue, everything
 * else awaits `client.transaction("write")`), and both halves are pinned.
 */
const DRIVER_CONTRACTS: readonly DriverContract[] = [
  {
    name: "pg",
    create: () => new PgDriver(),
    isolationLevel: "post-begin",
    timeout: true,
    maxWait: "acquisition",
  },
  {
    name: "postgres.js",
    create: () => new PostgresDriver(),
    isolationLevel: "post-begin",
    timeout: true,
    maxWait: "unsupported",
  },
  {
    name: "PGlite",
    create: () => new PGliteDriver(),
    isolationLevel: "post-begin",
    timeout: true,
    maxWait: "queue",
  },
  {
    name: "Bun SQL",
    create: () => new BunSQLDriver(),
    isolationLevel: "post-begin",
    timeout: true,
    maxWait: "unsupported",
  },
  {
    name: "mysql2",
    create: () => new MySQL2Driver(),
    isolationLevel: "pre-begin",
    timeout: true,
    maxWait: "acquisition",
  },
  {
    name: "PlanetScale",
    create: () => new PlanetScaleDriver(),
    isolationLevel: "pre-begin",
    timeout: true,
    maxWait: "unsupported",
  },
  {
    name: "SQLite3",
    create: () => new SQLite3Driver(),
    isolationLevel: "serializable-only",
    timeout: true,
    maxWait: "queue",
  },
  {
    name: "Bun SQLite",
    create: () => new BunSQLiteDriver(),
    isolationLevel: "serializable-only",
    timeout: true,
    maxWait: "queue",
  },
  {
    name: "libSQL (in-memory)",
    create: () => new LibSQLDriver(),
    isolationLevel: "serializable-only",
    timeout: true,
    maxWait: "queue",
  },
  {
    name: "libSQL (remote)",
    create: () => new LibSQLDriver({ databaseUrl: "libsql://example.invalid" }),
    isolationLevel: "serializable-only",
    timeout: true,
    maxWait: "acquisition",
  },
  {
    name: "D1 binding",
    create: () => Reflect.construct(D1Driver, [{ database: {} }]),
    isolationLevel: "unsupported",
    timeout: false,
    maxWait: "unsupported",
  },
  {
    name: "Neon HTTP",
    create: () => new NeonHTTPDriver(),
    isolationLevel: "unsupported",
    timeout: false,
    maxWait: "unsupported",
  },
];

const readSupport = (driver: object): TransactionOptionSupport =>
  Reflect.apply(
    Reflect.get(driver, "transactionOptionSupport"),
    driver,
    []
  ) as TransactionOptionSupport;

interface StubbedDriver {
  readonly driver: object;
  readonly callback: ReturnType<typeof vi.fn>;
  readonly initClient: ReturnType<typeof vi.fn>;
  readonly providerTransaction: ReturnType<typeof vi.fn>;
  readonly providerBatch: ReturnType<typeof vi.fn>;
  /** Everything a refusal must NOT have touched, as call counts. */
  dispatchCounts(): Record<string, number>;
}

const NO_DISPATCH = {
  callback: 0,
  initClient: 0,
  transaction: 0,
  executeBatch: 0,
} as const;

function stubDriver(create: () => object): StubbedDriver {
  const driver = create();
  const callback = vi.fn(async () => undefined);
  const initClient = vi.fn(async () => ({}));
  const providerTransaction = vi.fn(async () => undefined);
  const providerBatch = vi.fn(async () => []);
  Reflect.set(driver, "initClient", initClient);
  Reflect.set(driver, "transaction", providerTransaction);
  Reflect.set(driver, "executeBatch", providerBatch);
  return {
    driver,
    callback,
    initClient,
    providerTransaction,
    providerBatch,
    dispatchCounts: () => ({
      callback: callback.mock.calls.length,
      initClient: initClient.mock.calls.length,
      transaction: providerTransaction.mock.calls.length,
      executeBatch: providerBatch.mock.calls.length,
    }),
  };
}

const callTransaction = (stub: StubbedDriver, options: unknown) =>
  Reflect.apply(Reflect.get(stub.driver, "_transaction"), stub.driver, [
    stub.callback,
    options,
  ]) as Promise<unknown>;

const callBatch = (stub: StubbedDriver, options: unknown) =>
  Reflect.apply(Reflect.get(stub.driver, "_executeBatch"), stub.driver, [
    [{ sql: "SELECT 1", params: [] }],
    options,
  ]) as Promise<unknown>;

const ALL_LEVELS: readonly TransactionIsolationLevel[] = [
  "ReadUncommitted",
  "ReadCommitted",
  "RepeatableRead",
  "Serializable",
];

describe("transaction option contract: the declaration matrix", () => {
  test.each(
    DRIVER_CONTRACTS
  )("$name declares isolationLevel=$isolationLevel timeout=$timeout maxWait=$maxWait", ({
    create,
    isolationLevel,
    timeout,
    maxWait,
  }) => {
    const support = readSupport(create());
    expect(support.isolationLevel).toBe(isolationLevel);
    expect(support.timeout).toBe(timeout);
    expect(support.maxWait).toBe(maxWait);
  });

  test.each(
    DRIVER_CONTRACTS
  )("$name gives a reason for every option it cannot fully honor", ({
    create,
  }) => {
    const support = readSupport(create());
    // A refusal without a reason is the accept-and-ignore failure mode wearing
    // an error's clothes: the caller learns "no" but never learns why.
    // `post-begin` and `pre-begin` honor all four levels and owe no reason.
    const refusesSomeLevel =
      support.isolationLevel === "serializable-only" ||
      support.isolationLevel === "unsupported";
    if (refusesSomeLevel) {
      expect(support.isolationLevelReason).toBeTruthy();
    }
    if (!support.timeout) expect(support.timeoutReason).toBeTruthy();
    if (support.maxWait === "unsupported") {
      expect(support.maxWaitReason).toBeTruthy();
    }
  });

  test("the matrix covers every advertised driver", () => {
    // The pre-D-2 file pinned 11 drivers; libSQL now contributes two rows
    // because its maxWait mechanism depends on the database URL.
    expect(DRIVER_CONTRACTS).toHaveLength(12);
    expect(new Set(DRIVER_CONTRACTS.map((row) => row.name)).size).toBe(12);
  });
});

describe("transaction option contract: refusals are typed and pre-dispatch", () => {
  const refusedLevels = DRIVER_CONTRACTS.flatMap((contract) => {
    if (contract.isolationLevel === "unsupported") {
      return ALL_LEVELS.map((level) => ({ ...contract, level }));
    }
    if (contract.isolationLevel === "serializable-only") {
      return ALL_LEVELS.filter((level) => level !== "Serializable").map(
        (level) => ({ ...contract, level })
      );
    }
    return [];
  });

  test.each(
    refusedLevels
  )("$name refuses isolationLevel $level with V8003 and a reason", async ({
    create,
    level,
  }) => {
    const stub = stubDriver(create);
    const expectedReason = readSupport(stub.driver).isolationLevelReason;
    await expect(
      callTransaction(stub, { isolationLevel: level })
    ).rejects.toMatchObject({
      code: "V8003",
      name: "UnsupportedOperationError",
    });
    await expect(
      callTransaction(stub, { isolationLevel: level })
    ).rejects.toThrow(String(expectedReason));
    expect(stub.dispatchCounts()).toEqual(NO_DISPATCH);
  });

  test.each(
    DRIVER_CONTRACTS.filter((contract) => !contract.timeout)
  )("$name refuses timeout with V8003 and a reason", async ({ create }) => {
    const stub = stubDriver(create);
    const expectedReason = readSupport(stub.driver).timeoutReason;
    await expect(callTransaction(stub, { timeout: 50 })).rejects.toMatchObject({
      code: "V8003",
      name: "UnsupportedOperationError",
    });
    await expect(callTransaction(stub, { timeout: 50 })).rejects.toThrow(
      String(expectedReason)
    );
    expect(stub.dispatchCounts()).toEqual(NO_DISPATCH);
  });

  test.each(
    DRIVER_CONTRACTS.filter((contract) => contract.maxWait === "unsupported")
  )("$name refuses maxWait with V8003 and a reason", async ({ create }) => {
    const stub = stubDriver(create);
    const expectedReason = readSupport(stub.driver).maxWaitReason;
    await expect(callTransaction(stub, { maxWait: 50 })).rejects.toMatchObject({
      code: "V8003",
      name: "UnsupportedOperationError",
    });
    await expect(callTransaction(stub, { maxWait: 50 })).rejects.toThrow(
      String(expectedReason)
    );
    expect(stub.dispatchCounts()).toEqual(NO_DISPATCH);
  });

  test.each(
    DRIVER_CONTRACTS
  )("$name refuses timeout and maxWait on the array form, on every driver", async ({
    create,
  }) => {
    // Prisma's sequential API accepts isolationLevel only. An array of
    // preplanned operations has no interactive window to bound, so both
    // duration options are refused here even where the callback form honors
    // them — a caller who asks must not be told "fine" and then ignored.
    const stub = stubDriver(create);
    await expect(callBatch(stub, { timeout: 50 })).rejects.toMatchObject({
      code: "V5005",
    });
    await expect(callBatch(stub, { maxWait: 50 })).rejects.toMatchObject({
      code: "V5005",
    });
    await expect(callBatch(stub, { timeout: 50 })).rejects.toThrow(
      "$transaction([...])"
    );
    expect(stub.dispatchCounts()).toEqual(NO_DISPATCH);
  });

  test.each(
    DRIVER_CONTRACTS.filter(
      (contract) => contract.isolationLevel === "unsupported"
    )
  )("$name refuses isolationLevel on the array form too", async ({
    create,
  }) => {
    const stub = stubDriver(create);
    await expect(
      callBatch(stub, { isolationLevel: "Serializable" })
    ).rejects.toMatchObject({ code: "V8003" });
    expect(stub.dispatchCounts()).toEqual(NO_DISPATCH);
  });
});

describe("transaction option contract: malformed options are V5005", () => {
  const malformed: readonly { label: string; options: unknown }[] = [
    { label: "a non-object", options: 5 },
    { label: "an array", options: [] },
    { label: "an unknown key", options: { isolation: "Serializable" } },
    { label: "an unknown level", options: { isolationLevel: "serializable" } },
    { label: "a zero timeout", options: { timeout: 0 } },
    { label: "a negative maxWait", options: { maxWait: -1 } },
    { label: "a non-numeric timeout", options: { timeout: "5s" } },
    {
      label: "an infinite timeout",
      options: { timeout: Number.POSITIVE_INFINITY },
    },
  ];

  test.each(malformed)("every driver rejects $label before dispatch", async ({
    options,
  }) => {
    for (const contract of DRIVER_CONTRACTS) {
      const stub = stubDriver(contract.create);
      await expect(callTransaction(stub, options)).rejects.toMatchObject({
        code: "V5005",
        name: "TransactionError",
      });
      expect(stub.dispatchCounts()).toEqual(NO_DISPATCH);
    }
  });

  test.each(
    DRIVER_CONTRACTS
  )("$name still accepts an absent options argument", async ({ create }) => {
    const stub = stubDriver(create);
    await expect(
      Reflect.apply(Reflect.get(stub.driver, "_executeBatch"), stub.driver, [
        [],
      ])
    ).resolves.toEqual([]);
    expect(stub.initClient).not.toHaveBeenCalled();
    expect(stub.providerBatch).not.toHaveBeenCalled();
  });
});

describe("transaction entry conformance preserved from the no-options era", () => {
  test.each(
    DRIVER_CONTRACTS
  )("$name accepts an empty batch without opening a provider", async ({
    create,
  }) => {
    const stub = stubDriver(create);
    await expect(
      Reflect.apply(Reflect.get(stub.driver, "_executeBatch"), stub.driver, [
        [],
      ])
    ).resolves.toEqual([]);
    expect(stub.dispatchCounts()).toEqual(NO_DISPATCH);
  });

  test.each([
    {
      name: "D1 binding",
      create: () => Reflect.construct(D1Driver, [{ database: {} }]),
    },
    { name: "Neon HTTP", create: () => new NeonHTTPDriver() },
  ])("$name protected callback fallback fails closed", async ({ create }) => {
    const driver = create();
    const callback = vi.fn(async () => undefined);

    await expect(
      Reflect.apply(Reflect.get(driver, "transaction"), driver, [{}, callback])
    ).rejects.toMatchObject({ name: "TransactionError" });
    expect(callback).not.toHaveBeenCalled();
  });
});
