/**
 * PGlite provider suite — bulk writes and the batch dataflow substrate.
 *
 * Many-to-many junctions, bulk-write limits, returning folds and implicit
 * returning, array ordering on create, and the primary-key/ref dataflow that
 * only the batch-only substrate exercises.
 *
 * This is one of five `pglite*.test.ts` pieces. The suite is split by SCHEMA:
 * every behavior contract carries its own model set, and one program holding
 * all of them cannot be typechecked inside the fixed 1280 MB shard heap. Each
 * piece keeps the same `describe("PGlite Driver")` wrapper, so every test's
 * reported name is unchanged by the split.
 */

import { batchPrimaryKeyDataflowContract } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { batchRefSmokeContract } from "@tests/contracts/drivers/behaviors/batch-ref-smoke-behavior";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createBatchOnlyPGliteDriver } from "@tests/providers/local/pglite-fixtures";

describe("PGlite Driver", () => {
  manyToManyContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  orderingArrayCreateContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  implicitReturningContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  createManyReturnFoldContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  bulkWriteLimitContract.register({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  // `limit: 0` compiles to no statement at all, which is a different shape on
  // the batch-only path: the shared batch has nothing to send for it.
  bulkWriteLimitContract.register({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });

  manyToManyContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  batchPrimaryKeyDataflowContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  batchRefSmokeContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
});
