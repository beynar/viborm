import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { failResetOn, rejection } from "./pinned-session-condemned-fixtures";

describe("PGlite condemns the one client it cannot hand back", () => {
  it("refuses an already-admitted command through a second wrapper", async () => {
    const shared = new PGlite();
    try {
      failResetOn(shared);
      const alpha = new PGliteDriver({ client: shared, namespace: "public" });
      const beta = new PGliteDriver({ client: shared, namespace: "public" });
      let alphaEntered!: () => void;
      const running = new Promise<void>((resolve) => {
        alphaEntered = resolve;
      });
      let releaseAlpha!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseAlpha = resolve;
      });
      const condemning = rejection(
        alpha._withPinnedSession(async (_pinned, control) => {
          alphaEntered();
          await held;
          control.discard();
          return "done";
        })
      );
      await running;
      let bodyRan = false;
      const refused = rejection(
        beta._withPinnedSession(async (pinned) => {
          bodyRan = true;
          await pinned._executeRaw("CREATE TABLE beta_ran (id int)");
          return "body ran";
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseAlpha();
      const condemnation = await condemning;
      expect(
        condemnation instanceof Error ? condemnation.message : ""
      ).toContain("advisory-lock state");
      const outcome = await refused;
      expect(bodyRan).toBe(false);
      expect(outcome instanceof Error ? outcome.message : "").toContain(
        "will pin no further migration session"
      );
      const created = await alpha._executeRaw(
        "SELECT to_regclass('beta_ran') AS present"
      );
      expect(created.rows).toEqual([{ present: null }]);
    } finally {
      await shared.close();
    }
  });
});
