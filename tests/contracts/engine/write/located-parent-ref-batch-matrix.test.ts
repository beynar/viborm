import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";

/**
 * The whole located-parent-Ref family on the PGlite ATOMIC BATCH substrate (the
 * driver-matrix legs live in tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
 *
 * One `usePGliteSchemaFamily` database serves every arm here. The transaction leg is a
 * DIFFERENT substrate and therefore a different family, so it runs from
 * `located-parent-ref-transaction-matrix.test.ts` rather than beside this one.
 */
runLocatedParentRefBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});
