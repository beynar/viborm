/**
 * PGlite Driver Tests — a scalar list bound as one parameter (engine-09) and
 * a same-column OR read as that list (platform-15).
 */

import { runBoundMemberListBehavior } from "@tests/contracts/engine/query/bound-member-list-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runBoundMemberListBehavior({
  name: "PGlite",
  dialect: "postgresql",
  createDriver: createInMemoryPGliteDriver,
});
