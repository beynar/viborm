/**
 * A first connection that opened its socket and then stalls (the server never
 * answers the setup, nor the close that follows, as SurrealDB Cloud never
 * answers a WebSocket's close) still fails within its bound: the close of the
 * expired client is waited for a second at most. The SDK's client is replaced
 * by one whose `connect` and `close` never settle; no socket is opened.
 */

import { createClient } from "@client/client";
import { ConnectionError } from "@errors";
import { s } from "@schema";
import { afterEach, describe, expect, it, vi } from "vitest";

const closes = vi.hoisted(() => ({ count: 0 }));

vi.mock("surrealdb", async (original) => ({
  ...(await original<typeof import("surrealdb")>()),
  Surreal: class {
    connect(): Promise<true> {
      return new Promise(() => undefined);
    }
    close(): Promise<true> {
      closes.count++;
      return new Promise(() => undefined);
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("a SurrealDB first connection that opened and stalls", () => {
  it("fails as V1001 after ten seconds and a second for its close", async () => {
    vi.useFakeTimers();
    const { SurrealDriver } = await import("@drivers/surrealdb");
    const db = createClient({
      driver: new SurrealDriver({ url: "ws://stalled.invalid/rpc" }),
      schema: { item: s.model({ id: s.string().id() }) },
    });
    let failure: unknown;
    const query = db.item.findMany().then(
      () => undefined,
      (error: unknown) => {
        failure = error;
      }
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closes.count).toBe(1);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await query;
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure).toMatchObject({
      code: "V1001",
      message: "SurrealDB did not connect within 10 s.",
    });
  });
});
