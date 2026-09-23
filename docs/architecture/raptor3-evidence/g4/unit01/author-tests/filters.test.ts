import assert from "node:assert/strict";
import { AnyNull, DbNull, JsonNull } from "@schema/json-null";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedAuthor, seedPost, type World } from "./world";

function world(): World {
  const created = createWorld();
  seedAuthor(created, {
    id: 1,
    author_name: "Ada",
    tier: "pro",
    rating: 4.5,
    tags: JSON.stringify(["alpha", "beta"]),
    profile: JSON.stringify({ level: 3, name: "Ada", roles: ["admin", "dev"] }),
  });
  seedAuthor(created, {
    id: 2,
    author_name: "BOB",
    tier: "basic",
    rating: null,
    tags: JSON.stringify([]),
    profile: JSON.stringify({ level: 1, name: "bob", roles: ["dev"] }),
  });
  seedAuthor(created, {
    id: 3,
    author_name: "cyrus",
    tier: null,
    rating: 2.5,
    tags: JSON.stringify(["beta"]),
    profile: null,
  });
  seedPost(created, { id: 1, author_id: 1, title: "alpha one", rank: 10, category: "alpha", published: 1 });
  seedPost(created, { id: 2, author_id: 1, title: "alpha two", rank: 20, category: "alpha", published: 0 });
  seedPost(created, { id: 3, author_id: 2, title: "Beta one", rank: 30, category: "beta", published: 1 });
  return created;
}

async function ids(
  created: World,
  model: "author" | "post",
  where: Record<string, unknown>
): Promise<number[]> {
  const rows = (await created.engine.execute(model, "findMany", {
    where,
    orderBy: { id: "asc" },
    select: { id: true },
  })) as Record<string, unknown>[];
  return rows.map((row) => row.id as number);
}

describe("G4-01 filters (Q-W01..Q-W10)", () => {
  it("lowers string predicates with mode and exact-text spellings", async () => {
    const created = world();
    try {
      assert.deepEqual(await ids(created, "author", { name: "Ada" }), [1]);
      assert.deepEqual(await ids(created, "author", { name: { contains: "d" } }), [1]);
      assert.deepEqual(
        await ids(created, "author", { name: { contains: "B", mode: "insensitive" } }),
        [2]
      );
      assert.deepEqual(
        await ids(created, "author", { name: { startsWith: "b", mode: "insensitive" } }),
        [2]
      );
      assert.deepEqual(await ids(created, "author", { name: { startsWith: "cy" } }), [3]);
      assert.deepEqual(await ids(created, "author", { name: { endsWith: "us" } }), [3]);
      assert.deepEqual(
        await ids(created, "author", { name: { equals: "bob", mode: "insensitive" } }),
        [2]
      );
      assert.deepEqual(await ids(created, "author", { name: { equals: "bob" } }), []);
    } finally {
      await closeWorld(created);
    }
  });

  it("lowers set membership, negation and null predicates", async () => {
    const created = world();
    try {
      assert.deepEqual(await ids(created, "author", { id: { in: [1, 3] } }), [1, 3]);
      assert.deepEqual(await ids(created, "author", { id: { notIn: [1, 3] } }), [2]);
      assert.deepEqual(await ids(created, "author", { id: { in: [] } }), []);
      assert.deepEqual(await ids(created, "author", { id: { notIn: [] } }), [1, 2, 3]);
      assert.deepEqual(await ids(created, "author", { rating: null }), [2]);
      assert.deepEqual(await ids(created, "author", { rating: { not: null } }), [1, 3]);
      assert.deepEqual(await ids(created, "author", { NOT: { id: 1 } }), [2, 3]);
      assert.deepEqual(
        await ids(created, "author", { OR: [{ id: 1 }, { id: 3 }] }),
        [1, 3]
      );
      assert.deepEqual(
        await ids(created, "author", { AND: [{ id: { gte: 2 } }, { id: { lt: 3 } }] }),
        [2]
      );
      assert.deepEqual(await ids(created, "author", { tier: { in: ["pro"] } }), [1]);
      assert.deepEqual(
        await ids(created, "author", { name: { not: { contains: "A" } } }),
        [2, 3]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("lowers list containment predicates", async () => {
    const created = world();
    try {
      assert.deepEqual(await ids(created, "author", { tags: { has: "alpha" } }), [1]);
      assert.deepEqual(await ids(created, "author", { tags: { has: "beta" } }), [1, 3]);
      assert.deepEqual(
        await ids(created, "author", { tags: { hasEvery: ["alpha", "beta"] } }),
        [1]
      );
      assert.deepEqual(
        await ids(created, "author", { tags: { hasSome: ["alpha", "gamma"] } }),
        [1]
      );
      assert.deepEqual(await ids(created, "author", { tags: { isEmpty: true } }), [2]);
      assert.deepEqual(await ids(created, "author", { tags: { isEmpty: false } }), [1, 3]);
      assert.deepEqual(await ids(created, "author", { tags: { equals: ["beta"] } }), [3]);
      assert.deepEqual(await ids(created, "author", { tags: { hasSome: [] } }), []);
    } finally {
      await closeWorld(created);
    }
  });

  it("lowers JSON path, string, array and null-sentinel predicates", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, "author", { profile: { path: ["level"], equals: 3 } }),
        [1]
      );
      assert.deepEqual(
        await ids(created, "author", { profile: { path: ["level"], gt: 1 } }),
        [1]
      );
      assert.deepEqual(
        await ids(created, "author", {
          profile: { path: ["name"], string_contains: "d" },
        }),
        [1]
      );
      assert.deepEqual(
        await ids(created, "author", {
          profile: { path: ["name"], string_starts_with: "b" },
        }),
        [2]
      );
      assert.deepEqual(
        await ids(created, "author", {
          profile: { path: ["roles"], array_contains: ["admin"] },
        }),
        [1]
      );
      assert.deepEqual(await ids(created, "author", { profile: { equals: DbNull } }), [
        3,
      ]);
      assert.deepEqual(
        await ids(created, "author", { profile: { equals: JsonNull } }),
        []
      );
      assert.deepEqual(
        await ids(created, "author", { profile: { equals: AnyNull } }),
        [3]
      );
      assert.deepEqual(await ids(created, "author", { profile: { not: DbNull } }), [
        1, 2,
      ]);
    } finally {
      await closeWorld(created);
    }
  });

  it("lowers to-one shorthand, is and isNot", async () => {
    const created = world();
    try {
      assert.deepEqual(await ids(created, "post", { author: { name: "Ada" } }), [1, 2]);
      assert.deepEqual(
        await ids(created, "post", { author: { is: { name: "Ada" } } }),
        [1, 2]
      );
      assert.deepEqual(
        await ids(created, "post", { author: { isNot: { name: "Ada" } } }),
        [3]
      );
      seedPost(created, { id: 4, author_id: null, title: "orphan", rank: 40, category: "gamma" });
      assert.deepEqual(await ids(created, "post", { author: { is: null } }), [4]);
      assert.deepEqual(await ids(created, "post", { author: { isNot: null } }), [1, 2, 3]);
    } finally {
      await closeWorld(created);
    }
  });

  it("lowers collection quantifiers independently", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, "author", { posts: { some: { published: true } } }),
        [1, 2]
      );
      assert.deepEqual(
        await ids(created, "author", { posts: { every: { published: true } } }),
        [2, 3]
      );
      assert.deepEqual(
        await ids(created, "author", { posts: { none: { published: true } } }),
        [3]
      );
      assert.deepEqual(await ids(created, "author", { posts: { some: {} } }), [1, 2]);
    } finally {
      await closeWorld(created);
    }
  });

  it("resolves a same-model field-reference operand", async () => {
    const created = world();
    try {
      seedPost(created, { id: 40, title: "match", rank: 40, category: "delta" });
      const rows = (await created.engine.execute("post", "findMany", {
        where: {
          rank: {
            equals: (context: { fields: Record<string, unknown> }) =>
              context.fields.id,
          },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows.map((row) => row.id), [40]);
    } finally {
      await closeWorld(created);
    }
  });

  it("keeps the same operator meaning through a nested relation filter", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, "author", {
          posts: { some: { title: { startsWith: "beta", mode: "insensitive" } } },
        }),
        [2]
      );
      assert.deepEqual(
        await ids(created, "post", {
          author: { is: { tags: { has: "alpha" } } },
        }),
        [1, 2]
      );
    } finally {
      await closeWorld(created);
    }
  });
});
