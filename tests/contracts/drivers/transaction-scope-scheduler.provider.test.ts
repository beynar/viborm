import type { QueryExecutionContext } from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { clientUserPostSchema } from "@tests/fixtures/user-post-schema";
import { describe, expect, test } from "vitest";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve() {
      if (!resolver) throw new Error("Deferred resolver is unavailable");
      resolver();
    },
  };
}

class RecordingPGliteDriver extends PGliteDriver {
  readonly providerStatements: string[] = [];

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.providerStatements.push(statement);
    return super.executeRaw<T>(client, statement, params, context);
  }
}

/**
 * One PGlite for the whole worker, one private schema for this file. The recorder is
 * built over that shared database and MUST carry the suite's namespace: without it it
 * would address `public`, which belongs to no suite. The queue table below is raw SQL,
 * which the driver never rewrites, so it is qualified from the namespace by hand.
 */
const getFamily = usePGliteSchemaFamily(clientUserPostSchema);

describe("transaction-bound scope scheduling with PGlite", () => {
  test("persists a sibling admitted before nested rollback", async () => {
    const family = getFamily();
    const driver = new RecordingPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const queue = `"${family.namespace}"."phase8_scope_queue"`;
    const nestedStarted = createDeferred();
    const releaseNested = createDeferred();
    const nestedInsert = `INSERT INTO ${queue} (id) VALUES (1)`;
    const siblingInsert = `INSERT INTO ${queue} (id) VALUES (2)`;

    try {
      await driver._executeRaw(
        `CREATE TABLE ${queue} (id INTEGER PRIMARY KEY)`
      );
      await driver.withTransaction(async (outerTx) => {
        const nested = outerTx.withTransaction(async (nestedTx) => {
          await nestedTx._executeRaw(nestedInsert);
          nestedStarted.resolve();
          await releaseNested.promise;
          throw new Error("roll back nested insert");
        });
        const sibling = outerTx._executeRaw(siblingInsert);

        await nestedStarted.promise;
        await Promise.resolve();
        await Promise.resolve();
        const siblingReachedProvider =
          driver.providerStatements.includes(siblingInsert);
        releaseNested.resolve();

        await expect(nested).rejects.toThrow("roll back nested insert");
        await expect(sibling).resolves.toMatchObject({ rowCount: 1 });
        expect(siblingReachedProvider).toBe(false);
        await outerTx._executeRaw(`INSERT INTO ${queue} (id) VALUES (3)`);
      });

      const result = await driver._executeRaw<{ id: number }>(
        `SELECT id FROM ${queue} ORDER BY id`
      );
      expect(result.rows.map((row) => row.id)).toEqual([2, 3]);
      const rollbackIndex = driver.providerStatements.findIndex((statement) =>
        statement.startsWith("ROLLBACK TO SAVEPOINT")
      );
      const releaseIndex = driver.providerStatements.findIndex(
        (statement, index) =>
          index > rollbackIndex && statement.startsWith("RELEASE SAVEPOINT")
      );
      expect(driver.providerStatements.indexOf(siblingInsert)).toBeGreaterThan(
        releaseIndex
      );
    } finally {
      await driver.disconnect();
    }
  });
});
