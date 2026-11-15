/**
 * SurrealDB Driver Tests — K4, the produced row (permissions plan §4.4, R4, OD-13):
 * tests/contracts/engine/query/produced-row-behavior.ts.
 *
 * NOTE: These tests require a running SurrealDB server (SURREAL_TEST_URL).
 */

import { runProducedRowBehavior } from "@tests/contracts/engine/query/produced-row-behavior";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeEach, describe } from "vitest";

/** What reads the text of SQL's statements, by name. */
const WAIVED: Readonly<Record<string, string>> = {
  "one judged create and one judged move are each one statement carrying its judgement":
    "reads the judged INSERT and UPDATE SQL states",
  "a set update that writes nothing its judgement reads states its judgement once: in its candidates":
    "reads the judged UPDATE SQL states",
};

describe.skipIf(!surrealUrl)("SurrealDB Driver", () => {
  // biome-ignore lint/style/noDoneCallback: the test's context, to skip it by name.
  beforeEach((context) => {
    if (WAIVED[context.task.name]) context.skip();
  });
  runProducedRowBehavior({
    name: "SurrealDB",
    judgesComputedValues: true,
    createDriver: createSurrealTestDriver,
    prepare: async (client) => {
      await syncLiveSchema(client);
    },
  });
});
