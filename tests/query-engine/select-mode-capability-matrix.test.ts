import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { TransactionError } from "@errors";
import { push } from "@migrations";
import { describe, expect, test, vi } from "vitest";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

class BothCapabilitiesDriver extends PGliteDriver {
  override readonly supportsTransactions = true;
  override readonly supportsBatch = true;
}

class BatchOnlyDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

class NoAtomicDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

type AtomicOperation = "create" | "update" | "upsert";

const ATOMIC_OPERATIONS: readonly AtomicOperation[] = [
  "create",
  "update",
  "upsert",
];

async function setupDb(): Promise<PGlite> {
  const db = new PGlite();
  const client = createClient({
    schema: nestedWriteBehaviorSchema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(client, { force: true });
  return db;
}

function nestedCreate(driver: PGliteDriver, suffix: string) {
  const client = createClient({ schema: nestedWriteBehaviorSchema, driver });
  return {
    client,
    operation: client.user.create({
      data: {
        id: `user-${suffix}`,
        name: "Owner",
        posts: {
          create: { id: `post-${suffix}`, title: "Nested" },
        },
      },
    }),
  };
}

function unsupportedOperation(
  driver: NoAtomicDriver,
  operation: AtomicOperation
): PromiseLike<unknown> {
  const client = createClient({ schema: nestedWriteBehaviorSchema, driver });
  switch (operation) {
    case "create":
      return client.user.create({
        data: {
          id: "u-create",
          name: "Owner",
          posts: { create: { id: "p-create", title: "Nested" } },
        },
      });
    case "update":
      return client.user.update({
        where: { id: "u-update" },
        data: {
          posts: { create: { id: "p-update", title: "Nested" } },
        },
      });
    case "upsert":
      return client.user.upsert({
        where: { id: "u-upsert" },
        create: {
          id: "u-upsert",
          name: "Owner",
          posts: { create: { id: "p-upsert", title: "Nested" } },
        },
        update: { name: "Updated" },
      });
    default:
      throw new Error(`Unknown atomic operation '${operation}'.`);
  }
}

describe("operation executor capability matrix", () => {
  test(
    "transaction driver executes an operation program in one transaction",
    { timeout: 30_000 },
    async () => {
      const db = await setupDb();
      const driver = new PGliteDriver({ client: db });
      const transactionSpy = vi.spyOn(driver, "withTransaction");
      const batchSpy = vi.spyOn(driver, "_executeBatch");
      const { client, operation } = nestedCreate(driver, "transaction");

      await operation;

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).not.toHaveBeenCalled();
      await client.$disconnect();
    }
  );

  test(
    "driver supporting both capabilities prefers transaction execution",
    { timeout: 30_000 },
    async () => {
      const db = await setupDb();
      const driver = new BothCapabilitiesDriver({ client: db });
      const transactionSpy = vi.spyOn(driver, "withTransaction");
      const batchSpy = vi.spyOn(driver, "_executeBatch");
      const { client, operation } = nestedCreate(driver, "both");

      await operation;

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).not.toHaveBeenCalled();
      await client.$disconnect();
    }
  );

  test(
    "batch-only driver executes the same operation program in one atomic batch",
    { timeout: 30_000 },
    async () => {
      const db = await setupDb();
      const driver = new BatchOnlyDriver({ client: db });
      const transactionSpy = vi.spyOn(driver, "withTransaction");
      const batchSpy = vi.spyOn(driver, "_executeBatch");
      const { client, operation } = nestedCreate(driver, "batch");

      await operation;

      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy).not.toHaveBeenCalled();
      await client.$disconnect();
    }
  );

  describe("driver with neither atomic capability fails closed", () => {
    for (const operationName of ATOMIC_OPERATIONS) {
      test(`operation '${operationName}'`, async () => {
        const driver = new NoAtomicDriver();

        let thrown: unknown;
        try {
          await unsupportedOperation(driver, operationName);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(TransactionError);
        if (!(thrown instanceof TransactionError)) {
          throw new Error("expected a TransactionError");
        }
        expect(thrown.message).toBe(
          `Driver '${driver.driverName}' supports neither transactions nor atomic batch execution.`
        );
        expect(thrown.meta.driver).toBe(driver.driverName);
        expect(thrown.meta.operation).toBe(operationName);
      });
    }
  });
});
