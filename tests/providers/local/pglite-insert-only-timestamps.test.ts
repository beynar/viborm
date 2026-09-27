/**
 * PGlite — a `.now()` creation timestamp survives an attempted update (#47).
 *
 * One shared PGlite per file with a private schema (`usePGliteSchemaFamily`),
 * truncated between cells, on the transactional substrate. The cells are
 * shared with the SQLite3 suite: `tests/fixtures/insert-only-timestamps.ts`.
 */

import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import {
  insertOnlyTimestampCells,
  insertOnlyTimestampSchema,
} from "@tests/fixtures/insert-only-timestamps";
import { describe } from "vitest";

describe("PGlite insert-only creation timestamps", () => {
  const family = usePGliteSchemaFamily(insertOnlyTimestampSchema);
  insertOnlyTimestampCells(() => family().client);
});
