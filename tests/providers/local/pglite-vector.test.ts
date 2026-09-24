import { PGliteDriver } from "@drivers/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { vectorContract } from "@tests/contracts/drivers/behaviors/vector-behavior";

function createPGliteVectorDriver(): PGliteDriver {
  return new PGliteDriver({
    options: { extensions: { vector } },
    pgvector: true,
  });
}

vectorContract.register({
  driverName: "PGlite",
  enabled: true,
  createDriver: createPGliteVectorDriver,
});
