/**
 * PGlite Driver Tests — K4, the produced row (permissions plan §4.4, R4, OD-13): the
 * behaviour of tests/contracts/engine/query/produced-row-behavior.ts on
 * PostgreSQL's dialect, where a bound value outside a column's context is
 * text: the produced row is typed by the model's own columns.
 */

import { runProducedRowBehavior } from "@tests/contracts/engine/query/produced-row-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runProducedRowBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
});
