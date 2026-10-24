/**
 * The browser half of Neon Realtime over a fake native subscription: the
 * first result shows until the live baseline, renewals keep their read, the
 * SDK owns refresh and its own fingerprint check, and a refused update ends
 * the subscription with its cause.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { RawSqlQuery } from "@neon/realtime/server";
import { createClient, s } from "@src/index";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { afterEach, describe, expect, it, vi } from "vitest";
import { neonRealtime } from "../../../src/neon-realtime";
import { subscribe } from "../../../src/neon-realtime/client";

type NativeSnapshot = {
  status: string;
  error: unknown;
  data: Record<string, unknown>[] | undefined;
};
const native = vi.hoisted(() => {
  const state = {
    snapshot: undefined as unknown as NativeSnapshot,
    listeners: new Set<() => void>(),
    renewed: [] as unknown[],
    released: 0,
  };
  return {
    state,
    publish(snapshot: NativeSnapshot) {
      state.snapshot = snapshot;
      for (const listener of state.listeners) listener();
    },
  };
});
vi.mock("@neon/realtime/client", async (original) => ({
  ...(await original<typeof import("@neon/realtime/client")>()),
  createRealtimeClient: () => ({
    subscribe: () => ({
      getSnapshot: () => native.state.snapshot,
      onChange: (listener: () => void) => {
        native.state.listeners.add(listener);
        return () => native.state.listeners.delete(listener);
      },
      renew: async (sealed: unknown) => {
        native.state.renewed.push(sealed);
      },
      unsubscribe: () => {
        native.state.released += 1;
        native.state.listeners.clear();
      },
    }),
    close: () => {
      native.state.released += 1;
    },
  }),
}));

class RowsDriver extends SqlOnlyDriver {
  rows: Record<string, unknown>[] = [];
  constructor() {
    super(new PostgresAdapter(), "postgresql");
  }
  protected override async execute<T>() {
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
}

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  views: s.bigInt(),
});
const tagged = s.model({
  id: s.string().id(),
  flags: s.boolean().array(),
  counts: s.int().array(),
  tags: s.string().array(),
});
// A capability the SDK admits: a compact JWE with Neon's header.
const header = Buffer.from(
  JSON.stringify({ alg: "dir", enc: "A256GCM", v: 1 })
).toString("base64url");
let fingerprint = "a".repeat(64);
const realtime = {
  seal: async (_input: { readonly query: RawSqlQuery<never> }) => ({
    capability: `${header}..iv.ciphertext.tag`,
    queryFingerprint: fingerprint,
    expiresAt: Date.now() + 60_000,
  }),
};
const driver = new RowsDriver();
const db = createClient({ schema: { post, tagged }, driver }).$extends(
  neonRealtime({ realtime })
);
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const live = (id: string, rank: number) => ({
  id,
  title: `Title ${id}`,
  views: "12",
  "0viborm_ordinal": String(rank),
});

afterEach(() => {
  vi.useRealTimers();
  native.state.renewed.length = 0;
  native.state.released = 0;
  native.state.listeners.clear();
  fingerprint = "a".repeat(64);
});

describe("Neon Realtime subscriptions", () => {
  it("shows the first result until the live baseline, then the live value", async () => {
    driver.rows = [{ id: "p1", title: "Seed", views: "1" }];
    const query = wire(
      await db.post.findManyRealtime({ orderBy: { id: "desc" } })
    );
    native.state.snapshot = {
      status: "connecting",
      error: undefined,
      data: undefined,
    };
    const changes: unknown[] = [];
    const subscription = subscribe(query, {
      url: "wss://realtime",
      onChange: (snapshot) => changes.push(snapshot.data),
    });
    expect(subscription.getSnapshot()).toEqual({
      status: "connecting",
      error: undefined,
      data: [{ id: "p1", title: "Seed", views: 1n }],
    });
    const rows = [live("p1", 2), live("p2", 1)];
    native.publish({ status: "live", error: undefined, data: rows });
    const snapshot = subscription.getSnapshot();
    expect(snapshot).toEqual({
      status: "live",
      error: undefined,
      data: [
        { id: "p2", title: "Title p2", views: 12n },
        { id: "p1", title: "Title p1", views: 12n },
      ],
    });
    expect(subscription.getSnapshot()).toBe(snapshot);
    expect(changes).toEqual([snapshot.data]);
    // Published rows are fresh objects: the native rows stay as Neon sent them.
    (snapshot.data![0] as { title: string }).title = "mutated";
    expect(rows[1]!.title).toBe("Title p2");
    subscription.unsubscribe();
    expect(subscription.getSnapshot().status).toBe("closed");
    expect(native.state.released).toBe(1);
  });

  it("renews only with a capability for the same read", async () => {
    const subscription = subscribe(wire(await db.post.findManyRealtime()), {
      url: "wss://realtime",
    });
    const same = wire(
      await db.post.findManyRealtime(undefined, { initialData: false })
    );
    await subscription.renew(same);
    expect(native.state.renewed).toEqual([same.sealed]);
    const other = await db.post.findManyRealtime(
      { select: { id: true } },
      { initialData: false }
    );
    await expect(subscription.renew(other as never)).rejects.toThrow(
      "A renewal must be for the same live read."
    );
    // The SDK's own fingerprint check surfaces unchanged.
    fingerprint = "b".repeat(64);
    const stranger = await db.post.findManyRealtime(undefined, {
      initialData: false,
    });
    await expect(subscription.renew(stranger)).rejects.toThrow(
      "Live-query renewal must be for the same query"
    );
    subscription.unsubscribe();
  });

  it("refreshes through the SDK before the capability expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const query = wire(await db.post.findManyRealtime());
    const refreshQuery = vi.fn(() =>
      db.post.findManyRealtime(undefined, { initialData: false })
    );
    const subscription = subscribe(query, {
      url: "wss://realtime",
      refreshQuery,
    });
    await vi.advanceTimersByTimeAsync(55_000);
    expect(refreshQuery).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(native.state.renewed).toHaveLength(1));
    subscription.unsubscribe();
  });

  it("ends in error when a refresh answers another read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const subscription = subscribe(wire(await db.post.findManyRealtime()), {
      url: "wss://realtime",
      refreshQuery: () =>
        db.post.findManyRealtime(
          { select: { id: true } },
          { initialData: false }
        ) as never,
    });
    await vi.advanceTimersByTimeAsync(55_000);
    await vi.waitFor(() =>
      expect(subscription.getSnapshot().status).toBe("error")
    );
    expect(subscription.getSnapshot().error?.cause).toBeInstanceOf(TypeError);
    expect(native.state.renewed).toEqual([]);
  });

  it("ends in error, with the cause, when an OrThrow read loses its row", async () => {
    driver.rows = [{ id: "p1", title: "Seed", views: "1" }];
    const query = wire(
      await db.post.findUniqueOrThrowRealtime({ where: { id: "p1" } })
    );
    const subscription = subscribe(query, { url: "wss://realtime" });
    native.publish({ status: "live", error: undefined, data: [] });
    const snapshot = subscription.getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.cause).toMatchObject({ name: "NotFoundError" });
    expect(snapshot.data).toEqual({ id: "p1", title: "Seed", views: 1n });
    expect(native.state.released).toBe(1);
    subscription.unsubscribe();
    expect(subscription.getSnapshot()).toBe(snapshot);
    expect(native.state.released).toBe(1);
  });

  it("starts a renewal without data and decodes lists Neon sends as array text", async () => {
    const renewal = wire(
      await db.tagged.findManyRealtime(undefined, { initialData: false })
    );
    native.state.snapshot = {
      status: "connecting",
      error: undefined,
      data: undefined,
    };
    const subscription = subscribe(renewal, { url: "wss://realtime" });
    expect(subscription.getSnapshot().data).toBeUndefined();
    native.publish({
      status: "live",
      error: undefined,
      data: [
        {
          id: "t1",
          flags: "{t,f}",
          counts: "{1,-2}",
          tags: '{"a,b",c}',
          "0viborm_ordinal": "1",
        },
      ],
    });
    expect(subscription.getSnapshot().data).toEqual([
      {
        id: "t1",
        flags: [true, false],
        counts: [1, -2],
        tags: ["a,b", "c"],
      },
    ]);
    subscription.unsubscribe();
  });

  it("refuses a live read another VibORM version issued", async () => {
    const query = wire(await db.post.findManyRealtime());
    const foreign = { ...query, plan: { version: 2 as never } };
    expect(() => subscribe(foreign, { url: "wss://realtime" })).toThrow(
      "This live read was issued by another VibORM version."
    );
  });
});
