/**
 * PGlite Driver Tests — a read's bound values written as PostgreSQL literals
 * (the body of a view) read the rows the bound statement reads.
 */

import { runInlineLiteralsBehavior } from "@tests/contracts/adapters/inline-literals-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runInlineLiteralsBehavior({
  name: "PGlite",
  dialect: "postgresql",
  createDriver: createInMemoryPGliteDriver,
});
