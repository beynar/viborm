/**
 * PGlite provider suite — read shapes.
 *
 * Window functions, cursor and nested pagination, relation ordering and
 * aggregates, projection (`omit`), and the in/notIn filter execution sentinel.
 *
 * This is one of five `pglite*.test.ts` pieces. The suite is split by SCHEMA:
 * every behavior contract carries its own model set, and one program holding
 * all of them cannot be typechecked inside the fixed 1280 MB shard heap. Each
 * piece keeps the same `describe("PGlite Driver")` wrapper, so every test's
 * reported name is unchanged by the split.
 */

import { createClient } from "@client/client";

import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { windowUserPostSchema } from "@tests/fixtures/user-post-schema";
import { seedWindowUserPosts } from "@tests/fixtures/user-post-seed";

describe("PGlite Driver", () => {
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

  relationReadAggregateContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  nestedOrderByContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
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
      await syncLiveSchema(client);
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
});
