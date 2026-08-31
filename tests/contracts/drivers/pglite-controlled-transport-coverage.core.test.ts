/**
 * The PGlite driver's TYPED execution arm, over a supplied database.
 *
 * `src/drivers/pglite/index.ts` spells `execute` (170) and `executeRaw` (188)
 * as two bodies. `provider-result-contracts.core.test.ts` owns the raw one's
 * row-count rules and `supplied-pool-ownership.core.test.ts` owns supplied-
 * client ownership; what neither reaches is the typed entry, where a compiled
 * `Sql` becomes the positional statement and parameter list this provider
 * receives.
 *
 * A stock PGlite instance is deliberately NOT built here: it is what makes a
 * driver a consumable-result candidate (AGENTS.md Rule 5), it costs a WASM
 * database, and a core test may not own one. The branches that need a real
 * instance stay uncovered in this lane rather than being forged.
 */

import { PGliteDriver } from "@drivers/pglite";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

describe("PGlite controlled transport execution", () => {
  test("renders a typed statement into positional parameters for the supplied database", async () => {
    const query = vi.fn(async () => ({
      affectedRows: 0,
      rows: [{ id: 5 }, { id: 6 }],
    }));
    const driver = new PGliteDriver({ client: { query } as never });

    // Returned rows outrank the provider's `affectedRows` of 0.
    await expect(
      driver._execute<{ id: number }>(
        sql`SELECT id FROM events WHERE id > ${4}`,
        {
          operation: "findMany",
        }
      )
    ).resolves.toEqual({
      rows: [{ id: 5 }, { id: 6 }],
      rowCount: 2,
    });
    expect(query).toHaveBeenCalledWith(
      "SELECT id FROM events WHERE id > $1",
      [4]
    );
  });
});
