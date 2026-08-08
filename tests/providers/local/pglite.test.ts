import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import {
  BatchOnlyPGliteDriver,
  createInMemoryPGliteDriver,
} from "@tests/fixtures/drivers/pglite";
import { upsertAtomicitySchema } from "@tests/fixtures/upsert-atomicity-schema";
import { windowUserPostSchema } from "@tests/fixtures/user-post-schema";
import { seedWindowUserPosts } from "@tests/fixtures/user-post-seed";
import { batchPrimaryKeyDataflowContract } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { batchRefSmokeContract } from "@tests/contracts/drivers/behaviors/batch-ref-smoke-behavior";
import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import {
  fkIndexContract,
  fkIndexPlanContract,
  fkIndexUpgradeContract,
} from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import {
  mappedIndexContract,
  partialIndexCoverageContract,
  partialIndexPredicateChurnContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteJsonEnvelopeContract } from "@tests/contracts/drivers/behaviors/nested-write-json-envelope-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { orderingPlanContract } from "@tests/contracts/drivers/behaviors/ordering-plan-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";

function createBatchOnlyPGliteDriver(): PGliteDriver {
  return new BatchOnlyPGliteDriver();
}

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

  countAggregateWindowContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  distinctSkipWindowContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  cursorPaginationContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  nestedPaginationContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  omitContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  nestedWriteContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  compoundKeyContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  // Both substrates: the delegated update target must persist the same JSON
  // document whether the fragment runs as a transaction or as one atomic batch.
  nestedWriteJsonEnvelopeContract.register({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  nestedWriteJsonEnvelopeContract.register({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });
  manyToManyContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  relationFilterMutationContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  orderingArrayCreateContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  implicitReturningContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  createManyReturnFoldContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  bulkWriteLimitContract.register({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  // `limit: 0` compiles to no statement at all, which is a different shape on
  // the batch-only path: the shared batch has nothing to send for it.
  bulkWriteLimitContract.register({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });
  listJsonFilterContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  jsonNullSentinelContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  likeEscapeContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  blobFilterContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  fieldReferenceContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  prismaParityContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  optionalRelationParityContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  readPathRegressionContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  relationReadAggregateContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  nestedOrderByContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  clientRawContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  scalarRoundtripContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  decimalExactnessContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
    exactDecimal: true,
  });
  fullScalarRoundtripContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  nestedWriteContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  manyToManyContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  batchPrimaryKeyDataflowContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  batchRefSmokeContract.register({
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
