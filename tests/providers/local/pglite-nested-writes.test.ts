/**
 * PGlite provider suite — nested writes.
 *
 * The nested-write fragment language on both PGlite substrates (transaction
 * and native atomic batch), compound keys, and relation-filtered mutations.
 *
 * This is one of five `pglite*.test.ts` pieces. The suite is split by SCHEMA:
 * every behavior contract carries its own model set, and one program holding
 * all of them cannot be typechecked inside the fixed 1280 MB shard heap. Each
 * piece keeps the same `describe("PGlite Driver")` wrapper, so every test's
 * reported name is unchanged by the split.
 */

import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteJsonEnvelopeContract } from "@tests/contracts/drivers/behaviors/nested-write-json-envelope-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createBatchOnlyPGliteDriver } from "@tests/providers/local/pglite-fixtures";

describe("PGlite Driver", () => {
  nestedWriteContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  compoundKeyContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  // Both substrates: the delegated update target must persist the same JSON
  // document whether the fragment runs as a transaction or as one atomic batch.
  nestedWriteJsonEnvelopeContract.register({
    driverName: "PGlite (tx)",
    createDriver: createInMemoryPGliteDriver,
  });
  nestedWriteJsonEnvelopeContract.register({
    driverName: "PGlite (batch)",
    createDriver: createBatchOnlyPGliteDriver,
  });
  relationFilterMutationContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  nestedWriteContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "PGlite batch-only",
    createDriver: createBatchOnlyPGliteDriver,
  });
});
