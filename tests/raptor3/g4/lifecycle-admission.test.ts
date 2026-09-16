/**
 * G4 C13 falsifiers — admission, transform and cache boundaries
 * (LX-01, LX-07, LX-10, LX-11, LX-12, RF-10).
 *
 * Same shape as `lifecycle-events.test.ts`: every oracle is proven against the
 * shipped route (including a deliberate self-falsification) before it is run
 * through the private candidate route, which is red until the G4-03 seam lands.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createRoutedClient } from "./route-contract";

const ADMISSION_TABLE = "g4_admission_records";

function admissionSchema() {
  const record = s
    .model({
      id: s.int().id(),
      label: s.string().map("record_label"),
      score: s.int().map("record_score"),
    })
    .map(ADMISSION_TABLE);
  return { record };
}

type AnyClient = {
  $extends(definition: unknown): AnyClient;
  $withCache(options?: unknown): AnyClient;
  $transaction(work: unknown, options?: unknown): Promise<unknown>;
  $disconnect(): Promise<unknown>;
} & Record<string, { findMany(args?: unknown): Promise<unknown> }>;

/**
 * The cache-bypass oracle: three statement-count assertions, run against any
 * route. The shipped route must satisfy it, the candidate route is measured by
 * it, and a route that never bypasses the cache must be rejected by it (the
 * self-falsification cell below). Every call gets its own cache store, so a
 * second route never inherits the first one's entries and "the first read
 * reaches the provider" stays a real claim on all three.
 */
async function assertCacheBypass(base: AnyClient, route: string) {
  const background: Promise<unknown>[] = [];
  const statements: string[] = [];
  const observed = base
    .$extends(
      cache({
        driver: new MemoryCache(),
        waitUntil(promise: Promise<unknown>) {
          background.push(promise);
        },
      })
    )
    .$extends({
      name: "g4-statement-counter",
      observe(unit: unknown, proceed: () => Promise<unknown>) {
        const described = unit as { kind?: unknown };
        if (described.kind === "statement") statements.push("statement");
        background.push(proceed());
      },
    });
  const cached = observed.$withCache();

  await cached.record?.findMany({ where: { score: { gte: 10 } } });
  await Promise.all(background.splice(0));
  const afterFirst = statements.length;
  assert.ok(
    afterFirst > 0,
    `the first cached read on the ${route} route must reach the provider`
  );
  await cached.record?.findMany({ where: { score: { gte: 10 } } });
  await Promise.all(background.splice(0));
  assert.equal(
    statements.length,
    afterFirst,
    `the second cached read on the ${route} route reached the provider`
  );

  await observed.$transaction(async (transaction: AnyClient) => {
    await transaction.record?.findMany({ where: { score: { gte: 10 } } });
  });
  await Promise.all(background.splice(0));
  assert.ok(
    statements.length > afterFirst,
    `a read inside a transaction on the ${route} route must bypass the cache and reach the provider`
  );
}

describe("G4 C13 admission, transform and cache falsifiers", () => {
  let database: Database.Database;
  let driver: SQLite3Driver;
  let shipped: AnyClient;

  beforeEach(async () => {
    database = new Database(":memory:");
    driver = new SQLite3Driver({ client: database });
    shipped = createClient({
      schema: admissionSchema(),
      driver,
    }) as unknown as AnyClient;
    const migration = await syncLiveSchema(shipped as never);
    assert.equal(migration.applied, true);
    database.exec(
      `INSERT INTO ${ADMISSION_TABLE} (id, record_label, record_score) VALUES (1,'one',10),(2,'two',20)`
    );
  });

  afterEach(async () => {
    await shipped?.$disconnect();
    database?.close();
  });

  it("C13 double-admission: one awaited operation admits its request exactly once", async () => {
    let admissions = 0;
    const counting = {
      name: "g4-admission-counter",
      request() {
        admissions++;
        return {};
      },
    };
    const observed = shipped.$extends(counting);
    const pending = observed.record?.findMany({ where: { score: { gte: 10 } } });
    // A lazy PendingOperation memoizes its admission: awaiting the same
    // operation twice must not admit it twice.
    await pending;
    await pending;
    assert.equal(admissions, 1, "the shipped route admitted the request twice");

    // Falsify the counter: two distinct operations must be two admissions, so
    // a counter stuck at one could not detect a double admission.
    await observed.record?.findMany({ where: { score: { gte: 10 } } });
    assert.equal(admissions, 2);

    admissions = 0;
    const routed = createRoutedClient({
      schema: admissionSchema(),
      driver,
    }) as unknown as AnyClient;
    const routedPending = routed
      .$extends(counting)
      .record?.findMany({ where: { score: { gte: 10 } } });
    await routedPending;
    await routedPending;
    assert.equal(
      admissions,
      1,
      "the candidate route admitted one request more than once"
    );
    await routed.$disconnect();
  });

  it("C13 double-transform: the extension chain transforms one request once", async () => {
    const seen: unknown[] = [];
    const transforming = {
      name: "g4-request-transform",
      request({ input }: { input: Record<string, unknown> }) {
        seen.push(input);
        return { where: { score: { gte: 20 } } };
      },
    };
    const rows = await shipped
      .$extends(transforming)
      .record?.findMany({ where: { score: { gte: 0 } }, orderBy: { id: "asc" } });
    assert.equal(seen.length, 1, "the request transform ran more than once");
    assert.deepStrictEqual(rows, [{ id: 2, label: "two", score: 20 }]);

    seen.length = 0;
    const routed = createRoutedClient({
      schema: admissionSchema(),
      driver,
    }) as unknown as AnyClient;
    const routedRows = await routed
      .$extends(transforming)
      .record?.findMany({ where: { score: { gte: 0 } }, orderBy: { id: "asc" } });
    assert.equal(seen.length, 1, "the candidate route ran the transform twice");
    assert.deepStrictEqual(routedRows, [{ id: 2, label: "two", score: 20 }]);
    await routed.$disconnect();
  });

  it("C13 cache-bypass: a cached read inside a transaction never serves the cache", async () => {
    await assertCacheBypass(shipped, "shipped");

    const routed = createRoutedClient({
      schema: admissionSchema(),
      driver,
    }) as unknown as AnyClient;
    try {
      await assertCacheBypass(routed, "candidate");
    } finally {
      await routed.$disconnect();
    }
  });

  it("C13 cache-bypass: the same oracle rejects a route that always serves the cache", async () => {
    // The self-falsification. `assertCacheBypass` is the very function the cell
    // above runs against the candidate route, so a candidate section that
    // asserted nothing could not pass this: the stand-in below answers every
    // read from a stale cached row, inside a transaction included, and never
    // reaches a provider.
    const stale = [{ id: 1, label: "stale", score: 10 }];
    const cacheAlways: AnyClient = {
      $extends: () => cacheAlways,
      $withCache: () => cacheAlways,
      async $transaction(work: unknown) {
        return (work as (client: AnyClient) => Promise<unknown>)(cacheAlways);
      },
      async $disconnect() {
        return undefined;
      },
      record: {
        async findMany() {
          return stale;
        },
      },
    } as unknown as AnyClient;
    await assert.rejects(
      () => assertCacheBypass(cacheAlways, "cache-always stand-in"),
      /the first cached read on the cache-always stand-in route must reach the provider/
    );
  });
});
