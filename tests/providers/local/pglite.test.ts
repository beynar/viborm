/**
 * PGlite provider suite — schema structure.
 *
 * Index and ordering DDL, the plans those indexes have to produce, polymorphic
 * links across both PGlite substrates, and upsert atomicity (including the
 * injected unique-race sentinel that only this provider can express).
 *
 * This is one of five `pglite*.test.ts` pieces. The suite is split by SCHEMA:
 * every behavior contract carries its own model set, and one program holding
 * all of them cannot be typechecked inside the fixed 1280 MB shard heap. Each
 * piece keeps the same `describe("PGlite Driver")` wrapper, so every test's
 * reported name is unchanged by the split.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";

import {
  fkIndexContract,
  fkIndexPlanContract,
  fkIndexUpgradeContract,
} from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import {
  mappedIndexContract,
  partialIndexCoverageContract,
  partialIndexPredicateChurnContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { orderingPlanContract } from "@tests/contracts/drivers/behaviors/ordering-plan-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { upsertAtomicitySchema } from "@tests/fixtures/upsert-atomicity-schema";
import { createBatchOnlyPGliteDriver } from "@tests/providers/local/pglite-fixtures";

describe("PGlite Driver", () => {
  fkIndexContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  mappedIndexContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  partialIndexCoverageContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  partialIndexPredicateChurnContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  fkIndexUpgradeContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  fkIndexPlanContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  orderingPlanContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  forwardFkOrderingContract.register({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  forwardFkOrderingContract.register({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });

  polymorphicRelationContract.register({
    name: "PGlite",
    pgliteMode: "transaction",
  });
  // BOTH substrates, which is the §12 land gate read honestly: PGlite in
  // `transaction` mode is the transactional substrate, and `atomicBatch` — the
  // only native-batch substrate in the estate that actually runs contracts — is
  // the native-batch one.
  polymorphicCollectionReadContract.register({
    name: "PGlite",
    pgliteMode: "transaction",
  });
  polymorphicCollectionReadContract.register({
    name: "PGlite atomic batch",
    pgliteMode: "atomicBatch",
  });
  // BOTH substrates for the WRITE half too, and for a stronger reason than the
  // read half's: §1.6's slot-replacement protocol enforces its premises
  // DIFFERENTLY on each — a row lock in a transaction, in-batch assertions plus
  // the target-side UNIQUE in a native batch — so a single-substrate run would
  // leave half of the design unmeasured.
  polymorphicCollectionWriteContract.register({
    name: "PGlite",
    pgliteMode: "transaction",
  });
  polymorphicCollectionWriteContract.register({
    name: "PGlite atomic batch",
    pgliteMode: "atomicBatch",
  });
  readPathRegressionContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  upsertAtomicityContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  // PGlite is single-session, so a real cross-connection race cannot be
  // reproduced here. Instead, inject a conflicting row right before the
  // create-branch INSERT (inside the same transaction) to force the unique
  // violation a lost race produces, and assert the operation still succeeds
  // via the query engine's retry instead of leaking a raw constraint error.
  describe("upsert fallback unique-race retry", () => {
    class RaceInjectingPGliteDriver extends PGliteDriver {
      private injection:
        | { insertMarker: string; injectSql: string }
        | undefined;

      armInjection(insertMarker: string, injectSql: string): void {
        this.injection = { insertMarker, injectSql };
      }

      protected override async execute<T>(
        client: PGlite | Transaction,
        sql: string,
        params: unknown[]
      ): Promise<QueryResult<T>> {
        const injection = this.injection;
        if (injection && sql.includes(injection.insertMarker)) {
          this.injection = undefined;
          await super.execute(client, injection.injectSql, []);
        }
        return super.execute<T>(client, sql, params);
      }
    }

    let driver: RaceInjectingPGliteDriver;
    let client: ReturnType<typeof createRaceClient>;

    function createRaceClient() {
      return createClient({
        schema: upsertAtomicitySchema,
        driver,
      });
    }

    beforeEach(async () => {
      driver = new RaceInjectingPGliteDriver();
      client = createRaceClient();
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    test("upsert create branch losing a unique race is retried", async () => {
      driver.armInjection(
        'INSERT INTO "upsert_atomicity_users"',
        `INSERT INTO "upsert_atomicity_users" ("id", "name") VALUES ('race-user', 'sniped')`
      );

      const result = await client.user.upsert({
        where: { id: "race-user" },
        create: {
          id: "race-user",
          name: "created",
          posts: { create: { id: "race-post", title: "t" } },
        },
        update: { name: "updated" },
      });

      expect(result.id).toBe("race-user");
      const users = await client.user.findMany();
      expect(users).toHaveLength(1);
    });

    test("connectOrCreate create branch losing a unique race is retried", async () => {
      driver.armInjection(
        'INSERT INTO "upsert_atomicity_posts"',
        `INSERT INTO "upsert_atomicity_posts" ("id", "title") VALUES ('coc-post', 'sniped')`
      );

      await client.user.create({
        data: {
          id: "coc-user",
          name: "owner",
          posts: {
            connectOrCreate: {
              where: { id: "coc-post" },
              create: { id: "coc-post", title: "created" },
            },
          },
        },
      });

      const posts = await client.post.findMany();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.userId).toBe("coc-user");
    });
  });
});
