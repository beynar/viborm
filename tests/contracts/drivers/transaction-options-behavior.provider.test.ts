/**
 * Provider integration proof for the honored half of the transaction-option matrix.
 *
 * `transaction-portability.test.ts` pins *what* each driver claims. This file
 * proves the claims that can be proved in-process: statement placement relative
 * to BEGIN, "honored by construction" meaning literally no SQL, timeouts that
 * roll back and leave a usable connection, and a bounded queue wait that never
 * opens a transaction at all. The two claims that need a real server —
 * PostgreSQL serialization conflicts and proof that MySQL's pre-BEGIN statement
 * really binds to the transaction that follows — are in
 * `tests/drivers/transaction-options-live.test.ts` behind the Docker gates.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clientUserPostSchema,
  sqliteUserPostSchema,
} from "@tests/fixtures/user-post-schema";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
const ISOLATION_SQL = /SET TRANSACTION ISOLATION LEVEL/i;
const SELECT_SQL = /select/i;
const ANY_LEVEL_SQL =
  /READ UNCOMMITTED|READ COMMITTED|REPEATABLE READ|SERIALIZABLE/;
const SAVEPOINT_REASON = /SAVEPOINT/;

/** Record every statement a driver sends, in order, for placement assertions. */
function recordStatements(driver: object): string[] {
  const statements: string[] = [];
  for (const method of ["execute", "executeRaw"] as const) {
    const original = Reflect.get(driver, method) as (
      ...args: unknown[]
    ) => unknown;
    Reflect.set(
      driver,
      method,
      function patched(this: unknown, ...args: unknown[]) {
        statements.push(String(args[1]));
        return Reflect.apply(original, this, args);
      }
    );
  }
  return statements;
}

describe("isolationLevel: post-begin placement (PostgreSQL family)", () => {
  test("PGlite emits the level as the first statement inside the transaction", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    const statements = recordStatements(driver);
    await client.$transaction(
      async (tx) => {
        await tx.user.findMany();
      },
      { isolationLevel: "Serializable" }
    );

    const isolationIndex = statements.findIndex((sql) =>
      ISOLATION_SQL.test(sql)
    );
    expect(isolationIndex).toBeGreaterThanOrEqual(0);
    expect(statements[isolationIndex]).toBe(
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
    );
    // Nothing the caller asked for may run before the level is applied:
    // PostgreSQL silently keeps the old level if a statement got there first.
    const firstUserStatement = statements.findIndex((sql) =>
      SELECT_SQL.test(sql)
    );
    expect(firstUserStatement).toBeGreaterThan(isolationIndex);
    await client.$disconnect();
  });

  test.each([
    "ReadUncommitted",
    "ReadCommitted",
    "RepeatableRead",
    "Serializable",
  ] as const)("PGlite accepts %s and spells it in SQL", async (level) => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    const statements = recordStatements(driver);
    await client.$transaction(async () => undefined, { isolationLevel: level });

    const emitted = statements.filter((sql) => ISOLATION_SQL.test(sql));
    expect(emitted).toHaveLength(1);
    // PostgreSQL accepts all four spellings; it maps ReadUncommitted onto
    // ReadCommitted itself, which is the server's documented behavior and not
    // something VibORM should paper over.
    expect(emitted[0]).toMatch(ANY_LEVEL_SQL);
    await client.$disconnect();
  });

  test("PGlite emits no isolation statement when no level is asked for", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    const statements = recordStatements(driver);
    await client.$transaction(async (tx) => {
      await tx.user.findMany();
    });

    expect(statements.filter((sql) => ISOLATION_SQL.test(sql))).toHaveLength(0);
    await client.$disconnect();
  });
});

describe("isolationLevel: serializable-only (SQLite family)", () => {
  let driver: SQLite3Driver;

  beforeEach(() => {
    driver = new SQLite3Driver({ dataDir: ":memory:" });
  });

  test("Serializable is honored by construction, with no statement emitted", async () => {
    const client = createClient({ schema: sqliteUserPostSchema, driver });
    await syncLiveSchema(client);

    const statements = recordStatements(driver);
    await client.$transaction(
      async (tx) => {
        await tx.user.findMany();
      },
      { isolationLevel: "Serializable" }
    );

    // SQLite has no isolation-level statement. Honoring Serializable means
    // emitting nothing, because a single-writer transaction already is one.
    expect(statements.filter((sql) => ISOLATION_SQL.test(sql))).toHaveLength(0);
    await client.$disconnect();
  });

  test.each([
    "ReadUncommitted",
    "ReadCommitted",
    "RepeatableRead",
  ] as const)("%s is refused rather than silently upgraded", async (level) => {
    const client = createClient({ schema: sqliteUserPostSchema, driver });
    await syncLiveSchema(client);
    const callback = vi.fn(async () => undefined);

    await expect(
      client.$transaction(callback, { isolationLevel: level })
    ).rejects.toMatchObject({
      code: "V8003",
      name: "UnsupportedOperationError",
    });
    expect(callback).not.toHaveBeenCalled();
    await client.$disconnect();
  });
});

describe("timeout: expiry rolls back and leaves the connection usable", () => {
  test("an over-running callback is rolled back with V5002 and writes nothing", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    // The body blocks until this test releases it, so "the callback outran its
    // timeout" is a fact rather than a race between two durations.
    let releaseBody: (() => void) | undefined;
    const bodyHeld = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    await expect(
      client.$transaction(
        async (tx) => {
          await tx.user.create({
            data: {
              id: "u-timeout",
              name: "timed out",
              email: "timeout@example.com",
            },
          });
          await bodyHeld;
        },
        { timeout: 25 }
      )
    ).rejects.toMatchObject({ code: "V5002" });
    releaseBody?.();

    // Post-probe 1: the write inside the expired transaction is gone.
    const survivors = await client.user.findMany({
      where: { email: "timeout@example.com" },
    });
    expect(survivors).toHaveLength(0);

    // Post-probe 2: the connection was released cleanly, not poisoned — the
    // next transaction on the same driver commits normally.
    await client.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "u-after", name: "after", email: "after@example.com" },
      });
    });
    const after = await client.user.findMany({
      where: { email: "after@example.com" },
    });
    expect(after).toHaveLength(1);
    await client.$disconnect();
  });

  test("a callback that finishes inside its timeout commits normally", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    await client.$transaction(
      async (tx) => {
        await tx.user.create({
          data: { id: "u-fast", name: "fast", email: "fast@example.com" },
        });
      },
      { timeout: 5000 }
    );

    expect(
      await client.user.findMany({ where: { email: "fast@example.com" } })
    ).toHaveLength(1);
    await client.$disconnect();
  });
});

describe("maxWait: the serialized queue wait is bounded", () => {
  test("a transaction that outwaits maxWait never opens", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema: sqliteUserPostSchema, driver });
    await syncLiveSchema(client);

    let releaseHolder: (() => void) | undefined;
    const held = new Promise<void>((release) => {
      releaseHolder = release;
    });
    const waiter = vi.fn(async () => undefined);

    // Both transactions must enter the connection queue in the same tick: that
    // is the window in which a single-connection driver queues rather than
    // fails closed, and the queue wait is exactly what maxWait bounds.
    const holder = client.$transaction(async () => {
      await held;
    });
    const waiting = client.$transaction(waiter, { maxWait: 20 });

    await expect(waiting).rejects.toMatchObject({ code: "V5002" });
    // A bounded-out transaction never reaches BEGIN, so there is nothing to
    // roll back — the callback must not have been entered at all.
    expect(waiter).not.toHaveBeenCalled();

    releaseHolder?.();
    await holder;
    await client.$disconnect();
  });

  test("a transaction that gets its slot in time runs normally", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema: sqliteUserPostSchema, driver });
    await syncLiveSchema(client);

    await client.$transaction(
      async (tx) => {
        await tx.user.create({
          data: { id: "u-queued", name: "queued", email: "queued@example.com" },
        });
      },
      { maxWait: 5000 }
    );

    expect(
      await client.user.findMany({ where: { email: "queued@example.com" } })
    ).toHaveLength(1);
    await client.$disconnect();
  });
});

describe("nested $transaction: the savepoint option contract", () => {
  /**
   * The transaction client's runtime proxy serves `$transaction`, but the
   * `Client<C>` type does not declare it — a pre-existing type/runtime gap that
   * predates this lane and is not W5-U3's to close. Reach it through a narrow
   * local type rather than pretending the surface is typed.
   */
  type NestedTransactionClient = {
    $transaction: <T>(
      fn: (nested: never) => Promise<T>,
      options?: {
        isolationLevel?: string;
        timeout?: number;
        maxWait?: number;
      }
    ) => Promise<T>;
  };
  const nestedOf = (tx: unknown) => tx as unknown as NestedTransactionClient;

  test("a nested isolationLevel is refused, naming the savepoint reason", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    await client.$transaction(async (tx) => {
      const nested = vi.fn(async () => undefined);
      await expect(
        nestedOf(tx).$transaction(nested, { isolationLevel: "Serializable" })
      ).rejects.toMatchObject({
        code: "V8003",
        name: "UnsupportedOperationError",
      });
      await expect(
        nestedOf(tx).$transaction(nested, { isolationLevel: "Serializable" })
      ).rejects.toThrow(SAVEPOINT_REASON);
      expect(nested).not.toHaveBeenCalled();
    });
    await client.$disconnect();
  });

  test("a nested maxWait is refused: there is no slot to wait for", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    await client.$transaction(async (tx) => {
      await expect(
        nestedOf(tx).$transaction(async () => undefined, { maxWait: 50 })
      ).rejects.toMatchObject({ code: "V8003" });
    });
    await client.$disconnect();
  });

  test("a nested timeout is honored and rolls back to the savepoint", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    let releaseNested: (() => void) | undefined;
    const nestedHeld = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });

    await client.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "u-outer", name: "outer", email: "outer@example.com" },
      });
      await expect(
        nestedOf(tx).$transaction(
          async (nested: {
            user: { create: (args: unknown) => Promise<unknown> };
          }) => {
            await nested.user.create({
              data: {
                id: "u-inner",
                name: "inner",
                email: "inner@example.com",
              },
            });
            // Held, not slept: the savepoint expires because the body has not
            // finished, which is the contract, not because 200ms beat 25ms.
            await nestedHeld;
          },
          { timeout: 25 }
        )
      ).rejects.toMatchObject({ code: "V5002" });
      releaseNested?.();
    });

    // The savepoint rolled back; the outer transaction still committed.
    expect(
      await client.user.findMany({ where: { email: "inner@example.com" } })
    ).toHaveLength(0);
    expect(
      await client.user.findMany({ where: { email: "outer@example.com" } })
    ).toHaveLength(1);
    await client.$disconnect();
  });
});

describe("the array form carries isolationLevel into its transaction", () => {
  test("PGlite applies the level to the transaction the batch runs inside", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: clientUserPostSchema, driver });
    await syncLiveSchema(client);

    const statements = recordStatements(driver);
    await client.$transaction([client.user.findMany(), client.user.count()], {
      isolationLevel: "Serializable",
    });

    expect(statements.filter((sql) => ISOLATION_SQL.test(sql))).toEqual([
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    ]);
    await client.$disconnect();
  });

  test("an empty array still refuses an option the driver could not honor", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema: sqliteUserPostSchema, driver });
    await syncLiveSchema(client);

    // The empty-array fast path returns before any driver call. It must still
    // refuse, or the option would have been accepted and ignored.
    await expect(
      client.$transaction([], { isolationLevel: "ReadCommitted" })
    ).rejects.toMatchObject({ code: "V8003" });
    await expect(client.$transaction([])).resolves.toEqual([]);
    await client.$disconnect();
  });
});
