import type { PGliteDriver } from "@drivers/pglite";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";

/**
 * The batch-only substrate factory, shared by every `pglite*.test.ts` piece.
 *
 * The PGlite provider suite is split across several files because one program
 * holding every behavior schema cannot be typechecked inside the 1280 MB shard
 * heap. This factory is the one helper more than one piece needs, so it lives
 * in a sibling module rather than being duplicated (and it is deliberately NOT
 * named `*.test.ts`, so Vitest does not collect it as a suite).
 */
export function createBatchOnlyPGliteDriver(): PGliteDriver {
  return new BatchOnlyPGliteDriver();
}
