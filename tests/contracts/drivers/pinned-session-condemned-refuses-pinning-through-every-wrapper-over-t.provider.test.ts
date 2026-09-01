import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  discardingBody,
  failResetOn,
  rejection,
} from "./pinned-session-condemned-fixtures";

describe("PGlite condemns the one client it cannot hand back", () => {
  it("refuses pinning through EVERY wrapper over that one client", async () => {
    const shared = new PGlite();
    try {
      failResetOn(shared);
      const alpha = new PGliteDriver({ client: shared, namespace: "public" });
      const beta = new PGliteDriver({ client: shared, namespace: "public" });
      const condemning = await rejection(
        alpha._withPinnedSession(discardingBody())
      );
      expect(condemning instanceof Error ? condemning.message : "").toContain(
        "advisory-lock state"
      );
      let entered = false;
      const refused = await rejection(
        beta._withPinnedSession(() => {
          entered = true;
          return Promise.resolve("body ran");
        })
      );
      expect(entered).toBe(false);
      expect(refused instanceof Error ? refused.message : "").toContain(
        "advisory-lock state"
      );
    } finally {
      await shared.close();
    }
  });
});
