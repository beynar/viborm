/**
 * pg Driver Tests - viborm/ordering's respacing under a concurrent writer,
 * on two real connections: a member another transaction moves while
 * rekey's UPDATE waits on its row keeps the key that transaction gave it
 * (the UPDATE writes a row only while it holds the list and the key it was
 * ranked with), and the others are respaced around where it was.
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

const card = s.model({
  id: s.string().id(),
  board: s.string(),
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
  ] as const)("a member moved %s while rekey waits on its row keeps that key", async (_place, rank, order) => {
    const base = createClient({
      schema: { lane, card },
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
      // `rekey` is lazy: `then` starts it now, while the rival holds b.
      const rekeyed = db.lane.rekey().then((result: unknown) => result);
      // rekey's UPDATE waits on b's row.
      await pause(400);
      release();
      await rival;
      expect(await rekeyed).toEqual({ count: 2 });
      expect(
        (await db.lane.findMany()).map((row: { id: string }) => row.id)
      ).toEqual(order);
      const b = await base.lane.findUniqueOrThrow({ where: { id: "b" } });
      expect(b.rank).toBe(rank);
    } finally {
      await base.$disconnect();
    }
  });

  test("a member moved to another list, its key kept, while rekey waits on its row stays as that writer left it", async () => {
    const base = createClient({
      schema: { lane, card },
      driver: new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    });
    try {
      await syncLiveSchema(base);
      for (const [id, board, key] of [
        ["a", "A", "10512345"],
        ["b", "A", "10612345"],
        ["c", "A", "10712345"],
        ["y", "B", "10612345"],
      ] as const)
        await base.card.create({ data: { id, board, rank: key, title: id } });
      const db = ordering({ card: { key: "rank", within: ["board"] } })(
        base
      ) as any;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The rival moves b to board B, under its key, and holds its row.
      const rival = base.$transaction(async (tx) => {
        await tx.card.update({ where: { id: "b" }, data: { board: "B" } });
        await held;
      });
      await pause(150);
      const rekeyed = db.card
        .rekey({ where: { board: "A" } })
        .then((result: unknown) => result);
      await pause(400);
      release();
      await rival;
      expect(await rekeyed).toEqual({ count: 2 });
      const b = await base.card.findUniqueOrThrow({ where: { id: "b" } });
      expect([b.board, b.rank]).toEqual(["B", "10612345"]);
    } finally {
      await base.$disconnect();
    }
  });
});
