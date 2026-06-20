import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => post),
});

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("client_relation_filter_posts");

const schema = { user, post };

let client: Awaited<
  ReturnType<typeof PGliteCreateClient<{ schema: typeof schema }>>
>;

beforeAll(async () => {
  client = PGliteCreateClient({ schema });
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.post.deleteMany();
  await client.user.deleteMany();

  await client.user.create({
    data: {
      id: "user-1",
      name: "Alice",
      posts: {
        createMany: {
          data: [
            { id: "post-1", title: "Alice Published", published: true },
            { id: "post-2", title: "Alice Also Published", published: true },
          ],
        },
      },
    },
  });
  await client.user.create({
    data: {
      id: "user-2",
      name: "Bob",
      posts: {
        createMany: {
          data: [
            { id: "post-3", title: "Bob Published", published: true },
            { id: "post-4", title: "Bob Draft", published: false },
          ],
        },
      },
    },
  });
  await client.user.create({
    data: { id: "user-3", name: "Cara" },
  });
});

describe("Client Relation Filters", () => {
  test("executes some relation filters", async () => {
    const users = await client.user.findMany({
      where: { posts: { some: { published: false } } },
      orderBy: { id: "asc" },
    });

    expect(users.map((matchedUser) => matchedUser.name)).toEqual(["Bob"]);
  });

  test("executes every relation filters with explicit existence guard", async () => {
    const users = await client.user.findMany({
      where: {
        AND: [
          { posts: { some: {} } },
          { posts: { every: { published: true } } },
        ],
      },
      orderBy: { id: "asc" },
    });

    expect(users.map((matchedUser) => matchedUser.name)).toEqual(["Alice"]);
  });

  test("executes none relation filters", async () => {
    const users = await client.user.findMany({
      where: { posts: { none: { published: false } } },
      orderBy: { id: "asc" },
    });

    expect(users.map((matchedUser) => matchedUser.name)).toEqual([
      "Alice",
      "Cara",
    ]);
  });

  test("executes to-one is and isNot filters", async () => {
    const alicePosts = await client.post.findMany({
      where: { author: { is: { name: "Alice" } } },
      orderBy: { id: "asc" },
    });
    const nonAlicePosts = await client.post.findMany({
      where: { author: { isNot: { name: "Alice" } } },
      orderBy: { id: "asc" },
    });

    expect(alicePosts.map((matchedPost) => matchedPost.id)).toEqual([
      "post-1",
      "post-2",
    ]);
    expect(nonAlicePosts.map((matchedPost) => matchedPost.id)).toEqual([
      "post-3",
      "post-4",
    ]);
  });

  test("combines relation filters with OR and include", async () => {
    const users = await client.user.findMany({
      where: {
        OR: [
          { posts: { some: { published: false } } },
          { name: "Cara" },
        ],
      },
      include: { posts: true },
      orderBy: { id: "asc" },
    });

    expect(users.map((matchedUser) => matchedUser.name)).toEqual([
      "Bob",
      "Cara",
    ]);
    expect(users[0]?.posts.map((matchedPost) => matchedPost.title)).toEqual([
      "Bob Published",
      "Bob Draft",
    ]);
    expect(users[1]?.posts).toEqual([]);
  });
});
