import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { updatedAtCells, updatedAtSchema } from "@tests/fixtures/updated-at";
import { describe } from "vitest";

describe("PGlite `.updatedAt()`", () => {
  const family = usePGliteSchemaFamily(updatedAtSchema);
  updatedAtCells(() => family().client);
});
