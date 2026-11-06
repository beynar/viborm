/**
 * The official extensions' shared behaviours, on SurrealDB. Gated on
 * SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { runOnBehavior } from "@tests/contracts/public-client/on-behavior";
import {
  describeOrdering,
  schema as orderingSchema,
} from "@tests/contracts/public-client/ordering-behavior";
import { runSoftDeleteBehavior } from "@tests/contracts/public-client/soft-delete-behavior";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeEach, describe } from "vitest";

/** What a contract states in SQL's own words, by name, with why it does not apply. */
const WAIVED: Readonly<Record<string, string>> = {
  "an unlink reads the rows a hook wants under the lock the session's other reads take":
    "reads SQL's plan: no read here takes a lock",
  "a create computes its key in its own statement (a read first on MySQL)":
    "asserts the SQL it reads the last key with",
  "rekey of part of a list respaces the whole list, in its order":
    "counts the one statement SQL respaces in; here the rows are read, placed and written",
  "one order for every grouping: a card changes column with its place, in one move":
    "counts the reads of the path that computes the key in its UPDATE",
};

describe.skipIf(!surrealUrl)("SurrealDB", () => {
  // biome-ignore lint/style/noDoneCallback: the test's context, to skip it by name.
  beforeEach((context) => {
    if (WAIVED[context.task.name]) context.skip();
  });
  runOnBehavior({ name: "SurrealDB", createDriver: createSurrealTestDriver });
  runSoftDeleteBehavior({
    name: "SurrealDB",
    createDriver: createSurrealTestDriver,
  });
  describeOrdering(
    "SurrealDB",
    async () => {
      const client = createClient({
        schema: orderingSchema,
        driver: createSurrealTestDriver(),
      });
      await syncLiveSchema(client);
      return { client };
      // As MySQL's: a create reads the list's last key, and a move its neighbours.
    },
    2,
    { move: 3, update: 1, upsert: [1, 1, 2, 2] }
  );
});
