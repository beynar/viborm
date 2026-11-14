/**
 * PGlite: `groupBy` by a time step, in a session whose zone is not UTC. The
 * one connection keeps `SET TIME ZONE`, so every statement runs in Samoa
 * (UTC+13/+14, which skipped 2011-12-30), and no period may move with it.
 */

import { createClient } from "@client/client";
import {
  runGroupByDateStyleBehavior,
  runGroupByTimeStepBehavior,
} from "@tests/contracts/engine/query/groupby-time-step-behavior";
import { groupByTimeStepSchema } from "@tests/contracts/engine/query/groupby-time-step-cases";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runGroupByTimeStepBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  sessionZone: "Pacific/Apia",
  prepare: async (driver, table) => {
    await syncLiveSchema(
      createClient({ schema: groupByTimeStepSchema(table), driver })
    );
    await driver._executeRaw("SET TIME ZONE 'Pacific/Apia'");
  },
});

runGroupByDateStyleBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  inStyle: async (driver) => {
    await driver._executeRaw("SET DateStyle = 'SQL, DMY'");
  },
});
