import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { discardingBody } from "./pinned-session-condemned-fixtures";

describe("PGlite condemns the one client it cannot hand back", () => {
  it("stays usable when the reset SUCCEEDS", async () => {
    const client = new PGlite();
    try {
      const driver = new PGliteDriver({ client, namespace: "public" });
      await driver._withPinnedSession(discardingBody());
      await expect(
        driver._withPinnedSession(() => Promise.resolve("again"))
      ).resolves.toBe("again");
    } finally {
      await client.close();
    }
  });
});
