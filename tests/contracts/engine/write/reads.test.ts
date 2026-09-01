import {
  readSchema,
  runReadBehavior,
} from "@tests/contracts/engine/write/read-behavior";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";

/**
 * The read family on PGlite, in transaction and forced atomic-batch modes.
 *
 * Each leg takes a private SCHEMA on the worker's ONE PGlite rather than a database
 * of its own. That fixture empties the suite's tables before every test, so both legs
 * ask for the seed to be re-committed per test: without it every scenario would read
 * two empty result sets and agree about them.
 */
const getTransactionFamily = usePGliteSchemaFamily(readSchema);

runReadBehavior({
  name: "PGlite transaction",
  createDriver: () => getTransactionFamily().driver,
  seedPerTest: true,
});

// The batch arm binds both drivers to one PGlite instance AND one schema, so both
// clients read the same seeded tables. The Observed arm's extra driver is built over
// the shared database and MUST carry the namespace: without it it addresses `public`,
// where this suite has no tables at all.
const getBatchFamily = usePGliteSchemaFamily(readSchema);

runReadBehavior({
  name: "PGlite atomic batch",
  createDriver: () => getBatchFamily().driver,
  createObservedDriver: () => {
    const family = getBatchFamily();
    return new BatchOnlyPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
  },
  seedPerTest: true,
});
