import { PGliteDriver } from "@drivers/pglite";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { enumEvolutionTests } from "@tests/fixtures/enum-evolution";
import { describe } from "vitest";

const family = usePGliteSchemaFamily({});

describe("PostgreSQL enum evolution", () => {
  enumEvolutionTests(async (label) => {
    const { database, namespace: base } = family();
    const namespace = `${base}_${label}`;
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    return {
      namespace,
      driver: new PGliteDriver({ client: database, namespace }),
    };
  });
});
