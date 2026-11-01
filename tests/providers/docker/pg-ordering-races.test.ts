/**
 * pg Driver Tests - viborm/ordering's respacing under a concurrent writer,
 * on two real connections: a member another transaction moves while
 * rekey's UPDATE waits on its row keeps the place that transaction gave it
 * (PostgreSQL re-reads the row it waited on, and the UPDATE ranks it there).
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { createClient, s } from "@src/index";
import { ordering, orderingKey } from "@src/ordering";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const lane = s.model({
  id: s.string().id(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeIf("pg Driver: ordering races", () => {
  beforeEach(dropEveryLiveTable);
  afterAll(dropEveryLiveTable);

  test.each([
    ["last", "19", ["a", "c", "b"]],
    ["first", "0899", ["b", "a", "c"]],
  ] as const)("a member moved %s while rekey waits on its row keeps that place", async (_place, rank, order) => {
    const base = createClient({
      schema: { lane },
      driver: new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    });
    try {
      await syncLiveSchema(base);
      for (const [id, key] of [
        ["a", "10512345"],
        ["b", "10612345"],
        ["c", "10712345"],
      ] as const)
        await base.lane.create({ data: { id, rank: key, title: id } });
      const db = ordering({ lane: { key: "rank" } })(base) as any;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The rival moves b and holds its row until released.
      const rival = base.$transaction(async (tx) => {
        await tx.lane.update({ where: { id: "b" }, data: { rank } });
        await held;
      });
      await pause(150);
      const rekeyed = db.lane.rekey();
      // rekey's UPDATE waits on b's row.
      await pause(400);
      release();
      await rival;
      await rekeyed;
      expect(
        (await db.lane.findMany()).map((row: { id: string }) => row.id)
      ).toEqual(order);
      for (const row of await base.lane.findMany())
        expect(row.rank.length).toBeLessThanOrEqual(2);
    } finally {
      await base.$disconnect();
    }
  });
});
