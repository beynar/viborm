import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";

/**
 * The whole located-parent-Ref family on the PGlite TRANSACTION substrate (the
 * driver-matrix legs live in tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
 *
 * One `usePGliteSchemaFamily` database serves every arm here. The atomic-batch leg is a
 * DIFFERENT substrate and therefore a different family, so it runs from
 * `located-parent-ref-batch-matrix.test.ts` rather than beside this one.
 */
runLocatedParentRefBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
