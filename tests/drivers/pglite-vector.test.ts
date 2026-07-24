import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { runVectorBehavior } from "./vector-behavior";

function createPGliteVectorDriver(): PGliteDriver {
  return new PGliteDriver({
    client: new PGlite({ extensions: { vector } }),
    pgvector: true,
  });
}

runVectorBehavior({
  driverName: "PGlite",
  enabled: true,
  createDriver: createPGliteVectorDriver,
});
