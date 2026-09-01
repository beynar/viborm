import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { ConnectionError } from "@errors";
import { describe, expect, it } from "vitest";
import {
  discardingBody,
  failResetOn,
  prototypeTrapProxy,
  rejection,
} from "./pinned-session-condemned-fixtures";

describe("PGlite condemns the one client it cannot hand back", () => {
  it("keeps its typed refusal when the reset rejects with a hostile value", async () => {
    const client = new PGlite();
    try {
      failResetOn(client, prototypeTrapProxy());
      const driver = new PGliteDriver({ client, namespace: "public" });
      const thrown = await rejection(
        driver._withPinnedSession(discardingBody())
      );
      expect(thrown).toBeInstanceOf(ConnectionError);
      expect(thrown instanceof Error ? thrown.message : "").toContain(
        "advisory-lock state"
      );
      expect(
        thrown instanceof ConnectionError ? thrown.originalCause : undefined
      ).toBeInstanceOf(Error);
      const second = await rejection(
        driver._withPinnedSession(() => Promise.resolve(1))
      );
      expect(second instanceof Error ? second.message : "").toContain(
        "will pin no further migration session"
      );
      const rows = await driver._executeRaw("SELECT 1 AS one");
      expect(rows.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });
});
