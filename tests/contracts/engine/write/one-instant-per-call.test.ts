/**
 * A call's `now` and `updatedAt` fields hold one instant.
 *
 * Each generator read the wall clock on its own, so a create's `createdAt`
 * and `updatedAt` straddled a millisecond now and then (a flaky D1 test was
 * the witness). The clock here moves one millisecond on every read, so a
 * second read always differs.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, expect, test } from "vitest";

const stamped = s
  .model({
    id: s.int().id(),
    title: s.string(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("oipc_stamped");

const RealDate = globalThis.Date;
afterEach(() => {
  globalThis.Date = RealDate;
});

/** A `Date` whose clock advances one millisecond per read of the time. */
function tickingClock(start: number): DateConstructor {
  let now = start;
  return class TickingDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super((now += 1));
      else super(...(args as [string | number | Date]));
    }
    static override now() {
      now += 1;
      return now;
    }
  } as DateConstructor;
}

test("a create's createdAt and updatedAt are the same instant", async () => {
  const client = createClient({
    schema: { stamped },
    driver: new SQLite3Driver({ dataDir: ":memory:" }),
  });
  await syncLiveSchema(client);
  globalThis.Date = tickingClock(Date.UTC(2026, 9, 24));
  const created = await client.stamped.create({ data: { id: 1, title: "a" } });
  expect(created.createdAt.getTime()).toBe(created.updatedAt.getTime());
  globalThis.Date = RealDate;
  // A later call reads the clock again.
  const updated = await client.stamped.update({
    where: { id: 1 },
    data: { title: "b" },
  });
  expect(updated.updatedAt.getTime()).toBeGreaterThan(
    created.updatedAt.getTime()
  );
});
