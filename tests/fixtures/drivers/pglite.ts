import { PGliteDriver } from "@drivers/pglite";

export function createInMemoryPGliteDriver(): PGliteDriver {
  return new PGliteDriver();
}
