import { PGliteDriver } from "@drivers/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { rawIndexContract } from "@tests/contracts/drivers/behaviors/raw-index-behavior";
import { runRawIndexHnswBehavior } from "@tests/contracts/drivers/behaviors/raw-index-hnsw";

/** PGlite with pgvector, so an HNSW index is one a raw index can declare. */
function createPGliteVectorDriver(): PGliteDriver {
  return new PGliteDriver({
    options: { extensions: { vector } },
    pgvector: true,
  });
}

rawIndexContract.register({
  driverName: "PGlite",
  createDriver: createPGliteVectorDriver,
  push: true,
});

runRawIndexHnswBehavior({
  driverName: "PGlite",
  createDriver: createPGliteVectorDriver,
});
