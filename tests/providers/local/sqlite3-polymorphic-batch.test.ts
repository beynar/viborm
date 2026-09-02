/**
 * SQLite3 Prisma parity, optional and polymorphic relations, polymorphic collections, upsert atomicity, and the batch primary-key dataflow schema.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { createClient } from "@client/client";
import { batchPrimaryKeyDataflowContract } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { batchRefSmokeContract } from "@tests/contracts/drivers/behaviors/batch-ref-smoke-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { batchPrimaryKeyDataflowSchema } from "@tests/fixtures/batch-primary-key-dataflow-schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createBatchOnlySQLite3Driver } from "./sqlite3-fixtures";

describe("SQLite3 Driver", () => {
  prismaParityContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  optionalRelationParityContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicRelationContract.register({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicCollectionReadContract.register({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicCollectionWriteContract.register({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  upsertAtomicityContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  test("transactional nested update divides an integer PK and propagates it", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver,
    });

    try {
      await syncLiveSchema(client);
      await client.mutableUser.create({
        data: { id: 330, name: "Divide operation" },
      });

      const updated = await client.mutableUser.update({
        where: { id: 330 },
        data: {
          id: { divide: 3 },
          name: "Divide operation updated",
          posts: { create: { title: "Divide operation child" } },
        },
      });

      const posts = await client.mutablePost.findMany();
      expect(updated.id).toBe(110);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.userId).toBe(110);
    } finally {
      await client.$disconnect();
    }
  });
  batchPrimaryKeyDataflowContract.register({
    driverName: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  batchRefSmokeContract.register({
    driverName: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
});
