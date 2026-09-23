import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedAuthor, seedPost, type World } from "./world";

function world(): World {
  const created = createWorld();
  seedAuthor(created, { id: 1, author_name: "Ada", tier: "pro", rating: 4.5 });
  seedAuthor(created, { id: 2, author_name: "Bob", tier: "basic", rating: 1.5 });
  seedAuthor(created, { id: 3, author_name: "Cy", tier: null, rating: null });
  const posts = [
    { id: 1, author_id: 1, title: "alpha one", rank: 10, category: "alpha", published: 1 },
    { id: 2, author_id: 1, title: "alpha two", rank: 20, category: "alpha", published: 0 },
    { id: 3, author_id: 2, title: "Beta one", rank: 30, category: "beta", published: 1 },
    { id: 4, author_id: 2, title: "beta two", rank: 40, category: "beta", published: 1 },
    { id: 5, author_id: null, title: "orphan", rank: 50, category: "gamma", published: 0 },
  ];
  for (const post of posts) seedPost(created, post);
  return created;
}

describe("G4-01 read verbs (OP-R01..OP-R09)", () => {
  it("findUnique returns one row or null and OrThrow carries the not-found identity", async () => {
    const created = world();
    try {
      const found = (await created.engine.execute("post", "findUnique", {
        where: { id: 3 },
      })) as Record<string, unknown> | null;
      assert.equal(found?.title, "Beta one");
      assert.equal(
        await created.engine.execute("post", "findUnique", { where: { id: 99 } }),
        null
      );
      assert.equal(
        (
          (await created.engine.execute("post", "findUniqueOrThrow", {
            where: { id: 3 },
          })) as Record<string, unknown>
        ).id,
        3
      );
      await assert.rejects(
        created.engine.execute("post", "findUniqueOrThrow", { where: { id: 99 } }),
        (error: Error) => {
          assert.equal(error.message, "No post record found for findUniqueOrThrow");
          assert.equal(error.constructor.name, "NotFoundError");
          const meta = (error as { meta?: Record<string, unknown> }).meta;
          assert.equal(meta?.model, "post");
          assert.equal(meta?.operation, "findUniqueOrThrow");
          return true;
        }
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("findUnique accepts an extended unique where", async () => {
    const created = world();
    try {
      assert.equal(
        await created.engine.execute("post", "findUnique", {
          where: { id: 1, published: false },
        }),
        null
      );
      const found = (await created.engine.execute("post", "findUnique", {
        where: { id: 1, published: true },
      })) as Record<string, unknown>;
      assert.equal(found.id, 1);
    } finally {
      await closeWorld(created);
    }
  });

  it("findFirst honours order, skip and a signed take", async () => {
    const created = world();
    try {
      const first = (await created.engine.execute("post", "findFirst", {
        orderBy: { rank: "asc" },
      })) as Record<string, unknown>;
      assert.equal(first.id, 1);
      const last = (await created.engine.execute("post", "findFirst", {
        orderBy: { rank: "asc" },
        take: -1,
      })) as Record<string, unknown>;
      assert.equal(last.id, 5);
      assert.equal(
        await created.engine.execute("post", "findFirst", {
          where: { category: "nothing" },
        }),
        null
      );
      await assert.rejects(
        created.engine.execute("post", "findFirstOrThrow", {
          where: { category: "nothing" },
        }),
        (error: Error) => {
          assert.equal(error.message, "No post record found for findFirstOrThrow");
          return true;
        }
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("findMany windows with take, skip, cursor and a negative take", async () => {
    const created = world();
    try {
      const page = (await created.engine.execute("post", "findMany", {
        orderBy: { rank: "asc" },
        take: 2,
        skip: 1,
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(page.map((row) => row.id), [2, 3]);

      const fromCursor = (await created.engine.execute("post", "findMany", {
        orderBy: { rank: "asc" },
        cursor: { id: 3 },
        take: 2,
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(fromCursor.map((row) => row.id), [3, 4]);

      const afterCursor = (await created.engine.execute("post", "findMany", {
        orderBy: { rank: "asc" },
        cursor: { id: 3 },
        skip: 1,
        take: 2,
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(afterCursor.map((row) => row.id), [4, 5]);

      const backward = (await created.engine.execute("post", "findMany", {
        orderBy: { rank: "asc" },
        take: -2,
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(backward.map((row) => row.id), [4, 5]);

      const backwardFromCursor = (await created.engine.execute("post", "findMany", {
        orderBy: { rank: "asc" },
        cursor: { id: 3 },
        take: -2,
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(backwardFromCursor.map((row) => row.id), [2, 3]);
    } finally {
      await closeWorld(created);
    }
  });

  it("distinct removes duplicates before the window", async () => {
    const created = world();
    try {
      const rows = (await created.engine.execute("post", "findMany", {
        distinct: ["category"],
        orderBy: { rank: "asc" },
        select: { id: true, category: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows.map((row) => row.category), ["alpha", "beta", "gamma"]);
      const windowed = (await created.engine.execute("post", "findMany", {
        distinct: ["category"],
        orderBy: { rank: "asc" },
        take: 2,
        select: { id: true, category: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(windowed.map((row) => row.category), ["alpha", "beta"]);
    } finally {
      await closeWorld(created);
    }
  });

  it("count returns a number or the selected count shape, and exist a boolean", async () => {
    const created = world();
    try {
      assert.equal(await created.engine.execute("post", "count", {}), 5);
      assert.equal(
        await created.engine.execute("post", "count", { where: { published: true } }),
        3
      );
      assert.deepEqual(
        await created.engine.execute("post", "count", {
          select: { _all: true, authorId: true },
        }),
        { _all: 5, authorId: 4 }
      );
      assert.equal(
        await created.engine.execute("post", "count", { take: 2 }),
        2
      );
      assert.equal(await created.engine.execute("post", "exist", {}), true);
      assert.equal(
        await created.engine.execute("post", "exist", {
          where: { category: "nothing" },
        }),
        false
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("aggregate answers each selection in its own domain", async () => {
    const created = world();
    try {
      const result = (await created.engine.execute("post", "aggregate", {
        _count: true,
        _avg: { rank: true },
        _sum: { rank: true },
        _min: { rank: true },
        _max: { rank: true },
      })) as Record<string, unknown>;
      assert.equal(result._count, 5);
      assert.deepEqual(result._avg, { rank: 30 });
      assert.deepEqual(result._sum, { rank: 150 });
      assert.deepEqual(result._min, { rank: 10 });
      assert.deepEqual(result._max, { rank: 50 });

      const counted = (await created.engine.execute("post", "aggregate", {
        _count: { _all: true, authorId: true },
      })) as Record<string, unknown>;
      assert.deepEqual(counted._count, { _all: 5, authorId: 4 });

      const empty = (await created.engine.execute("post", "aggregate", {
        where: { category: "nothing" },
        _avg: { rank: true },
        _sum: { rank: true },
      })) as Record<string, unknown>;
      assert.deepEqual(empty._avg, { rank: null });
      assert.deepEqual(empty._sum, { rank: null });
    } finally {
      await closeWorld(created);
    }
  });

  it("groupBy groups, filters with having and orders by an aggregate", async () => {
    const created = world();
    try {
      const rows = (await created.engine.execute("post", "groupBy", {
        by: ["category"],
        _count: true,
        _sum: { rank: true },
        orderBy: { category: "asc" },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows, [
        { category: "alpha", _count: 2, _sum: { rank: 30 } },
        { category: "beta", _count: 2, _sum: { rank: 70 } },
        { category: "gamma", _count: 1, _sum: { rank: 50 } },
      ]);

      const having = (await created.engine.execute("post", "groupBy", {
        by: ["category"],
        _count: true,
        having: { rank: { _sum: { gt: 40 } } },
        orderBy: { category: "asc" },
      })) as Record<string, unknown>[];
      assert.deepEqual(having.map((row) => row.category), ["beta", "gamma"]);

      const logical = (await created.engine.execute("post", "groupBy", {
        by: ["category"],
        _count: true,
        having: {
          OR: [
            { rank: { _sum: { gt: 60 } } },
            { NOT: { rank: { _count: { gt: 1 } } } },
          ],
        },
        orderBy: { category: "asc" },
      })) as Record<string, unknown>[];
      assert.deepEqual(logical.map((row) => row.category), ["beta", "gamma"]);

      const scalarHaving = (await created.engine.execute("post", "groupBy", {
        by: ["category"],
        _count: true,
        having: { category: { notIn: ["alpha"] } },
        orderBy: { category: "asc" },
      })) as Record<string, unknown>[];
      assert.deepEqual(scalarHaving.map((row) => row.category), ["beta", "gamma"]);

      const byAggregate = (await created.engine.execute("post", "groupBy", {
        by: ["category"],
        _count: true,
        orderBy: { _sum: { rank: "desc" } },
        take: 2,
      })) as Record<string, unknown>[];
      assert.deepEqual(byAggregate.map((row) => row.category), ["beta", "gamma"]);
    } finally {
      await closeWorld(created);
    }
  });

  it("a pure read opens no transaction and runs one statement", async () => {
    const created = world();
    try {
      created.statements.length = 0;
      await created.engine.execute("post", "count", {});
      assert.equal(created.statements.length, 1);
      assert.ok(!created.statements.some((statement) => /BEGIN/i.test(statement)));
    } finally {
      await closeWorld(created);
    }
  });
});
