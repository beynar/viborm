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
    userId: s.string().nullable(),
    author: s
      .manyToOne(() => user)
      .fields("userId")
      .references("id")
      .optional(),
  })
  .map("nested_mutation_posts");

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
});

describe("Nested Mutation Routing", () => {
  test("update executes nested createMany on to-many relation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          createMany: {
            data: [
              { id: "post-1", title: "First" },
              { id: "post-2", title: "Second" },
            ],
          },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((createdPost) => createdPost.id)).toEqual([
      "post-1",
      "post-2",
    ]);
    expect(posts.map((createdPost) => createdPost.userId)).toEqual([
      "user-1",
      "user-1",
    ]);
  });

  test("update executes nested connect on to-many relation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          connect: { id: "post-1" },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.userId).toBe("user-1");
  });

  test("update executes nested disconnect on to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Connected" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          disconnect: { id: "post-1" },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.userId).toBeNull();
  });

  test("update executes nested delete on to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Delete me" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          delete: { id: "post-1" },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post).toBeNull();
  });

  test("update executes nested set on to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: [
            { id: "post-1", title: "Old first" },
            { id: "post-2", title: "Old second" },
          ],
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-3", title: "Replacement" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          set: { id: "post-3" },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.userId)).toEqual([
      null,
      null,
      "user-1",
    ]);
  });

  test("update executes nested connectOrCreate on to-many relation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          connectOrCreate: {
            where: { id: "post-1" },
            create: { id: "post-1", title: "Created and connected" },
          },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.userId).toBe("user-1");
    expect(post?.title).toBe("Created and connected");
  });
});
