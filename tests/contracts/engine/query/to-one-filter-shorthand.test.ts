/**
 * To-one relation filter shorthand (Prisma parity, W1-U5).
 *
 * `{ author: { name: "x" } }` is sugar for `{ author: { is: { name: "x" } } }`.
 * Every case here asserts the shorthand and the explicit `is` spelling produce
 * the SAME rows against a real database, so the desugaring cannot drift into a
 * different query. Queries are written inline (not through a helper taking an
 * args type) so the shorthand has to survive the client's own type inference,
 * not just the runtime validator. See src/validation/relations/filter.ts for
 * the disambiguation and collision rules.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    email: s.string(),
    profile: s.toOne(() => profile),
    posts: s.toMany(() => post),
  })
  .map("shorthand_users");

const profile = s
  .model({
    id: s.string().id(),
    bio: s.string(),
    userId: s.string().unique().nullable(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
  })
  .map("shorthand_profiles");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("shorthand_posts");

const createShorthandClient = () =>
  createClient({
    schema: { user, profile, post },
    driver: new PGliteDriver({ client: openTestPGlite() }),
  });

let client: ReturnType<typeof createShorthandClient>;

const ids = (rows: readonly { id: string }[]): string[] =>
  rows.map((row) => row.id);

beforeAll(async () => {
  client = createShorthandClient();
  await syncLiveSchema(client);

  await client.user.createMany({
    data: [
      { id: "u1", name: "Alice", email: "alice@example.com" },
      { id: "u2", name: "Bob", email: "bob@example.com" },
      { id: "u3", name: "Carol", email: "carol@example.com" },
    ],
  });
  await client.profile.createMany({
    data: [
      { id: "p1", bio: "writes", userId: "u1" },
      { id: "p2", bio: "reads", userId: "u2" },
      { id: "p3", bio: "writes", userId: null },
    ],
  });
  await client.post.createMany({
    data: [
      { id: "a1", title: "alpha", authorId: "u1" },
      { id: "a2", title: "beta", authorId: "u2" },
      { id: "a3", title: "gamma", authorId: "u3" },
    ],
  });
});

afterAll(async () => {
  await client.$disconnect();
});

describe("to-one filter shorthand - parent-held (post.author)", () => {
  test("shorthand equals the explicit `is` form", async () => {
    const shorthand = await client.post.findMany({
      where: { author: { name: "Alice" } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: { author: { is: { name: "Alice" } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["a1"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });

  test("compound shorthand with several scalar keys", async () => {
    const shorthand = await client.post.findMany({
      where: { author: { name: "Bob", email: { endsWith: "@example.com" } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: {
        author: { is: { name: "Bob", email: { endsWith: "@example.com" } } },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["a2"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });

  test("`isNot` still works", async () => {
    const rows = await client.post.findMany({
      where: { author: { isNot: { name: "Alice" } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(rows)).toEqual(["a2", "a3"]);
  });
});

describe("to-one filter shorthand - inverse side (profile.user)", () => {
  test("shorthand equals the explicit `is` form", async () => {
    const shorthand = await client.profile.findMany({
      where: { user: { name: "Bob" } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.profile.findMany({
      where: { user: { is: { name: "Bob" } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["p2"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });

  test("`user: null` still means the relation is absent", async () => {
    const bare = await client.profile.findMany({
      where: { user: null },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.profile.findMany({
      where: { user: { is: null } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(bare)).toEqual(["p3"]);
    expect(ids(bare)).toEqual(ids(explicit));
  });
});

describe("to-one filter shorthand - nesting", () => {
  test("desugars at every level of a to-one chain", async () => {
    const shorthand = await client.post.findMany({
      where: { author: { profile: { bio: "writes" } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: { author: { is: { profile: { is: { bio: "writes" } } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["a1"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });

  test("mixed spellings along one chain agree", async () => {
    const mixed = await client.post.findMany({
      where: { author: { is: { profile: { bio: "reads" } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: { author: { is: { profile: { is: { bio: "reads" } } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(mixed)).toEqual(["a2"]);
    expect(ids(mixed)).toEqual(ids(explicit));
  });

  test("shorthand carries a to-many filter through to the target", async () => {
    const shorthand = await client.profile.findMany({
      where: { user: { posts: { some: { title: "alpha" } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.profile.findMany({
      where: { user: { is: { posts: { some: { title: "alpha" } } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["p1"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });
});

describe("to-one filter shorthand - under boolean combinators", () => {
  test("inside an OR array", async () => {
    const shorthand = await client.post.findMany({
      where: {
        OR: [{ author: { name: "Alice" } }, { author: { name: "Carol" } }],
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: {
        OR: [
          { author: { is: { name: "Alice" } } },
          { author: { is: { name: "Carol" } } },
        ],
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["a1", "a3"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });

  test("inside NOT", async () => {
    const shorthand = await client.post.findMany({
      where: { NOT: { author: { name: "Alice" } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: { NOT: { author: { is: { name: "Alice" } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["a2", "a3"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });

  test("inside a NOT array", async () => {
    const shorthand = await client.post.findMany({
      where: { NOT: [{ author: { name: "Alice" } }] },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: { NOT: [{ author: { is: { name: "Alice" } } }] },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["a2", "a3"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });

  test("shorthand nested inside the target's own OR", async () => {
    const shorthand = await client.post.findMany({
      where: { author: { OR: [{ name: "Alice" }, { name: "Bob" }] } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const explicit = await client.post.findMany({
      where: { author: { is: { OR: [{ name: "Alice" }, { name: "Bob" }] } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(ids(shorthand)).toEqual(["a1", "a2"]);
    expect(ids(shorthand)).toEqual(ids(explicit));
  });
});
