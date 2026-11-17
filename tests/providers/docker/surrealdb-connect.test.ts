/**
 * The first connection of a driver given a `url` is bounded: the SDK retries a
 * connection that never opens for good, so an address nothing answers at left
 * a command waiting without a word. Run in the SurrealDB lane (gated on
 * SURREAL_TEST_URL), the only one that opens sockets; no server is reached.
 */

import { createClient } from "@client/client";
import { SurrealDriver } from "@drivers/surrealdb";
import { ConnectionError } from "@errors";
import { s } from "@schema";
import { surrealUrl } from "@tests/fixtures/drivers/surrealdb";
import { describe, expect, it } from "vitest";

describe.skipIf(!surrealUrl)("a SurrealDB driver given a url", () => {
  it("fails its first connection as V1001 when nothing answers, after ten seconds", async () => {
    const db = createClient({
      // Port 9 (discard): nothing listens there on a test machine.
      driver: new SurrealDriver({ url: "ws://127.0.0.1:9" }),
      schema: { item: s.model({ id: s.string().id() }) },
    });
    const started = Date.now();
    const failure = await db.item.findMany().then(
      () => undefined,
      (error: unknown) => error
    );
    const waited = Date.now() - started;
    // The driver's own words, not a redacted provider failure; no url.
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure).toMatchObject({
      code: "V1001",
      message: "SurrealDB did not connect within 10 s.",
    });
    expect(waited).toBeGreaterThanOrEqual(9900);
    expect(waited).toBeLessThan(20_000);
  }, 30_000);
});
