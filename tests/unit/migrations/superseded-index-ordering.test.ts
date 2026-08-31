/** Live index-name relocation across schema-scoped providers. */

import { createClient } from "@client/client";
import { s } from "@schema";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const MOVED_SHARED_IDX = /moved_shared_idx/;
const MOVED_B = /moved_b/;

const movedFrom = s
  .model({ id: s.string().id(), x: s.string() })
  .index(["x"], { name: "moved_shared_idx" })
  .map("moved_a");
const movedUntouched = s
  .model({ id: s.string().id(), y: s.string() })
  .map("moved_b");
const beforeMove = { movedFrom, movedUntouched };

const movedSource = s
  .model({ id: s.string().id(), x: s.string() })
  .map("moved_a");
const movedTo = s
  .model({ id: s.string().id(), y: s.string() })
  .index(["y"], { name: "moved_shared_idx" })
  .map("moved_b");
const afterMove = { movedSource, movedTo };

describe("live push — an index name that moves to another table", () => {
  for (const [driverName, createDriver] of [
    ["pglite", createInMemoryPGliteDriver],
    ["sqlite3", createInMemorySQLite3Driver],
  ] as const) {
    it(`is freed before it is taken on ${driverName}`, async () => {
      const driver = createDriver();
      const before = createClient({ schema: beforeMove as never, driver });
      const after = createClient({ schema: afterMove as never, driver });
      try {
        await syncLiveSchema(before as never);
        const planned = await syncLiveSchema(after as never);

        expect(planned.operations.map((op) => op.label)).toEqual([
          "dropIndex",
          "createIndex",
        ]);
        const sql = planned.statements
          .map((statement) => statement.sql)
          .join("\n");
        // DROP INDEX is schema-scoped on Postgres and SQLite, so the source
        // table name is not restated. The freed name and the destination table
        // are the facts the SQL must show.
        expect(sql).toMatch(MOVED_SHARED_IDX);
        expect(sql).toMatch(MOVED_B);
      } finally {
        // ONE disconnect, because there is one driver: both clients wrap the same
        // `createDriver()` handle, so closing it through `after` closes it for
        // `before` too. What was missing was not a second call but this `finally` —
        // a failed plan assertion used to skip the call entirely and leave the
        // loop's per-dialect handle open for the rest of the run.
        await after.$disconnect();
      }
    });
  }
});
