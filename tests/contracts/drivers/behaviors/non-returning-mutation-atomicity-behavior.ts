import { defineContract } from "@tests/contracts/contract";
import { createClient } from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { MySQL2Driver } from "@drivers/mysql2";
import type { QueryResult } from "@drivers/types";
import { NotFoundError } from "@errors";
import { push } from "@migrations";
import type { Pool, PoolConnection } from "mysql2/promise";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface StatementEvent {
  readonly client: Pool | PoolConnection;
  readonly statement: string;
}

type StatementHook = (event: StatementEvent) => void | Promise<void>;

class HookedMySQL2Driver extends MySQL2Driver {
  readonly providerClients: Array<Pool | PoolConnection> = [];
  readonly statements: string[] = [];
  private readonly beforeStatement: StatementHook | undefined;
  private readonly afterStatement: StatementHook | undefined;

  constructor(
    databaseUrl: string,
    hooks: {
      beforeStatement?: StatementHook;
      afterStatement?: StatementHook;
    } = {}
  ) {
    super({ databaseUrl });
    this.beforeStatement = hooks.beforeStatement;
    this.afterStatement = hooks.afterStatement;
  }

  protected override async execute<T>(
    client: Pool | PoolConnection,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const event = { client, statement };
    this.providerClients.push(client);
    this.statements.push(statement);
    await this.beforeStatement?.(event);
    const result = await super.execute<T>(client, statement, params, context);
    await this.afterStatement?.(event);
    return result;
  }
}

const item = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("atomic_mysql_items");

const autoItem = s
  .model({
    id: s.int().id().increment(),
    token: s.string().unique(),
    name: s.string(),
  })
  .map("atomic_mysql_auto_items");

const schema = { item, autoItem };

function createAtomicClient(driver: MySQL2Driver) {
  return createClient({ schema, driver });
}

type AtomicMySQLClient = ReturnType<typeof createAtomicClient>;

export function runNonReturningMutationAtomicityBehavior(
  databaseUrl: string
): void {
  describe("mysql2 atomic non-returning mutation interleavings", () => {
    const clients: AtomicMySQLClient[] = [];

    function boot(driver: MySQL2Driver) {
      const client = createAtomicClient(driver);
      clients.push(client);
      return client;
    }

    function createDriver(
      hooks: ConstructorParameters<typeof HookedMySQL2Driver>[1] = {}
    ): HookedMySQL2Driver {
      return new HookedMySQL2Driver(databaseUrl, hooks);
    }

    beforeEach(async () => {
      const setup = boot(createDriver());
      await push(setup, { force: true });
    });

    afterEach(async () => {
      for (const client of clients.splice(0)) {
        await client.$disconnect();
      }
    });

    test(
      "competing updates return their own writes while sharing one connection per operation",
      { timeout: 30_000 },
      async () => {
        const seeder = clients[0]!;
        await seeder.item.create({
          data: { id: "update", email: "update@test.com", name: "before" },
        });

        const firstUpdated = createDeferred();
        const releaseFirst = createDeferred();
        const secondLockAttempted = createDeferred();
        const firstDriver = createDriver({
          afterStatement: async ({ statement }) => {
            if (!isItemUpdate(statement)) return;
            firstUpdated.resolve();
            await releaseFirst.promise;
          },
        });
        const secondDriver = createDriver({
          beforeStatement: ({ statement }) => {
            if (isItemLock(statement)) secondLockAttempted.resolve();
          },
        });
        const first = boot(firstDriver);
        const second = boot(secondDriver);

        const firstPromise = Promise.resolve(
          first.item.update({
            where: { email: "update@test.com" },
            data: { name: "first" },
          })
        );
        await firstUpdated.promise;
        const secondPromise = Promise.resolve(
          second.item.update({
            where: { email: "update@test.com" },
            data: { name: "second" },
          })
        );
        await secondLockAttempted.promise;
        releaseFirst.resolve();

        const [firstResult, secondResult] = await Promise.all([
          firstPromise,
          secondPromise,
        ]);
        expect(firstResult.name).toBe("first");
        expect(secondResult.name).toBe("second");
        assertConnectionAffinity(firstDriver);
        assertConnectionAffinity(secondDriver);
        assertDifferentConnections(firstDriver, secondDriver);
      }
    );

    test(
      "a replacement row survives a delete that locked and deleted the captured PK",
      { timeout: 30_000 },
      async () => {
        const seeder = clients[0]!;
        await seeder.item.create({
          data: { id: "old", email: "replace@test.com", name: "old" },
        });

        const firstReadReturned = createDeferred();
        const releaseDelete = createDeferred();
        const replacementDeleteAttempted = createDeferred();
        let heldFirstRead = false;
        const deletingDriver = createDriver({
          afterStatement: async ({ statement }) => {
            if (heldFirstRead || !isItemSelect(statement)) return;
            heldFirstRead = true;
            firstReadReturned.resolve();
            await releaseDelete.promise;
          },
        });
        const replacingDriver = createDriver({
          beforeStatement: ({ statement }) => {
            if (isItemSelect(statement)) replacementDeleteAttempted.resolve();
          },
        });
        const deleting = boot(deletingDriver);
        const replacing = boot(replacingDriver);

        const deletePromise = Promise.resolve(
          deleting.item.delete({
            where: { email: "replace@test.com" },
          })
        );
        await firstReadReturned.promise;
        const replacePromise = (async () => {
          try {
            await replacing.item.delete({ where: { id: "old" } });
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
          }
          return replacing.item.create({
            data: {
              id: "replacement",
              email: "replace@test.com",
              name: "replacement",
            },
          });
        })();
        await replacementDeleteAttempted.promise;
        releaseDelete.resolve();

        await expect(deletePromise).resolves.toMatchObject({ id: "old" });
        await expect(replacePromise).resolves.toMatchObject({
          id: "replacement",
        });
        await expect(
          replacing.item.findUnique({ where: { email: "replace@test.com" } })
        ).resolves.toMatchObject({ id: "replacement" });
        expect(deletingDriver.statements.some(isItemLock)).toBe(true);
        assertConnectionAffinity(deletingDriver);
        assertDifferentConnections(deletingDriver, replacingDriver);
      }
    );

    test(
      "interleaved auto-increment creates refetch their own inserted identities",
      { timeout: 30_000 },
      async () => {
        const firstInserted = createDeferred();
        const releaseFirst = createDeferred();
        const firstDriver = createDriver({
          afterStatement: async ({ statement }) => {
            if (!isAutoItemInsert(statement)) return;
            firstInserted.resolve();
            await releaseFirst.promise;
          },
        });
        const secondDriver = createDriver();
        const first = boot(firstDriver);
        const second = boot(secondDriver);

        const firstPromise = Promise.resolve(
          first.autoItem.create({
            data: { token: "first", name: "first" },
          })
        );
        await firstInserted.promise;
        const secondResult = await second.autoItem.create({
          data: { token: "second", name: "second" },
        });
        releaseFirst.resolve();
        const firstResult = await firstPromise;

        expect(firstResult.token).toBe("first");
        expect(secondResult.token).toBe("second");
        expect(firstResult.id).not.toBe(secondResult.id);
        assertConnectionAffinity(firstDriver);
        assertConnectionAffinity(secondDriver);
        assertDifferentConnections(firstDriver, secondDriver);
      }
    );

    test(
      "competing upserts identify their branches and refetch their own updates",
      { timeout: 30_000 },
      async () => {
        const seeder = clients[0]!;
        await seeder.item.create({
          data: { id: "upsert", email: "upsert@test.com", name: "before" },
        });

        const firstMutated = createDeferred();
        const releaseFirst = createDeferred();
        const secondLockAttempted = createDeferred();
        const firstDriver = createDriver({
          afterStatement: async ({ statement }) => {
            if (!(isItemUpdate(statement) || isNativeUpsert(statement))) return;
            firstMutated.resolve();
            await releaseFirst.promise;
          },
        });
        const secondDriver = createDriver({
          beforeStatement: ({ statement }) => {
            if (isItemLock(statement)) secondLockAttempted.resolve();
          },
        });
        const first = boot(firstDriver);
        const second = boot(secondDriver);
        const upsert = (target: typeof first, id: string, name: string) =>
          target.item.upsert({
            where: { email: "upsert@test.com" },
            create: { id, email: "upsert@test.com", name },
            update: { name },
          });

        const firstPromise = Promise.resolve(
          upsert(first, "unused-first", "first")
        );
        await firstMutated.promise;
        const secondPromise = Promise.resolve(
          upsert(second, "unused-second", "second")
        );
        await secondLockAttempted.promise;
        releaseFirst.resolve();

        const [firstResult, secondResult] = await Promise.all([
          firstPromise,
          secondPromise,
        ]);
        expect(firstResult).toMatchObject({ id: "upsert", name: "first" });
        expect(secondResult).toMatchObject({ id: "upsert", name: "second" });
        expect(firstDriver.statements.some(isNativeUpsert)).toBe(false);
        expect(secondDriver.statements.some(isNativeUpsert)).toBe(false);
        assertConnectionAffinity(firstDriver);
        assertConnectionAffinity(secondDriver);
        assertDifferentConnections(firstDriver, secondDriver);
      }
    );
  });
}

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error("Deferred resolver is unavailable");
      resolvePromise();
    },
  };
}

function assertConnectionAffinity(driver: HookedMySQL2Driver): void {
  expect(driver.providerClients.length).toBeGreaterThan(1);
  expect(new Set(driver.providerClients).size).toBe(1);
  expect(driver.providerClients.every(isPoolConnection)).toBe(true);
}

function assertDifferentConnections(
  first: HookedMySQL2Driver,
  second: HookedMySQL2Driver
): void {
  expect(first.providerClients[0]).toBeDefined();
  expect(second.providerClients[0]).toBeDefined();
  expect(first.providerClients[0]).not.toBe(second.providerClients[0]);
}

function isPoolConnection(
  client: Pool | PoolConnection
): client is PoolConnection {
  return "release" in client && typeof client.release === "function";
}

function isItemSelect(statement: string): boolean {
  return (
    /^SELECT\b/i.test(statement) && statement.includes("atomic_mysql_items")
  );
}

function isItemLock(statement: string): boolean {
  return isItemSelect(statement) && /FOR UPDATE/i.test(statement);
}

function isItemUpdate(statement: string): boolean {
  return /^UPDATE `atomic_mysql_items`/i.test(statement);
}

function isAutoItemInsert(statement: string): boolean {
  return /^INSERT INTO `atomic_mysql_auto_items`/i.test(statement);
}

function isNativeUpsert(statement: string): boolean {
  return /INSERT INTO `atomic_mysql_items`[\s\S]*ON DUPLICATE KEY UPDATE/i.test(
    statement
  );
}

export const nonReturningMutationAtomicityContract = defineContract({
  id: "drivers.non-returning-mutation-atomicity",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runNonReturningMutationAtomicityBehavior,
});
