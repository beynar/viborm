import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  discardingBody,
  failResetOn,
  rejection,
} from "./pinned-session-condemned-fixtures";

describe("PGlite condemns the one client it cannot hand back", () => {
  it("refuses every later pinned session on a client it cannot prove clean", async () => {
    const client = new PGlite();
    try {
      failResetOn(client);
      const driver = new PGliteDriver({ client, namespace: "public" });
      const thrown = await rejection(
        driver._withPinnedSession(discardingBody())
      );
      expect(thrown instanceof Error ? thrown.message : "").toContain(
        "advisory-lock state"
      );
      const second = await rejection(
        driver._withPinnedSession(() => Promise.resolve(1))
      );
      expect(second instanceof Error ? second.message : "").toContain(
        "advisory-lock state"
      );
      const rows = await driver._executeRaw("SELECT 1 AS one");
      expect(rows.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });
});
