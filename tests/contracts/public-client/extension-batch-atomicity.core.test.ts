/**
 * A nested write under a parameterized domain is one atomic unit on a
 * batch-only transport (E5.4; the wave-4 parameter-equality exactness fix).
 *
 * An equality on a call's value (the tenant) pins nothing a nested write's
 * target lookup must prove disjoint from an earlier tombstone: it leaves the
 * lookup's facts exact, so the whole operation stays one batch. When such an
 * equality cleared them (50856ee26 to the fix), the lookup became an ordered
 * observation and the operation two batches, and a failure in the second
 * left the first's delete committed. D1 witnesses it on its binding
 * (tests/providers/workers/d1-domain-predicates.test.ts); this file is the
 * same unit on SQLite3's batch-only substrate, in `test:core`.
 */

import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { composedRowsClient } from "@tests/providers/workers/d1-composed-rows";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

/** The statement the concurrent write lands before: the nested title update. */
const TITLE_UPDATE = /^UPDATE "post" SET "title"/;

/**
 * Batch-only SQLite3 counting its batches, with one concurrent write landed
 * on the connection, outside every batch, just before the batch holding a
 * matching statement runs.
 */
class InterleavingBatchDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batches = 0;
  concurrent: { before: RegExp; sql: string; params: unknown[] } | undefined;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches += 1;
    const concurrent = this.concurrent;
    if (concurrent && queries.some(({ sql }) => concurrent.before.test(sql))) {
      this.concurrent = undefined;
      client.prepare(concurrent.sql).run(...concurrent.params);
    }
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries)
        results.push(await this.execute<T>(tx, query.sql, query.params ?? []));
      return results;
    });
  }
}

const opened: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

describe("a nested update and delete under tenancy and soft delete, on a batch-only transport", () => {
  const T = { tenant: "acme" } as const;
  const nested = {
    ...T,
    where: { id: 1 },
    data: {
      posts: {
        update: { where: { id: 10 }, data: { title: "n" } },
        delete: { id: 13 },
      },
    },
  };
  const open = async () => {
    const driver = new InterleavingBatchDriver({ dataDir: ":memory:" });
    const { base, db } = await composedRowsClient(driver, syncLiveSchema);
    opened.push(base);
    await db.author.create({ ...T, data: { id: 1, name: "a" } });
    await db.post.createMany({
      ...T,
      data: [
        { id: 10, title: "t", authorId: 1 },
        { id: 13, title: "w", authorId: 1 },
      ],
    });
    return { driver, base, db };
  };

  test("is one batch", async () => {
    const { driver, db } = await open();
    const before = driver.batches;
    await db.author.update(nested);
    expect(driver.batches - before).toBe(1);
  });

  test("when its update's target is tombstoned before the batch, none of its writes stays", async () => {
    const { driver, base, db } = await open();
    driver.concurrent = {
      before: TITLE_UPDATE,
      sql: `UPDATE "post" SET "deletedAt" = '2026-01-01T00:00:00.000Z' WHERE "id" = ?`,
      params: [10],
    };
    expect(await failure(db.author.update(nested))).toBeInstanceOf(Error);
    expect(driver.concurrent).toBeUndefined();
    expect(
      await base.post.findMany({
        orderBy: { id: "asc" },
        select: { id: true, title: true, deletedAt: true },
      })
    ).toEqual([
      { id: 10, title: "t", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: 13, title: "w", deletedAt: null },
    ]);
  });
});
