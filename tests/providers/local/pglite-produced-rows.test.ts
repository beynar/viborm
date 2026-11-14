/**
 * PGlite Driver Tests — K4, the produced row (permissions plan §4.4, R4, OD-13): the
 * behaviour of tests/contracts/engine/query/produced-row-behavior.ts on
 * PostgreSQL's dialect, where a bound value outside a column's context is
 * text: the produced row is typed by the model's own columns.
 */

import { withRows } from "@extensions/rows-runtime";
import { runProducedRowBehavior } from "@tests/contracts/engine/query/produced-row-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

// These definitions are stated as plain objects: what reads their rows is brought here.
withRows();

runProducedRowBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
});
