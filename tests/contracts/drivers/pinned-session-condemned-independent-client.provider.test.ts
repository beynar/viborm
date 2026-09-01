import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

/**
 * The independent leg of the condemned-session suite, in its own process.
 *
 * PGlite does not return its Wasm heap on close, so even two SEQUENTIAL
 * databases in one process measured 1643 MiB. One measures ~1430 and fits the
 * ordinary 1536 ceiling. The claim is unchanged: a client that never saw the
 * condemned session still pins normally.
 */
describe("PGlite condemns the one client it cannot hand back", () => {
  it("still pins a client that never saw the condemned session", async () => {
    const independent = new PGlite();
    try {
      const elsewhere = new PGliteDriver({
        client: independent,
        namespace: "public",
      });
      await expect(
        elsewhere._withPinnedSession(() => Promise.resolve("ok"))
      ).resolves.toBe("ok");
    } finally {
      await independent.close();
    }
  });
});
