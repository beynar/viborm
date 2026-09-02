import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { describe, expect, test, vi } from "vitest";

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

/**
 * The suite's private schema on the worker-shared PGlite. Every driver built
 * over `family.database` must carry `family.namespace`, or it addresses an empty
 * `public`.
 */
const getFamily = usePGliteSchemaFamily(nestedWriteBehaviorSchema);

/**
 * The multi-statement sample these tests select a substrate for.
 *
 * RETARGETED DELIBERATELY (query-performance-plan Phase 8.2). A bare nested
 * create tree with literal keys is no longer multi-statement on PostgreSQL: it
 * folds into one `WITH`-chained command and runs statement-atomically, with no
 * transaction and no batch — which is what the fold is FOR, and what its own
 * witnesses pin. The `include` is what keeps this payload multi-statement, for a
 * reason these tests are indifferent to: the sibling arms' effects are invisible
 * to the outer SELECT of one command, so a relation projection keeps the
 * separate terminal read. The subject here is unchanged — a create tree that
 * needs several statements needs an atomic substrate.
 */
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
      include: { posts: true },
    }),
  };
}

describe("operation executor capability matrix", () => {
  test(
    "transaction driver executes an operation program in one transaction",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      const driver = new PGliteDriver({
        client: family.database,
        namespace: family.namespace,
      });
      const transactionSpy = vi.spyOn(driver, "withTransaction");
      const batchSpy = vi.spyOn(driver, "_executeBatch");
      const { operation } = nestedCreate(driver, "transaction");

      await operation;

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).not.toHaveBeenCalled();
    }
  );

  test(
    "driver supporting both capabilities prefers transaction execution",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      const driver = new BothCapabilitiesDriver({
        client: family.database,
        namespace: family.namespace,
      });
      const transactionSpy = vi.spyOn(driver, "withTransaction");
      const batchSpy = vi.spyOn(driver, "_executeBatch");
      const { operation } = nestedCreate(driver, "both");

      await operation;

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).not.toHaveBeenCalled();
    }
  );

  test(
    "batch-only driver executes the same operation program in one atomic batch",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      const driver = new BatchOnlyDriver({
        client: family.database,
        namespace: family.namespace,
      });
      const transactionSpy = vi.spyOn(driver, "withTransaction");
      const batchSpy = vi.spyOn(driver, "_executeBatch");
      const { operation } = nestedCreate(driver, "batch");

      await operation;

      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy).not.toHaveBeenCalled();
    }
  );
});
