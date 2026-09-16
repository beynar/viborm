import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedAuthor, seedPost, type World } from "./world";

function world(): World {
  const created = createWorld();
  seedAuthor(created, { id: 1, author_name: "Ada", rating: 4.5 });
  seedAuthor(created, { id: 2, author_name: "Bob", rating: null });
  seedAuthor(created, { id: 3, author_name: "Cy", rating: 2.5 });
  seedPost(created, { id: 1, author_id: 1, title: "a1", rank: 10, category: "alpha", published: 1 });
  seedPost(created, { id: 2, author_id: 1, title: "a2", rank: 20, category: "alpha", published: 0 });
  seedPost(created, { id: 3, author_id: 1, title: "a3", rank: 30, category: "beta", published: 1 });
  seedPost(created, { id: 4, author_id: 2, title: "b1", rank: 40, category: "beta", published: 1 });
  seedPost(created, { id: 5, author_id: 3, title: "c1", rank: 50, category: "gamma", published: 0 });
  return created;
}

async function rows(
  created: World,
  model: "author" | "post",
  args: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  return (await created.engine.execute(model, "findMany", args)) as Record<
    string,
    unknown
  >[];
}

describe("G4-01 ordering (Q-O01..Q-O04)", () => {
  it("orders by direction, explicit null placement and several keys", async () => {
    const created = world();
    try {
      // An unqualified direction states no placement: NULLs land where the
      // provider puts them (SQLite: first ascending), which is the shipped
      // answer for this input. `repairs.test.ts` pins it differentially.
      assert.deepEqual(
        (await rows(created, "author", {
          orderBy: { rating: "asc" },
          select: { id: true },
        })).map((row) => row.id),
        [2, 3, 1]
      );
      assert.deepEqual(
        (await rows(created, "author", {
          orderBy: { rating: { sort: "asc", nulls: "first" } },
          select: { id: true },
        })).map((row) => row.id),
        [2, 3, 1]
      );
      assert.deepEqual(
        (await rows(created, "author", {
          orderBy: { rating: { sort: "desc", nulls: "last" } },
          select: { id: true },
        })).map((row) => row.id),
        [1, 3, 2]
      );
      assert.deepEqual(
        (await rows(created, "post", {
          orderBy: [{ category: "asc" }, { rank: "desc" }],
          select: { id: true },
        })).map((row) => row.id),
        [2, 1, 4, 3, 5]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("orders by a to-one relation path and by a collection count", async () => {
    const created = world();
    try {
      assert.deepEqual(
        (await rows(created, "post", {
          orderBy: [{ author: { name: "desc" } }, { id: "asc" }],
          select: { id: true },
        })).map((row) => row.id),
        [5, 4, 1, 2, 3]
      );
      assert.deepEqual(
        (await rows(created, "author", {
          orderBy: { posts: { _count: "desc" } },
          select: { id: true },
        })).map((row) => row.id),
        [1, 2, 3]
      );
      assert.deepEqual(
        (await rows(created, "author", {
          orderBy: [{ posts: { _count: "asc" } }, { id: "desc" }],
          select: { id: true },
        })).map((row) => row.id),
        [3, 2, 1]
      );
    } finally {
      await closeWorld(created);
    }
  });
});

describe("G4-01 projection and nested pagination (Q-S01..Q-S03, Q-P03)", () => {
  it("honours select, include and desugared omit", async () => {
    const created = world();
    try {
      const selected = await rows(created, "post", {
        where: { id: 1 },
        select: { id: true, title: true },
      });
      assert.deepEqual(selected, [{ id: 1, title: "a1" }]);

      const included = await rows(created, "post", {
        where: { id: 1 },
        include: { author: { select: { name: true } } },
      });
      assert.equal(included[0]!.title, "a1");
      assert.deepEqual(included[0]!.author, { name: "Ada" });

      const omitted = await rows(created, "post", {
        where: { id: 1 },
        omit: { title: true, rank: true, category: true, published: true, authorId: true },
      });
      assert.deepEqual(omitted, [{ id: 1 }]);

      const omittedWithInclude = await rows(created, "post", {
        where: { id: 1 },
        omit: { title: true, rank: true, category: true, published: true, authorId: true },
        include: { author: { select: { id: true } } },
      });
      assert.deepEqual(omittedWithInclude, [{ id: 1, author: { id: 1 } }]);
    } finally {
      await closeWorld(created);
    }
  });

  it("scopes every nested window per parent", async () => {
    const created = world();
    try {
      const authors = await rows(created, "author", {
        orderBy: { id: "asc" },
        select: {
          id: true,
          posts: {
            where: { published: true },
            orderBy: { rank: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      });
      assert.deepEqual(authors, [
        { id: 1, posts: [{ id: 3 }] },
        { id: 2, posts: [{ id: 4 }] },
        { id: 3, posts: [] },
      ]);

      const skipped = await rows(created, "author", {
        where: { id: 1 },
        select: {
          id: true,
          posts: { orderBy: { rank: "asc" }, skip: 1, select: { id: true } },
        },
      });
      assert.deepEqual(skipped[0]!.posts, [{ id: 2 }, { id: 3 }]);

      const cursored = await rows(created, "author", {
        where: { id: 1 },
        select: {
          id: true,
          posts: {
            orderBy: { rank: "asc" },
            cursor: { id: 2 },
            take: 1,
            select: { id: true },
          },
        },
      });
      assert.deepEqual(cursored[0]!.posts, [{ id: 2 }]);

      const distinct = await rows(created, "author", {
        where: { id: 1 },
        select: {
          id: true,
          posts: {
            orderBy: { rank: "asc" },
            distinct: ["category"],
            select: { category: true },
          },
        },
      });
      assert.deepEqual(distinct[0]!.posts, [
        { category: "alpha" },
        { category: "beta" },
      ]);
    } finally {
      await closeWorld(created);
    }
  });

  it("projects relation counts, optionally filtered by their target", async () => {
    const created = world();
    try {
      const counted = await rows(created, "author", {
        orderBy: { id: "asc" },
        select: { id: true, _count: { select: { posts: true } } },
      });
      assert.deepEqual(counted, [
        { id: 1, _count: { posts: 3 } },
        { id: 2, _count: { posts: 1 } },
        { id: 3, _count: { posts: 1 } },
      ]);

      const filtered = await rows(created, "author", {
        orderBy: { id: "asc" },
        select: {
          id: true,
          _count: { select: { posts: { where: { published: true } } } },
        },
      });
      assert.deepEqual(filtered, [
        { id: 1, _count: { posts: 2 } },
        { id: 2, _count: { posts: 1 } },
        { id: 3, _count: { posts: 0 } },
      ]);

      const included = await rows(created, "author", {
        where: { id: 1 },
        include: { _count: true },
      });
      assert.deepEqual(included[0]!._count, { posts: 3 });
    } finally {
      await closeWorld(created);
    }
  });

  it("keeps a to-one carrier null and a collection carrier a fresh array", async () => {
    const created = world();
    try {
      seedPost(created, { id: 6, author_id: null, title: "orphan", rank: 60, category: "delta" });
      const orphan = await rows(created, "post", {
        where: { id: 6 },
        include: { author: true },
      });
      assert.equal(orphan[0]!.author, null);
      const empty = await rows(created, "author", {
        where: { id: 3 },
        select: { id: true, posts: { where: { published: true }, select: { id: true } } },
      });
      assert.deepEqual(empty[0]!.posts, []);
    } finally {
      await closeWorld(created);
    }
  });
});
