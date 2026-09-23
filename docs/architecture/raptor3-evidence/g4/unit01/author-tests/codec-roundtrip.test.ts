import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedAuthor } from "./world";

describe("G4-01 scalar codec crossings (SC-01..SC-14, SL-01..SL-10, Q-R01)", () => {
  it("decodes every admitted scalar domain from its physical spelling", async () => {
    const world = createWorld();
    try {
      seedAuthor(world, {
        id: 1,
        author_name: "Ada",
        tier: "pro",
        rating: 4.25,
        balance: 123456n,
        joined_at: "2024-03-04T05:06:07.008Z",
        birthday: "1990-01-02",
        shift_start: "08:30:00.000",
        tags: JSON.stringify(["alpha", "beta"]),
        avatar: Buffer.from([1, 2, 250]),
        profile: JSON.stringify({ level: 3, nested: { ok: true } }),
        visits: 9007199254740993n,
        active: 1,
      });

      const rows = (await world.engine.execute("author", "findMany", {
        where: { id: 1 },
      })) as Record<string, unknown>[];
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.name, "Ada");
      assert.equal(row.tier, "pro");
      assert.equal(row.rating, 4.25);
      assert.equal(String(row.balance), "1234.56");
      assert.ok(row.joinedAt instanceof Date);
      assert.equal(
        (row.joinedAt as Date).toISOString(),
        "2024-03-04T05:06:07.008Z"
      );
      assert.ok(row.birthday instanceof Date);
      assert.equal(
        (row.birthday as Date).toISOString(),
        "1990-01-02T00:00:00.000Z"
      );
      assert.equal(row.shiftStart, "08:30:00");
      assert.deepEqual(row.tags, ["alpha", "beta"]);
      assert.deepEqual([...(row.avatar as Uint8Array)], [1, 2, 250]);
      assert.deepEqual(row.profile, { level: 3, nested: { ok: true } });
      assert.equal(row.visits, 9007199254740993n);
      assert.equal(row.active, true);
    } finally {
      await closeWorld(world);
    }
  });

  it("carries every scalar domain through a nested relation carrier", async () => {
    const world = createWorld();
    try {
      seedAuthor(world, { id: 1, author_name: "Ada" });
      world.database
        .prepare(
          `INSERT INTO g4_posts(id, author_id, title, rank, category, published)
           VALUES (1, 1, 'first', 1, 'alpha', 1)`
        )
        .run();
      const rows = (await world.engine.execute("post", "findMany", {
        include: { author: true },
      })) as Record<string, unknown>[];
      const carried = rows[0]!.author as Record<string, unknown>;
      assert.equal(carried.name, "Ada");
      assert.equal(String(carried.balance), "0");
      assert.equal(carried.visits, 1n);
      assert.deepEqual(carried.tags, []);
      assert.ok(carried.joinedAt instanceof Date);
      assert.equal(carried.active, false);
    } finally {
      await closeWorld(world);
    }
  });

  it("refuses a malformed provider row with the established identity", async () => {
    const world = createWorld();
    try {
      seedAuthor(world, { id: 2, author_name: "Bad", active: 7 });
      await assert.rejects(
        world.engine.execute("author", "findMany", { where: { id: 2 } }),
        (error: Error) => {
          assert.match(
            error.message,
            /returned a malformed boolean scalar for operation "findMany": the value is not true, false, zero, or one\./
          );
          const meta = (error as { meta?: Record<string, unknown> }).meta;
          assert.equal(meta?.scalarType, "boolean");
          assert.equal(meta?.operation, "findMany");
          return true;
        }
      );
    } finally {
      await closeWorld(world);
    }
  });

  it("refuses an integer outside the safe range", async () => {
    const world = createWorld();
    try {
      seedAuthor(world, { id: 3, author_name: "Wide", rating: 1.5 });
      world.database
        .prepare("UPDATE g4_authors SET id = 9007199254740993 WHERE id = 3")
        .run();
      await assert.rejects(
        world.engine.execute("author", "findMany", {}),
        (error: Error) => {
          assert.match(
            error.message,
            /malformed int scalar .*: the integer is outside the safe range\./
          );
          return true;
        }
      );
    } finally {
      await closeWorld(world);
    }
  });

  it("returns fresh public containers for every result", async () => {
    const world = createWorld();
    try {
      seedAuthor(world, { id: 4, author_name: "Fresh", tags: '["x"]' });
      const read = () =>
        world.engine.execute("author", "findMany", {
          select: { id: true, tags: true, posts: { select: { id: true } } },
        }) as Promise<Record<string, unknown>[]>;
      const first = await read();
      const second = await read();
      assert.notEqual(first, second);
      assert.notEqual(first[0], second[0]);
      assert.notEqual(first[0]!.tags, second[0]!.tags);
      assert.deepEqual(first[0]!.posts, []);
      assert.notEqual(first[0]!.posts, second[0]!.posts);
    } finally {
      await closeWorld(world);
    }
  });
});
