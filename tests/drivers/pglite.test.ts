import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createInMemoryPGliteDriver } from "../fixtures/drivers/pglite";
import { upsertAtomicitySchema } from "../fixtures/upsert-atomicity-schema";
import { windowUserPostSchema } from "../fixtures/user-post-schema";
import { seedWindowUserPosts } from "../fixtures/user-post-seed";
import { runBatchPrimaryKeyDataflowBehavior } from "./batch-primary-key-dataflow-behavior";
import { runBatchRefSmokeBehavior } from "./batch-ref-smoke-behavior";
import { runBlobFilterBehavior } from "./blob-filter-behavior";
import { runBulkWriteLimitBehavior } from "./bulk-write-limit-behavior";
import { runClientRawBehavior } from "./client-raw-behavior";
import { runCompoundKeyBehavior } from "./compound-key-behavior";
import { runCountAggregateWindowBehavior } from "./count-aggregate-window-behavior";
import { runCursorPaginationBehavior } from "./cursor-pagination-behavior";
import { runDecimalExactnessBehavior } from "./decimal-exactness-behavior";
import { runDistinctSkipWindowBehavior } from "./distinct-skip-window-behavior";
import { runFieldReferenceBehavior } from "./field-reference-behavior";
import {
  runFkIndexBehavior,
  runFkIndexPlanBehavior,
  runFkIndexUpgradeBehavior,
} from "./fk-index-behavior";
import { runForwardFkOrderingBehavior } from "./forward-fk-ordering-behavior";
import { runImplicitReturningBehavior } from "./implicit-returning-behavior";
import { runMappedIndexBehavior } from "./index-ddl-behavior";
import { runJsonNullSentinelBehavior } from "./json-null-sentinel-behavior";
import { runLikeEscapeBehavior } from "./like-escape-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runManyToManyBehavior } from "./many-to-many-behavior";
import { runNestedOrderByBehavior } from "./nested-orderby-behavior";
import { runNestedPaginationBehavior } from "./nested-pagination-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
import { runNestedWriteJsonEnvelopeBehavior } from "./nested-write-json-envelope-behavior";
import { runOmitBehavior } from "./omit-behavior";
import { runOptionalRelationParityBehavior } from "./optional-relation-parity-behavior";
import { runOrderingArrayCreateBehavior } from "./ordering-array-create-behavior";
import { runOrderingPlanBehavior } from "./ordering-plan-behavior";
import { runPrismaParityBehavior } from "./prisma-parity-behavior";
import { runReadPathRegressionBehavior } from "./read-path-regression-behavior";
import { runRelationFilterMutationBehavior } from "./relation-filter-mutation-behavior";
import { runRelationReadAggregateBehavior } from "./relation-read-aggregate-behavior";
import {
  runFullScalarRoundtripBehavior,
  runScalarRoundtripBehavior,
} from "./scalar-roundtrip-behavior";
import { runUpsertAtomicityBehavior } from "./upsert-atomicity-behavior";

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

function createBatchOnlyPGliteDriver(): PGliteDriver {
  return new BatchOnlyPGliteDriver();
}

describe("PGlite Driver", () => {
  runFkIndexBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runMappedIndexBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runFkIndexUpgradeBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runFkIndexPlanBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runOrderingPlanBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runForwardFkOrderingBehavior({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  runForwardFkOrderingBehavior({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });

  runCountAggregateWindowBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runDistinctSkipWindowBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runCursorPaginationBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runNestedPaginationBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runOmitBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runNestedWriteBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runCompoundKeyBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runNestedWriteAdvancedBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  // Both substrates: the delegated update target must persist the same JSON
  // document whether the fragment runs as a transaction or as one atomic batch.
  runNestedWriteJsonEnvelopeBehavior({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  runNestedWriteJsonEnvelopeBehavior({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });
  runManyToManyBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runRelationFilterMutationBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runOrderingArrayCreateBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runImplicitReturningBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runBulkWriteLimitBehavior({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  // `limit: 0` compiles to no statement at all, which is a different shape on
  // the batch-only path: the shared batch has nothing to send for it.
  runBulkWriteLimitBehavior({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });
  runListJsonFilterBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runJsonNullSentinelBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runLikeEscapeBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runBlobFilterBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runFieldReferenceBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runPrismaParityBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runOptionalRelationParityBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runReadPathRegressionBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runRelationReadAggregateBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runNestedOrderByBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runClientRawBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runScalarRoundtripBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  runDecimalExactnessBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
    exactDecimal: true,
  });
  runFullScalarRoundtripBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  runNestedWriteBehavior({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  runNestedWriteAdvancedBehavior({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  runManyToManyBehavior({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  runBatchPrimaryKeyDataflowBehavior({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  runBatchRefSmokeBehavior({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });

  // Executes real Postgres SQL — guards against regressions like the former
  // `col = ANY(($1, $2))` output, which text-only assertions cannot catch
  describe("in/notIn filter execution", () => {
    let client: ReturnType<typeof createTestClient>;

    function createTestClient() {
      return createClient({
        schema: windowUserPostSchema,
        driver: createInMemoryPGliteDriver(),
      });
    }

    beforeEach(async () => {
      client = createTestClient();
      await push(client, { force: true });
      await seedWindowUserPosts(client);
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    test("in with multiple values", async () => {
      const users = await client.user.findMany({
        where: { id: { in: ["u1", "u3"] } },
        orderBy: { id: "asc" },
      });
      expect(users.map((u) => u.id)).toEqual(["u1", "u3"]);
    });

    test("in with a single value", async () => {
      const users = await client.user.findMany({
        where: { id: { in: ["u2"] } },
      });
      expect(users.map((u) => u.id)).toEqual(["u2"]);
    });

    test("in with an empty list matches nothing", async () => {
      const users = await client.user.findMany({
        where: { id: { in: [] } },
      });
      expect(users).toEqual([]);
    });

    test("notIn with multiple values", async () => {
      const users = await client.user.findMany({
        where: { id: { notIn: ["u1", "u2"] } },
      });
      expect(users.map((u) => u.id)).toEqual(["u3"]);
    });

    test("notIn with a single value", async () => {
      const users = await client.user.findMany({
        where: { id: { notIn: ["u2"] } },
        orderBy: { id: "asc" },
      });
      expect(users.map((u) => u.id)).toEqual(["u1", "u3"]);
    });

    test("notIn with an empty list matches everything", async () => {
      const users = await client.user.findMany({
        where: { id: { notIn: [] } },
      });
      expect(users).toHaveLength(3);
    });

    test("groupBy having in", async () => {
      const groups = await client.post.groupBy({
        by: ["authorId"],
        having: { authorId: { in: ["u1", "u2"] } },
        orderBy: { authorId: "asc" },
      });
      expect(groups.map((g) => g.authorId)).toEqual(["u1", "u2"]);
    });
  });

  runUpsertAtomicityBehavior({
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
      await push(client, { force: true });
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
